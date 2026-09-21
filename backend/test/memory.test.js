import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { clearEmbeddingCache, cosineSimilarity, embedTexts, embeddingStatus, localEmbed, resolveEmbeddingProvider } from '../src/embeddings.js';
import { VectorStore } from '../src/vectorstore.js';
import { buildTasteProfile, describeItem, engagementScore, productKey, syncShelfHistory } from '../src/history.js';

const env = {};

function daysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const history = [
  { type: 'added', at: daysAgo(30), item: { id: '1', name: 'Sony WH-1000XM5 Wireless Headphones', brand: 'Sony', price: 449, currency: 'CAD', site: 'store-a.com', url: 'https://store-a.com/xm5' } },
  { type: 'cart', at: daysAgo(29), item: { id: '1', name: 'Sony WH-1000XM5 Wireless Headphones', brand: 'Sony', price: 449, currency: 'CAD', site: 'store-a.com', url: 'https://store-a.com/xm5' } },
  { type: 'added', at: daysAgo(20), item: { id: '2', name: 'Bose QuietComfort Wireless Headphones', brand: 'Bose', price: 399, currency: 'CAD', site: 'store-b.com', url: 'https://store-b.com/qc' } },
  { type: 'removed', at: daysAgo(19), item: { id: '2', name: 'Bose QuietComfort Wireless Headphones', brand: 'Bose', price: 399, currency: 'CAD', site: 'store-b.com', url: 'https://store-b.com/qc' } },
  { type: 'added', at: daysAgo(5), item: { id: '3', name: 'Ceramic Table Lamp', brand: 'Hay', price: 120, currency: 'CAD', site: 'store-c.com', url: 'https://store-c.com/lamp' } }
];

const shelf = [
  { id: '4', name: 'Sony WF-1000XM5 Wireless Earbuds', brand: 'Sony', price: 329, currency: 'CAD', site: 'store-a.com', url: 'https://store-a.com/wf', addedAt: daysAgo(2) }
];

async function freshStore() {
  const store = new VectorStore({ file: null });
  await syncShelfHistory({ items: shelf, events: history, store, env });
  return store;
}

test('localEmbed is deterministic, normalized, and ranks related products together', () => {
  const a = localEmbed('Sony WH-1000XM5 Wireless Headphones');
  const b = localEmbed('Sony WH-1000XM5 Wireless Headphones');
  assert.deepEqual(a, b);
  assert.ok(Math.abs(Math.sqrt(a.reduce((sum, value) => sum + value * value, 0)) - 1) < 1e-9);

  const related = cosineSimilarity(a, localEmbed('Sony WH-1000XM4 Wireless Headphones'));
  const unrelated = cosineSimilarity(a, localEmbed('Ceramic Table Lamp'));
  assert.ok(related > unrelated, `${related} should beat ${unrelated}`);
});

test('embedTexts uses the offline encoder when no key is configured', async () => {
  const result = await embedTexts(['hello shelf'], { env: {} });
  assert.equal(result.provider, 'local');
  assert.equal(result.dimensions, 256);
  assert.equal(embeddingStatus({}).semantic, false);
  assert.equal(resolveEmbeddingProvider({ OPENAI_API_KEY: 'k' }), 'openai');
});

