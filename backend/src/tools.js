import {
  categoryFromName,
  findDuplicateGroups,
  normalizeItems,
  pickItems,
  priceBand,
  similarity,
  toNumber
} from './items.js';
import { convert, loadRates, withNormalizedPrices } from './currency.js';
import { fetchOffer } from './offers.js';
import { searchStatus, searchWeb } from './search.js';

export { normalizeItems };

const CURRENCY_ENUM = ['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'JPY', 'CNY', 'INR', 'KRW', 'NZD', 'CHF', 'MXN', 'BRL', 'SGD', 'HKD'];

export const toolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'list_items',
      description: 'Inspect, filter, and sort the shopping items currently saved on the Side Shelf. Always call this before answering anything that depends on what is saved.',
      parameters: {
        type: 'object',
        properties: {
          sort_by: {
            type: 'string',
            enum: ['added', 'price_low', 'price_high', 'name', 'rating', 'value'],
            description: 'Sort order. "value" ranks rating per unit of price and skips items missing either field.'
          },
          query: { type: 'string', description: 'Free-text filter matched against name, brand, seller, tags, and store.' },
          site: { type: 'string', description: 'Only items from this store hostname.' },
          brand: { type: 'string', description: 'Only items from this brand.' },
          category: { type: 'string', description: 'Only items in this inferred category (electronics, clothing, home, beauty, food, fitness, other).' },
          tag: { type: 'string', description: 'Only items carrying this tag.' },
          min_price: { type: 'number', description: 'Minimum price, in each item\'s own currency.' },
          max_price: { type: 'number', description: 'Maximum price, in each item\'s own currency.' },
          has_price: { type: 'boolean', description: 'When true, only items whose price is known.' },
          target_currency: { type: 'string', enum: CURRENCY_ENUM, description: 'Also report each price converted to this currency.' },
          limit: { type: 'integer', description: 'Maximum number of items to return (default 50).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compare_items',
      description: 'Build an attribute-by-attribute comparison of saved items: normalized prices, per-attribute winners, price gaps, and exactly which facts are missing.',
      parameters: {
        type: 'object',
        properties: {
          item_ids: { type: 'array', items: { type: 'string' }, description: 'IDs to compare. Omit to compare every saved item.' },
          target_currency: { type: 'string', enum: CURRENCY_ENUM, description: 'Currency to normalize prices into before comparing.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'price_summary',
      description: 'Price statistics for the saved items with known prices, per currency plus an approximate combined total.',
      parameters: {
        type: 'object',
        properties: {
          target_currency: { type: 'string', enum: CURRENCY_ENUM, description: 'Currency for the combined total.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'organize_items',
      description: 'Group and reorder the shelf by store, brand, price band, category, value, rating, recency, or duplicate clusters. Reorders the real cards unless apply is false.',
      parameters: {
        type: 'object',
        properties: {
          strategy: {
            type: 'string',
            enum: ['store', 'brand', 'price_band', 'category', 'value', 'rating', 'recency', 'duplicates'],
            description: 'How to group the items.'
          },
          target_currency: { type: 'string', enum: CURRENCY_ENUM, description: 'Currency used when grouping or sorting by price.' },
          apply: { type: 'boolean', description: 'Default true. Set false to propose an arrangement without moving the cards.' }
        },
        required: ['strategy']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'find_duplicates',
      description: 'Detect saved cards that look like the same product from different stores, and show the price spread within each cluster.',
      parameters: {
        type: 'object',
        properties: {
          threshold: { type: 'number', description: 'Similarity threshold between 0 and 1 (default 0.55). Raise it for stricter matching.' },
          target_currency: { type: 'string', enum: CURRENCY_ENUM, description: 'Currency used to compare prices inside a cluster.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'rank_items',
      description: 'Score saved items on a weighted blend of price, rating, review volume, and availability, with a per-item breakdown of why it scored that way.',
      parameters: {
        type: 'object',
        properties: {
          item_ids: { type: 'array', items: { type: 'string' }, description: 'IDs to rank. Omit to rank every saved item.' },
          weights: {
            type: 'object',
            description: 'Relative importance, each 0-1. Defaults: price 0.4, rating 0.3, popularity 0.2, availability 0.1.',
            properties: {
              price: { type: 'number' },
              rating: { type: 'number' },
              popularity: { type: 'number' },
              availability: { type: 'number' }
            }
          },
          target_currency: { type: 'string', enum: CURRENCY_ENUM, description: 'Currency used to compare prices.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tag_items',
      description: 'Label saved cards with short tags and an optional note so the shelf stays organized between chats.',
      parameters: {
        type: 'object',
        properties: {
          updates: {
            type: 'array',
            description: 'One entry per card to label.',
            items: {
              type: 'object',
              properties: {
                item_id: { type: 'string' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Short labels, e.g. "finalist", "too pricey".' },
                note: { type: 'string', description: 'One-line note shown on the card.' },
                mode: { type: 'string', enum: ['replace', 'add'], description: 'Default "add".' }
              },
              required: ['item_id']
            }
          }
        },
        required: ['updates']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_deals',
      description: 'Search the internet for cheaper listings of a saved item (pass item_id) or of any product (pass query). Returns candidate offers with prices when the provider or snippet exposes them.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'Saved item to hunt a better price for. The query is built from its name and brand.' },
          query: { type: 'string', description: 'Search text. Required when item_id is omitted; refines the query when both are given.' },
          max_results: { type: 'integer', description: 'How many results to return, 1-10 (default 6).' },
          include_sites: { type: 'array', items: { type: 'string' }, description: 'Restrict to these store hostnames.' },
          exclude_sites: { type: 'array', items: { type: 'string' }, description: 'Hostnames to leave out.' },
          verify: { type: 'boolean', description: 'Default true. Opens the top results server-side to confirm the listed price instead of trusting the snippet.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fetch_offer',
      description: 'Open one public product URL and read its real price, availability, rating, and seller from the page itself. Use this to confirm a deal before recommending it.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The public product page URL.' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'evaluate_deal',
      description: 'Compare candidate offers against a saved item: savings in money and percent, ranked best-first, with the caveats that would make the deal worse than it looks.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'The saved item the offers are alternatives to.' },
          offers: {
            type: 'array',
            description: 'Offers gathered from search_deals or fetch_offer.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                site: { type: 'string' },
                price: { type: 'number' },
                currency: { type: 'string' },
                shipping: { type: 'number', description: 'Shipping cost in the same currency, if known.' },
                availability: { type: 'string' },
                confirmed: { type: 'boolean', description: 'True only if the price came from fetch_offer or the search provider, not a guess.' }
              },
              required: ['url']
            }
          },
          target_currency: { type: 'string', enum: CURRENCY_ENUM, description: 'Currency for the savings math.' }
        },
        required: ['item_id', 'offers']
      }
    }
  }
];

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function normalizedValue(entry) {
  return entry?.normalized?.value ?? null;
}

function shelfItemSummary(item) {
  return {
    id: item.id,
    name: item.name,
    price: item.price,
    currency: item.currency,
    site: item.site,
    brand: item.brand,
    url: item.url
  };
}

function missingFields(items) {
  const fields = ['price', 'rating', 'ratingCount', 'brand', 'availability', 'seller'];
  const gaps = {};
  for (const field of fields) {
    const ids = items.filter((item) => item[field] === null || item[field] === '' || item[field] === undefined).map((item) => item.id);
    if (ids.length) gaps[field] = ids;
  }
  return gaps;
}

function valuePerPrice(item, normalized) {
  if (normalized === null || normalized <= 0 || item.rating === null) return null;
  return round((item.rating / normalized) * 100, 4);
}

function applyFilters(items, args) {
  const query = String(args.query || '').trim().toLowerCase();
  return items.filter((item) => {
    if (args.site && !item.site.toLowerCase().includes(String(args.site).toLowerCase())) return false;
    if (args.brand && !item.brand.toLowerCase().includes(String(args.brand).toLowerCase())) return false;
    if (args.category && item.category !== String(args.category).toLowerCase()) return false;
    if (args.tag && !item.tags.some((tag) => tag.toLowerCase() === String(args.tag).toLowerCase())) return false;
    if (args.has_price && item.price === null) return false;
    if (toNumber(args.min_price) !== null && (item.price === null || item.price < Number(args.min_price))) return false;
    if (toNumber(args.max_price) !== null && (item.price === null || item.price > Number(args.max_price))) return false;
    if (query) {
      const haystack = [item.name, item.brand, item.seller, item.site, item.note, ...item.tags].join(' ').toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

function sortItems(entries, sortBy) {
  const sorted = [...entries];
  if (sortBy === 'price_low') sorted.sort((a, b) => (normalizedValue(a) ?? Infinity) - (normalizedValue(b) ?? Infinity));
  else if (sortBy === 'price_high') sorted.sort((a, b) => (normalizedValue(b) ?? -Infinity) - (normalizedValue(a) ?? -Infinity));
  else if (sortBy === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortBy === 'rating') sorted.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  else if (sortBy === 'value') sorted.sort((a, b) => (b.valueScore ?? -1) - (a.valueScore ?? -1));
  else if (sortBy === 'added') sorted.sort((a, b) => new Date(b.addedAt || 0) - new Date(a.addedAt || 0));
  return sorted;
}

function decorate(items, targetCurrency, rates) {
  const normalized = withNormalizedPrices(items, targetCurrency, rates);
  return {
    ...normalized,
    items: normalized.items.map((item) => ({
      ...item,
      valueScore: valuePerPrice(item, normalizedValue(item))
    }))
  };
}

function queryForItem(item, extra = '') {
  const parts = [item.brand, item.name].filter(Boolean).join(' ');
  const deduped = [...new Set(parts.split(/\s+/))].join(' ');
  return [deduped.slice(0, 160), extra, 'price'].filter(Boolean).join(' ').trim();
}

function dealCaveats(offer, item) {
  const caveats = [];
  if (!offer.confirmed) caveats.push('Price was read from a search snippet, not the live page. Confirm with fetch_offer.');
  if (offer.currency && item.currency && offer.currency !== item.currency) caveats.push(`Offer is in ${offer.currency} and the saved card is in ${item.currency}; the conversion is approximate.`);
  if (!offer.currency) caveats.push('The offer currency is unknown, so the comparison may not be apples to apples.');
  if (/marketplace|ebay|aliexpress|wish|temu|reseller/i.test(`${offer.site} ${offer.title}`)) caveats.push('Marketplace or reseller listing: check the seller, condition, and warranty.');
  if (/refurb|renewed|used|open box|pre-owned/i.test(String(offer.title))) caveats.push('The title suggests refurbished or used stock, not new.');
  if (/out.?of.?stock|backorder|sold.?out/i.test(String(offer.availability))) caveats.push('The listing may be out of stock.');
  if (offer.shipping) caveats.push(`Shipping of ${offer.shipping} is included in the landed price.`);
  const titleOverlap = offer.title ? similarity({ name: offer.title }, item) : 0;
  if (titleOverlap < 0.25) caveats.push('The listing title does not closely match the saved item; it may be a different model or a bundle.');
  return { caveats, titleMatch: round(titleOverlap, 2) };
}

function rankOffers(offers, item, targetCurrency, rates) {
  const baseCurrency = targetCurrency || item.currency || offers.find((offer) => offer.currency)?.currency || 'USD';
  const baseline = item.price === null
    ? null
    : convert(item.price, item.currency || baseCurrency, baseCurrency, rates);

  const evaluated = offers.map((offer) => {
    const price = toNumber(offer.price);
    const shipping = toNumber(offer.shipping) || 0;
    const landed = price === null ? null : price + shipping;
    const converted = landed === null ? null : convert(landed, String(offer.currency || baseCurrency).toUpperCase(), baseCurrency, rates);
    const { caveats, titleMatch } = dealCaveats(offer, item);
    const savings = baseline && converted ? round(baseline.value - converted.value) : null;
    return {
      title: offer.title || '',
      url: offer.url,
      site: offer.site || (() => { try { return new URL(offer.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
      price,
      currency: String(offer.currency || '').toUpperCase(),
      shipping: shipping || null,
      landedPrice: converted ? { value: converted.value, currency: converted.currency, approximate: converted.approximate } : null,
      availability: offer.availability || '',
      confirmed: Boolean(offer.confirmed),
      titleMatch,
      savings,
      savingsPercent: savings !== null && baseline?.value ? round((savings / baseline.value) * 100, 1) : null,
      caveats
    };
  });

  const priced = evaluated.filter((offer) => offer.landedPrice);
  priced.sort((a, b) => a.landedPrice.value - b.landedPrice.value);
  const unpriced = evaluated.filter((offer) => !offer.landedPrice);

  return {
    baseline: baseline ? { value: baseline.value, currency: baseline.currency, approximate: baseline.approximate } : null,
    offers: [...priced, ...unpriced],
    bestOffer: priced[0] || null
  };
}

async function verifyOffers(results, deps, limit) {
  const targets = results.slice(0, Math.max(0, limit));
  const confirmations = await Promise.all(targets.map((entry) => fetchOffer(entry.url, deps).catch((error) => ({ ok: false, error: error.message }))));
  return results.map((entry, index) => {
    const confirmation = confirmations[index];
    if (!confirmation?.ok || !confirmation.product) {
      return { ...entry, confirmed: false, ...(confirmation?.error ? { verifyError: confirmation.error } : {}) };
    }
    const product = confirmation.product;
    return {
      ...entry,
      title: product.name || entry.title,
      price: product.price ?? entry.price,
      currency: product.currency || entry.currency,
      availability: product.availability,
      rating: product.rating,
      ratingCount: product.ratingCount,
      seller: product.seller,
      confirmed: product.price !== null,
      priceSource: product.price !== null ? 'page' : entry.priceSource,
      ...(confirmation.note ? { note: confirmation.note } : {})
    };
  });
}

/**
 * Run one SideKick tool. Returns the JSON payload handed back to the model plus any
 * side-effect actions (reordering, tagging, offer cards) for the extension to apply.
 */
export async function executeTool(name, args = {}, rawItems = [], context = {}) {
  const env = context.env || process.env;
  const rates = loadRates(env);
  const items = normalizeItems(rawItems);
  const deps = { env, fetchImpl: context.fetchImpl, lookup: context.lookup };
  const actions = [];
  const done = (result) => ({ result, actions });

  if (name === 'list_items') {
    const filtered = applyFilters(items, args);
    const decorated = decorate(filtered, args.target_currency, rates);
    const sorted = sortItems(decorated.items, args.sort_by);
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 100);
    return done({
      count: sorted.length,
      totalOnShelf: items.length,
      targetCurrency: decorated.targetCurrency,
      mixedCurrencies: decorated.mixedCurrencies,
      rateDisclaimer: decorated.rateDisclaimer,
      items: sorted.slice(0, limit)
    });
  }

  if (name === 'compare_items') {
    const selected = pickItems(items, args.item_ids);
    if (!selected.length) return done({ count: 0, items: [], note: 'No saved items matched those IDs.' });

    const decorated = decorate(selected, args.target_currency, rates);
    const entries = decorated.items;
    const priced = entries.filter((entry) => normalizedValue(entry) !== null);
    const cheapest = priced.length ? priced.reduce((a, b) => (normalizedValue(a) <= normalizedValue(b) ? a : b)) : null;
    const priciest = priced.length ? priced.reduce((a, b) => (normalizedValue(a) >= normalizedValue(b) ? a : b)) : null;
    const rated = entries.filter((entry) => entry.rating !== null);
    const reviewed = entries.filter((entry) => entry.ratingCount !== null);
    const valued = entries.filter((entry) => entry.valueScore !== null);

    const attributes = ['price', 'rating', 'ratingCount', 'brand', 'seller', 'site', 'availability'].map((field) => ({
      attribute: field,
      values: Object.fromEntries(entries.map((entry) => [entry.id, field === 'price' ? normalizedValue(entry) : entry[field]]))
    }));

    return done({
      count: entries.length,
      targetCurrency: decorated.targetCurrency,
      mixedCurrencies: decorated.mixedCurrencies,
      rateDisclaimer: decorated.rateDisclaimer,
      items: entries,
      attributes,
      winners: {
        cheapest: cheapest ? shelfItemSummary(cheapest) : null,
        mostExpensive: priciest ? shelfItemSummary(priciest) : null,
        bestRated: rated.length ? shelfItemSummary(rated.reduce((a, b) => (a.rating >= b.rating ? a : b))) : null,
        mostReviewed: reviewed.length ? shelfItemSummary(reviewed.reduce((a, b) => (a.ratingCount >= b.ratingCount ? a : b))) : null,
        bestValue: valued.length ? shelfItemSummary(valued.reduce((a, b) => (a.valueScore >= b.valueScore ? a : b))) : null,
        inStock: entries.filter((entry) => /instock|in_stock|available/i.test(entry.availability)).map((entry) => entry.id)
      },
      priceRange: cheapest && priciest
        ? {
            min: { value: normalizedValue(cheapest), currency: decorated.targetCurrency },
            max: { value: normalizedValue(priciest), currency: decorated.targetCurrency },
            spread: round(normalizedValue(priciest) - normalizedValue(cheapest)),
            spreadPercent: normalizedValue(cheapest) > 0
              ? round(((normalizedValue(priciest) - normalizedValue(cheapest)) / normalizedValue(cheapest)) * 100, 1)
              : null
          }
        : null,
      missing: missingFields(entries),
      note: 'A lower price alone does not make an item better. Name the missing fields instead of guessing at them.'
    });
  }

  if (name === 'price_summary') {
    const withPrice = items.filter((item) => item.price !== null);
    const groups = new Map();
    for (const item of withPrice) {
      const currency = item.currency || 'UNKNOWN';
      if (!groups.has(currency)) groups.set(currency, []);
      groups.get(currency).push(item);
    }

    const decorated = decorate(withPrice, args.target_currency, rates);
    const normalizedTotals = decorated.items.map(normalizedValue).filter((value) => value !== null);

    return done({
      itemsWithPrice: withPrice.length,
      itemsWithoutPrice: items.length - withPrice.length,
      currencies: [...groups.entries()].map(([currency, group]) => {
        const prices = group.map((item) => item.price);
        const total = prices.reduce((a, b) => a + b, 0);
        return {
          currency,
          count: group.length,
          total: round(total),
          average: round(total / prices.length),
          min: Math.min(...prices),
          max: Math.max(...prices)
        };
      }),
      combined: normalizedTotals.length
        ? {
            currency: decorated.targetCurrency,
            total: round(normalizedTotals.reduce((a, b) => a + b, 0)),
            average: round(normalizedTotals.reduce((a, b) => a + b, 0) / normalizedTotals.length),
            approximate: decorated.mixedCurrencies
          }
        : null,
      rateDisclaimer: decorated.rateDisclaimer
    });
  }

  if (name === 'organize_items') {
    const strategy = args.strategy || 'store';
    const decorated = decorate(items, args.target_currency, rates);
    const entries = decorated.items;
    const groups = {};
    const push = (key, id) => {
      groups[key] ||= [];
      groups[key].push(id);
    };

    if (strategy === 'duplicates') {
      const clusters = findDuplicateGroups(entries);
      const clustered = new Set();
      clusters.forEach((cluster, index) => {
        const label = `Likely same product ${index + 1}: ${cluster[0].name.slice(0, 40)}`;
        for (const member of cluster) {
          push(label, member.id);
          clustered.add(member.id);
        }
      });
      for (const entry of entries) if (!clustered.has(entry.id)) push('Unique', entry.id);
    } else {
      // "Value" is only meaningful relative to the rest of the shelf, so split at the median.
      const valueScores = entries.map((entry) => entry.valueScore).filter((score) => score !== null).sort((a, b) => a - b);
      const valueMidpoint = valueScores.length ? valueScores[Math.floor(valueScores.length / 2)] : 0;

      for (const entry of entries) {
        if (strategy === 'store') push(entry.site || entry.seller || 'Unknown store', entry.id);
        else if (strategy === 'brand') push(entry.brand || 'Unknown brand', entry.id);
        else if (strategy === 'price_band') push(priceBand(normalizedValue(entry)), entry.id);
        else if (strategy === 'category') push(entry.category || categoryFromName(entry.name), entry.id);
        else if (strategy === 'rating') {
          if (entry.rating === null) push('Unrated', entry.id);
          else if (entry.rating >= 4.5) push('4.5 and up', entry.id);
          else if (entry.rating >= 4) push('4.0 – 4.4', entry.id);
          else push('Under 4.0', entry.id);
        } else if (strategy === 'value') {
          if (entry.valueScore === null) push('Not enough data', entry.id);
          else push(entry.valueScore >= valueMidpoint ? 'Better value' : 'Weaker value', entry.id);
        } else if (strategy === 'recency') {
          const added = entry.addedAt ? new Date(entry.addedAt) : null;
          const days = added && !Number.isNaN(added.valueOf()) ? (Date.now() - added.valueOf()) / 86_400_000 : null;
          if (days === null) push('Unknown date', entry.id);
          else if (days <= 1) push('Today', entry.id);
          else if (days <= 7) push('This week', entry.id);
          else push('Older', entry.id);
        } else push('Other', entry.id);
      }
    }

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const sortWithin = (ids) => {
      if (strategy === 'value') return [...ids].sort((a, b) => (byId.get(b).valueScore ?? -1) - (byId.get(a).valueScore ?? -1));
      if (strategy === 'price_band') return [...ids].sort((a, b) => (normalizedValue(byId.get(a)) ?? Infinity) - (normalizedValue(byId.get(b)) ?? Infinity));
      if (strategy === 'rating') return [...ids].sort((a, b) => (byId.get(b).rating ?? -1) - (byId.get(a).rating ?? -1));
      return ids;
    };

    const orderedGroups = Object.fromEntries(Object.entries(groups).map(([key, ids]) => [key, sortWithin(ids)]));
    const suggestedOrder = Object.values(orderedGroups).flat();
    const summaries = Object.entries(orderedGroups).map(([label, ids]) => {
      const prices = ids.map((id) => normalizedValue(byId.get(id))).filter((value) => value !== null);
      return {
        label,
        count: ids.length,
        itemIds: ids,
        cheapest: prices.length ? Math.min(...prices) : null,
        averagePrice: prices.length ? round(prices.reduce((a, b) => a + b, 0) / prices.length) : null
      };
    });

    const apply = args.apply !== false;
    if (apply && suggestedOrder.length) {
      actions.push({ type: 'reorder', ids: suggestedOrder, strategy, groups: summaries.map(({ label, itemIds }) => ({ label, itemIds })) });
    }

    return done({
      strategy,
      applied: apply && suggestedOrder.length > 0,
      targetCurrency: decorated.targetCurrency,
      groups: orderedGroups,
      groupSummaries: summaries,
      suggestedOrder,
      rateDisclaimer: decorated.rateDisclaimer
    });
  }

  if (name === 'find_duplicates') {
    const threshold = Math.min(Math.max(Number(args.threshold) || 0.55, 0.2), 0.95);
    const decorated = decorate(items, args.target_currency, rates);
    const clusters = findDuplicateGroups(decorated.items, threshold);

    return done({
      threshold,
      targetCurrency: decorated.targetCurrency,
      clusterCount: clusters.length,
      clusters: clusters.map((cluster) => {
        const prices = cluster.map(normalizedValue).filter((value) => value !== null);
        const cheapest = cluster.filter((entry) => normalizedValue(entry) !== null)
          .sort((a, b) => normalizedValue(a) - normalizedValue(b))[0] || null;
        return {
          items: cluster.map((entry) => ({ ...shelfItemSummary(entry), normalizedPrice: normalizedValue(entry) })),
          cheapest: cheapest ? shelfItemSummary(cheapest) : null,
          priceSpread: prices.length > 1 ? round(Math.max(...prices) - Math.min(...prices)) : null,
          confidence: round(Math.min(...cluster.slice(1).map((entry) => similarity(cluster[0], entry))), 2)
        };
      }),
      note: clusters.length
        ? 'Similar names are not proof of an identical product. Check model numbers and variants before telling the user to drop one.'
        : 'No likely duplicates found.',
      rateDisclaimer: decorated.rateDisclaimer
    });
  }

  if (name === 'rank_items') {
    const selected = pickItems(items, args.item_ids);
    if (!selected.length) return done({ count: 0, ranking: [], note: 'No saved items matched those IDs.' });

    const weights = {
      price: Number(args.weights?.price ?? 0.4),
      rating: Number(args.weights?.rating ?? 0.3),
      popularity: Number(args.weights?.popularity ?? 0.2),
      availability: Number(args.weights?.availability ?? 0.1)
    };
    const weightTotal = Object.values(weights).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) || 1;

    const decorated = decorate(selected, args.target_currency, rates);
    const entries = decorated.items;
    const prices = entries.map(normalizedValue).filter((value) => value !== null);
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;
    const maxReviews = Math.max(1, ...entries.map((entry) => entry.ratingCount ?? 0));

    const ranking = entries.map((entry) => {
      const price = normalizedValue(entry);
      const unknown = [];
      const priceScore = price === null || minPrice === null
        ? (unknown.push('price'), 0.5)
        : (maxPrice === minPrice ? 1 : (maxPrice - price) / (maxPrice - minPrice));
      const ratingScore = entry.rating === null ? (unknown.push('rating'), 0.5) : Math.min(1, entry.rating / 5);
      const popularityScore = entry.ratingCount === null
        ? (unknown.push('ratingCount'), 0.5)
        : Math.log10(1 + entry.ratingCount) / Math.log10(1 + maxReviews);
      const availabilityScore = /instock|in_stock|available/i.test(entry.availability)
        ? 1
        : (entry.availability ? 0.2 : (unknown.push('availability'), 0.5));

      const score = (
        priceScore * weights.price
        + ratingScore * weights.rating
        + popularityScore * weights.popularity
        + availabilityScore * weights.availability
      ) / weightTotal;

      return {
        ...shelfItemSummary(entry),
        normalizedPrice: price,
        score: round(score * 100, 1),
        breakdown: {
          price: round(priceScore, 3),
          rating: round(ratingScore, 3),
          popularity: round(popularityScore, 3),
          availability: round(availabilityScore, 3)
        },
        estimatedFields: unknown,
        confidence: unknown.length === 0 ? 'high' : unknown.length < 3 ? 'medium' : 'low'
      };
    }).sort((a, b) => b.score - a.score);

    return done({
      count: ranking.length,
      weights,
      targetCurrency: decorated.targetCurrency,
      ranking,
      note: 'Items with estimatedFields were scored on a neutral 0.5 placeholder for those fields. Say so rather than presenting the score as certain.',
      rateDisclaimer: decorated.rateDisclaimer
    });
  }

  if (name === 'tag_items') {
    const known = new Map(items.map((item) => [item.id, item]));
    const updates = (Array.isArray(args.updates) ? args.updates : [])
      .map((update) => ({
        id: String(update?.item_id || ''),
        tags: (Array.isArray(update?.tags) ? update.tags : [])
          .map((tag) => String(tag).trim().slice(0, 24))
          .filter(Boolean)
          .slice(0, 8),
        note: String(update?.note || '').slice(0, 160),
        mode: update?.mode === 'replace' ? 'replace' : 'add'
      }))
      .filter((update) => known.has(update.id))
      .slice(0, 50);

    if (updates.length) actions.push({ type: 'set_tags', updates });

    return done({
      updated: updates.map((update) => ({ ...update, name: known.get(update.id).name })),
      skipped: (Array.isArray(args.updates) ? args.updates : [])
        .map((update) => String(update?.item_id || ''))
        .filter((id) => !known.has(id)),
      note: updates.length ? 'Tags applied to the shelf cards.' : 'No matching cards, so nothing was tagged.'
    });
  }

  if (name === 'search_deals') {
    const status = searchStatus(env);
    const item = args.item_id ? items.find((entry) => entry.id === String(args.item_id)) || null : null;
    if (args.item_id && !item) return done({ error: `No saved item with id ${args.item_id}.` });

    const query = item ? queryForItem(item, String(args.query || '')) : String(args.query || '').trim();
    if (!query) return done({ error: 'Provide a query, an item_id, or both.' });

    const search = await searchWeb({
      query,
      maxResults: args.max_results,
      includeSites: args.include_sites,
      excludeSites: args.exclude_sites
    }, deps);

    if (!search.results.length) {
      return done({
        provider: search.provider,
        query: search.query,
        results: [],
        error: search.error || 'The search returned no usable results.',
        setupHint: status.setupHint || undefined
      });
    }

    const verify = args.verify !== false;
    const results = verify ? await verifyOffers(search.results, deps, 3) : search.results;

    let comparison = null;
    if (item) {
      comparison = rankOffers(results.filter((entry) => entry.price !== null && entry.price !== undefined), item, args.target_currency, rates);
      if (comparison.offers.length) {
        actions.push({
          type: 'offers',
          itemId: item.id,
          itemName: item.name,
          query: search.query,
          provider: search.provider,
          offers: comparison.offers.slice(0, 6)
        });
      }
    }

    return done({
      provider: search.provider,
      query: search.query,
      verified: verify,
      cached: Boolean(search.cached),
      baselineItem: item ? shelfItemSummary(item) : null,
      results,
      ...(comparison ? { baseline: comparison.baseline, rankedOffers: comparison.offers, bestOffer: comparison.bestOffer } : {}),
      ...(search.providerSummary ? { providerSummary: search.providerSummary } : {}),
      note: 'Only results marked confirmed had their price read from the live page. Never state an unconfirmed price as fact.'
    });
  }

  if (name === 'fetch_offer') {
    const result = await fetchOffer(String(args.url || ''), deps).catch((error) => ({ ok: false, error: error.message }));
    return done(result);
  }

  if (name === 'evaluate_deal') {
    const item = items.find((entry) => entry.id === String(args.item_id));
    if (!item) return done({ error: `No saved item with id ${args.item_id}.` });

    const offers = (Array.isArray(args.offers) ? args.offers : []).filter((offer) => offer?.url).slice(0, 12);
    if (!offers.length) return done({ error: 'Provide at least one offer with a URL.' });

    const ranked = rankOffers(offers, item, args.target_currency, rates);
    if (ranked.offers.length) {
      actions.push({ type: 'offers', itemId: item.id, itemName: item.name, offers: ranked.offers.slice(0, 6) });
    }

    const best = ranked.bestOffer;
    return done({
      item: shelfItemSummary(item),
      baseline: ranked.baseline,
      offers: ranked.offers,
      bestOffer: best,
      verdict: !ranked.baseline
        ? 'The saved card has no price, so no saving can be calculated.'
        : best && best.savings !== null && best.savings > 0
          ? `The best candidate is about ${best.savings} ${ranked.baseline.currency} cheaper (${best.savingsPercent}%)${best.confirmed ? '' : ', but that price is unconfirmed'}.`
          : 'Nothing found beats the saved price once shipping and currency are taken into account.',
      note: 'Report the caveats on an offer together with its price.'
    });
  }

  return done({ error: `Unknown tool: ${name}` });
}
