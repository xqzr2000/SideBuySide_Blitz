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
const suggestions = document.getElementById('suggestions');

let currentItems = [];
let history = [];
let dealsByItem = {};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatMoney(value, currency) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'Price unavailable';
  try {
    return new Intl.NumberFormat(undefined, {
      style: currency ? 'currency' : 'decimal',
      currency: currency || undefined,
      maximumFractionDigits: 2
    }).format(Number(value));
  } catch {
    return `${currency || ''} ${Number(value).toFixed(2)}`.trim();
  }
}

function formatPrice(item) {
  return formatMoney(item.price, item.currency);
}

function showStatus(message, kind = '') {
  status.textContent = message;
  status.className = `status ${kind}`.trim();
  setTimeout(() => status.classList.add('hidden'), 3500);
}

async function loadItems() {
  const data = await chrome.storage.local.get(['items', 'chatHistory', 'deals']);
  currentItems = Array.isArray(data.items) ? data.items : [];
  history = Array.isArray(data.chatHistory) ? data.chatHistory : [];
  dealsByItem = data.deals && typeof data.deals === 'object' ? data.deals : {};
  renderCards();
  renderChat();
}

function bestDealFor(id) {
  const found = dealsByItem[id];
  if (!found?.offers?.length) return null;
  const priced = found.offers.filter((offer) => offer.landedPrice);
  if (!priced.length) return null;
  return { ...found, best: priced[0] };
}

function renderCards() {
  emptyState.classList.toggle('hidden', currentItems.length > 0);
  cards.innerHTML = currentItems.map((item) => {
    const image = item.image
      ? `<img class="product-image" src="${escapeHtml(item.image)}" alt="" referrerpolicy="no-referrer" />`
      : `<div class="product-image placeholder">S</div>`;

    const tags = Array.isArray(item.tags) && item.tags.length
      ? `<div class="tags">${item.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>`
      : '';
    const note = item.note ? `<div class="card-note">${escapeHtml(item.note)}</div>` : '';

    const deal = bestDealFor(item.id);
    const dealBadge = deal
      ? `<button class="deal-badge${deal.best.savings > 0 ? ' win' : ''}" data-action="details">
           ${deal.best.savings > 0
             ? `Found ${escapeHtml(formatMoney(deal.best.savings, deal.best.landedPrice.currency))} cheaper at ${escapeHtml(deal.best.site)}`
             : `${deal.offers.length} offer${deal.offers.length === 1 ? '' : 's'} checked — none cheaper`}
         </button>`
      : '';

    return `
      <article class="card" data-id="${escapeHtml(item.id)}">
        <div class="card-main">
          ${image}
          <div>
            <h2 class="product-title">${escapeHtml(item.name)}</h2>
            <div class="product-meta">${escapeHtml(item.brand || item.site || 'Saved product')}</div>
            <div class="price">${escapeHtml(formatPrice(item))}</div>
            ${tags}
            ${note}
            ${dealBadge}
          </div>
        </div>
        <div class="card-actions">
          <button data-action="cart">Add2Cart</button>
          <button data-action="deals">Find deals</button>
          <button data-action="details">Details</button>
          <button class="remove-button" data-action="remove">Remove</button>
        </div>
      </article>`;
  }).join('');
}

