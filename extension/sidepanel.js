const shelfView = document.getElementById('shelfView');
const chatView = document.getElementById('chatView');
const cards = document.getElementById('cards');
const emptyState = document.getElementById('emptyState');
const status = document.getElementById('status');
const talkButton = document.getElementById('talkButton');
const backButton = document.getElementById('backButton');
const settingsButton = document.getElementById('settingsButton');
const detailsDialog = document.getElementById('detailsDialog');
const detailsBody = document.getElementById('detailsBody');
const closeDetails = document.getElementById('closeDetails');
const chatMessages = document.getElementById('chatMessages');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const sendButton = document.getElementById('sendButton');
const chatError = document.getElementById('chatError');
const clearChatButton = document.getElementById('clearChatButton');

let currentItems = [];
let history = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatPrice(item) {
  if (item.price === null || item.price === undefined || Number.isNaN(Number(item.price))) return 'Price unavailable';
  try {
    return new Intl.NumberFormat(undefined, {
      style: item.currency ? 'currency' : 'decimal',
      currency: item.currency || undefined,
      maximumFractionDigits: 2
    }).format(Number(item.price));
  } catch {
    return `${item.currency || ''} ${Number(item.price).toFixed(2)}`.trim();
  }
}

function showStatus(message, kind = '') {
  status.textContent = message;
  status.className = `status ${kind}`.trim();
  setTimeout(() => status.classList.add('hidden'), 3500);
}

async function loadItems() {
  const data = await chrome.storage.local.get(['items', 'chatHistory']);
  currentItems = Array.isArray(data.items) ? data.items : [];
  history = Array.isArray(data.chatHistory) ? data.chatHistory : [];
  renderCards();
  renderChat();
}

function renderCards() {
  emptyState.classList.toggle('hidden', currentItems.length > 0);
  cards.innerHTML = currentItems.map((item) => {
    const image = item.image
      ? `<img class="product-image" src="${escapeHtml(item.image)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="product-image placeholder">S</div>`;
    return `
      <article class="card" data-id="${escapeHtml(item.id)}">
        <div class="card-main">
          ${image}
          <div>
            <h2 class="product-title">${escapeHtml(item.name)}</h2>
            <div class="product-meta">${escapeHtml(item.brand || item.site || 'Saved product')}</div>
            <div class="price">${escapeHtml(formatPrice(item))}</div>
          </div>
        </div>
        <div class="card-actions">
          <button data-action="cart">Add2Cart</button>
          <button class="remove-button" data-action="remove">Remove</button>
          <button data-action="details">Details</button>
        </div>
      </article>`;
  }).join('');
}

