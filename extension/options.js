const form = document.getElementById('form');
const input = document.getElementById('apiBaseUrl');
const status = document.getElementById('status');
const tokenInput = document.getElementById('apiToken');
const memory = document.getElementById('memory');
const forgetButton = document.getElementById('forgetButton');

async function config() {
  const { apiBaseUrl = 'http://127.0.0.1:8787', apiToken = '' } = await chrome.storage.sync.get(['apiBaseUrl', 'apiToken']);
  return { apiBaseUrl: apiBaseUrl.replace(/\/$/, ''), apiToken };
}

function authHeaders(apiToken) {
  return apiToken ? { Authorization: `Bearer ${apiToken}` } : {};
}

async function refreshMemory() {
  const { apiBaseUrl, apiToken } = await config();
  try {
    const response = await fetch(`${apiBaseUrl}/api/history/stats`, { headers: authHeaders(apiToken) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}.`);
    const stats = data.memory || {};
    const brands = (data.profile?.topBrands || []).slice(0, 3).map((entry) => entry.value).join(', ');
    memory.textContent = [
      `${stats.records || 0} products indexed (${stats.onShelf || 0} on the shelf, ${stats.pastItems || 0} past).`,
      `Embeddings: ${data.embeddings?.provider} (${data.embeddings?.semantic ? 'semantic' : 'offline, matches wording only'}).`,
      brands ? `Top brands: ${brands}.` : 'Not enough history for a taste profile yet.'
    ].join(' ');
  } catch (error) {
    memory.textContent = `Could not read the memory index: ${error.message}`;
  }
}

forgetButton.addEventListener('click', async () => {
  if (!confirm('Delete the indexed shelf history from the backend and clear the local event log? This cannot be undone.')) return;
  const { apiBaseUrl, apiToken } = await config();
  forgetButton.disabled = true;
  try {
    const response = await fetch(`${apiBaseUrl}/api/history`, { method: 'DELETE', headers: authHeaders(apiToken) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}.`);
    await chrome.storage.local.set({ shelfHistory: [] });
    memory.textContent = `Forgotten: ${data.cleared} indexed product${data.cleared === 1 ? '' : 's'} removed, local log cleared.`;
  } catch (error) {
    memory.textContent = `Could not clear the memory index: ${error.message}`;
  } finally {
    forgetButton.disabled = false;
  }
});

async function init() {
  const { apiBaseUrl, apiToken } = await config();
  input.value = apiBaseUrl;
  tokenInput.value = apiToken;
  refreshMemory();
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
    if (data.embeddings) {
      lines.push(`Shelf memory: ${data.embeddings.provider}${data.embeddings.semantic ? '' : ' (offline encoder)'}.`);
    }
    if (Array.isArray(data.tools)) lines.push(`SideKick tools: ${data.tools.length}.`);
    status.textContent = lines.join(' ');
    refreshMemory();
  } catch (error) {
    status.textContent = `Saved, but could not connect: ${error.message}`;
  }
});

init();
