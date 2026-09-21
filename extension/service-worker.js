import { extractProductFromPage } from './product-extractor.js';

const MENU_ID = 'add-to-sidebuyside';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Add2SideBuySide',
      contexts: ['all']
    });
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

async function extractFromTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractProductFromPage
  });
  return result || null;
}

async function saveProduct(product, tab) {
  const { items = [] } = await chrome.storage.local.get('items');
  const existing = items.find((item) => item.url === product.url);
  const now = new Date().toISOString();

  const nextItem = {
    ...product,
    id: existing?.id || crypto.randomUUID(),
    tabId: tab.id,
    addedAt: existing?.addedAt || now,
    updatedAt: now
  };

  const next = existing
    ? items.map((item) => (item.id === existing.id ? nextItem : item))
    : [nextItem, ...items];

  await chrome.storage.local.set({ items: next });
  return nextItem;
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id || !tab.url?.startsWith('http')) return;

  try {
    const product = await extractFromTab(tab.id);
    if (!product) return; // Requirement: do nothing on non-product pages.
    await saveProduct(product, tab);
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.warn('SideBuySide could not add this page:', error);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ADD_TO_CART') return;

  (async () => {
    const item = message.item;
    if (!item?.url) return sendResponse({ ok: false, reason: 'Missing product URL.' });

    let targetTab = null;
    if (item.tabId) {
      targetTab = await chrome.tabs.get(item.tabId).catch(() => null);
      if (targetTab?.url !== item.url) targetTab = null;
    }

    if (!targetTab) {
      const allTabs = await chrome.tabs.query({}).catch(() => []);
      targetTab = allTabs.find((candidate) => candidate.url === item.url) || null;
    }

    if (!targetTab) {
      const opened = await chrome.tabs.create({ url: item.url, active: true });
      sendResponse({ ok: true, opened: true, clicked: false, tabId: opened.id });
      return;
    }

    await chrome.tabs.update(targetTab.id, { active: true });
    if (!item.addToCartSelector) {
      sendResponse({ ok: true, opened: false, clicked: false, tabId: targetTab.id });
      return;
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      args: [item.addToCartSelector],
      func: (selector) => {
        const button = document.querySelector(selector);
        if (!button || button.disabled) return false;
        button.scrollIntoView({ block: 'center', behavior: 'smooth' });
        button.click();
        return true;
      }
    });

    sendResponse({ ok: true, opened: false, clicked: Boolean(result), tabId: targetTab.id });
  })().catch((error) => sendResponse({ ok: false, reason: error.message }));

  return true;
});
