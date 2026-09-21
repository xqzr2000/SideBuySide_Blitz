import http from 'node:http';
import { loadEnvFile } from 'node:process';
import { runSideKick } from './agent.js';

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    return sendJson(res, 200, {
      ok: true,
      service: 'SideBuySide',
      openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
      model: process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini'
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (!isAuthorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
    try {
      const body = await readJson(req);
      const history = Array.isArray(body?.history) ? body.history : [];
      const items = Array.isArray(body?.items) ? body.items : [];
      if (!history.length) return sendJson(res, 400, { error: 'history is required' });
      const result = await runSideKick({ history, items });
      return sendJson(res, 200, result);
    } catch (error) {
      console.error(error);
      return sendJson(res, error.statusCode || 500, { error: error.message || 'Unexpected server error' });
    }
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`SideBuySide backend listening on http://0.0.0.0:${port}`);
});
