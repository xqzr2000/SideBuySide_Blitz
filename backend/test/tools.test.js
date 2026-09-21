import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/tools.js';

const items = [
  { id: 'a', name: 'Acme Headphones One', price: 100, currency: 'CAD', site: 'store-a.com', rating: 4.5, ratingCount: 200, availability: 'InStock', brand: 'Acme' },
  { id: 'b', name: 'Acme Headphones One', price: 80, currency: 'CAD', site: 'store-b.com', rating: 4.1, ratingCount: 30, brand: 'Acme' },
  { id: 'c', name: 'Mystery Item', price: null, currency: 'CAD', site: 'store-a.com' }
];

const env = {};

test('compare_items identifies price range and winners', async () => {
  const { result } = await executeTool('compare_items', {}, items, { env });
  assert.equal(result.count, 3);
  assert.equal(result.priceRange.min.value, 80);
  assert.equal(result.priceRange.max.value, 100);
  assert.equal(result.priceRange.spread, 20);
  assert.equal(result.winners.cheapest.id, 'b');
  assert.equal(result.winners.bestRated.id, 'a');
  assert.deepEqual(result.missing.price, ['c']);
});

test('organize_items groups by store and emits a reorder action', async () => {
  const { result, actions } = await executeTool('organize_items', { strategy: 'store' }, items, { env });
  assert.deepEqual(result.groups['store-a.com'], ['a', 'c']);
  assert.deepEqual(result.groups['store-b.com'], ['b']);
  assert.equal(result.applied, true);
  assert.equal(actions[0].type, 'reorder');
  assert.deepEqual(actions[0].ids, ['a', 'c', 'b']);
});

test('organize_items with apply false proposes without touching the shelf', async () => {
  const { result, actions } = await executeTool('organize_items', { strategy: 'brand', apply: false }, items, { env });
  assert.equal(result.applied, false);
  assert.equal(actions.length, 0);
  assert.deepEqual(result.groups.Acme, ['a', 'b']);
});

test('list_items filters by query and sorts by price', async () => {
  const { result } = await executeTool('list_items', { query: 'headphones', sort_by: 'price_low' }, items, { env });
  assert.deepEqual(result.items.map((item) => item.id), ['b', 'a']);
  assert.equal(result.totalOnShelf, 3);
});

test('list_items converts prices into a target currency', async () => {
  const { result } = await executeTool('list_items', { has_price: true, target_currency: 'USD' }, items, { env });
  assert.equal(result.targetCurrency, 'USD');
  assert.equal(result.items[0].normalized.currency, 'USD');
  assert.equal(result.items[0].normalized.approximate, true);
  assert.ok(result.items[0].normalized.value < 100);
});

test('find_duplicates clusters the same product from two stores', async () => {
  const { result } = await executeTool('find_duplicates', {}, items, { env });
  assert.equal(result.clusterCount, 1);
  assert.deepEqual(result.clusters[0].items.map((item) => item.id), ['a', 'b']);
  assert.equal(result.clusters[0].cheapest.id, 'b');
  assert.equal(result.clusters[0].priceSpread, 20);
});

test('rank_items scores every item and flags estimated fields', async () => {
  const { result } = await executeTool('rank_items', {}, items, { env });
  assert.equal(result.count, 3);
  assert.ok(result.ranking[0].score >= result.ranking[1].score);
  const mystery = result.ranking.find((entry) => entry.id === 'c');
  assert.ok(mystery.estimatedFields.includes('price'));
  assert.equal(mystery.confidence, 'low');
});

test('price_summary reports per-currency stats and a combined total', async () => {
  const { result } = await executeTool('price_summary', { target_currency: 'CAD' }, items, { env });
  assert.equal(result.itemsWithPrice, 2);
  assert.equal(result.itemsWithoutPrice, 1);
  assert.equal(result.currencies[0].total, 180);
  assert.equal(result.combined.total, 180);
});

test('tag_items applies tags to known cards and skips unknown ids', async () => {
  const { result, actions } = await executeTool('tag_items', {
    updates: [
      { item_id: 'a', tags: ['finalist'], note: 'Best rated so far' },
      { item_id: 'zzz', tags: ['ghost'] }
    ]
  }, items, { env });
  assert.deepEqual(result.skipped, ['zzz']);
  assert.equal(actions[0].type, 'set_tags');
  assert.deepEqual(actions[0].updates[0].tags, ['finalist']);
});

test('evaluate_deal computes savings and surfaces caveats', async () => {
  const { result, actions } = await executeTool('evaluate_deal', {
    item_id: 'a',
    offers: [
      { title: 'Acme Headphones One', url: 'https://store-c.com/p', price: 70, currency: 'CAD', confirmed: true },
      { title: 'Acme Headphones One (Renewed)', url: 'https://ebay.com/p', price: 55, currency: 'CAD', confirmed: false }
    ]
  }, items, { env });

  assert.equal(result.baseline.value, 100);
  assert.equal(result.bestOffer.url, 'https://ebay.com/p');
  assert.equal(result.bestOffer.savings, 45);
  assert.ok(result.bestOffer.caveats.some((caveat) => /refurbished or used/i.test(caveat)));
  assert.ok(result.offers[1].savings === 30);
  assert.equal(actions[0].type, 'offers');
});

test('evaluate_deal adds shipping before comparing', async () => {
  const { result } = await executeTool('evaluate_deal', {
    item_id: 'a',
    offers: [{ title: 'Acme Headphones One', url: 'https://store-c.com/p', price: 95, shipping: 15, currency: 'CAD', confirmed: true }]
  }, items, { env });
  assert.equal(result.bestOffer.landedPrice.value, 110);
  assert.equal(result.bestOffer.savings, -10);
});

test('search_deals explains itself when no provider is configured', async () => {
  const { result } = await executeTool('search_deals', { item_id: 'a' }, items, { env: {} });
  assert.deepEqual(result.results, []);
  assert.match(result.error, /TAVILY_API_KEY/);
});

test('search_deals verifies the top results against the live page', async () => {
  const html = `<html><head><title>Acme Headphones One</title>
    <script type="application/ld+json">{"@type":"Product","name":"Acme Headphones One","offers":{"@type":"Offer","price":"64.99","priceCurrency":"CAD","availability":"https://schema.org/InStock"}}</script>
    </head><body>Add to cart</body></html>`;

  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({
        results: [{ title: 'Acme Headphones One', url: 'https://store-d.example/p', content: 'On sale for $69.99' }]
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(html, { headers: { 'Content-Type': 'text/html' } });
  };

  const { result, actions } = await executeTool('search_deals', { item_id: 'a' }, items, {
    env: { TAVILY_API_KEY: 'test-key' },
    fetchImpl,
    lookup: async () => [{ address: '93.184.216.34' }]
  });

  assert.equal(result.provider, 'tavily');
  assert.equal(result.results[0].confirmed, true);
  assert.equal(result.results[0].price, 64.99);
  assert.equal(result.bestOffer.savings, 35.01);
  assert.equal(actions[0].type, 'offers');
});

test('unknown tools fail loudly instead of silently', async () => {
  const { result } = await executeTool('teleport_item', {}, items, { env });
  assert.match(result.error, /Unknown tool/);
});