function renderChat() {
  chatMessages.innerHTML = '';
  if (!history.length) {
    addMessageElement('assistant', currentItems.length
      ? `I can see ${currentItems.length} saved item${currentItems.length === 1 ? '' : 's'}. I can compare them, organize the shelf, spot duplicates, or search the web for a better price.`
      : 'Add a few shopping items first, then I can compare, organize, and hunt for better deals on them.');
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

function offerLine(offer) {
  const price = offer.landedPrice
    ? formatMoney(offer.landedPrice.value, offer.landedPrice.currency)
    : 'Price not readable';
  const savings = offer.savings === null || offer.savings === undefined
    ? ''
    : offer.savings > 0
      ? `<span class="offer-savings win">saves ${escapeHtml(formatMoney(offer.savings, offer.landedPrice?.currency))}${offer.savingsPercent ? ` (${escapeHtml(String(offer.savingsPercent))}%)` : ''}</span>`
      : `<span class="offer-savings">${escapeHtml(formatMoney(Math.abs(offer.savings), offer.landedPrice?.currency))} more</span>`;

  const flags = [
    offer.confirmed ? '<span class="chip ok">price confirmed</span>' : '<span class="chip warn">unconfirmed price</span>',
    offer.landedPrice?.approximate ? '<span class="chip">converted</span>' : ''
  ].filter(Boolean).join('');

  const caveats = (offer.caveats || []).length
    ? `<ul class="offer-caveats">${offer.caveats.map((caveat) => `<li>${escapeHtml(caveat)}</li>`).join('')}</ul>`
    : '';

  return `
    <li class="offer">
      <a class="offer-title" href="${escapeHtml(offer.url)}" target="_blank" rel="noreferrer">${escapeHtml(offer.title || offer.url)}</a>
      <div class="offer-meta">${escapeHtml(offer.site || '')}</div>
      <div class="offer-price">${escapeHtml(price)} ${savings}</div>
      <div class="chips">${flags}</div>
      ${caveats}
    </li>`;
}

function addOffersElement(action) {
  const block = document.createElement('div');
  block.className = 'message assistant offers-block';
  block.innerHTML = `
    <div class="offers-head">Deals checked for ${escapeHtml(action.itemName || 'this item')}</div>
    ${action.provider ? `<div class="offers-sub">via ${escapeHtml(action.provider)}</div>` : ''}
    <ul class="offers">${(action.offers || []).map(offerLine).join('')}</ul>`;
  chatMessages.appendChild(block);
  block.scrollIntoView({ block: 'end' });
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
  const found = dealsByItem[item.id];
  const dealSection = found?.offers?.length
    ? `<div class="detail-deals">
         <h3>Deals SideKick found${found.checkedAt ? ` · ${escapeHtml(new Date(found.checkedAt).toLocaleDateString())}` : ''}</h3>
         <ul class="offers">${found.offers.map(offerLine).join('')}</ul>
       </div>`
    : '';

  detailsBody.innerHTML = [
    detail('Name', item.name),
    detail('Price', formatPrice(item)),
    detail('Brand', item.brand),
    detail('Seller', item.seller),
    detail('Store', item.site),
    detail('Availability', item.availability),
    detail('Rating', item.rating ? `${item.rating}${item.ratingCount ? ` (${item.ratingCount})` : ''}` : ''),
    detail('SKU', item.sku),
    detail('Tags', (item.tags || []).join(', ')),
    detail('Note', item.note),
    detail('Added', item.addedAt ? new Date(item.addedAt).toLocaleString() : ''),
    detail('URL', item.url, true)
  ].filter(Boolean).join('') + dealSection;
  detailsDialog.showModal();
}

async function removeItem(id) {
  currentItems = currentItems.filter((item) => item.id !== id);
  delete dealsByItem[id];
  await chrome.storage.local.set({ items: currentItems, deals: dealsByItem });
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
  if (button.dataset.action === 'deals') {
    showChat();
    await sendToSideKick(`Search the web for a better deal on "${item.name}" (item id ${item.id}). Verify the prices you find and tell me whether any of them actually beats what I saved.`);
  }
});

closeDetails.addEventListener('click', () => detailsDialog.close());
talkButton.addEventListener('click', showChat);
backButton.addEventListener('click', showShelf);
settingsButton.addEventListener('click', () => chrome.runtime.openOptionsPage());

suggestions?.addEventListener('click', async (event) => {
  const chip = event.target.closest('button[data-prompt]');
  if (!chip) return;
  await sendToSideKick(chip.dataset.prompt);
});

clearChatButton.addEventListener('click', async () => {
  history = [];
  await chrome.storage.local.set({ chatHistory: history });
  renderChat();
});

/** Apply the shelf mutations SideKick asked for: reordering, tagging, and deal results. */
async function applyActions(actions = []) {
  let itemsChanged = false;
  let dealsChanged = false;

  for (const action of actions) {
    if (action?.type === 'reorder' && Array.isArray(action.ids) && action.ids.length) {
      const byId = new Map(currentItems.map((item) => [item.id, item]));
      const ordered = action.ids.map((id) => byId.get(id)).filter(Boolean);
      const seen = new Set(action.ids);
      currentItems = [...ordered, ...currentItems.filter((item) => !seen.has(item.id))];
      itemsChanged = true;
    }

    if (action?.type === 'set_tags' && Array.isArray(action.updates)) {
      const updates = new Map(action.updates.map((update) => [update.id, update]));
      currentItems = currentItems.map((item) => {
        const update = updates.get(item.id);
        if (!update) return item;
        const existing = Array.isArray(item.tags) ? item.tags : [];
        const tags = update.mode === 'replace' ? update.tags : [...new Set([...existing, ...(update.tags || [])])];
        return { ...item, tags: tags.slice(0, 8), note: update.note || item.note || '' };
      });
      itemsChanged = true;
    }

    if (action?.type === 'offers' && action.itemId) {
      dealsByItem[action.itemId] = {
        itemName: action.itemName || '',
        query: action.query || '',
        provider: action.provider || '',
        checkedAt: new Date().toISOString(),
        offers: action.offers || []
      };
      dealsChanged = true;
      addOffersElement(action);
    }
  }

  if (itemsChanged) await chrome.storage.local.set({ items: currentItems });
  if (dealsChanged) await chrome.storage.local.set({ deals: dealsByItem });
  if (itemsChanged || dealsChanged) renderCards();
}

async function getBackendConfig() {
  const { apiBaseUrl = 'http://127.0.0.1:8787', apiToken = '' } = await chrome.storage.sync.get(['apiBaseUrl', 'apiToken']);
  return { apiBaseUrl: apiBaseUrl.replace(/\/$/, ''), apiToken };
}

let sending = false;

async function sendToSideKick(content) {
  if (sending || !content.trim()) return;
  sending = true;

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
    history.push({ role: 'assistant', content: answer });
    await chrome.storage.local.set({ chatHistory: history });
    addMessageElement('assistant', answer);
    await applyActions(data.actions || []);
  } catch (error) {
    pending.remove();
    chatError.textContent = `${error.message} Check the backend URL in Settings and make sure the Node server is running.`;
    chatError.classList.remove('hidden');
  } finally {
    sending = false;
    sendButton.disabled = false;
    chatInput.disabled = false;
    chatInput.focus();
  }
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await sendToSideKick(chatInput.value.trim());
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.items) currentItems = changes.items.newValue || [];
  if (changes.deals) dealsByItem = changes.deals.newValue || {};
  if (changes.items || changes.deals) renderCards();
});

loadItems();
