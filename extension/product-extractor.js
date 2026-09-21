export function extractProductFromPage() {
  function first(...values) {
    return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  }

  function text(selector) {
    const el = document.querySelector(selector);
    return el?.textContent?.trim() || '';
  }

  function attr(selector, name) {
    return document.querySelector(selector)?.getAttribute(name)?.trim() || '';
  }

  function parsePrice(value) {
    if (value === null || value === undefined) return null;
    const normalized = String(value).replace(/\s/g, '').replace(/,/g, '');
    const match = normalized.match(/(?:\d+)(?:\.\d{1,2})?/);
    if (!match) return null;
    const price = Number(match[0]);
    return Number.isFinite(price) ? price : null;
  }

  function currencyFromText(value) {
    const textValue = String(value || '').toUpperCase();
    const code = textValue.match(/\b(USD|CAD|EUR|GBP|AUD|JPY|CNY|INR|KRW|NZD|CHF)\b/);
    if (code) return code[1];
    if (textValue.includes('CA$') || textValue.includes('C$')) return 'CAD';
    if (textValue.includes('US$')) return 'USD';
    if (textValue.includes('€')) return 'EUR';
    if (textValue.includes('£')) return 'GBP';
    if (textValue.includes('¥')) return 'JPY';
    return '';
  }

  function flattenJsonLd(node, acc = []) {
    if (!node) return acc;
    if (Array.isArray(node)) {
      node.forEach((child) => flattenJsonLd(child, acc));
      return acc;
    }
    if (typeof node !== 'object') return acc;
    acc.push(node);
    if (node['@graph']) flattenJsonLd(node['@graph'], acc);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') flattenJsonLd(value, acc);
    }
    return acc;
  }

  function jsonLdProducts() {
    const nodes = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        flattenJsonLd(JSON.parse(script.textContent), nodes);
      } catch {
        // Ignore malformed JSON-LD.
      }
    }
    return nodes.filter((node) => {
      const type = node?.['@type'];
      return type === 'Product' || (Array.isArray(type) && type.includes('Product'));
    });
  }

  function findOffer(product) {
    const offers = product?.offers;
    if (Array.isArray(offers)) return offers.find(Boolean) || {};
    return offers || {};
  }

  function findLikelyAddToCartSelector() {
    const candidates = [
      'button[name*="add" i][name*="cart" i]',
      'button[id*="add" i][id*="cart" i]',
      'button[class*="add" i][class*="cart" i]',
      '[role="button"][aria-label*="add to cart" i]',
      'input[type="submit"][value*="add to cart" i]'
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      if (el && !el.disabled) return selector;
    }
    return '';
  }

  function pageLooksCommercial() {
    const bodyText = document.body?.innerText?.slice(0, 15000).toLowerCase() || '';
    const signals = ['add to cart', 'add to bag', 'buy now', 'in stock', 'out of stock', 'shipping', 'checkout'];
    return signals.some((signal) => bodyText.includes(signal));
  }

  const products = jsonLdProducts();
  const product = products[0] || {};
  const offer = findOffer(product);

  const metaPrice = first(
    attr('meta[property="product:price:amount"]', 'content'),
    attr('meta[property="og:price:amount"]', 'content'),
    attr('meta[itemprop="price"]', 'content')
  );

  const metaCurrency = first(
    attr('meta[property="product:price:currency"]', 'content'),
    attr('meta[property="og:price:currency"]', 'content'),
    attr('meta[itemprop="priceCurrency"]', 'content')
  );

  const visiblePriceText = first(text('[itemprop="price"]'), text('[data-price]'), text('[class*="price" i]'));
  const rawPrice = first(offer.price, offer.lowPrice, product.price, metaPrice, visiblePriceText);
  const price = parsePrice(rawPrice);
  const currency = first(
    offer.priceCurrency,
    product.priceCurrency,
    metaCurrency,
    currencyFromText(rawPrice),
    currencyFromText(visiblePriceText)
  ) || '';

  const name = first(
    product.name,
    attr('meta[property="og:title"]', 'content'),
    attr('meta[name="twitter:title"]', 'content'),
    text('h1')
  );

  const imageValue = first(
    Array.isArray(product.image) ? product.image[0] : product.image,
    attr('meta[property="og:image"]', 'content'),
    attr('meta[name="twitter:image"]', 'content')
  );

  const hasStructuredProduct = products.length > 0;
  const hasProductSignals = hasStructuredProduct || (Boolean(name) && price !== null && pageLooksCommercial());
  if (!hasProductSignals) return null;

  let brand = product.brand;
  if (brand && typeof brand === 'object') brand = brand.name;

  let rating = null;
  let ratingCount = null;
  if (product.aggregateRating) {
    rating = parsePrice(product.aggregateRating.ratingValue);
    ratingCount = parsePrice(first(product.aggregateRating.ratingCount, product.aggregateRating.reviewCount));
  }

  const seller = typeof offer.seller === 'object' ? offer.seller?.name : offer.seller;

  return {
    name: String(name || document.title || 'Unnamed item').trim(),
    price,
    currency: String(currency || '').trim(),
    url: location.href,
    image: String(imageValue || '').trim(),
    brand: String(brand || '').trim(),
    availability: String(offer.availability || '').replace(/^https?:\/\/schema.org\//, ''),
    seller: String(seller || '').trim(),
    sku: String(first(product.sku, product.mpn, product.gtin13, product.gtin) || '').trim(),
    rating,
    ratingCount,
    site: location.hostname.replace(/^www\./, ''),
    addToCartSelector: findLikelyAddToCartSelector(),
    pageTitle: document.title
  };
}
