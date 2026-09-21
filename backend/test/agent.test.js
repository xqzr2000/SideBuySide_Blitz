import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, runSideKick } from '../src/agent.js';

const items = [
  { id: 'a', name: 'Acme Headphones One', price: 100, currency: 'CAD', site: 'store-a.com' },
  { id: 'b', name: 'Nova Earbuds', price: null, currency: 'CAD', site: 'store-b.com' }
];

function reply(message) {
  return new Response(JSON.stringify({ choices: [{ message }] }), { headers: { 'Content-Type': 'application/json' } });
}

test('buildSystemPrompt tells SideKick whether web search is available', () => {
  const off = buildSystemPrompt({ items, env: {} });
  assert.match(off, /Web search is NOT configured/);
  assert.match(off, /2 saved items, 1 without a price/);

  const on = buildSystemPrompt({ items, env: { TAVILY_API_KEY: 'k' } });
  assert.match(on, /tavily provider/);
});

test('runSideKick executes tool calls and collects shelf actions', async () => {
  const sent = [];
  let round = 0;
  const fetchImpl = async (_url, options) => {
    sent.push(JSON.parse(options.body));
    round += 1;
    if (round === 1) {
      return reply({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'organize_items', arguments: JSON.stringify({ strategy: 'store' }) }
        }]
      });
    }
    return reply({ role: 'assistant', content: 'Sorted your shelf by store.' });
  };

  const result = await runSideKick({
    history: [{ role: 'user', content: 'organize my shelf by store' }],
    items,
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl
  });

  assert.equal(result.message, 'Sorted your shelf by store.');
  assert.equal(result.orchestration[0].tool, 'organize_items');
  assert.equal(result.actions[0].type, 'reorder');
  assert.deepEqual(result.actions[0].ids, ['a', 'b']);

  const toolMessage = sent[1].messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'call_1');
  assert.match(toolMessage.content, /store-a\.com/);
});

test('runSideKick reports a tool failure back to the model instead of crashing', async () => {
  let round = 0;
  const fetchImpl = async (url) => {
    if (url.includes('openrouter')) {
      round += 1;
      if (round === 1) {
        return reply({
          role: 'assistant',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fetch_offer', arguments: '{"url":"http://127.0.0.1/admin"}' } }]
        });
      }
      return reply({ role: 'assistant', content: 'I could not open that page.' });
    }
    throw new Error('should not be reached');
  };

  const result = await runSideKick({
    history: [{ role: 'user', content: 'check this url' }],
    items,
    env: { OPENROUTER_API_KEY: 'k' },
    fetchImpl
  });

  assert.equal(result.message, 'I could not open that page.');
  assert.match(result.orchestration[0].output.error, /private address/);
});

test('runSideKick refuses to run without an OpenRouter key', async () => {
  await assert.rejects(
    () => runSideKick({ history: [{ role: 'user', content: 'hi' }], items, env: {} }),
    /OPENROUTER_API_KEY/
  );
});
