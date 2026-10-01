// Only used when OPENAI_MODEL is unset; set OPENAI_MODEL in backend/.env to pick any model.
export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

/** Honour OPENAI_BASE_URL so an Azure or other OpenAI-compatible gateway can stand in. */
export function openAiBaseUrl(env = process.env) {
  return String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/**
 * Model IDs carried over from OpenRouter look like "openai/gpt-5-mini"; OpenAI itself
 * wants the bare ID. Gateways set through OPENAI_BASE_URL (OpenRouter, LiteLLM, …)
 * need the prefixed ID, so it is kept for them.
 */
export function normalizeModel(value, fallback = DEFAULT_OPENAI_MODEL, env = process.env) {
  const model = String(value || '').trim() || fallback;
  return /^https:\/\/api\.openai\.com\b/.test(openAiBaseUrl(env)) ? model.replace(/^openai\//, '') : model;
}

export function openAiModel(env = process.env) {
  return normalizeModel(env.OPENAI_MODEL, DEFAULT_OPENAI_MODEL, env);
}

export function openAiHeaders(env = process.env) {
  return {
    Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    ...(env.OPENAI_ORG_ID ? { 'OpenAI-Organization': env.OPENAI_ORG_ID } : {}),
    ...(env.OPENAI_PROJECT_ID ? { 'OpenAI-Project': env.OPENAI_PROJECT_ID } : {})
  };
}

export function openAiErrorMessage(data, status, label = 'OpenAI request') {
  return data?.error?.message || `${label} failed (${status}).`;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 };
}

/**
 * Fold one API response's `usage` into a running tally. Chat Completions reports
 * prompt/completion tokens, the Responses API input/output tokens, and embeddings
 * only prompt tokens, so all three shapes are accepted.
 */
export function addUsage(tally, usage) {
  if (!usage || typeof usage !== 'object') return tally;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  const total = Number(usage.total_tokens) || prompt + completion;
  tally.promptTokens += prompt;
  tally.completionTokens += completion;
  tally.totalTokens += total;
  tally.requests += 1;
  return tally;
}

/** Rough count for text the API has not seen yet: about four characters per token. */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / 4);
}
