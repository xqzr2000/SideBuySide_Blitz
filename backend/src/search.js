import { parsePriceFromText } from './currency.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export const PROVIDER_SETUP = {
  tavily: 'Set TAVILY_API_KEY (https://tavily.com).',
  brave: 'Set BRAVE_SEARCH_API_KEY (https://brave.com/search/api).',
  serpapi: 'Set SERPAPI_API_KEY (https://serpapi.com).',
  openrouter: 'Set OPENROUTER_API_KEY; SideKick then uses OpenRouter\'s built-in web plugin.'
};

/** Pick a provider: an explicit SEARCH_PROVIDER wins, otherwise the first configured key. */
export function resolveProvider(env = process.env) {
  const explicit = String(env.SEARCH_PROVIDER || '').trim().toLowerCase();
  if (explicit && explicit !== 'auto') return explicit;
  if (env.TAVILY_API_KEY) return 'tavily';
  if (env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (env.SERPAPI_API_KEY) return 'serpapi';
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  return 'none';
}

export function searchStatus(env = process.env) {
  const provider = resolveProvider(env);
  return {
    provider,
    configured: provider !== 'none',
    setupHint: provider === 'none'
      ? `Web search is off. ${Object.values(PROVIDER_SETUP).join(' ')}`
      : ''
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeResult(raw) {
  const url = String(raw.url || '');
  const snippet = String(raw.snippet || '').slice(0, 600);
  const fromSnippet = parsePriceFromText(`${raw.title || ''} ${snippet}`);
  return {
    title: String(raw.title || '').slice(0, 220),
    url,
    site: hostOf(url),
    snippet,
    // Snippet prices are a hint only; fetch_offer confirms them.
    price: raw.price ?? fromSnippet.price,
    currency: String(raw.currency || fromSnippet.currency || '').toUpperCase(),
    priceSource: raw.price != null ? 'provider' : (fromSnippet.price != null ? 'snippet' : 'none')
  };
}

async function tavilySearch(query, maxResults, env, fetchImpl) {
  const response = await fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_API_KEY}` },
    body: JSON.stringify({ query, max_results: maxResults, search_depth: 'basic', include_answer: false })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error || `Tavily search failed (${response.status}).`);
  return (data.results || []).map((entry) => normalizeResult({ title: entry.title, url: entry.url, snippet: entry.content }));
}

async function braveSearch(query, maxResults, env, fetchImpl) {
  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(maxResults));
  const response = await fetchImpl(url.toString(), {
    headers: { Accept: 'application/json', 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.detail || `Brave search failed (${response.status}).`);
  return (data.web?.results || []).map((entry) => normalizeResult({
    title: entry.title,
    url: entry.url,
    snippet: entry.description
  }));
}

async function serpapiSearch(query, maxResults, env, fetchImpl) {
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_shopping');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(maxResults));
  url.searchParams.set('api_key', env.SERPAPI_API_KEY);
  const response = await fetchImpl(url.toString());
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(data.error || `SerpApi search failed (${response.status}).`);
  const shopping = data.shopping_results || [];
  const organic = data.organic_results || [];
  return [...shopping, ...organic].slice(0, maxResults).map((entry) => normalizeResult({
    title: entry.title,
    url: entry.product_link || entry.link,
    snippet: entry.snippet || entry.source || '',
    price: typeof entry.extracted_price === 'number' ? entry.extracted_price : undefined,
    currency: entry.currency
  }));
}

/** OpenRouter's web plugin returns citations as message annotations. */
async function openRouterSearch(query, maxResults, env, fetchImpl) {
  const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': env.OPENROUTER_SITE_URL || 'http://localhost:8787',
      'X-Title': env.OPENROUTER_APP_NAME || 'SideBuySide SideKick'
    },
    body: JSON.stringify({
      model: env.OPENROUTER_SEARCH_MODEL || env.OPENROUTER_MODEL || 'openai/gpt-5-mini',
      plugins: [{ id: 'web', max_results: maxResults }],
      messages: [{
        role: 'user',
        content: `Find current retail listings and prices for: ${query}. List the store, the product, and the price.`
      }]
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenRouter web search failed (${response.status}).`);

  const message = data?.choices?.[0]?.message || {};
  const annotations = (message.annotations || [])
    .filter((entry) => entry?.type === 'url_citation' && entry.url_citation?.url)
    .map((entry) => normalizeResult({
      title: entry.url_citation.title,
      url: entry.url_citation.url,
      snippet: entry.url_citation.content || ''
    }));

  return {
    results: annotations.slice(0, maxResults),
    summary: String(message.content || '').slice(0, 1200)
  };
}

function buildQuery({ query, includeSites = [], excludeSites = [] }) {
  const include = includeSites.filter(Boolean).slice(0, 4);
  const exclude = excludeSites.filter(Boolean).slice(0, 6);
  const parts = [query.trim()];
  if (include.length) parts.push(`(${include.map((site) => `site:${site}`).join(' OR ')})`);
  for (const site of exclude) parts.push(`-site:${site}`);
  return parts.join(' ').slice(0, 400);
}

/**
 * Run one web search through whichever provider is configured and return
 * price-annotated results. Repeated identical queries are served from a short cache.
 */
export async function searchWeb(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const provider = resolveProvider(env);
  const maxResults = Math.min(Math.max(Number(options.maxResults) || 6, 1), 10);
  const query = buildQuery({
    query: String(options.query || '').slice(0, 300),
    includeSites: options.includeSites || [],
    excludeSites: options.excludeSites || []
  });

  if (!query.trim()) return { provider, query, results: [], error: 'A search query is required.' };
  if (provider === 'none') {
    return { provider, query, results: [], configured: false, error: searchStatus(env).setupHint };
  }

  const cacheKey = `${provider}:${maxResults}:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return { ...cached.value, cached: true };

  try {
    let payload;
    if (provider === 'tavily') payload = { results: await tavilySearch(query, maxResults, env, fetchImpl) };
    else if (provider === 'brave') payload = { results: await braveSearch(query, maxResults, env, fetchImpl) };
    else if (provider === 'serpapi') payload = { results: await serpapiSearch(query, maxResults, env, fetchImpl) };
    else if (provider === 'openrouter') payload = await openRouterSearch(query, maxResults, env, fetchImpl);
    else {
      return { provider, query, results: [], configured: false, error: `Unknown SEARCH_PROVIDER "${provider}".` };
    }

    const value = {
      provider,
      query,
      configured: true,
      results: (payload.results || []).filter((entry) => entry.url),
      ...(payload.summary ? { providerSummary: payload.summary } : {})
    };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (error) {
    return { provider, query, results: [], error: error.message };
  }
}

export function clearSearchCache() {
  cache.clear();
}
