import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../src/tools.js';
import { VectorStore } from '../src/vectorstore.js';
import { syncShelfHistory } from '../src/history.js';

const env = {};

function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const events = [
  { type: 'added', at: daysAgo(30), item: { id: '1', name: 'Sony WH-1000XM5 Wireless Headphones', brand: 'Sony', price: 449, currency: 'CAD', site: 'store-a.com', url: 'https://store-a.com/xm5' } },
  { type: 'cart', at: daysAgo(29), item: { id: '1', name: 'Sony WH-1000XM5 Wireless Headphones', brand: 'Sony', price: 449, currency: 'CAD', site: 'store-a.com', url: 'https://store-a.com/xm5' } },
  { type: 'added', at: daysAgo(22), item: { id: '2', name: 'Sony WH-CH720N Wireless Headphones', brand: 'Sony', price: 179, currency: 'CAD', site: 'store-a.com', url: 'https://store-a.com/ch720' } },
  { type: 'added', at: daysAgo(20), item: { id: '3', name: 'Bose QuietComfort Wireless Headphones', brand: 'Bose', price: 399, currency: 'CAD', site: 'store-b.com', url: 'https://store-b.com/qc' } },
  { type: 'removed', at: daysAgo(19), item: { id: '3', name: 'Bose QuietComfort Wireless Headphones', brand: 'Bose', price: 399, currency: 'CAD', site: 'store-b.com', url: 'https://store-b.com/qc' } },
  { type: 'added', at: daysAgo(6), item: { id: '4', name: 'Ceramic Table Lamp', brand: 'Hay', price: 120, currency: 'CAD', site: 'store-c.com', url: 'https://store-c.com/lamp' } }
];

const shelf = [
  { id: '5', name: 'Sony WF-1000XM5 Wireless Earbuds', brand: 'Sony', price: 329, currency: 'CAD', site: 'store-a.com', url: 'https://store-a.com/wf', addedAt: daysAgo(2) }
];

async function storeWithHistory() {
  const store = new VectorStore({ file: null });
  await syncShelfHistory({ items: shelf, events, store, env });
  return store;
}

test('search_history finds past products the shelf no longer holds', async () => {
  const store = await storeWithHistory();
  const { result } = await executeTool('search_history', { query: 'wireless headphones', top_k: 5 }, shelf, { env, store });

  assert.equal(result.indexed, 5);
  assert.ok(result.results.length >= 3);
  assert.ok(result.results.every((entry) => entry.score > 0));
  const names = result.results.map((entry) => entry.name);
  assert.ok(names.some((name) => /WH-1000XM5/.test(name)));
  assert.ok(!names.includes('Ceramic Table Lamp') || result.results.at(-1).name === 'Ceramic Table Lamp');
});

test('search_history filters by status and brand', async () => {
  const store = await storeWithHistory();
  const onShelf = await executeTool('search_history', { query: 'headphones', status: 'on_shelf' }, shelf, { env, store });
  assert.deepEqual(onShelf.result.results.map((entry) => entry.name), ['Sony WF-1000XM5 Wireless Earbuds']);

  const bose = await executeTool('search_history', { query: 'headphones', brand: 'Bose' }, shelf, { env, store });
  assert.equal(bose.result.results.length, 1);
  assert.equal(bose.result.results[0].status, 'past');
  assert.deepEqual(bose.result.results[0].interactions, { added: 1, removed: 1 });
});

test('search_history says so when the index is empty', async () => {
  const { result } = await executeTool('search_history', { query: 'anything' }, [], { env, store: new VectorStore({ file: null }) });
  assert.equal(result.indexed, 0);
  assert.match(result.note, /empty/i);
});

test('similar_items finds neighbours of a saved card and excludes itself', async () => {
  const store = await storeWithHistory();
  const { result } = await executeTool('similar_items', { item_id: '5', top_k: 3 }, shelf, { env, store });
  assert.equal(result.subject, 'Sony WF-1000XM5 Wireless Earbuds');
  assert.ok(result.results.length >= 2);
  assert.ok(!result.results.some((entry) => entry.name === 'Sony WF-1000XM5 Wireless Earbuds'));
  assert.match(result.results[0].name, /Sony/);
});

