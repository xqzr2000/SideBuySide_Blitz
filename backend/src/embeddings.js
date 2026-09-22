import { tokenize } from './items.js';
import { openAiBaseUrl, openAiHeaders } from './openai.js';

export const LOCAL_DIMENSIONS = 256;
const MAX_INPUT_CHARS = 2000;
const BATCH_SIZE = 64;
const cache = new Map();
const CACHE_LIMIT = 2000;

export const EMBEDDING_SETUP = {
  openai: 'Set OPENAI_API_KEY for text-embedding-3-small (the same key SideKick chats with).',
  voyage: 'Set VOYAGE_API_KEY for voyage-3-lite.',
  jina: 'Set JINA_API_KEY for jina-embeddings-v3.',
  cohere: 'Set COHERE_API_KEY for embed-english-v3.0.'
};

/** Explicit EMBEDDING_PROVIDER wins; otherwise the first configured key, else the offline encoder. */
export function resolveEmbeddingProvider(env = process.env) {
  const explicit = String(env.EMBEDDING_PROVIDER || '').trim().toLowerCase();
  if (explicit && explicit !== 'auto') return explicit;
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.VOYAGE_API_KEY) return 'voyage';
  if (env.JINA_API_KEY) return 'jina';
  if (env.COHERE_API_KEY) return 'cohere';
  return 'local';
}

export function embeddingModel(provider, env = process.env) {
  if (env.EMBEDDING_MODEL) return env.EMBEDDING_MODEL;
  if (provider === 'openai') return 'text-embedding-3-small';
  if (provider === 'voyage') return 'voyage-3-lite';
  if (provider === 'jina') return 'jina-embeddings-v3';
  if (provider === 'cohere') return 'embed-english-v3.0';
  return `local-hash-${LOCAL_DIMENSIONS}`;
}

export function embeddingStatus(env = process.env) {
  const provider = resolveEmbeddingProvider(env);
  return {
    provider,
    model: embeddingModel(provider, env),
    semantic: provider !== 'local',
    note: provider === 'local'
      ? `Using the built-in offline encoder: it matches wording, not meaning, so "earbuds" and "headphones" look unrelated. ${Object.values(EMBEDDING_SETUP).join(' ')}`
      : ''
  };
}

function fnv1a(text, seed = 2166136261) {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function l2Normalize(vector) {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (sum === 0) return Array.from(vector, () => 0);
  const norm = Math.sqrt(sum);
  return Array.from(vector, (value) => value / norm);
}

/**
 * Deterministic signed-hashing encoder over tokens, token bigrams, and character
 * trigrams. Lexical rather than semantic, but it needs no key and no network, so
 * shelf memory works out of the box.
 */
export function localEmbed(text) {
  const vector = new Float64Array(LOCAL_DIMENSIONS);
  const tokens = tokenize(text);
  const counts = new Map();

  const bump = (feature, weight) => counts.set(feature, (counts.get(feature) || 0) + weight);
  for (const token of tokens) bump(`t:${token}`, 1);
  for (let index = 1; index < tokens.length; index += 1) bump(`b:${tokens[index - 1]}_${tokens[index]}`, 0.6);

  const compact = String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (let index = 0; index + 3 <= compact.length; index += 1) {
    const gram = compact.slice(index, index + 3);
    if (!gram.includes(' ')) bump(`c:${gram}`, 0.25);
  }

  for (const [feature, count] of counts) {
    const weight = (1 + Math.log(count)) * (feature.startsWith('c:') ? 1 : 1.5);
    const hash = fnv1a(feature);
    const sign = fnv1a(feature, 486187739) & 1 ? 1 : -1;
    vector[hash % LOCAL_DIMENSIONS] += sign * weight;
  }

  return l2Normalize(vector);
}

async function openAiShaped(texts, { url, apiKey, headers, model, extra = {}, fetchImpl }) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: headers || { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: texts, ...extra })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || data?.detail || `Embedding request failed (${response.status}).`);
  const vectors = (data.data || []).map((entry) => entry.embedding);
  if (vectors.length !== texts.length) throw new Error('The embedding provider returned a different number of vectors than inputs.');
  return vectors;
}

async function cohereEmbed(texts, { apiKey, model, fetchImpl }) {
  const response = await fetchImpl('https://api.cohere.com/v2/embed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, texts, input_type: 'search_document', embedding_types: ['float'] })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || `Cohere embedding failed (${response.status}).`);
  const vectors = data?.embeddings?.float || [];
  if (vectors.length !== texts.length) throw new Error('Cohere returned a different number of vectors than inputs.');
  return vectors;
}

async function embedBatch(provider, texts, env, fetchImpl) {
  const model = embeddingModel(provider, env);
  if (provider === 'openai') {
    return openAiShaped(texts, { url: `${openAiBaseUrl(env)}/embeddings`, headers: openAiHeaders(env), model, fetchImpl });
  }
  if (provider === 'voyage') {
    return openAiShaped(texts, { url: 'https://api.voyageai.com/v1/embeddings', apiKey: env.VOYAGE_API_KEY, model, fetchImpl });
  }
  if (provider === 'jina') {
    return openAiShaped(texts, { url: 'https://api.jina.ai/v1/embeddings', apiKey: env.JINA_API_KEY, model, fetchImpl });
  }
  if (provider === 'cohere') {
    return cohereEmbed(texts, { apiKey: env.COHERE_API_KEY, model, fetchImpl });
  }
  throw new Error(`Unknown EMBEDDING_PROVIDER "${provider}".`);
}

/**
 * Embed a batch of texts, falling back to the offline encoder if a hosted provider
 * fails, so a bad key degrades recall instead of breaking the shelf.
 */
export async function embedTexts(texts = [], deps = {}) {
  const env = deps.env || process.env;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const requested = resolveEmbeddingProvider(env);
  const inputs = texts.map((text) => String(text || '').slice(0, MAX_INPUT_CHARS));
  if (!inputs.length) return { provider: requested, model: embeddingModel(requested, env), dimensions: 0, vectors: [] };

  if (requested === 'local') {
    return {
      provider: 'local',
      model: embeddingModel('local', env),
      dimensions: LOCAL_DIMENSIONS,
      vectors: inputs.map(localEmbed)
    };
  }

  const model = embeddingModel(requested, env);
  const vectors = new Array(inputs.length);
  const pending = [];
  inputs.forEach((text, index) => {
    const key = `${requested}:${model}:${text}`;
    const hit = cache.get(key);
    if (hit) vectors[index] = hit;
    else pending.push({ index, text, key });
  });

  try {
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const slice = pending.slice(start, start + BATCH_SIZE);
      const embedded = await embedBatch(requested, slice.map((entry) => entry.text), env, fetchImpl);
      slice.forEach((entry, offset) => {
        const vector = l2Normalize(embedded[offset] || []);
        vectors[entry.index] = vector;
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(entry.key, vector);
      });
    }
  } catch (error) {
    return {
      provider: 'local',
      model: embeddingModel('local', env),
      dimensions: LOCAL_DIMENSIONS,
      vectors: inputs.map(localEmbed),
      degradedFrom: requested,
      error: error.message
    };
  }

  return { provider: requested, model, dimensions: vectors[0]?.length || 0, vectors };
}

export function cosineSimilarity(a = [], b = []) {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function clearEmbeddingCache() {
  cache.clear();
}
