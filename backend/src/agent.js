import { executeTool, normalizeItems, toolDefinitions } from './tools.js';
import { searchStatus } from './search.js';
import { embeddingStatus } from './embeddings.js';
import { openAiBaseUrl, openAiErrorMessage, openAiHeaders, openAiModel } from './openai.js';

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

/**
 * Only user and assistant text turns come from the panel. Anything else (a stray
 * "system" turn, a malformed entry) is dropped rather than forwarded to the model.
 */
function sanitizeHistory(history = []) {
  return history
    .filter((message) => (message?.role === 'user' || message?.role === 'assistant') && typeof message.content === 'string')
    .map(({ role, content }) => ({ role, content }))
    .slice(-20);
}

/**
 * Echo an assistant turn back with only the fields the Chat Completions API accepts
 * as input. Response-only fields such as `annotations` are rejected if sent back.
 */
function assistantTurn(message) {
  const turn = { role: 'assistant', content: message.content ?? null };
  if (message.tool_calls?.length) {
    turn.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: call.type || 'function',
      function: { name: call.function?.name, arguments: call.function?.arguments ?? '{}' }
    }));
  }
  return turn;
}

async function callOpenAI({ messages, tools }, env = process.env, fetchImpl = globalThis.fetch) {
  if (!env.OPENAI_API_KEY) {
    const error = new Error('OPENAI_API_KEY is not configured on the backend.');
    error.statusCode = 503;
    throw error;
  }

  const body = {
    model: openAiModel(env),
    messages,
    tools,
    tool_choice: 'auto'
  };
  // GPT-5 and o-series models reject any temperature but the default, so it is
  // only sent when explicitly configured for a model that accepts it.
  const temperature = Number(env.OPENAI_TEMPERATURE);
  if (env.OPENAI_TEMPERATURE !== undefined && env.OPENAI_TEMPERATURE !== '' && Number.isFinite(temperature)) {
    body.temperature = temperature;
  }
  if (env.OPENAI_REASONING_EFFORT) body.reasoning_effort = env.OPENAI_REASONING_EFFORT;

  const response = await fetchImpl(`${openAiBaseUrl(env)}/chat/completions`, {
    method: 'POST',
    headers: openAiHeaders(env),
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(openAiErrorMessage(data, response.status));
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

export function buildSystemPrompt({ items = [], env = process.env, memory = null } = {}) {
  const search = searchStatus(env);
  const embeddings = embeddingStatus(env);
  const lines = [
    'You are SideKick, the shopping agent inside the SideBuySide Chrome side panel.',
    'You do three jobs: organize the Side Shelf, compare what is on it, and search the internet for a better deal on it.',
    '',
    'Tools:',
    '- list_items, compare_items, price_summary: read the shelf. Call them before any claim about what is saved.',
    '- organize_items and tag_items change the real cards in the side panel, so only call them when the user wants the shelf rearranged or labelled.',
    '- find_duplicates spots the same product saved from two stores; rank_items scores a shortlist on weighted criteria.',
    '- search_deals looks for cheaper listings, fetch_offer opens one listing and reads its live price, evaluate_deal does the savings math.',
    '- search_history, similar_items, taste_profile and recommend_products read the shelf-history vector database: every product ever saved, including cards the user later removed.',
    '',
    'Recommending:',
    '- Ground every recommendation in the history tools. Name the saved products that justify it instead of asserting a preference.',
    '- Items recommended from history are things the user already saved and did not keep; say so rather than passing them off as new finds.',
    '- Say when the profile is thin, and never infer sensitive traits about the user from their shopping history.',
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

  lines.push(embeddings.semantic
    ? `Shelf memory is embedded with ${embeddings.provider} (${embeddings.model}).`
    : 'Shelf memory uses the built-in offline encoder, which matches wording rather than meaning: near-synonyms will not match, so do not read too much into a weak similarity score.');

  const withoutPrice = items.filter((item) => item.price === null).length;
  lines.push(
    '',
    `Shelf right now: ${items.length} saved item${items.length === 1 ? '' : 's'}${withoutPrice ? `, ${withoutPrice} without a price` : ''}.`
  );
  if (memory?.records) {
    lines.push(`Shelf history indexed: ${memory.records} product${memory.records === 1 ? '' : 's'} (${memory.pastItems} no longer on the shelf).`);
  }

  return lines.join('\n');
}

export async function runSideKick({ history = [], items = [], env = process.env, fetchImpl, store = null } = {}) {
  const safeItems = normalizeItems(items);
  const messages = [
    { role: 'system', content: buildSystemPrompt({ items: safeItems, env, memory: store?.stats?.() || null }) },
    ...sanitizeHistory(history)
  ];

  let lastText = '';
  const orchestration = [];
  const actions = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const result = await callOpenAI({ messages, tools: toolDefinitions }, env, fetchImpl || globalThis.fetch);
    const assistant = result?.choices?.[0]?.message;
    if (!assistant) throw new Error('OpenAI returned no assistant message.');

    messages.push(assistantTurn(assistant));
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
        const executed = await executeTool(name, args, safeItems, { env, fetchImpl, store });
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
