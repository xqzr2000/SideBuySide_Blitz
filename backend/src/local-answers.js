import { openAiModel } from './openai.js';

/**
 * Canned replies for small talk that never needs the model. A message only matches
 * when the whole thing is the phrase, so "hi, compare my shelf" still goes to SideKick.
 */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const CAPABILITIES = [
  'compare what is on your shelf and pick the best buy',
  'search the web for a cheaper listing and check its live price',
  'organize, tag, and rank your saved items',
  'spot the same product saved from two stores',
  'recommend what to look at next from your shelf history'
];

const RULES = [
  {
    id: 'identity',
    pattern: /^(who|what) (are|r) (you|u)( exactly)?$|^whats? your name$|^what is your name$|^are you (a )?(bot|robot|ai|human|real|person|chatgpt)$|^introduce yourself$/,
    reply: () => 'I am SideKick, the shopping agent inside the SideBuySide side panel. I work with the products you save to your shelf: comparing them, organizing them, and hunting for better deals.'
  },
  {
    id: 'capabilities',
    pattern: /^(help|what can (you|u) do( for me)?|what do you do|how do (you|i use you|i use this)( work)?|how does this work|what are your (features|skills|tools))$/,
    reply: () => `Here is what I can do:\n${CAPABILITIES.map((line) => `• ${line}`).join('\n')}\n\nTry a chip below the chat, or ask something like "which of these is the best value?"`
  },
  {
    id: 'model',
    pattern: /^(what|which) (model|llm|ai model|language model)( are you| do you use| is this| powers you| are you using| is running)?$/,
    reply: ({ env }) => `This backend is configured to answer with ${openAiModel(env)}. Change OPENAI_MODEL in backend/.env to use a different model.`
  },
  {
    id: 'greeting',
    pattern: /^(hi|hello|hey|hiya|yo|howdy|greetings|good (morning|afternoon|evening))( there)?( sidekick)?$/,
    reply: ({ items }) => (items.length
      ? `Hi! You have ${items.length} item${items.length === 1 ? '' : 's'} on your shelf. Want me to compare them or look for a better deal?`
      : 'Hi! Save a few products with Add2SideBuySide and I can compare them and hunt for better deals.')
  },
  {
    id: 'how-are-you',
    pattern: /^(how are you|how r u|hows it going|how are you doing|whats up|sup)( today)?$/,
    reply: () => 'Doing well and ready to shop. What would you like me to look at?'
  },
  {
    id: 'thanks',
    pattern: /^(thanks|thank you|thx|ty|cheers|great thanks|ok thanks|thanks a lot|thank you so much|perfect thanks)( sidekick)?$/,
    reply: () => 'You are welcome! Ask any time you want another comparison or price check.'
  },
  {
    id: 'goodbye',
    pattern: /^(bye|goodbye|see you|see ya|later|good night)$/,
    reply: () => 'Bye! Your shelf will be here when you get back.'
  }
];

export function localAnswer(text, { items = [], env = process.env } = {}) {
  const normalized = normalize(text);
  if (!normalized || normalized.length > 60) return null;
  const rule = RULES.find((entry) => entry.pattern.test(normalized));
  return rule ? { id: rule.id, message: rule.reply({ items, env }) } : null;
}
