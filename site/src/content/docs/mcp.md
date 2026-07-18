---
title: For your AI agent (MCP)
description: The MCP server that gives AI coding agents the real values of your Strapi project.
---

The same engine, exposed over the [Model Context Protocol](https://modelcontextprotocol.io)
so coding agents (Claude Code, Copilot agent mode, Cursor, …) **query your
project’s real values instead of inventing them.**

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
Claude Code CLI, …). If you run both, pin the version
(`devkit-for-strapi-mcp@x.y.z`) to match your installed extension and avoid drift.
:::

Point the client at the `devkit-for-strapi-mcp` stdio server. The recommended
config runs it with `npx` (no global install) and passes your project's **absolute**
path:

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

The path argument is **optional but the most reliable default** — it's indexed at
startup, so the first tool call already works, on every client. Omit it to rely on
the client's `roots` capability or the cwd, or register the project later with the
`add_project` tool.

Where this config file lives:

- **Claude Code** — a `.mcp.json` at your project root, or run
  `claude mcp add devkit-for-strapi -- npx -y devkit-for-strapi-mcp .`
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
`"command": "cmd"`, `"args": ["/c", "npx", "-y", "devkit-for-strapi-mcp", "<path>"]`.
:::

:::note
The standalone `devkit-for-strapi-mcp` npm package publishes with the public
release. Until then, the VS Code-family editors above ship the server **bundled**
(zero-config) — that's the supported path today.
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
