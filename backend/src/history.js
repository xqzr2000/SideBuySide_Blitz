import crypto from 'node:crypto';
import { categoryFromName, normalizeItems, tokenize, toNumber } from './items.js';
import { withNormalizedPrices } from './currency.js';
import { embedTexts, embeddingModel, l2Normalize, resolveEmbeddingProvider } from './embeddings.js';

export const EVENT_TYPES = ['added', 'viewed', 'cart', 'deal', 'removed'];

/** How much each interaction says about what the shopper actually wants. */
export const EVENT_WEIGHTS = {
  added: 1,
  viewed: 0.3,
  cart: 2.5,
  deal: 1.5,
  removed: -0.8
};

const HALF_LIFE_DAYS = 45;
const MAX_EVENTS_PER_RECORD = 24;

export function productKey(item) {
  const url = String(item?.url || '').trim().toLowerCase();
  if (url) {
    // Strip tracking noise so the same product re-added later lands on one record.
    const canonical = url.split('#')[0].replace(/([?&])(utm_[^&]+|gclid|fbclid|ref|tag)=[^&]*/g, '$1').replace(/[?&]+$/, '');
    return `u_${crypto.createHash('sha1').update(canonical).digest('hex').slice(0, 20)}`;
  }
  const id = String(item?.id || item?.name || '').trim().toLowerCase();
  return id ? `i_${crypto.createHash('sha1').update(id).digest('hex').slice(0, 20)}` : '';
}

/** The text that gets embedded. Keep it stable: any change re-embeds the record. */
export function describeItem(item) {
  const parts = [String(item.name || '').trim()];
  if (item.brand) parts.push(`Brand: ${item.brand}.`);
  const category = item.category || categoryFromName(item.name);
  if (category) parts.push(`Category: ${category}.`);
  if (item.site) parts.push(`Store: ${item.site}.`);
  if (item.seller && item.seller !== item.site) parts.push(`Seller: ${item.seller}.`);
  if (item.price !== null && item.price !== undefined && item.price !== '') {
    parts.push(`Price: ${item.price}${item.currency ? ` ${item.currency}` : ''}.`);
  }
  if (Array.isArray(item.tags) && item.tags.length) parts.push(`Tags: ${item.tags.join(', ')}.`);
  if (item.note) parts.push(String(item.note));
  return parts.filter(Boolean).join(' ').slice(0, 1200);
}

export function recencyWeight(at, now = Date.now()) {
  const stamp = at ? new Date(at).valueOf() : NaN;
  if (Number.isNaN(stamp)) return 0.5;
  const ageDays = Math.max(0, (now - stamp) / 86_400_000);
  return 0.5 ** (ageDays / HALF_LIFE_DAYS);
}

export function normalizeEvents(events = []) {
  return events
    .filter(Boolean)
    .map((event) => {
      const item = event.item || event.product || {};
      const type = EVENT_TYPES.includes(String(event.type)) ? String(event.type) : 'viewed';
      return {
        type,
        at: String(event.at || event.timestamp || '') || new Date().toISOString(),
        item: normalizeItems([{ ...item, id: item.id || event.itemId || '' }])[0] || null
      };
    })
    .filter((event) => event.item && (event.item.url || event.item.name !== 'Unnamed item'))
    .slice(-2000);
}

function mergeEvents(existing = [], incoming = []) {
  const seen = new Map();
  for (const event of [...existing, ...incoming]) {
    if (!event?.type || !event?.at) continue;
    seen.set(`${event.type}@${event.at}`, { type: event.type, at: event.at });
  }
  return [...seen.values()]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    .slice(-MAX_EVENTS_PER_RECORD);
}

/**
 * How much a product is wanted, in one number. A removal that was never reversed is
 * the loudest signal on a card: it dampens the earlier interest rather than being
 * averaged against it. Re-adding the product later makes that removal stale.
 */