test('similar_items accepts free text and rejects an empty request', async () => {
  const store = await storeWithHistory();
  const byText = await executeTool('similar_items', { text: 'ceramic lamp for the living room' }, shelf, { env, store });
  assert.equal(byText.result.results[0].name, 'Ceramic Table Lamp');

  const empty = await executeTool('similar_items', {}, shelf, { env, store });
  assert.match(empty.result.error, /item_id or text/);
});

test('taste_profile reports preferences without leaking raw vectors', async () => {
  const store = await storeWithHistory();
  const { result } = await executeTool('taste_profile', { target_currency: 'CAD' }, shelf, { env, store });

  assert.equal(result.vector, undefined);
  assert.equal(result.negativeVector, undefined);
  assert.equal(result.topBrands[0].value, 'Sony');
  assert.equal(result.topCategories[0].value, 'electronics');
  assert.equal(result.signals.cartClicks, 1);
  assert.equal(result.typicalSpend.currency, 'CAD');
  assert.equal(result.embedding.provider, 'local');
});

test('recommend_products ranks past items against the profile and explains why', async () => {
  const store = await storeWithHistory();
  const { result, actions } = await executeTool('recommend_products', { top_k: 3 }, shelf, { env, store });

  assert.ok(result.recommendations.length > 0);
  assert.ok(result.recommendations.every((entry) => entry.source === 'history'));
  assert.ok(!result.recommendations.some((entry) => entry.status === 'on_shelf'));
  assert.ok(result.recommendations[0].becauseYouSaved.length > 0);
  assert.equal(result.basis.topBrands[0], 'Sony');
  assert.equal(actions[0].type, 'recommendations');
  assert.ok(actions[0].items[0].becauseYouSaved.length > 0);
});

test('recommend_products honours a budget and a category filter', async () => {
  const store = await storeWithHistory();
  const { result } = await executeTool('recommend_products', {
    category: 'electronics',
    max_price: 200,
    target_currency: 'CAD',
    top_k: 5
  }, shelf, { env, store });

  assert.ok(result.recommendations.length > 0);
  assert.ok(result.recommendations.every((entry) => entry.category === 'electronics'));
  assert.ok(result.recommendations.every((entry) => entry.price === null || entry.price <= 200));
});

test('recommend_products pushes a rejected product down the ranking', async () => {
  const store = await storeWithHistory();
  const { result } = await executeTool('recommend_products', { query: 'wireless headphones', top_k: 5 }, shelf, { env, store });
  const names = result.recommendations.map((entry) => entry.name);
  const bose = names.findIndex((name) => /Bose/.test(name));
  const sony = names.findIndex((name) => /WH-1000XM5/.test(name));
  assert.ok(sony > -1);
  assert.ok(bose === -1 || sony < bose, `expected the carted Sony to outrank the removed Bose: ${names.join(', ')}`);
});

test('recommend_products blends web candidates and drops ones already in memory', async () => {
  const store = await storeWithHistory();
  const fetchImpl = async (url) => {
    if (url.startsWith('https://api.tavily.com')) {
      return new Response(JSON.stringify({
        results: [
          { title: 'Sony WH-1000XM6 Wireless Headphones', url: 'https://store-d.example/xm6', content: 'New release, $499.99' },
          { title: 'Sony WH-1000XM5 Wireless Headphones', url: 'https://store-a.com/xm5', content: 'Already saved, $449' }
        ]
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error('unexpected fetch');
  };

  const { result } = await executeTool('recommend_products', { query: 'wireless headphones', include_web: true, top_k: 5 }, shelf, {
    env: { TAVILY_API_KEY: 'k' },
    fetchImpl,
    store
  });

  assert.equal(result.fromWeb.length, 1);
  assert.equal(result.fromWeb[0].url, 'https://store-d.example/xm6');
  assert.equal(result.fromWeb[0].priceConfirmed, false);
  assert.ok(result.recommendations.some((entry) => entry.source === 'web'));
  assert.match(result.note, /unconfirmed/);
});

test('recommend_products explains itself when web search is off', async () => {
  const store = await storeWithHistory();
  const { result } = await executeTool('recommend_products', { include_web: true }, shelf, { env: {}, store });
  assert.match(result.webError, /TAVILY_API_KEY/);
  assert.equal(result.fromWeb.length, 0);
});

test('recommend_products asks for direction when there is no history at all', async () => {
  const { result } = await executeTool('recommend_products', {}, [], { env, store: new VectorStore({ file: null }) });
  assert.deepEqual(result.recommendations, []);
  assert.match(result.note, /no usable history/i);
});