test('embedTexts calls a hosted provider and normalizes what it returns', async () => {
  clearEmbeddingCache();
  let body = null;
  const fetchImpl = async (url, options) => {
    body = JSON.parse(options.body);
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    return new Response(JSON.stringify({ data: [{ embedding: [3, 4] }, { embedding: [0, 2] }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const result = await embedTexts(['one', 'two'], { env: { OPENAI_API_KEY: 'k' }, fetchImpl });
  assert.equal(result.provider, 'openai');
  assert.equal(body.model, 'text-embedding-3-small');
  assert.deepEqual(result.vectors[0], [0.6, 0.8]);
  assert.deepEqual(result.vectors[1], [0, 1]);
});

test('embedTexts falls back to the offline encoder when the provider fails', async () => {
  clearEmbeddingCache();
  const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 });
  const result = await embedTexts(['one'], { env: { OPENAI_API_KEY: 'nope' }, fetchImpl });
  assert.equal(result.provider, 'local');
  assert.equal(result.degradedFrom, 'openai');
  assert.match(result.error, /bad key/);
});

test('productKey ignores tracking parameters and fragments', () => {
  const base = productKey({ url: 'https://store-a.com/xm5' });
  assert.equal(productKey({ url: 'https://store-a.com/xm5?utm_source=email' }), base);
  assert.equal(productKey({ url: 'https://store-a.com/xm5#reviews' }), base);
  assert.notEqual(productKey({ url: 'https://store-a.com/other' }), base);
  assert.equal(productKey({}), '');
});

test('describeItem builds stable embedding text from the card', () => {
  const text = describeItem({ name: 'Lamp', brand: 'Hay', category: 'home', site: 'store-c.com', price: 120, currency: 'CAD', tags: ['finalist'] });
  assert.match(text, /Brand: Hay/);
  assert.match(text, /Category: home/);
  assert.match(text, /Price: 120 CAD/);
  assert.match(text, /Tags: finalist/);
});

test('syncShelfHistory indexes current and removed products with their events', async () => {
  const store = await freshStore();
  const stats = store.stats();
  assert.equal(stats.records, 4);
  assert.equal(stats.embedded, 4);
  assert.equal(stats.onShelf, 1);
  assert.equal(stats.pastItems, 3);

  const bose = store.get(productKey({ url: 'https://store-b.com/qc' }));
  assert.equal(bose.meta.status, 'past');
  assert.deepEqual(bose.meta.events.map((event) => event.type), ['added', 'removed']);

  const sony = store.get(productKey({ url: 'https://store-a.com/xm5' }));
  assert.ok(sony.meta.events.some((event) => event.type === 'cart'));
});

test('syncShelfHistory only re-embeds what changed', async () => {
  const store = await freshStore();
  const second = await syncShelfHistory({ items: shelf, events: history, store, env });
  assert.equal(second.embeddedNow, 0);

  const updated = await syncShelfHistory({
    items: [{ ...shelf[0], price: 299 }],
    events: history,
    store,
    env
  });
  assert.equal(updated.embeddedNow, 1);
});

test('a card dropped from the shelf stays in memory as a past item', async () => {
  const store = await freshStore();
  await syncShelfHistory({ items: [], events: [], store, env });
  const record = store.get(productKey({ url: 'https://store-a.com/wf' }));
  assert.equal(record.meta.status, 'past');
  assert.ok(record.meta.removedAt);
  assert.equal(store.size, 4);
});

test('changing embedding provider drops vectors and re-embeds on the next sync', async () => {
  const store = await freshStore();
  const signature = store.signature;
  const result = await syncShelfHistory({
    items: shelf,
    events: history,
    store,
    env: { EMBEDDING_PROVIDER: 'local', EMBEDDING_MODEL: 'other-model' }
  });
  assert.notEqual(store.signature, signature);
  assert.equal(result.reindexed, true);
  assert.equal(result.embeddedNow, 4);
  assert.equal(store.missingVectors().length, 0);
});

test('engagementScore rewards carting and penalizes removal', async () => {
  const store = await freshStore();
  const sony = store.get(productKey({ url: 'https://store-a.com/xm5' }));
  const bose = store.get(productKey({ url: 'https://store-b.com/qc' }));
  assert.ok(engagementScore(sony) > 1);
  assert.ok(engagementScore(bose) < 0);
});

test('buildTasteProfile summarizes brands, categories, and spend', async () => {
  const store = await freshStore();
  const profile = buildTasteProfile(store, { targetCurrency: 'CAD' });
  assert.equal(profile.topBrands[0].value, 'Sony');
  assert.equal(profile.topCategories[0].value, 'electronics');
  assert.equal(profile.signals.cartClicks, 1);
  assert.equal(profile.droppedProducts, 1);
  assert.ok(profile.vector.length > 0);
  assert.equal(profile.typicalSpend.currency, 'CAD');
  assert.equal(profile.strength, 'thin');
});

test('VectorStore query filters, ranks, and can diversify', async () => {
  const store = new VectorStore({ file: null });
  store.upsert({ id: 'a', text: 'a', vector: [1, 0], meta: { status: 'past', category: 'electronics' } });
  store.upsert({ id: 'b', text: 'b', vector: [0.95, 0.31], meta: { status: 'past', category: 'electronics' } });
  store.upsert({ id: 'c', text: 'c', vector: [0, 1], meta: { status: 'on_shelf', category: 'home' } });

  const ranked = store.query([1, 0], { topK: 3 });
  assert.deepEqual(ranked.map((record) => record.id), ['a', 'b', 'c']);
  assert.equal(ranked[0].score, 1);

  const filtered = store.query([1, 0], { topK: 3, filter: (record) => record.meta.status === 'on_shelf' });
  assert.deepEqual(filtered.map((record) => record.id), ['c']);

  const excluded = store.query([1, 0], { topK: 2, exclude: ['a'] });
  assert.deepEqual(excluded.map((record) => record.id), ['b', 'c']);

  const diverse = store.query([1, 0], { topK: 2, mmr: 0.2 });
  assert.deepEqual(diverse.map((record) => record.id), ['a', 'c']);
});

test('VectorStore persists to disk and reloads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbs-vectors-'));
  const file = path.join(dir, 'nested', 'vectors.json');
  try {
    const store = new VectorStore({ file });
    await store.load();
    await syncShelfHistory({ items: shelf, events: history, store, env });
    await store.save();

    const reopened = await new VectorStore({ file }).load();
    assert.equal(reopened.size, 4);
    assert.equal(reopened.signature, store.signature);
    assert.equal(reopened.missingVectors().length, 0);
    assert.equal(reopened.stats().onShelf, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('VectorStore survives a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbs-vectors-'));
  const file = path.join(dir, 'vectors.json');
  try {
    await fs.writeFile(file, '{ not json', 'utf8');
    const store = await new VectorStore({ file }).load();
    assert.equal(store.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('re-syncing a shelf card without an addedAt does not log a new event each time', async () => {
  const store = new VectorStore({ file: null });
  const undated = [{ id: '9', name: 'Wool Blanket', url: 'https://store-d.com/blanket', price: 80, currency: 'CAD' }];
  await syncShelfHistory({ items: undated, events: [], store, env });
  await syncShelfHistory({ items: undated, events: [], store, env });
  await syncShelfHistory({ items: undated, events: [], store, env });

  const record = store.get(productKey(undated[0]));
  assert.equal(record.meta.events.length, 1);
  assert.equal(record.meta.addedCount, 1);
});
