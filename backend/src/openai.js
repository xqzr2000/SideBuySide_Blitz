export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini';

/** Honour OPENAI_BASE_URL so an Azure or other OpenAI-compatible gateway can stand in. */
export function openAiBaseUrl(env = process.env) {
  return String(env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

/** Model IDs carried over from OpenRouter look like "openai/gpt-5-mini"; OpenAI wants the bare ID. */
export function normalizeModel(value, fallback = DEFAULT_OPENAI_MODEL) {
  const model = String(value || '').trim();
  return (model || fallback).replace(/^openai\//, '');
}

export function openAiModel(env = process.env) {
  return normalizeModel(env.OPENAI_MODEL);
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
