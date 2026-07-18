---
title: Configuration
description: Settings, commands, project-discovery exclusions, and MCP setup for other clients.
---

DevKit works with **zero configuration**. Everything below is optional.

## Settings

All settings live under `strapiDevkit.*` (Settings UI → search "DevKit for Strapi",
or edit `settings.json`).

| Setting | Default | What it does |
|---|---|---|
| `strapiDevkit.enable` | `true` | Master switch for all DevKit features. |
| `strapiDevkit.completion.enable` | `true` | Suggest real Strapi references inside magic-string call sites. |
| `strapiDevkit.diagnostics.enable` | `true` | Underline invalid references and obsolete Strapi v4 patterns. |
| `strapiDevkit.diagnostics.unknownReferenceSeverity` | `"error"` | Severity for an unknown/invalid reference — `error`, `warning`, `information` or `hint`. (The "v4 pattern in a v5 project" warning is unaffected.) |
| `strapiDevkit.hover.enable` | `true` | Show a hover bubble describing what a magic string resolves to, plus service-method signatures. |
| `strapiDevkit.referencesCodeLens.enable` | `true` | Show the "N references (Strapi)" CodeLens on content-types, services, controllers and their methods — counting usages the TypeScript server can't see. |
| `strapiDevkit.referencesCodeLens.methods` | `true` | Also show the per-method "N references (Strapi)" lens. Disable to keep only the file-level lens. |
| `strapiDevkit.exclude` | `[]` | Glob patterns of paths to exclude from project discovery. |

### Excluding projects

If your workspace contains example apps or fixtures you don't want indexed:

```json
{
  "strapiDevkit.exclude": ["examples", "**/fixtures/**"]
}
```

Patterns are glob-matched against each discovered project’s path; a bare segment
like `examples` matches a project in any folder of that name. A discovered project
whose path matches any pattern is ignored.

## Commands

From the Command Palette (`Ctrl/Cmd+Shift+P`):

- **DevKit for Strapi: Show Detected Projects**
- **DevKit for Strapi: Rescan Workspace** — re-discover projects and rebuild the index (use after large changes if something looks stale).
- **DevKit for Strapi: Enter License Key** — store your Pro licence key (see [Pro](/pro/#activating-your-licence)).
- **DevKit for Strapi: Clear License Key** — remove the stored licence key.

## MCP for other clients

In **VS Code, Cursor, Windsurf and Antigravity** the MCP server is bundled and
**auto-registered** — no config needed.

For **other MCP clients** (Claude Code, Claude Desktop, a standalone agent), point
the client at the `devkit-for-strapi-mcp` stdio server with `npx`. Passing your
project's absolute path is **optional but the most reliable** (indexed at startup,
works on every client):

```json
{
  "mcpServers": {
    "devkit-for-strapi": {
      "command": "npx",
      "args": ["-y", "devkit-for-strapi-mcp", "/absolute/path/to/your/strapi-project"]
    }
  }
}
```

The server also accepts the workspace via the client's `roots` capability, and
exposes an `add_project` tool to register a project on demand. Per-client config
locations (Claude Code `.mcp.json`, Claude Desktop `claude_desktop_config.json`, …)
and the Windows `npx` note are in [For your AI agent (MCP) → Setup](/mcp/#setup).

:::note
The in-editor auto-registration is the recommended path today. The standalone
`devkit-for-strapi-mcp` npm package publishes with the public release.
:::

## Pro licence

The Pro features (propagated rename, move/extract, safe apply) are unlocked by a
licence key:

- **Editor** — run **DevKit for Strapi: Enter License Key** from the Command Palette
  (stored in the OS keychain, not `settings.json`).
- **Standalone MCP** — set `DEVKIT_LICENSE_KEY` in the server's `env` block.

Validated **once on activation**, then cached **offline**. Full steps and the
no-licence behaviour: [Pro → Activating your licence](/pro/#activating-your-licence).
