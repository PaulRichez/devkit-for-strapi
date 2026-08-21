---
title: For your AI agent (MCP)
description: The MCP server that gives AI coding agents the real values of your Strapi project.
---

The same engine, exposed over the [Model Context Protocol](https://modelcontextprotocol.io)
so coding agents (Claude Code, Copilot agent mode, Cursor, …) **query your
project’s real values instead of grepping for them.**

## Is this Strapi’s MCP server?

No — and they don’t compete. Strapi ships its
[own MCP server](https://docs.strapi.io/cms/features/strapi-mcp-server) (GA since
5.49), and it’s good at something DevKit deliberately doesn’t do.

| | **Strapi MCP** (official) | **DevKit MCP** |
|---|---|---|
| Acts on | your **content** — entries in a running app | your **codebase** — the files in your editor |
| Reads | the live API, over HTTP | your real `schema.json` and source files |
| Needs | a **running** instance + an admin token | nothing: no server, no token, no network |
| Requires | Strapi **≥ 5.47**, enabled explicitly | Strapi **v4 or v5**, zero config |
| Typical ask | *"create an article draft and publish it"* | *"what code uses `api::article.article`?"* |
| Tools | CRUD per content-type (list, get, create, update, publish…) | resolve, validate, find references, dependency graph, dead code, broken refs, routes |
| Can change | your content | your code (rename, move, schema edits — [Pro](/pro/)) |

> **Use Strapi’s MCP to work _with_ your content. Use DevKit to work _on_ your code.**

Plenty of projects want both — they answer different questions, and nothing stops
an agent from having the two connected at once. DevKit also keeps working when the
app doesn’t: mid-migration, on a failing build, in CI, or on a Strapi v4 project.

## Setup

### In your editor — nothing to configure

In **VS Code, Cursor, Windsurf and Antigravity** the server is **bundled in the
extension and auto-registered** with the editor's MCP support. Install the
extension and your agent can use the tools immediately — no config, no separate
install.

On editors without the MCP-provider API (e.g. **VSCodium**), install the extension
for the editor features and wire the standalone server below for your agent.

### In Claude Code, Claude Desktop, or another MCP client

:::tip[Already in a VS Code-family editor?]
Skip this section. The bundled server (above) is the **same engine**, already
auto-registered — adding the `npx` config too would just run a second copy. Use
`npx` only for a client that **isn't** a VS Code-family editor (Claude Desktop, the
Claude Code CLI, …). If you run both, keep the extension up to date — the
`@latest` below keeps the standalone server in step with it. Avoid pinning an
exact version: it freezes you out of fixes.
:::

Point the client at the `devkit-for-strapi-mcp` stdio server. The recommended
config runs it with `npx` (no global install) and passes your project's **absolute**
path:

```json
{
  "mcpServers": {
    "devkit-for-strapi": {
      "command": "npx",
      "args": ["-y", "devkit-for-strapi-mcp@latest", "/absolute/path/to/your/strapi-project"]
    }
  }
}
```

The path argument is **optional but the most reliable default** — it's indexed at
startup, so the first tool call already works, on every client. Omit it to rely on
the client's `roots` capability or the cwd, or register the project later with the
`add_project` tool.

Where this config file lives:

- **Claude Code** — a `.mcp.json` at your project root, or run
  `claude mcp add devkit-for-strapi -- npx -y devkit-for-strapi-mcp@latest .`
  (the trailing `.` is the current directory — Claude Code runs the server from
  your project root, so it resolves correctly via the cwd fallback)
- **Claude Desktop** — `claude_desktop_config.json` (then restart the app):
  - **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`
  - **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Cursor / Windsurf / others** — their MCP settings (an `mcp.json`), same
  `mcpServers` block.

For the **Pro** refactor tools, add an
env block — `"env": { "DEVKIT_LICENSE_KEY": "polar_xxx" }` (see
[Activating your licence](/pro/#activating-your-licence)).

:::caution[Windows]
If your client reports `npx` was not found, wrap it:
`"command": "cmd"`, `"args": ["/c", "npx", "-y", "devkit-for-strapi-mcp@latest", "<path>"]`.
:::

:::note
The standalone server is published on npm as
[`devkit-for-strapi-mcp`](https://www.npmjs.com/package/devkit-for-strapi-mcp), and
listed in the official MCP registry as `io.github.PaulRichez/devkit-for-strapi-mcp`.
In the VS Code-family editors above you don't need it — the same server ships
**bundled** in the extension (zero-config).
:::

:::caution[Set this up earlier? You may be stuck on an old version]
`npx` caches what it downloads and will keep running that copy — for months, and
even without a version pin. If you configured the server before reading this, it
may still be an early build, with bugs that are long fixed.

**Check what's actually running:** ask your agent to call **`server_info`**, which
reports the real version, and compare it with the
[latest on npm](https://www.npmjs.com/package/devkit-for-strapi-mcp).

**If it's behind**, clear the npx cache and restart your MCP client:

- macOS / Linux — `rm -rf ~/.npm/_npx`
- Windows — `rmdir /s /q "%LOCALAPPDATA%\npm-cache\_npx"`

The `@latest` in the config above resolves the tag from the registry on every
start, so this won't happen again.
:::

## Tools

Full parameters and return shapes for every tool are in the
[MCP tool reference](/mcp-tools/). A quick map:

**Know** — read the project’s truth: `list_projects`, `list_content_types`,
`list_components`, `list_artifacts`, `get_schema`, `resolve`,
`validate_reference`, `find_references`, `list_routes`.

**Understand** — health & impact: `list_unused` (dead code), `list_broken_refs`,
`coverage`, `find_relation_usages`, `list_refs`, `dependencies` / `dependents`
(the dependency graph, for cut analysis).

**Refactor (Pro)** — plan → review → apply: `plan_rename_method` /
`plan_rename_entity`, `plan_move` / `plan_move_entities`, `plan_change_relation`,
`plan_rename_attribute`, `create_plugin`, `extract_to_plugin`, then `apply_edits`
/ `apply_rename`.

Every refactor returns a **contractual, reviewable plan** (text edits + file
creates/renames/deletes + content fingerprints). Applying is explicit and **safe
by construction**: the executor is confined to your discovered project root(s)
(symlink-resolved), refuses to silently overwrite, verifies the fingerprints
first (a stale plan is rejected), is best-effort transactional, and self-verifies
afterward. Guarantee, don’t guess — that principle applies to writes too.
