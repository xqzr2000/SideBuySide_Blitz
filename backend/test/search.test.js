import test from 'node:test';
import assert from 'node:assert/strict';
import { clearSearchCache, resolveProvider, searchStatus, searchWeb } from '../src/search.js';
import { convert, parsePriceFromText, withNormalizedPrices } from '../src/currency.js';

test('resolveProvider prefers an explicit setting, then the first configured key', () => {
  assert.equal(resolveProvider({}), 'none');
  assert.equal(resolveProvider({ OPENAI_API_KEY: 'k' }), 'openai');
  assert.equal(resolveProvider({ OPENAI_API_KEY: 'k', BRAVE_SEARCH_API_KEY: 'b' }), 'brave');
  assert.equal(resolveProvider({ TAVILY_API_KEY: 't', BRAVE_SEARCH_API_KEY: 'b' }), 'tavily');
  assert.equal(resolveProvider({ SEARCH_PROVIDER: 'serpapi', TAVILY_API_KEY: 't' }), 'serpapi');
});

test('searchStatus hands back setup instructions when search is off', () => {
  const status = searchStatus({});
  assert.equal(status.configured, false);
  assert.match(status.setupHint, /BRAVE_SEARCH_API_KEY/);
});

test('searchWeb builds site filters and pulls prices out of snippets', async () => {
  clearSearchCache();
  let requested = null;
  const fetchImpl = async (url, options) => {
    requested = JSON.parse(options.body);
    return new Response(JSON.stringify({
      results: [
        { title: 'Nova Earbuds', url: 'https://www.shop.example.com/nova', content: 'Now CA$89.99 with free shipping' },
        { title: 'No price here', url: 'https://other.example.com/x', content: 'Great product' }
      ]
    }), { headers: { 'Content-Type': 'application/json' } });
  };

  const result = await searchWeb(
    { query: 'nova earbuds', includeSites: ['shop.example.com'], excludeSites: ['spam.example.com'] },
    { env: { TAVILY_API_KEY: 'test' }, fetchImpl }
  );

  assert.match(requested.query, /site:shop\.example\.com/);
  assert.match(requested.query, /-site:spam\.example\.com/);
  assert.equal(result.results[0].price, 89.99);
  assert.equal(result.results[0].currency, 'CAD');
  assert.equal(result.results[0].site, 'shop.example.com');
  assert.equal(result.results[0].priceSource, 'snippet');
  assert.equal(result.results[1].priceSource, 'none');
});

test('searchWeb reads OpenAI web_search citations from the Responses API', async () => {
  clearSearchCache();
  let request = null;
  const text = 'Store A lists it at $199.00, in stock.\nStore B has it for $210.00.';
  const fetchImpl = async (url, options) => {
    request = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed' },
        {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'output_text',
            text,
            annotations: [
              { type: 'url_citation', start_index: 30, end_index: 38, url: 'https://a.example.com/p?utm_source=openai', title: 'Store A' },
              { type: 'url_citation', start_index: 60, end_index: 68, url: 'https://b.example.com/p', title: 'Store B' },
              { type: 'url_citation', start_index: 62, end_index: 68, url: 'https://b.example.com/p', title: 'Store B again' }
            ]
          }]
        }
      ]
    }), { headers: { 'Content-Type': 'application/json' } });
  };

  const result = await searchWeb(
    { query: 'nova earbuds' },
    { env: { OPENAI_API_KEY: 'k', OPENAI_SEARCH_COUNTRY: 'ca' }, fetchImpl }
  );

  assert.equal(request.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(request.body.tools, [{ type: 'web_search', user_location: { type: 'approximate', country: 'CA' } }]);
  assert.equal(request.body.model, 'gpt-5-mini');
  assert.equal(result.provider, 'openai');
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].url, 'https://a.example.com/p');
  assert.equal(result.results[0].price, 199);
  assert.equal(result.results[1].price, 210);
  assert.match(result.providerSummary, /Store A/);
});

test('searchWeb returns provider errors instead of throwing', async () => {
  clearSearchCache();
  const fetchImpl = async () => new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 429 });
  const result = await searchWeb({ query: 'nova' }, { env: { TAVILY_API_KEY: 'k' }, fetchImpl });
  assert.deepEqual(result.results, []);
  assert.match(result.error, /quota exceeded/);
});

test('searchWeb serves a repeated query from cache', async () => {
  clearSearchCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({ results: [{ title: 'x', url: 'https://x.example.com', content: '' }] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  };
  const deps = { env: { TAVILY_API_KEY: 'k' }, fetchImpl };
  await searchWeb({ query: 'same query' }, deps);
  const second = await searchWeb({ query: 'same query' }, deps);
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
});

test('parsePriceFromText understands symbols and currency codes', () => {
  assert.deepEqual(parsePriceFromText('Only $1,299.00 today'), { price: 1299, currency: 'USD' });
  assert.deepEqual(parsePriceFromText('Now CA$89.99'), { price: 89.99, currency: 'CAD' });
  assert.deepEqual(parsePriceFromText('249.50 EUR'), { price: 249.5, currency: 'EUR' });
  assert.deepEqual(parsePriceFromText('no price at all'), { price: null, currency: '' });
});

test('convert marks cross-currency results approximate and round-trips', () => {
  assert.deepEqual(convert(100, 'USD', 'USD'), { value: 100, currency: 'USD', approximate: false });
  const cad = convert(100, 'USD', 'CAD');
  assert.equal(cad.approximate, true);
  assert.ok(cad.value > 100);
  assert.equal(convert(100, 'USD', 'XYZ'), null);
});

test('withNormalizedPrices defaults to the only currency on the shelf', () => {
  const single = withNormalizedPrices([{ price: 10, currency: 'GBP' }], '');
  assert.equal(single.targetCurrency, 'GBP');
  assert.equal(single.mixedCurrencies, false);
  assert.equal(single.rateDisclaimer, '');

  const mixed = withNormalizedPrices([{ price: 10, currency: 'GBP' }, { price: 10, currency: 'USD' }], '');
  assert.equal(mixed.targetCurrency, 'USD');
  assert.equal(mixed.mixedCurrencies, true);
  assert.match(mixed.rateDisclaimer, /rough/);
});