export function engagementScore(record, now = Date.now()) {
  const events = record?.meta?.events || [];
  let positive = 0;
  let removalPressure = 0;

  for (const event of events) {
    const weight = EVENT_WEIGHTS[event.type] ?? 0;
    const recency = recencyWeight(event.at, now);
    if (weight > 0) positive += weight * recency;
    else if (weight < 0) removalPressure += Math.abs(weight) * recency;
  }
  if (record?.meta?.status === 'on_shelf') positive += 0.5 * recencyWeight(record.meta.lastSeen, now);

  const rejected = events.at(-1)?.type === 'removed';
  const score = rejected ? positive * 0.35 - 1.5 * removalPressure : positive - 0.3 * removalPressure;
  return Number(score.toFixed(4));
}

/**
 * Fold the extension's current shelf plus its append-only event log into the vector
 * store, embedding only the records whose text is new or whose vectors were dropped.
 */
export async function syncShelfHistory({ items = [], events = [], store, env = process.env, fetchImpl } = {}) {
  if (!store) throw new Error('syncShelfHistory needs a vector store.');

  const provider = resolveEmbeddingProvider(env);
  const signature = `${provider}:${embeddingModel(provider, env)}`;
  const invalidated = store.setSignature(signature);

  const now = new Date().toISOString();
  const currentItems = normalizeItems(items);
  const onShelfKeys = new Set();
  const staged = new Map();

  const stage = (item, event) => {
    const key = productKey(item);
    if (!key) return;
    const entry = staged.get(key) || { item, events: [] };
    // Later snapshots of the same product win, so prices stay current.
    entry.item = { ...entry.item, ...Object.fromEntries(Object.entries(item).filter(([, value]) => value !== '' && value !== null)) };
    if (event) entry.events.push(event);
    staged.set(key, entry);
  };

  for (const event of normalizeEvents(events)) stage(event.item, { type: event.type, at: event.at });
  for (const item of currentItems) {
    const key = productKey(item);
    if (key) onShelfKeys.add(key);
    // Reuse the stored timestamp when the card has none, so re-syncing the same
    // shelf does not log a fresh "added" event every time.
    const at = item.addedAt || (key && store.get(key)?.meta?.firstSeen) || now;
    stage(item, { type: 'added', at });
  }

  const pending = [];
  for (const [key, entry] of staged) {
    const existing = store.get(key);
    const mergedEvents = mergeEvents(existing?.meta?.events, entry.events);
    const text = describeItem(entry.item);
    const changed = !existing || existing.text !== text || !existing.vector?.length;
    const status = onShelfKeys.has(key) ? 'on_shelf' : 'past';
    const removedEvent = mergedEvents.filter((event) => event.type === 'removed').at(-1);

    const record = store.upsert({
      id: key,
      text,
      vector: changed ? null : existing.vector,
      meta: {
        itemId: entry.item.id || existing?.meta?.itemId || '',
        name: entry.item.name,
        brand: entry.item.brand,
        site: entry.item.site,
        seller: entry.item.seller,
        category: entry.item.category || categoryFromName(entry.item.name),
        price: entry.item.price,
        currency: entry.item.currency,
        rating: entry.item.rating,
        ratingCount: entry.item.ratingCount,
        url: entry.item.url,
        image: entry.item.image,
        tags: entry.item.tags,
        status,
        events: mergedEvents,
        addedCount: mergedEvents.filter((event) => event.type === 'added').length,
        removedAt: status === 'past' ? (removedEvent?.at || existing?.meta?.removedAt || null) : null,
        firstSeen: existing?.meta?.firstSeen || mergedEvents[0]?.at || now,
        lastSeen: mergedEvents.at(-1)?.at || now
      }
    });
    if (changed) pending.push(record);
  }

  // Anything the shelf dropped stays in memory, but it is no longer "on shelf".
  for (const record of store.all()) {
    if (record.meta?.status === 'on_shelf' && !onShelfKeys.has(record.id)) {
      store.upsert({ id: record.id, meta: { status: 'past', removedAt: record.meta.removedAt || now } });
    }
  }

  const toEmbed = store.missingVectors();
  let embedding = { provider, model: embeddingModel(provider, env), vectors: [] };
  if (toEmbed.length) {
    embedding = await embedTexts(toEmbed.map((record) => record.text), { env, fetchImpl });
    toEmbed.forEach((record, index) => {
      const vector = embedding.vectors[index];
      if (vector?.length) store.upsert({ id: record.id, vector });
    });
    if (embedding.provider !== provider) store.setSignature(`${embedding.provider}:${embedding.model}`);
  }

  await store.save();

  return {
    ...store.stats(),
    provider: embedding.provider || provider,
    model: embedding.model,
    embeddedNow: toEmbed.length,
    changed: pending.length,
    reindexed: invalidated,
    ...(embedding.error ? { embeddingError: embedding.error, degradedFrom: embedding.degradedFrom } : {})
  };
}

