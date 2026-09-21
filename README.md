# SideBuySide

SideBuySide is a Chrome Manifest V3 extension that turns Chrome's side panel into a lightweight product comparison shelf. Right-click a shopping product page, choose **Add2SideBuySide**, and the extension extracts product metadata into a card. A local Node.js backend powers **SideKick**, an OpenRouter agent with tools for scanning, comparing, summarizing, and organizing those saved cards.

## What is included

- Chrome side panel UI (Chrome 116+)
- Right-click **Add2SideBuySide** context menu
- Product-page detection using JSON-LD/schema.org metadata plus conservative page heuristics
- Persistent cards in `chrome.storage.local`
- Card actions: **Add2Cart**, **Remove**, **Details**
- Details view with name, price, URL, time added, store, brand, seller, availability, rating, and SKU when available
- SideKick chat powered by OpenRouter
- Tool-calling / task-orchestration loop with tools for listing, comparing, summarizing prices, and organizing products
- Local VS Code + `.devcontainer` support
- GitHub Codespaces port forwarding support

## Architecture

```text
Shopping page
   │ right-click Add2SideBuySide
   ▼
Chrome service worker ── extracts product metadata
   │
   ▼
chrome.storage.local
   │
   ├── Side panel cards
   │
   └── SideKick chat ──POST /api/chat──> Node.js backend :8787
                                      │
                                      └── OpenRouter + tool orchestration
```

The OpenRouter API key lives **only in the backend `.env`**. It is never stored in the Chrome extension. The backend uses only built-in Node.js APIs, so there are no runtime npm dependencies to install.

## 1. Run the backend locally

From the repository root:

```bash
cp backend/.env.example backend/.env
# Edit backend/.env and add your OPENROUTER_API_KEY
npm run dev
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` folder from this project.
5. Pin SideBuySide if desired. Clicking the extension icon opens the Chrome side panel.

The extension defaults to `http://127.0.0.1:8787` for the backend.

## 3. Demo flow

1. Open a product detail page on a retailer.
2. Right-click the page and choose **Add2SideBuySide**.
3. If SideBuySide can identify a shopping product, the side panel opens and a card is added. If the page does not look like a product page, nothing happens.
4. Add products from a few stores.
5. Use **Details** to inspect captured metadata.
6. Use **Remove** to delete a card.
7. Use **Add2Cart**. SideBuySide will focus the original product tab and, when a conservative add-to-cart selector was captured, click that button. Otherwise it opens/focuses the product page so the user can choose variants/options and add it manually.
8. Click **Talk to SideKick** and ask things like:
   - `Compare these items. What are the major tradeoffs?`
   - `Which items have missing information I should check before buying?`
   - `Organize these by store.`
   - `Give me a price summary.`

## Dev Container / GitHub Codespaces

Open the repository in the devcontainer. Port **8787** is automatically forwarded.

For **local VS Code + devcontainer**, Chrome on the same computer can continue using:

```text
http://127.0.0.1:8787
```

For **GitHub Codespaces**, Chrome cannot use the Codespace container's `localhost` directly. In the Codespaces **Ports** panel:

1. Find port `8787`.
2. For the simplest extension demo, make the port **Public** temporarily. If you do this, set a strong random `SIDEBUYSIDE_TOKEN` in `backend/.env`.
3. Copy the forwarded HTTPS URL (for example, an `https://...app.github.dev` URL).
4. Open the SideBuySide extension's **Settings**, paste that URL as the backend URL, and paste the same token if you configured one.

The development manifest allows localhost plus `https://*.app.github.dev/*` so this workflow works without hard-coding a single Codespace hostname.

## OpenRouter configuration

`backend/.env`:

```dotenv
PORT=8787
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_MODEL=openai/gpt-5-mini
OPENROUTER_SITE_URL=http://localhost:8787
OPENROUTER_APP_NAME=SideBuySide SideKick
SIDEBUYSIDE_TOKEN=
```

You can replace `OPENROUTER_MODEL` with another OpenRouter tool-calling model.

## Product detection behavior

SideBuySide intentionally uses a conservative rule:

- Prefer schema.org `Product` JSON-LD.
- Otherwise require a plausible title, a detectable price, and shopping-language signals such as Add to Cart / Buy Now / shipping / stock.

That keeps the context-menu action quiet on ordinary pages, as requested. Retail sites vary significantly, so metadata quality will also vary.

## Add2Cart limitations

There is no universal browser API for adding arbitrary products to arbitrary retailer carts. This MVP captures a conservative add-to-cart selector when one is visible on the product page. When the user explicitly clicks **Add2Cart**, it will only attempt that selector on the matching product tab. Product variants, login requirements, anti-bot protections, custom web components, and retailer-specific flows may require site adapters later.

## Security / production notes

This is a development prototype. Before publishing to the Chrome Web Store:

- Replace broad/dev host permissions with the smallest set of backend origins you actually need.
- Keep `SIDEBUYSIDE_TOKEN` enabled whenever a development backend is exposed on a public forwarded port; use stronger authentication for a production service.
- Use an HTTPS backend outside localhost.
- Add per-retailer adapters for high-confidence cart actions.
- Consider a backend database only if you want cross-device shelves; today the shelf remains local to Chrome.
