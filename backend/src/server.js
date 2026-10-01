import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { promptOverhead, runSideKick } from './agent.js';
import { toolDefinitions } from './tools.js';
import { searchStatus } from './search.js';
import { embeddingStatus } from './embeddings.js';
import { getDefaultStore } from './vectorstore.js';
import { buildTasteProfile, syncShelfHistory } from './history.js';
import { openAiModel } from './openai.js';

const envFile = new URL('../.env', import.meta.url);
// Variables the shell or Codespaces injected always win over .env.
const shellKeys = new Set(Object.keys(process.env));
const fileKeys = new Set();
let envFileStamp = null;

/**
 * Load backend/.env, and load it again whenever it changes, so switching
 * OPENAI_MODEL (or any other setting) takes effect on the next request without
 * restarting the server.
 */
function refreshEnv() {
  let stamp;
  try {
    stamp = statSync(envFile).mtimeMs;
  } catch {
    stamp = null; // .env is optional; environment variables can also come from the shell.
  }
  if (stamp === envFileStamp) return;
  envFileStamp = stamp;

  let parsed = {};
  if (stamp !== null) {
    try {
      parsed = parseEnv(readFileSync(envFile, 'utf8'));
    } catch (error) {
      console.warn('Could not read backend/.env:', error.message);
      return;
    }
  }
  for (const key of fileKeys) {
    if (!(key in parsed)) delete process.env[key];
  }
  fileKeys.clear();
  for (const [key, value] of Object.entries(parsed)) {
    if (shellKeys.has(key)) continue;
    process.env[key] = value;
    fileKeys.add(key);
  }
}

refreshEnv();

const port = Number(process.env.PORT || 8787);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
  });
  res.end(payload);
}


function isAuthorized(req) {
  const expected = process.env.SIDEBUYSIDE_TOKEN;
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Invalid JSON body.');
    error.statusCode = 400;
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS'
    });
    return res.end();
  }

  refreshEnv();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    const search = searchStatus(process.env);
    const memory = (await getDefaultStore(process.env)).stats();
    return sendJson(res, 200, {
      ok: true,
      service: 'SideBuySide',
      provider: 'openai',
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      model: openAiModel(process.env),
      search,
      embeddings: embeddingStatus(process.env),
      memory,
      promptOverhead: promptOverhead({ env: process.env, memory }),
      tools: toolDefinitions.map((tool) => tool.function.name)
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    try {
      const body = await readJson(req);
      const history = Array.isArray(body?.history) ? body.history : [];
      const items = Array.isArray(body?.items) ? body.items : [];
      const events = Array.isArray(body?.shelfHistory) ? body.shelfHistory : [];
      if (!history.length) return sendJson(res, 400, { error: 'history is required' });

      const store = await getDefaultStore(process.env);
      let memory = null;
      try {
        // Index before answering so SideKick's memory includes what was just saved.
        memory = await syncShelfHistory({ items, events, store });
      } catch (error) {
        console.warn('Shelf history sync failed:', error.message);
      }

      const result = await runSideKick({ history, items, store, env: process.env });
      return sendJson(res, 200, { ...result, memory });
    } catch (error) {
      console.error(error);
      return sendJson(res, error.statusCode || 500, { error: error.message || 'Unexpected server error' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/history/sync') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    try {
      const body = await readJson(req);
      const store = await getDefaultStore(process.env);
      const memory = await syncShelfHistory({
        items: Array.isArray(body?.items) ? body.items : [],
        events: Array.isArray(body?.shelfHistory) ? body.shelfHistory : [],
        store
      });
      return sendJson(res, 200, { ok: true, memory });
    } catch (error) {
      console.error(error);
      return sendJson(res, error.statusCode || 500, { error: error.message || 'Unexpected server error' });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/history/stats') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    const store = await getDefaultStore(process.env);
    const profile = buildTasteProfile(store);
    const { vector, negativeVector, ...readable } = profile;
    return sendJson(res, 200, {
      ok: true,
      memory: store.stats(),
      embeddings: embeddingStatus(process.env),
      profile: readable
    });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/history') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    const store = await getDefaultStore(process.env);
    const cleared = store.clear();
    await store.save();
    return sendJson(res, 200, { ok: true, cleared });
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`SideBuySide backend listening on http://0.0.0.0:${port} (model: ${openAiModel(process.env)})`);
});
