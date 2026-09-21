/**
 * Offline FX table so cross-currency shelves can be compared without a network call.
 * Values are approximate USD per 1 unit and WILL drift; every converted number is
 * returned with `approximate: true` so SideKick has to say so out loud.
 */
export const DEFAULT_RATES_USD = {
  USD: 1,
  CAD: 0.73,
  EUR: 1.08,
  GBP: 1.27,
  AUD: 0.66,
  NZD: 0.61,
  CHF: 1.12,
  JPY: 0.0067,
  CNY: 0.14,
  INR: 0.012,
  KRW: 0.00073,
  MXN: 0.05,
  BRL: 0.18,
  SEK: 0.095,
  NOK: 0.094,
  DKK: 0.145,
  PLN: 0.25,
  SGD: 0.74,
  HKD: 0.128
};

const SYMBOLS = [
  ['CA$', 'CAD'],
  ['C$', 'CAD'],
  ['A$', 'AUD'],
  ['NZ$', 'NZD'],
  ['US$', 'USD'],
  ['HK$', 'HKD'],
  ['R$', 'BRL'],
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['¥', 'JPY'],
  ['₹', 'INR'],
  ['₩', 'KRW'],
  ['$', 'USD']
];

/** Merge the built-in table with an FX_RATES_USD override (JSON of {code: usdPerUnit}). */
export function loadRates(env = process.env) {
  const rates = { ...DEFAULT_RATES_USD };
  const raw = env?.FX_RATES_USD;
  if (!raw) return rates;
  try {
    const parsed = JSON.parse(raw);
    for (const [code, value] of Object.entries(parsed)) {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) rates[String(code).toUpperCase()] = n;
    }
  } catch {
    // A malformed override should never take the shelf down; fall back to defaults.
  }
  return rates;
}

export function currencyFromText(value) {
  const text = String(value || '').toUpperCase();
  const code = text.match(/\b(USD|CAD|EUR|GBP|AUD|JPY|CNY|INR|KRW|NZD|CHF|MXN|BRL|SEK|NOK|DKK|PLN|SGD|HKD)\b/);
  if (code) return code[1];
  for (const [symbol, currency] of SYMBOLS) {
    if (text.includes(symbol)) return currency;
  }
  return '';
}

/** Pull the first plausible price out of free text such as a search snippet. */
export function parsePriceFromText(value) {
  const text = String(value || '');
  const match = text.match(/(?:CA\$|C\$|A\$|NZ\$|US\$|HK\$|R\$|\$|€|£|¥|₹|₩)\s?(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/)
    || text.match(/(\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?)\s?(?:USD|CAD|EUR|GBP|AUD|JPY|CNY|INR|KRW|NZD|CHF)\b/i);
  if (!match) return { price: null, currency: '' };
  const price = Number(String(match[1]).replace(/[,\s]/g, ''));
  if (!Number.isFinite(price)) return { price: null, currency: '' };
  return { price, currency: currencyFromText(match[0]) || currencyFromText(text) };
}

export function convert(amount, from, to, rates = loadRates()) {
  const value = Number(amount);
  const source = String(from || '').toUpperCase();
  const target = String(to || '').toUpperCase();
  if (!Number.isFinite(value) || !source || !target) return null;
  if (source === target) return { value: round(value), currency: target, approximate: false };
  const fromRate = rates[source];
  const toRate = rates[target];
  if (!fromRate || !toRate) return null;
  return { value: round((value * fromRate) / toRate), currency: target, approximate: true };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Add a `normalized` price to each item so comparisons across stores in different
 * currencies are at least directionally honest.
 */
export function withNormalizedPrices(items, targetCurrency, rates = loadRates()) {
  const target = String(targetCurrency || '').toUpperCase();
  const currencies = new Set(items.map((item) => item.currency).filter(Boolean));
  const resolved = target || (currencies.size === 1 ? [...currencies][0] : 'USD');

  let unconvertible = 0;
  const priced = items.map((item) => {
    if (item.price === null) return { ...item, normalized: null };
    const converted = convert(item.price, item.currency || resolved, resolved, rates);
    if (!converted) unconvertible += 1;
    return { ...item, normalized: converted };
  });

  return {
    targetCurrency: resolved,
    mixedCurrencies: currencies.size > 1,
    unconvertible,
    items: priced,
    rateDisclaimer: currencies.size > 1 || (target && currencies.size && !currencies.has(resolved))
      ? 'Converted with a built-in offline rate table. Treat converted values as rough, and say so when reporting them.'
      : ''
  };
}
