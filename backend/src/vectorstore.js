import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cosineSimilarity } from './embeddings.js';

const FILE_VERSION = 1;
const MAX_RECORDS = 5000;
const VECTOR_PRECISION = 6;

function round(value) {
  const factor = 10 ** VECTOR_PRECISION;
  return Math.round(value * factor) / factor;
}

/**
 * A small on-disk vector database: cosine search over the shelf history, kept in
 * memory and persisted as one JSON file. No dependencies, and a shelf is hundreds
 * of products at most, so a linear scan is far cheaper than an index.
 */
export class VectorStore {
  constructor({ file = null, signature = '' } = {}) {
    this.file = file;
    this.signature = signature;
    this.records = new Map();
    this.loaded = !file;
    this.writing = null;
  }

  get size() {
    return this.records.size;
  }

  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data?.version !== FILE_VERSION) return this;
      this.signature = String(data.signature || '');
      for (const record of data.records || []) {
        if (record?.id) this.records.set(String(record.id), record);
      }
    } catch {
      // A missing or corrupt store is not fatal; it simply starts empty.
    }
    return this;
  }

  /**
   * Switching embedding provider invalidates every stored vector, so drop the
   * vectors but keep the texts and metadata for a cheap re-embed on the next sync.
   */
  setSignature(signature) {
    const next = String(signature || '');
    if (!next || next === this.signature) {
      this.signature = next || this.signature;
      return false;
    }
    this.signature = next;
    for (const record of this.records.values()) record.vector = null;
    return true;
  }

  get(id) {
    return this.records.get(String(id)) || null;
  }

  upsert(record) {
    if (!record?.id) return null;
    const id = String(record.id);
    const existing = this.records.get(id);
    // An omitted vector keeps whatever is stored; an explicit null clears it so the
    // record is picked up for re-embedding.
    const vector = record.vector === undefined
      ? (existing?.vector ?? null)
      : (record.vector?.length ? Array.from(record.vector, round) : null);

    const merged = {
      id,
      text: record.text ?? existing?.text ?? '',
      vector,
      meta: { ...(existing?.meta || {}), ...(record.meta || {}) }
    };
    this.records.set(id, merged);

    if (this.records.size > MAX_RECORDS) {
      // Evict the least recently seen products first.
      const ordered = [...this.records.values()].sort((a, b) => String(a.meta?.lastSeen || '').localeCompare(String(b.meta?.lastSeen || '')));
      for (const stale of ordered.slice(0, this.records.size - MAX_RECORDS)) this.records.delete(stale.id);
    }
    return merged;
  }

  remove(ids = []) {
    let removed = 0;
    for (const id of ids) if (this.records.delete(String(id))) removed += 1;
    return removed;
  }

  clear() {
    const count = this.records.size;
    this.records.clear();
    return count;
  }

  all() {
    return [...this.records.values()];
  }

  missingVectors() {
    return this.all().filter((record) => !Array.isArray(record.vector) || !record.vector.length);
  }

  /**
   * Cosine top-k with an optional metadata filter and optional MMR re-ranking
   * (lambda 1 = pure relevance, lower values trade relevance for variety).
   */
  query(vector, { topK = 5, minScore = 0, filter = null, exclude = null, mmr = 1 } = {}) {
    if (!Array.isArray(vector) || !vector.length) return [];
    const excluded = exclude instanceof Set ? exclude : new Set(exclude || []);

    const scored = [];
    for (const record of this.records.values()) {
      if (excluded.has(record.id)) continue;
      if (!Array.isArray(record.vector) || !record.vector.length) continue;
      if (typeof filter === 'function' && !filter(record)) continue;
      const score = cosineSimilarity(vector, record.vector);
      if (score < minScore) continue;
      scored.push({ ...record, score: Number(score.toFixed(4)) });
    }
    scored.sort((a, b) => b.score - a.score);

    const limit = Math.max(1, Math.min(Number(topK) || 5, 50));
    const lambda = Math.min(Math.max(Number(mmr), 0), 1);
    if (lambda >= 1 || scored.length <= limit) return scored.slice(0, limit);

    const selected = [];
    const pool = scored.slice(0, Math.min(scored.length, limit * 5));
    while (selected.length < limit && pool.length) {
      let bestIndex = 0;
      let bestValue = -Infinity;
      pool.forEach((candidate, index) => {
        const redundancy = selected.length
          ? Math.max(...selected.map((chosen) => cosineSimilarity(candidate.vector, chosen.vector)))
          : 0;
        const value = lambda * candidate.score - (1 - lambda) * redundancy;
        if (value > bestValue) {
          bestValue = value;
          bestIndex = index;
        }
      });
      selected.push(pool.splice(bestIndex, 1)[0]);
    }
    return selected;
  }

  stats() {
    const records = this.all();
    const embedded = records.filter((record) => Array.isArray(record.vector) && record.vector.length);
    const onShelf = records.filter((record) => record.meta?.status === 'on_shelf');
    const firstSeen = records.map((record) => record.meta?.firstSeen).filter(Boolean).sort();
    const lastSeen = records.map((record) => record.meta?.lastSeen).filter(Boolean).sort();
    return {
      records: records.length,
      embedded: embedded.length,
      pendingEmbedding: records.length - embedded.length,
      onShelf: onShelf.length,
      pastItems: records.length - onShelf.length,
      dimensions: embedded[0]?.vector?.length || 0,
      signature: this.signature,
      oldestProduct: firstSeen[0] || null,
      lastActivity: lastSeen.at(-1) || null
    };
  }

  toJSON() {
    return { version: FILE_VERSION, signature: this.signature, savedAt: new Date().toISOString(), records: this.all() };
  }

  /** Serialized atomic writes: never leave a half-written store behind. */
  async save() {
    if (!this.file) return false;
    const run = async () => {
      const payload = JSON.stringify(this.toJSON());
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temp, payload, 'utf8');
      await fs.rename(temp, this.file);
      return true;
    };
    this.writing = (this.writing || Promise.resolve()).then(run, run);
    return this.writing;
  }
}

const stores = new Map();

export function vectorStorePath(env = process.env) {
  return env.VECTOR_STORE_PATH
    ? path.resolve(env.VECTOR_STORE_PATH)
    : fileURLToPath(new URL('../data/shelf-vectors.json', import.meta.url));
}

/** One shared store per file path, so every request sees the same shelf memory. */
export async function getDefaultStore(env = process.env) {
  const file = vectorStorePath(env);
  if (!stores.has(file)) stores.set(file, new VectorStore({ file }).load());
  return stores.get(file);
}

export function resetDefaultStores() {
  stores.clear();
}
