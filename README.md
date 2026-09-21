# SideBuySide

SideBuySide is a Chrome Manifest V3 extension that turns Chrome's side panel into a lightweight product comparison shelf. 

Right-click a shopping product page, choose **Add2SideBuySide**, and the extension extracts product metadata into a card. 

## Who is Sidekick

Sidekick is SideBuySide’s AI agent. It helps you organize your Side Shelf, compare items within the same category, and scout the internet for better deals.

## What SideKick can do

SideKick runs as a tool-calling agent on the Node backend. It never answers from memory about your shelf — it calls a tool, and anything a tool could not establish is reported as missing rather than guessed.

### Organize the shelf

| Tool | What it does |
| --- | --- |
| `list_items` | Filter by text, store, brand, category, tag, or price range, and sort by price, rating, recency, or value for money. |
| `organize_items` | Group and physically reorder the cards by store, brand, price band, category, value, rating, recency, or duplicate cluster. |
| `tag_items` | Label cards (`finalist`, `too pricey`, …) and add a one-line note. Labels survive re-adding the page and show up on the card. |
| `find_duplicates` | Spot the same product saved from two different stores and show the price spread inside each cluster. |

### Compare what is on it

| Tool | What it does |
| --- | --- |
| `compare_items` | An attribute-by-attribute matrix with per-attribute winners, the price spread in money and percent, and an explicit list of which facts are missing on which card. |
| `rank_items` | A weighted score across price, rating, review volume, and availability, with a per-item breakdown and a confidence level that drops when fields had to be estimated. |
| `price_summary` | Per-currency statistics plus an approximate combined total. |

Prices from different currencies are normalized through an offline rate table before anything is compared, and every converted figure is flagged approximate so SideKick has to say so.

### Search the internet for a better deal

| Tool | What it does |
| --- | --- |
| `search_deals` | Builds a query from a saved card (or your own text), searches the web, and by default opens the top results server-side to read their real prices instead of trusting a snippet. |
| `fetch_offer` | Opens one product URL and extracts price, currency, availability, rating, and seller from its JSON-LD or meta tags. |
| `evaluate_deal` | Does the savings math against the saved card — landed price including shipping, savings in money and percent, ranked best-first — and attaches the caveats that make a deal worse than it looks (unconfirmed price, marketplace seller, refurbished stock, currency conversion, a title that does not match the saved model). |

Results come back into the side panel as deal cards with a confirmed/unconfirmed badge, and the best find is summarized on the shelf card itself.

Outbound fetches are restricted to public http(s) addresses: private, loopback, and link-local targets are refused, redirects are re-validated at every hop, and responses are size- and time-capped.

## Setup

```bash
cp backend/.env.example backend/.env   # add your OPENROUTER_API_KEY
npm start                              # backend on http://127.0.0.1:8787
npm test                               # backend test suite
```

Then load `extension/` as an unpacked extension (`chrome://extensions` → Developer mode → Load unpacked) and point **Settings** at the backend URL.

### Web search configuration

Web search is optional and pluggable. Set one of these and SideKick picks it up automatically (`SEARCH_PROVIDER` forces a specific one):

| Provider | Key | Notes |
| --- | --- | --- |
| Tavily | `TAVILY_API_KEY` | Preferred when present. |
| Brave Search | `BRAVE_SEARCH_API_KEY` | |
| SerpApi | `SERPAPI_API_KEY` | Uses the Google Shopping engine, so prices come straight from the provider. |
| OpenRouter | `OPENROUTER_API_KEY` | Fallback; uses OpenRouter's built-in web plugin, no extra account needed. |

With none of them set, deal hunting is disabled and SideKick says so instead of inventing prices. **Settings → Save & Test** reports which provider is live.

## UI Demo

See **SideBuySide** in action

https://github.com/user-attachments/assets/9267cede-1671-467f-a9d3-1cd4e57a8af1

