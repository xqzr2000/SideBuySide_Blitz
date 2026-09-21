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

## Who is Sidekick

Sidekick is SideBuySide’s AI agent. It helps you organize your Side Shelf, compare items within the same category, and scout the internet for better deals.

## UI Demo

See **SideBuySide** in action

https://github.com/user-attachments/assets/9267cede-1671-467f-a9d3-1cd4e57a8af1


