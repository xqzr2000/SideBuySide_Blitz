import http from 'node:http';
import { loadEnvFile } from 'node:process';
import { runSideKick } from './agent.js';
import { toolDefinitions } from './tools.js';
import { searchStatus } from './search.js';
import { embeddingStatus } from './embeddings.js';
import { getDefaultStore } from './vectorstore.js';
import { buildTasteProfile, syncShelfHistory } from './history.js';

try {
  loadEnvFile(new URL('../.env', import.meta.url));
} catch {
  // .env is optional; environment variables can also be injected by the shell/Codespaces.
}

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

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    const search = searchStatus(process.env);
    return sendJson(res, 200, {
      ok: true,
      service: 'SideBuySide',
      openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini',
      search,
      embeddings: embeddingStatus(process.env),
      memory: (await getDefaultStore(process.env)).stats(),
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

      const result = await runSideKick({ history, items, store });
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
  console.log(`SideBuySide backend listening on http://0.0.0.0:${port}`);
});
