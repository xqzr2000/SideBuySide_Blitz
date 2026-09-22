import { parsePriceFromText } from './currency.js';
import { normalizeModel, openAiBaseUrl, openAiErrorMessage, openAiHeaders } from './openai.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

export const PROVIDER_SETUP = {
  tavily: 'Set TAVILY_API_KEY (https://tavily.com).',
  brave: 'Set BRAVE_SEARCH_API_KEY (https://brave.com/search/api).',
  serpapi: 'Set SERPAPI_API_KEY (https://serpapi.com).',
  openai: 'Set OPENAI_API_KEY; SideKick then uses OpenAI\'s built-in web_search tool.'
};

/** Pick a provider: an explicit SEARCH_PROVIDER wins, otherwise the first configured key. */
export function resolveProvider(env = process.env) {
  const explicit = String(env.SEARCH_PROVIDER || '').trim().toLowerCase();
  if (explicit && explicit !== 'auto') return explicit;
  if (env.TAVILY_API_KEY) return 'tavily';
  if (env.BRAVE_SEARCH_API_KEY) return 'brave';
  if (env.SERPAPI_API_KEY) return 'serpapi';
  if (env.OPENAI_API_KEY) return 'openai';
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

/** The line of the answer a citation sits in: that is where the store and price are. */
function lineAround(text, index) {
  const at = Math.max(0, Math.min(Number(index) || 0, text.length));
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const stop = text.indexOf('\n', at);
  return text.slice(start, stop === -1 ? text.length : stop).trim();
}

/**
 * OpenAI's Responses API with the hosted web_search tool. Sources come back as
 * url_citation annotations on the output text; each one becomes a result, with the
 * cited line of the answer as its snippet.
 */
async function openAiSearch(query, maxResults, env, fetchImpl) {
  const tool = { type: env.OPENAI_WEB_SEARCH_TOOL || 'web_search' };
  if (env.OPENAI_SEARCH_COUNTRY) {
    // Prices and stock differ by market, so search from the shopper's country.
    tool.user_location = { type: 'approximate', country: String(env.OPENAI_SEARCH_COUNTRY).toUpperCase() };
  }

  const response = await fetchImpl(`${openAiBaseUrl(env)}/responses`, {
    method: 'POST',
    headers: openAiHeaders(env),
    body: JSON.stringify({
      model: normalizeModel(env.OPENAI_SEARCH_MODEL || env.OPENAI_MODEL),
      tools: [tool],
      input: `Search the web for current retail listings of: ${query}. Give one line per listing with the store, the exact product, and its price, and cite each listing's page.`
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(openAiErrorMessage(data, response.status, 'OpenAI web search'));

  const texts = (data.output || [])
    .filter((item) => item?.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((part) => part?.type === 'output_text');

  const seen = new Set();
  const results = [];
  for (const part of texts) {
    const text = String(part.text || '');
    for (const annotation of part.annotations || []) {
      if (annotation?.type !== 'url_citation') continue;
      // Responses puts url/title on the annotation; tolerate the nested chat shape too.
      const citation = annotation.url_citation || annotation;
      const url = String(citation.url || '').replace(/[?&]utm_source=openai$/, '');
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push(normalizeResult({
        title: citation.title,
        url,
        snippet: lineAround(text, annotation.start_index)
      }));
    }
  }

  return {
    results: results.slice(0, maxResults),
    summary: texts.map((part) => part.text).join('\n').slice(0, 1200)
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
    else if (provider === 'openai') payload = await openAiSearch(query, maxResults, env, fetchImpl);
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
