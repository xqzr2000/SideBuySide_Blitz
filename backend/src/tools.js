function money(value, currency = '') {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return { value: n, currency: currency || '' };
}

export function normalizeItems(items = []) {
  return items
    .filter(Boolean)
    .map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || 'Unnamed item'),
      price: item.price === null || item.price === undefined || item.price === '' ? null : (Number.isFinite(Number(item.price)) ? Number(item.price) : null),
      currency: String(item.currency || ''),
      url: String(item.url || ''),
      image: String(item.image || ''),
      brand: String(item.brand || ''),
      availability: String(item.availability || ''),
      rating: item.rating === null || item.rating === undefined || item.rating === '' ? null : (Number.isFinite(Number(item.rating)) ? Number(item.rating) : null),
      ratingCount: item.ratingCount === null || item.ratingCount === undefined || item.ratingCount === '' ? null : (Number.isFinite(Number(item.ratingCount)) ? Number(item.ratingCount) : null),
      seller: String(item.seller || ''),
      site: String(item.site || ''),
      addedAt: String(item.addedAt || '')
    }))
    .slice(0, 100);
}

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_items',
      description: 'Inspect the shopping items currently saved in SideBuySide.',
      parameters: {
        type: 'object',
        properties: {
          sort_by: {
            type: 'string',
            enum: ['added', 'price_low', 'price_high', 'name'],
            description: 'Optional sort order.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compare_items',
      description: 'Compare selected saved items across price and available product metadata.',
      parameters: {
        type: 'object',
        properties: {
          item_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs to compare. Omit to compare all items.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'price_summary',
      description: 'Calculate price statistics for the saved items with known prices.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'organize_items',
      description: 'Create a suggested organization of cards by store, brand, price band, or category clues in the item names.',
      parameters: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            enum: ['store', 'brand', 'price_band', 'category'],
            description: 'How to group the items.'
          }
        },
        required: ['strategy']
      }
    }
  }
];

function pickItems(items, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return items;
  const wanted = new Set(ids.map(String));
  return items.filter((item) => wanted.has(item.id));
}

function categoryFromName(name) {
  const text = String(name).toLowerCase();
  const categories = [
    ['electronics', ['laptop', 'phone', 'tablet', 'headphone', 'earbud', 'monitor', 'keyboard', 'mouse', 'camera', 'tv']],
    ['clothing', ['shirt', 'jacket', 'dress', 'jean', 'pant', 'shoe', 'sneaker', 'hoodie', 'coat']],
    ['home', ['chair', 'desk', 'lamp', 'sofa', 'mattress', 'pillow', 'table', 'vacuum']],
    ['beauty', ['cream', 'serum', 'shampoo', 'makeup', 'lipstick', 'fragrance', 'perfume']],
    ['food', ['coffee', 'tea', 'snack', 'chocolate', 'protein', 'grocery']]
  ];
  for (const [category, words] of categories) {
    if (words.some((word) => text.includes(word))) return category;
  }
  return 'other';
}

export function executeTool(name, args = {}, rawItems = []) {
  const items = normalizeItems(rawItems);

  if (name === 'list_items') {
    const sorted = [...items];
    if (args.sort_by === 'price_low') sorted.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    if (args.sort_by === 'price_high') sorted.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
    if (args.sort_by === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
    if (args.sort_by === 'added') sorted.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
    return { count: sorted.length, items: sorted };
  }

  if (name === 'compare_items') {
    const selected = pickItems(items, args.item_ids);
    const known = selected.filter((item) => item.price !== null);
    const cheapest = known.length ? known.reduce((a, b) => (a.price <= b.price ? a : b)) : null;
    const mostExpensive = known.length ? known.reduce((a, b) => (a.price >= b.price ? a : b)) : null;
    return {
      count: selected.length,
      items: selected,
      priceRange: known.length
        ? {
            min: money(cheapest.price, cheapest.currency),
            max: money(mostExpensive.price, mostExpensive.currency)
          }
        : null,
      note: 'Prices may use different currencies; do not compare numeric values across currencies without calling that limitation out.'
    };
  }

  if (name === 'price_summary') {
    const groups = new Map();
    for (const item of items.filter((item) => item.price !== null)) {
      const currency = item.currency || 'UNKNOWN';
      if (!groups.has(currency)) groups.set(currency, []);
      groups.get(currency).push(item);
    }
    return {
      currencies: [...groups.entries()].map(([currency, group]) => {
        const prices = group.map((item) => item.price);
        return {
          currency,
          count: group.length,
          total: prices.reduce((a, b) => a + b, 0),
          average: prices.reduce((a, b) => a + b, 0) / prices.length,
          min: Math.min(...prices),
          max: Math.max(...prices)
        };
      })
    };
  }

  if (name === 'organize_items') {
    const strategy = args.strategy || 'store';
    const groups = {};
    for (const item of items) {
      let key = 'Other';
      if (strategy === 'store') key = item.site || item.seller || 'Unknown store';
      if (strategy === 'brand') key = item.brand || 'Unknown brand';
      if (strategy === 'price_band') {
        if (item.price === null) key = 'Price unknown';
        else if (item.price < 25) key = 'Under 25';
        else if (item.price < 100) key = '25–99';
        else if (item.price < 500) key = '100–499';
        else key = '500+';
      }
      if (strategy === 'category') key = categoryFromName(item.name);
      groups[key] ||= [];
      groups[key].push(item.id);
    }
    return { strategy, groups, suggestedOrder: Object.values(groups).flat() };
  }

  return { error: `Unknown tool: ${name}` };
}
