<p align="center">
  <img src="assets/icon.svg" width="120" alt="DevKit for Strapi logo" />
</p>

<h1 align="center">DevKit for Strapi</h1>

<p align="center">
  Accurate, project-aware tooling for Strapi <em>magic strings</em> — for your editor <strong>and</strong> your AI agent.<br/>
  Where Copilot <strong>guesses</strong>, DevKit for Strapi <strong>knows</strong>: it reads your real <code>schema.json</code>.
</p>

---

## Why

Strapi runs on _magic strings_ — UIDs like `api::article.article`, service/controller refs, policy and
middleware names, component UIDs, route `handler`s. In most editors they have **no autocomplete, no
validation, and broken navigation**, and a typo fails **silently at runtime**. AI coding assistants make
it worse: they happily **hallucinate** UIDs and method names that don't exist in your project.

DevKit for Strapi reads the **real** content-types, components, services, controllers, policies,
middlewares and routes of every Strapi project in your workspace, and turns those strings into
first-class, verified code — in two surfaces that share one engine:

- a **VS Code extension** for humans, and
- an **MCP server** that gives AI agents the same ground truth.

The rule everywhere: **guarantee, don't guess.** When something can't be proven (a non-literal string, an
unverifiable external plugin), DevKit stays silent rather than show a false positive.

---

## 🧩 The VS Code extension

Inside a Strapi project — zero config, no type generation:

- **Autocomplete** — inside a magic string, suggests the real values for the context at your cursor:
  UIDs, services, controllers, policies, middlewares, components, and a content-type's route actions.
- **Diagnostics** — underlines references that don't exist (with quick fixes that suggest the closest
  match), and flags Strapi v4 patterns (`entityService`, `data.attributes`) used in a v5 project.
- **Go to definition** — <kbd>Ctrl/Cmd</kbd>-click a string to jump to the right target: a UID → its
  `schema.json`, a service/controller/policy/middleware → its file, a route `handler` → the controller
  **method**, a component → its JSON, a `plugin('a').service('b')` chain → the plugin's service.
- **Find references & CodeLens** — a “N references” lens on every definition, including **per-method**
  usages (`strapi.service('x').find()` calls and route handlers) the TypeScript server can't see, because
  `strapi.service(...)` is typed `any`. A second “N incoming relations” lens on `schema.json`.
- **Rename** (<kbd>F2</kbd>) — on an entity **or a method**: propagates to every call-site and route
  handler, renames the underlying file/folder, and updates relation `target`s. No grep-and-pray.
- **Hover** — describes what a string resolves to, with the signature for service methods and usage
  insights (incoming relations, route handlers, data usages).

---

## 🤖 The MCP server — ground truth for AI agents

The same engine, exposed over the [Model Context Protocol](https://modelcontextprotocol.io) so coding
agents (Claude Code, Copilot agent mode, Cursor, …) **query your project's real values instead of
inventing them**. 29 stdio tools, in three layers:

**Know** — read the project's truth
`list_projects` · `list_content_types` · `list_components` · `list_artifacts` · `get_schema` · `resolve` ·
`validate_reference` · `find_references` · `list_routes`

**Understand** — health & impact analysis
`list_unused` (dead code) · `list_broken_refs` · `coverage` · `find_relation_usages` · `list_refs` (glob) ·
`dependencies` / `dependents` (the dependency graph, for cut analysis)

**Refactor** — plan → review → apply
`plan_rename_method` / `plan_rename_entity` · `plan_move` / `plan_move_entities` · `plan_change_relation` ·
`plan_rename_attribute` · `create_plugin` · `extract_to_plugin`, then `apply_edits` / `apply_rename`.

Every refactor returns a **contractual, reviewable plan** (text edits + file creates/renames/deletes +
content fingerprints). Applying is explicit and **safe by construction**: the executor is **confined to
your discovered project root(s)** (symlink-resolved — no escape), refuses to silently overwrite, verifies
the fingerprints first (a stale plan is rejected, not applied), is **best-effort transactional** (rolls
back on a mid-write failure), and **self-verifies** afterward (re-checks for broken refs). Garantir, ne
pas deviner — applied to writes too.

### Set it up

- **VS Code, Cursor, Windsurf, Antigravity** — the server is **bundled in the extension and
  auto-registered** with the editor's MCP support. Nothing to configure: install the extension and your
  agent can use the tools.
- **Other MCP clients** — run `devkit-for-strapi-mcp` as a stdio server, passing your project path. It
  also accepts the workspace folder via the client's `roots` capability (so it just works wherever you
  open it), and a tool (`add_project`) to register a project on demand.

