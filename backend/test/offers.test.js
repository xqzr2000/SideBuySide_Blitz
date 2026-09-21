import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, extractProductFromHtml, fetchOffer, isPrivateAddress } from '../src/offers.js';

const publicLookup = async () => [{ address: '93.184.216.34' }];

test('extractProductFromHtml reads JSON-LD product data', () => {
  const html = `<html><head>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Nova Earbuds","sku":"NV-22","brand":{"name":"Nova"},
      "aggregateRating":{"ratingValue":"4.6","reviewCount":"1240"},
      "offers":{"@type":"Offer","price":"129.99","priceCurrency":"USD","availability":"https://schema.org/InStock","seller":{"name":"Nova Store"}}}</script>
    </head><body></body></html>`;

  const product = extractProductFromHtml(html, 'https://shop.example.com/nova');
  assert.equal(product.name, 'Nova Earbuds');
  assert.equal(product.price, 129.99);
  assert.equal(product.currency, 'USD');
  assert.equal(product.availability, 'InStock');
  assert.equal(product.rating, 4.6);
  assert.equal(product.ratingCount, 1240);
  assert.equal(product.seller, 'Nova Store');
  assert.equal(product.site, 'shop.example.com');
  assert.equal(product.structured, true);
});

test('extractProductFromHtml falls back to meta tags and marks the data unstructured', () => {
  const html = `<html><head>
    <meta property="og:title" content="Nova Earbuds Pro" />
    <meta property="product:price:amount" content="149.00" />
    <meta property="product:price:currency" content="CAD" />
    </head><body></body></html>`;

  const product = extractProductFromHtml(html, 'https://shop.example.com/pro');
  assert.equal(product.name, 'Nova Earbuds Pro');
  assert.equal(product.price, 149);
  assert.equal(product.currency, 'CAD');
  assert.equal(product.structured, false);
});

test('extractProductFromHtml guesses a price from page text as a last resort', () => {
  const html = '<html><head><title>Kettle</title></head><body><div class="price">CA$49.95</div></body></html>';
  const product = extractProductFromHtml(html, 'https://shop.example.com/kettle');
  assert.equal(product.price, 49.95);
  assert.equal(product.currency, 'CAD');
});

test('isPrivateAddress covers loopback, LAN, and link-local ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.16.0.9', '169.254.1.1', '::1', 'fd00::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '93.184.216.34', '2606:2800:220:1::']) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test('assertPublicUrl refuses private hosts and non-http schemes', async () => {
  await assert.rejects(() => assertPublicUrl('http://localhost:8787/admin', publicLookup), /private address/);
  await assert.rejects(() => assertPublicUrl('http://192.168.0.1/', publicLookup), /private address/);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd', publicLookup), /http\(s\)/);
  await assert.rejects(() => assertPublicUrl('https://intranet.example.com', async () => [{ address: '10.0.0.4' }]), /private address/);
  const url = await assertPublicUrl('https://shop.example.com/p', publicLookup);
  assert.equal(url.hostname, 'shop.example.com');
});

test('fetchOffer follows redirects and re-validates every hop', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.endsWith('/start')) {
      return new Response('', { status: 302, headers: { location: 'https://shop.example.com/final' } });
    }
    return new Response('<html><head><meta property="og:title" content="Final"><meta property="product:price:amount" content="12.50"></head></html>', {
      headers: { 'Content-Type': 'text/html' }
    });
  };

  const result = await fetchOffer('https://shop.example.com/start', { fetchImpl, lookup: publicLookup });
  assert.deepEqual(seen, ['https://shop.example.com/start', 'https://shop.example.com/final']);
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://shop.example.com/final');
  assert.equal(result.product.price, 12.5);
  assert.equal(result.priceConfirmed, true);
});

test('fetchOffer reports HTTP errors instead of throwing', async () => {
  const fetchImpl = async () => new Response('nope', { status: 404 });
  const result = await fetchOffer('https://shop.example.com/gone', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, false);
  assert.match(result.error, /HTTP 404/);
});

test('fetchOffer refuses a redirect into a private address', async () => {
  const fetchImpl = async (url) => (url.endsWith('/start')
    ? new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
    : new Response('<html></html>'));
  const result = await fetchOffer('https://shop.example.com/start', { fetchImpl, lookup: publicLookup });
  assert.equal(result.ok, false);
  assert.match(result.error, /private address/);
});

test('extractProductFromHtml handles grouped thousands and price ranges', () => {
  const grouped = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Desk","offers":{"price":"1,299.00","priceCurrency":"USD"}}</script></head></html>`;
  assert.equal(extractProductFromHtml(grouped, 'https://shop.example.com/desk').price, 1299);

  const ranged = `<html><head><script type="application/ld+json">{"@type":"Product","name":"Tee","offers":{"lowPrice":"$19.99 - $29.99","priceCurrency":"USD"}}</script></head></html>`;
  assert.equal(extractProductFromHtml(ranged, 'https://shop.example.com/tee').price, 19.99);
});
