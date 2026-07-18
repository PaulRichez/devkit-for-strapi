---
title: Installation
description: Install DevKit for Strapi in your editor and (optionally) wire the MCP server into other AI clients.
---

DevKit for Strapi gives your editor and your AI agent accurate, project-aware
support for Strapi [magic strings](/concepts/) — by reading your real `schema.json`.

## Requirements

- A **Strapi v4 or v5** project (detected per project — multi-project workspaces work).
- **VS Code `1.101+`** or a compatible fork (Cursor, Windsurf, Google Antigravity, VSCodium).
- No configuration, no type generation, no extra setup.

## Install the extension

- **VS Code** — search **"DevKit for Strapi"** in the Extensions view (VS Code Marketplace) and install.
- **Cursor / Windsurf / Antigravity / VSCodium** — install from **[Open VSX](https://open-vsx.org/extension/paul-richez/devkit-for-strapi)**.

Open a Strapi project and it works immediately.

## Verify it's active

A status bar item appears at the **bottom-left**: `DevKit for Strapi: N`, where `N`
is the number of Strapi projects detected in your workspace. If it shows `0`, the
workspace has no recognizable Strapi project (or it's excluded — see
[Configuration](/configuration/)).

DevKit adds a few commands to the Command Palette — the two you’ll use right after install:

- **DevKit for Strapi: Show Detected Projects** — lists the projects it found.
- **DevKit for Strapi: Rescan Workspace** — re-discovers projects and rebuilds the index.

See [Configuration → Commands](/configuration/#commands) for the full list (including **Enter / Clear License Key** for Pro).

## Your first 30 seconds

Open a controller or service and try these — no config, no type generation:

- Inside a `strapi.service('…')` call, start typing — **real UIDs** are suggested.
- Type a UID that doesn't exist (`strapi.documents('api::article.artcle')`) — it's
  **underlined** with a "did you mean" quick fix.
- `Ctrl`/`Cmd`-click a UID — you **jump straight to its `schema.json`**.
- Hover a service method for its **signature** and usage insights.

That's the free editor experience. See [In your editor](/editor/) for the full list.

## The MCP server

The MCP server (for AI agents) is **bundled in the extension and auto-registered**
in VS Code, Cursor, Windsurf and Antigravity — nothing else to install. Your agent
can use the tools right away.

To wire it into **other MCP clients** — Claude Code, Claude Desktop, or a
standalone agent — see [For your AI agent (MCP) → Setup](/mcp/#setup).

## Next

- [Configuration](/configuration/) — settings, commands, exclusions, MCP clients.
- [Strapi magic strings](/concepts/) — what DevKit understands.
- [In your editor](/editor/) · [For your AI agent](/mcp/) · [Pro](/pro/)
