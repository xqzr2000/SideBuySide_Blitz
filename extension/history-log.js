const MAX_EVENTS = 500;

/** The fields the backend needs to index a product; everything else stays local. */
function trimItem(item = {}) {
  return {
    id: item.id || '',
    name: item.name || '',
    brand: item.brand || '',
    price: item.price ?? null,
    currency: item.currency || '',
    url: item.url || '',
    site: item.site || '',
    seller: item.seller || '',
    image: item.image || '',
    rating: item.rating ?? null,
    ratingCount: item.ratingCount ?? null,
    tags: Array.isArray(item.tags) ? item.tags : []
  };
}

/**
 * Append one interaction to the shelf history log. The log is append-only and
 * capped: removing a card from the shelf does not erase that it was once saved,
 * which is what makes recommendations possible.
 */
export async function recordShelfEvent(type, item) {
  if (!item?.url && !item?.name) return null;
  const { shelfHistory = [] } = await chrome.storage.local.get('shelfHistory');
  const event = { type, at: new Date().toISOString(), item: trimItem(item) };
  const next = [...shelfHistory, event].slice(-MAX_EVENTS);
  await chrome.storage.local.set({ shelfHistory: next });
  return event;
}

export async function readShelfHistory() {
  const { shelfHistory = [] } = await chrome.storage.local.get('shelfHistory');
  return Array.isArray(shelfHistory) ? shelfHistory : [];
}

export async function clearShelfHistory() {
  await chrome.storage.local.set({ shelfHistory: [] });
}
