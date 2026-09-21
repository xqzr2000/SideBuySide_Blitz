import dns from 'node:dns/promises';
import net from 'node:net';
import { currencyFromText, parsePriceFromText } from './currency.js';
import { toNumber } from './items.js';

const USER_AGENT = 'Mozilla/5.0 (compatible; SideBuySideBot/0.2; +https://github.com/xqzr2000/SideBuySide_Blitz)';
const MAX_BYTES = 1_500_000;
const MAX_REDIRECTS = 3;

export function isPrivateAddress(ip) {
  const address = String(ip || '').toLowerCase();
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (address.startsWith('::ffff:')) return isPrivateAddress(address.slice(7));
  if (address === '::1' || address === '::') return true;
  return /^(fc|fd|fe8|fe9|fea|feb)/.test(address);
}

/** Reject anything that is not a public http(s) origin, so a tool call cannot probe the LAN. */
export async function assertPublicUrl(rawUrl, lookup = dns.lookup) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw Object.assign(new Error('That is not a valid URL.'), { statusCode: 400 });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw Object.assign(new Error('Only http(s) URLs can be inspected.'), { statusCode: 400 });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw Object.assign(new Error('Refusing to fetch a private address.'), { statusCode: 400 });
    return url;
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw Object.assign(new Error('Refusing to fetch a private address.'), { statusCode: 400 });
  }
  const resolved = await lookup(host, { all: true }).catch(() => []);
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (addresses.some((entry) => isPrivateAddress(entry?.address))) {
    throw Object.assign(new Error('Refusing to fetch a private address.'), { statusCode: 400 });
  }
  return url;
}

async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return '';
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await response.text();
    return text.slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let html = '';
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength ?? value.length ?? 0;
    html += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return html.slice(0, maxBytes);
}

function flatten(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, acc));
    return acc;
  }
  acc.push(node);
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') flatten(value, acc);
  }
  return acc;
}

function jsonLdNodes(html) {
  const nodes = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    try {
      flatten(JSON.parse(match[1].trim()), nodes);
    } catch {
      // Malformed JSON-LD is common in the wild; skip it.
    }
  }
  return nodes;
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name|itemprop)=["']${escaped}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeEntities(match[1].trim());
  }
  return '';
}

function decodeEntities(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#039;', "'")
    .replaceAll('&nbsp;', ' ');
}

/** "1,299.00", "$129.99 - $199.99" and "129.99 USD" all reduce to a single number. */
function numberFromRaw(raw) {
  if (typeof raw === 'number') return toNumber(raw);
  const cleaned = String(raw ?? '').replace(/[\s,](?=\d{3}\b)/g, '');
  const match = cleaned.match(/\d+(?:\.\d{1,2})?/);
  return match ? toNumber(match[0]) : null;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
}

function offerOf(product) {
  const offers = product?.offers;
  if (Array.isArray(offers)) return offers.find(Boolean) || {};
  return offers || {};
}

/** Extract product facts from raw HTML: JSON-LD first, then OpenGraph/meta, then visible text. */
export function extractProductFromHtml(html = '', pageUrl = '') {
  const source = String(html);
  const products = jsonLdNodes(source).filter((node) => {
    const type = node?.['@type'];
    return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
  });
  const product = products[0] || {};
  const offer = offerOf(product);

  const rawPrice = firstValue(
    offer.price,
    offer.lowPrice,
    product.price,
    metaContent(source, 'product:price:amount'),
    metaContent(source, 'og:price:amount'),
    metaContent(source, 'price')
  );

  let price = numberFromRaw(rawPrice);
  let currency = String(firstValue(
    offer.priceCurrency,
    product.priceCurrency,
    metaContent(source, 'product:price:currency'),
    metaContent(source, 'og:price:currency'),
    metaContent(source, 'priceCurrency')
  ) || '').toUpperCase();

  if (price === null) {
    const guessed = parsePriceFromText(stripTags(source).slice(0, 4000));
    price = guessed.price;
    currency = currency || guessed.currency;
  }
  if (!currency) currency = currencyFromText(String(rawPrice || ''));

  const title = firstValue(
    product.name,
    metaContent(source, 'og:title'),
    metaContent(source, 'twitter:title'),
    (source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
  );

  const brandValue = typeof product.brand === 'object' ? product.brand?.name : product.brand;
  const sellerValue = typeof offer.seller === 'object' ? offer.seller?.name : offer.seller;
  const imageValue = firstValue(
    Array.isArray(product.image) ? product.image[0] : product.image,
    metaContent(source, 'og:image')
  );

  let site = '';
  try {
    site = new URL(pageUrl).hostname.replace(/^www\./, '');
  } catch {
    site = '';
  }

  return {
    url: String(pageUrl || ''),
    site,
    name: decodeEntities(String(title || '')).trim(),
    price,
    currency,
    brand: String(brandValue || '').trim(),
    seller: String(sellerValue || '').trim(),
    availability: String(offer.availability || '').replace(/^https?:\/\/schema\.org\//, ''),
    rating: toNumber(product.aggregateRating?.ratingValue),
    ratingCount: toNumber(firstValue(product.aggregateRating?.ratingCount, product.aggregateRating?.reviewCount)),
    sku: String(firstValue(product.sku, product.mpn, product.gtin13, product.gtin) || '').trim(),
    image: String(imageValue || '').trim(),
    structured: products.length > 0
  };
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Fetch a candidate offer page and read its real price, rather than trusting a
 * search snippet. Redirects are followed manually so every hop is re-validated.
 */
export async function fetchOffer(rawUrl, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const lookup = options.lookup || dns.lookup;
  const timeoutMs = Number(options.timeoutMs) || 9000;
  const maxBytes = Number(options.maxBytes) || MAX_BYTES;

  let target = await assertPublicUrl(rawUrl, lookup);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(target.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' }
      });

      const location = response.headers?.get?.('location');
      if (response.status >= 300 && response.status < 400 && location) {
        target = await assertPublicUrl(new URL(location, target).toString(), lookup);
        continue;
      }

      if (!response.ok) {
        return { url: target.toString(), status: response.status, ok: false, error: `The page returned HTTP ${response.status}.` };
      }

      const html = await readCapped(response, maxBytes);
      const product = extractProductFromHtml(html, target.toString());
      return {
        url: target.toString(),
        status: response.status,
        ok: true,
        product,
        priceConfirmed: product.price !== null,
        note: product.structured ? '' : 'No structured product data on this page; values were guessed from page text and may be wrong.'
      };
    }
    return { url: target.toString(), ok: false, error: 'Too many redirects.' };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'The page took too long to respond.' : error.message;
    return { url: String(rawUrl), ok: false, error: reason };
  } finally {
    clearTimeout(timer);
  }
}