For Claude Code, Claude Desktop, or any standalone MCP client:

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

### Try it

Once it's wired, ask your agent:

- *"Which content types exist in this project?"*
- *"What uses `api::article.article`?"*
- *"Is `api::article.artcle` a valid reference?"*

It answers from your real `schema.json` — not from a guess.

---

## Accurate by design

- **Reads your real schema** — answers come from your project's files, not from a model's guess.
- **Multi-project** — discovers every Strapi project in the workspace by content (scanning for
  `@strapi/strapi`), never assuming _workspace root = Strapi root_. References resolve against the project
  that **owns** the edited file; an ambiguous request returns candidates, never a silent choice.
- **Strapi v4 _and_ v5** — the version is detected per project; v4-in-v5 patterns are flagged. Knows the
  difference between a `collectionType` and a `singleType` (their auto-CRUD actions differ) and a
  schema-only content-type's auto-generated controller.
- **JavaScript & TypeScript** — identical behavior for ESM and CommonJS projects (challenged by a
  JS⇄TS parity test).
- **Runs everywhere** — VS Code and its forks (Cursor, Windsurf, Google Antigravity) via Open VSX and the
  VS Code Marketplace.

---

## Install

**Editor** — search **“DevKit for Strapi”** in the Extensions view (VS Code Marketplace), or install from
[Open VSX](https://open-vsx.org) for Cursor / Windsurf / VSCodium. Open a Strapi project and it works.

**Requirements** — a Strapi **v4** or **v5** project, and VS Code `1.101+` (or a compatible fork). No
configuration, no type generation, no extra setup.

The MCP server needs no separate install in those editors — it ships inside the extension.

---

## Architecture

A pnpm monorepo around one pure engine:

| Package | Role |
|---|---|
| `devkit-for-strapi-core` | The editor-agnostic engine — all Strapi knowledge, reads IO through a `FileSystem` seam, pure TypeScript. |
| `devkit-for-strapi` | The VS Code extension (providers, watcher) — glue, no Strapi logic. |
| `devkit-for-strapi-mcp` | The stdio MCP server — a third client of the same engine. |

The same core powers the editor, the MCP server, and the tests — so a fact verified once is true on every
surface.

---

## Trademark

Independent, community-built tool — **not affiliated with, endorsed by, or sponsored by Strapi SAS.**
“Strapi” is a trademark of Strapi SAS, used here only to describe compatibility.

## License

The **core engine and the free editor/MCP wedge are free to use** (licensed [MIT](LICENSE))
(`devkit-for-strapi-core`, plus the read/navigation/diagnostics surface of the extension and the
read-only MCP tools).

The **Pro write/refactor engine** (propagated rename, move/extract, schema edits, plan→apply) is a
**separate package that is not included in this repository** — the `packages/pro` here is an
**MIT-licensed stub** that only preserves the public API so the free tier builds and runs. The real Pro
engine is licensed under **PolyForm Shield 1.0.0** and is bundled into the **published** VS Code
extension and MCP server, so those distributed artifacts are governed by `MIT AND
PolyForm-Shield-1.0.0`. Building from this repository produces the **free tier**; Pro features return a
"Pro required" upsell. Get Pro: <https://devkit-for-strapi.paulrichez.fr/pro/>.
