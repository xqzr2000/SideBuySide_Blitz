const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'new', 'buy', 'shop', 'online', 'official', 'store',
  'free', 'shipping', 'sale', 'deal', 'best', 'from', 'size', 'color', 'colour', 'pack'
]);

export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toStringList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(list.map((entry) => String(entry).trim()).filter(Boolean))].slice(0, 12);
}

export function categoryFromName(name) {
  const text = String(name).toLowerCase();
  const categories = [
    ['electronics', ['laptop', 'phone', 'tablet', 'headphone', 'earbud', 'monitor', 'keyboard', 'mouse', 'camera', 'tv', 'speaker', 'console', 'router', 'ssd']],
    ['clothing', ['shirt', 'jacket', 'dress', 'jean', 'pant', 'shoe', 'sneaker', 'hoodie', 'coat', 'sock', 'hat']],
    ['home', ['chair', 'desk', 'lamp', 'sofa', 'mattress', 'pillow', 'table', 'vacuum', 'blender', 'kettle', 'cookware']],
    ['beauty', ['cream', 'serum', 'shampoo', 'makeup', 'lipstick', 'fragrance', 'perfume', 'sunscreen']],
    ['food', ['coffee', 'tea', 'snack', 'chocolate', 'protein', 'grocery', 'cereal']],
    ['fitness', ['dumbbell', 'treadmill', 'yoga', 'bike', 'running', 'barbell', 'kettlebell']]
  ];
  for (const [category, words] of categories) {
    if (words.some((word) => text.includes(word))) return category;
  }
  return 'other';
}

export function priceBand(price) {
  if (price === null) return 'Price unknown';
  if (price < 25) return 'Under 25';
  if (price < 100) return '25–99';
  if (price < 500) return '100–499';
  return '500+';
}

export function normalizeItems(items = []) {
  return items
    .filter(Boolean)
    .map((item) => {
      const name = String(item.name || 'Unnamed item');
      return {
        id: String(item.id || ''),
        name,
        price: toNumber(item.price),
        currency: String(item.currency || '').toUpperCase(),
        url: String(item.url || ''),
        image: String(item.image || ''),
        brand: String(item.brand || ''),
        availability: String(item.availability || ''),
        rating: toNumber(item.rating),
        ratingCount: toNumber(item.ratingCount),
        seller: String(item.seller || ''),
        sku: String(item.sku || ''),
        site: String(item.site || ''),
        tags: toStringList(item.tags),
        note: String(item.note || ''),
        category: String(item.category || '') || categoryFromName(name),
        addedAt: String(item.addedAt || '')
      };
    })
    .slice(0, 100);
}

export function pickItems(items, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return items;
  const wanted = new Set(ids.map(String));
  return items.filter((item) => wanted.has(item.id));
}

export function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Jaccard overlap of name tokens, nudged by matching brand and model-ish tokens. */
export function similarity(a, b) {
  const left = new Set(tokenize(a?.name));
  const right = new Set(tokenize(b?.name));
  if (!left.size || !right.size) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  let score = shared / (left.size + right.size - shared);

  const sameSku = a?.sku && b?.sku && a.sku.toLowerCase() === b.sku.toLowerCase();
  if (sameSku) return 1;

  const brandA = String(a?.brand || '').toLowerCase();
  const brandB = String(b?.brand || '').toLowerCase();
  if (brandA && brandA === brandB) score += 0.1;

  // Model numbers ("xm5", "m3", "wh1000") are strong identity signals.
  const modelish = (set) => [...set].filter((token) => /\d/.test(token));
  const modelsA = modelish(left);
  const modelsB = modelish(right);
  if (modelsA.length && modelsB.length && modelsA.some((token) => modelsB.includes(token))) score += 0.15;

  return Math.min(1, Number(score.toFixed(3)));
}

/** Cluster items that look like the same product saved from different stores. */
export function findDuplicateGroups(items, threshold = 0.55) {
  const clusters = [];
  for (const item of items) {
    const match = clusters.find((cluster) => cluster.some((member) => similarity(member, item) >= threshold));
    if (match) match.push(item);
    else clusters.push([item]);
  }
  return clusters.filter((cluster) => cluster.length > 1);
}