function renderChat() {
  chatMessages.innerHTML = '';
  if (!history.length) {
    addMessageElement('assistant', currentItems.length
      ? `I can see ${currentItems.length} saved item${currentItems.length === 1 ? '' : 's'}. Ask me to compare them, point out tradeoffs, or organize the shelf.`
      : 'Add a few shopping items first, then I can compare and organize them.');
    return;
  }
  for (const message of history) addMessageElement(message.role, message.content);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addMessageElement(role, content, pending = false) {
  const div = document.createElement('div');
  div.className = `message ${role}${pending ? ' pending' : ''}`;
  div.textContent = content;
  chatMessages.appendChild(div);
  div.scrollIntoView({ block: 'end' });
  return div;
}

function showShelf() {
  chatView.classList.add('hidden');
  shelfView.classList.remove('hidden');
}

function showChat() {
  shelfView.classList.add('hidden');
  chatView.classList.remove('hidden');
  renderChat();
  setTimeout(() => chatInput.focus(), 0);
}

function detail(label, value, isUrl = false) {
  if (value === null || value === undefined || value === '') return '';
  const content = isUrl
    ? `<a href="${escapeHtml(value)}" target="_blank" rel="noreferrer">${escapeHtml(value)}</a>`
    : escapeHtml(value);
  return `<div class="detail-row"><div class="detail-label">${escapeHtml(label)}</div><div class="detail-value">${content}</div></div>`;
}

function showDetails(item) {
  detailsBody.innerHTML = [
    detail('Name', item.name),
    detail('Price', formatPrice(item)),
    detail('Brand', item.brand),
    detail('Seller', item.seller),
    detail('Store', item.site),
    detail('Availability', item.availability),
    detail('Rating', item.rating ? `${item.rating}${item.ratingCount ? ` (${item.ratingCount})` : ''}` : ''),
    detail('SKU', item.sku),
    detail('Added', item.addedAt ? new Date(item.addedAt).toLocaleString() : ''),
    detail('URL', item.url, true)
  ].filter(Boolean).join('');
  detailsDialog.showModal();
}

async function removeItem(id) {
  currentItems = currentItems.filter((item) => item.id !== id);
  await chrome.storage.local.set({ items: currentItems });
  renderCards();
}

async function addToCart(item) {
  showStatus('Opening the product page…');
  const result = await chrome.runtime.sendMessage({ type: 'ADD_TO_CART', item });
  if (!result?.ok) return showStatus(result?.reason || 'Could not open this product.', 'error');
  if (result.clicked) showStatus('Add-to-cart control clicked on the product page.', 'success');
  else if (result.opened) showStatus('Product page opened. Choose options there, then add it to cart.');
  else showStatus('Product page focused. Use its Add to Cart control.');
}

cards.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const card = button.closest('[data-id]');
  const item = currentItems.find((entry) => entry.id === card?.dataset.id);
  if (!item) return;

  if (button.dataset.action === 'remove') await removeItem(item.id);
  if (button.dataset.action === 'details') showDetails(item);
  if (button.dataset.action === 'cart') await addToCart(item);
});

closeDetails.addEventListener('click', () => detailsDialog.close());
talkButton.addEventListener('click', showChat);
backButton.addEventListener('click', showShelf);
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

clearChatButton.addEventListener('click', async () => {
  history = [];
  await chrome.storage.local.set({ chatHistory: history });
  renderChat();
});

async function applyOrchestration(orchestration = []) {
  const organizeSteps = orchestration.filter((step) => step?.tool === 'organize_items');
  const last = organizeSteps.at(-1);
  const order = last?.output?.suggestedOrder;
  if (!Array.isArray(order) || !order.length) return;

  const byId = new Map(currentItems.map((item) => [item.id, item]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean);
  const untouched = currentItems.filter((item) => !order.includes(item.id));
  currentItems = [...ordered, ...untouched];
  await chrome.storage.local.set({ items: currentItems });
  renderCards();
}

async function getBackendConfig() {
  const { apiBaseUrl = 'http://127.0.0.1:8787', apiToken = '' } = await chrome.storage.sync.get(['apiBaseUrl', 'apiToken']);
  return { apiBaseUrl: apiBaseUrl.replace(/\/$/, ''), apiToken };
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = chatInput.value.trim();
  if (!content) return;

  chatError.classList.add('hidden');
  history.push({ role: 'user', content });
  await chrome.storage.local.set({ chatHistory: history });
  addMessageElement('user', content);
  chatInput.value = '';
  sendButton.disabled = true;
  chatInput.disabled = true;
  const pending = addMessageElement('assistant', 'SideKick is checking your shelf…', true);

  try {
    const { apiBaseUrl, apiToken } = await getBackendConfig();
    const response = await fetch(`${apiBaseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {})
      },
      body: JSON.stringify({ history, items: currentItems })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Server returned ${response.status}.`);

    pending.remove();
    const answer = data.message || 'No response returned.';
    await applyOrchestration(data.orchestration || []);
    history.push({ role: 'assistant', content: answer });
    await chrome.storage.local.set({ chatHistory: history });
    addMessageElement('assistant', answer);
  } catch (error) {
    pending.remove();
    chatError.textContent = `${error.message} Check the backend URL in Settings and make sure the Node server is running.`;
    chatError.classList.remove('hidden');
  } finally {
    sendButton.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.items) {
    currentItems = changes.items.newValue || [];
    renderCards();
  }
});

loadItems();