function centroid(records, weightOf) {
  let dimensions = 0;
  for (const record of records) dimensions = Math.max(dimensions, record.vector?.length || 0);
  if (!dimensions) return null;
  const sum = new Float64Array(dimensions);
  let total = 0;
  for (const record of records) {
    const weight = weightOf(record);
    if (!weight || !record.vector?.length) continue;
    total += Math.abs(weight);
    for (let index = 0; index < record.vector.length; index += 1) sum[index] += record.vector[index] * weight;
  }
  if (!total) return null;
  return l2Normalize(sum);
}

function tally(records, key, weightOf) {
  const counts = new Map();
  for (const record of records) {
    const value = String(record.meta?.[key] || '').trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + Math.max(0.1, weightOf(record)));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value, weight]) => ({ value, weight: Number(weight.toFixed(2)) }));
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Number(((sorted[middle - 1] + sorted[middle]) / 2).toFixed(2));
}

/**
 * Turn the indexed history into a taste profile: a positive centroid of what the
 * shopper engages with, a negative one for what they drop, plus readable stats.
 */
export function buildTasteProfile(store, { now = Date.now(), targetCurrency = '' } = {}) {
  const records = store.all().filter((record) => record.vector?.length);
  const scored = records.map((record) => ({ ...record, engagement: engagementScore(record, now) }));
  const liked = scored.filter((record) => record.engagement > 0);
  const dropped = scored.filter((record) => record.engagement <= 0);

  const priced = scored.filter((record) => toNumber(record.meta?.price) !== null);
  const normalized = withNormalizedPrices(
    priced.map((record) => ({ price: record.meta.price, currency: record.meta.currency })),
    targetCurrency
  );
  const byCategory = new Map();
  priced.forEach((record, index) => {
    const value = normalized.items[index]?.normalized?.value;
    if (value === null || value === undefined) return;
    const category = record.meta.category || 'other';
    if (!byCategory.has(category)) byCategory.set(category, []);
    byCategory.get(category).push(value);
  });

  const themeWeights = new Map();
  for (const record of liked) {
    for (const token of new Set(tokenize(record.meta?.name || ''))) {
      themeWeights.set(token, (themeWeights.get(token) || 0) + record.engagement);
    }
  }

  const allPrices = [...byCategory.values()].flat();

  return {
    vector: centroid(liked, (record) => record.engagement),
    negativeVector: dropped.length >= 2 ? centroid(dropped, (record) => Math.abs(record.engagement) || 0.5) : null,
    indexedProducts: records.length,
    engagedProducts: liked.length,
    droppedProducts: dropped.length,
    topBrands: tally(liked, 'brand', (record) => record.engagement),
    topCategories: tally(liked, 'category', (record) => record.engagement),
    topStores: tally(liked, 'site', (record) => record.engagement),
    themes: [...themeWeights.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([token]) => token),
    priceByCategory: [...byCategory.entries()].map(([category, values]) => ({
      category,
      count: values.length,
      min: Math.min(...values),
      median: median(values),
      max: Math.max(...values),
      currency: normalized.targetCurrency
    })),
    typicalSpend: allPrices.length
      ? { median: median(allPrices), min: Math.min(...allPrices), max: Math.max(...allPrices), currency: normalized.targetCurrency }
      : null,
    signals: {
      cartClicks: scored.filter((record) => (record.meta?.events || []).some((event) => event.type === 'cart')).length,
      dealChecks: scored.filter((record) => (record.meta?.events || []).some((event) => event.type === 'deal')).length,
      repeatAdds: scored.filter((record) => (record.meta?.addedCount || 0) > 1).length
    },
    strength: liked.length >= 8 ? 'good' : liked.length >= 3 ? 'thin' : 'insufficient',
    rateDisclaimer: normalized.rateDisclaimer
  };
}
