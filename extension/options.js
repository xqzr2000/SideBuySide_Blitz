const form = document.getElementById('form');
const input = document.getElementById('apiBaseUrl');
const status = document.getElementById('status');
const tokenInput = document.getElementById('apiToken');

async function init() {
  const { apiBaseUrl = 'http://127.0.0.1:8787', apiToken = '' } = await chrome.storage.sync.get(['apiBaseUrl', 'apiToken']);
  input.value = apiBaseUrl;
  tokenInput.value = apiToken;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const apiBaseUrl = input.value.trim().replace(/\/$/, '');
  const apiToken = tokenInput.value.trim();
  await chrome.storage.sync.set({ apiBaseUrl, apiToken });
  status.textContent = 'Saved. Testing connection…';
  try {
    const response = await fetch(`${apiBaseUrl}/health`, {
      headers: apiToken ? { Authorization: `Bearer ${apiToken}` } : {}
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error('Health check failed.');
    const lines = [data.openRouterConfigured
      ? `Connected. SideKick model: ${data.model}`
      : 'Connected, but OPENROUTER_API_KEY is not configured yet.'];
    if (data.search) {
      lines.push(data.search.configured
        ? `Web search: on (${data.search.provider}).`
        : 'Web search: off. Set TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, SERPAPI_API_KEY, or rely on OpenRouter\'s web plugin.');
    }
    if (Array.isArray(data.tools)) lines.push(`SideKick tools: ${data.tools.length}.`);
    status.textContent = lines.join(' ');
  } catch (error) {
    status.textContent = `Saved, but could not connect: ${error.message}`;
  }
});

init();
