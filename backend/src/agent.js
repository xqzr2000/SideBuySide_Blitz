import { executeTool, normalizeItems, toolDefinitions } from './tools.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function parseToolArgs(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function callOpenRouter({ messages, tools }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENROUTER_API_KEY is not configured on the backend.');
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini';
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_SITE_URL || 'http://localhost:8787',
      'X-Title': process.env.OPENROUTER_APP_NAME || 'SideBuySide SideKick'
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.3
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `OpenRouter request failed (${response.status}).`);
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

export async function runSideKick({ history = [], items = [] }) {
  const safeItems = normalizeItems(items);
  const system = {
    role: 'system',
    content: [
      'You are SideKick, the shopping comparison agent inside the SideBuySide Chrome extension.',
      'Help the user compare products, notice tradeoffs, organize the saved cards, and reason about buying choices.',
      'Use tools whenever the answer depends on the current saved cards. Do not invent prices, specs, discounts, stock, ratings, or facts that are absent from the cards.',
      'A low price alone is not enough to call something better. Explain uncertainty and missing information.',
      'You cannot complete purchases or claim that an item was added to a retailer cart. The extension UI handles cart actions.',
      'Keep responses useful and concise unless the user asks for a detailed analysis.'
    ].join(' ')
  };

  const messages = [system, ...history.slice(-20)];
  let lastText = '';
  const orchestration = [];

  for (let round = 0; round < 5; round += 1) {
    const result = await callOpenRouter({ messages, tools: toolDefinitions });
    const assistant = result?.choices?.[0]?.message;
    if (!assistant) throw new Error('OpenRouter returned no assistant message.');

    messages.push(assistant);
    if (assistant.content) lastText = assistant.content;

    const calls = assistant.tool_calls || [];
    if (!calls.length) {
      return { message: assistant.content || lastText || 'I could not produce a response.', orchestration };
    }

    for (const call of calls) {
      const name = call?.function?.name;
      const args = parseToolArgs(call?.function?.arguments);
      const output = executeTool(name, args, safeItems);
      orchestration.push({ tool: name, args, output });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(output)
      });
    }
  }

  return {
    message: lastText || 'I reached the tool-orchestration limit. Try asking a narrower comparison question.',
    orchestration
  };
}
