import { executeTool, normalizeItems, toolDefinitions } from './tools.js';
import { searchStatus } from './search.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_ROUNDS = 8;

function parseToolArgs(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

async function callOpenRouter({ messages, tools }, env = process.env, fetchImpl = globalThis.fetch) {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) {
    const error = new Error('OPENROUTER_API_KEY is not configured on the backend.');
    error.statusCode = 503;
    throw error;
  }

  const model = env.OPENROUTER_MODEL || 'openai/gpt-5-mini';
  const response = await fetchImpl(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': env.OPENROUTER_SITE_URL || 'http://localhost:8787',
      'X-Title': env.OPENROUTER_APP_NAME || 'SideBuySide SideKick'
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

export function buildSystemPrompt({ items = [], env = process.env } = {}) {
  const search = searchStatus(env);
  const lines = [
    'You are SideKick, the shopping agent inside the SideBuySide Chrome side panel.',
    'You do three jobs: organize the Side Shelf, compare what is on it, and search the internet for a better deal on it.',
    '',
    'Tools:',
    '- list_items, compare_items, price_summary: read the shelf. Call them before any claim about what is saved.',
    '- organize_items and tag_items change the real cards in the side panel, so only call them when the user wants the shelf rearranged or labelled.',
    '- find_duplicates spots the same product saved from two stores; rank_items scores a shortlist on weighted criteria.',
    '- search_deals looks for cheaper listings, fetch_offer opens one listing and reads its live price, evaluate_deal does the savings math.',
    '',
    'Rules:',
    '- Never invent a price, spec, discount, rating, or stock level. If a field is missing, say it is missing.',
    '- A price is only a fact once fetch_offer or the search provider returned it. Snippet prices are leads; label them as unconfirmed.',
    '- Converted prices come from an offline rate table. Call converted figures approximate whenever you quote one.',
    '- A lower price alone does not make an item better. Weigh rating, review volume, seller, condition, and shipping, and say what you could not check.',
    '- Before recommending an offer, check it is the same model and not used, refurbished, or a bundle.',
    '- You cannot buy anything or add anything to a retailer cart; the side panel handles that.',
    '- Be concise by default: a short verdict, then the few facts behind it. Expand only when asked.'
  ];

  lines.push(
    '',
    search.configured
      ? `Web search is available through the ${search.provider} provider.`
      : 'Web search is NOT configured on this backend. If the user asks for better deals, say so plainly and share the setup hint from the tool result instead of guessing at prices.'
  );

  const withoutPrice = items.filter((item) => item.price === null).length;
  lines.push(
    '',
    `Shelf right now: ${items.length} saved item${items.length === 1 ? '' : 's'}${withoutPrice ? `, ${withoutPrice} without a price` : ''}.`
  );

  return lines.join('\n');
}

export async function runSideKick({ history = [], items = [], env = process.env, fetchImpl } = {}) {
  const safeItems = normalizeItems(items);
  const messages = [
    { role: 'system', content: buildSystemPrompt({ items: safeItems, env }) },
    ...history.slice(-20)
  ];

  let lastText = '';
  const orchestration = [];
  const actions = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await callOpenRouter({ messages, tools: toolDefinitions }, env, fetchImpl || globalThis.fetch);
    const assistant = result?.choices?.[0]?.message;
    if (!assistant) throw new Error('OpenRouter returned no assistant message.');

    messages.push(assistant);
    if (assistant.content) lastText = assistant.content;

    const calls = assistant.tool_calls || [];
    if (!calls.length) {
      return { message: assistant.content || lastText || 'I could not produce a response.', orchestration, actions };
    }

    for (const call of calls) {
      const name = call?.function?.name;
      const args = parseToolArgs(call?.function?.arguments);
      let output;
      try {
        const executed = await executeTool(name, args, safeItems, { env, fetchImpl });
        output = executed.result;
        actions.push(...executed.actions);
      } catch (error) {
        // A failing tool should degrade the answer, not the whole conversation.
        output = { error: error.message || 'The tool failed.' };
      }
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
    orchestration,
    actions
  };
}
