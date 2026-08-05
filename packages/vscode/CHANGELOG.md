# Changelog

## 0.1.4

Accuracy and plumbing — no new features. Both fixes were found by running the
engine against real public Strapi v5 projects rather than the test fixtures.

**Corrections**

- The v4-in-v5 warning claimed `strapi.entityService` **"was removed in Strapi
  v5"**. It is *deprecated*, not removed — it still runs. Telling someone their
  working code was removed is the kind of false positive "guarantee, don't
  guess" exists to prevent; the wording now matches Strapi's own docs.
- The MCP server announced version **`0.1.0`** in its handshake regardless of
  what was actually running — it was hard-coded and never bumped. It now reports
  the real version, injected at build time from `package.json`, so a client can
  display it and a bug report can name it.

**Docs**

- Both READMEs now show how to *use* the bundled MCP server — agent mode, example
  prompts, and a copy-paste config for Claude Code / Claude Desktop. It was
  described but never explained, so installers had no path to it.
- Bug reports and questions now go to **[GitHub issues](https://github.com/PaulRichez/devkit-for-strapi/issues)**
  (the repository is public); anything about a Pro licence stays on email.
- Corrected the documented MCP tool count (30 = 28 active + 2 deprecated
  aliases), documented the previously missing `refresh` tool, and warned that the
  server does not watch the filesystem — after a `git pull` or branch switch the
  index is stale until `refresh` runs.

## 0.1.3

Bug-fix release — accuracy hardening (from two internal audits). Versions are now
aligned with the `devkit-for-strapi-mcp` package (0.1.1/0.1.2 skipped). No new features;
every change makes an existing result *more correct*.

**Fewer false positives** (the "guarantee, never guess" rule)

- Core framework namespaces (`admin::`, `strapi::`), component UIDs used in
  content-type contexts, schema-only content-types, nested controllers/services,
  and `this.method()` self-calls are no longer wrongly flagged or mis-rewritten.
- The incremental index no longer leaves stale or phantom references after an
  edit (5 divergences that could surface false "unknown reference" warnings).
- Multi-project resolution no longer silently falls back to the only project when
  an explicit selector doesn't match.

**Coverage & speed**

- Now indexes `src/extensions/**` content-type overrides.
- Faster incremental re-indexing after file changes.

## 0.1.0

First public release.

**In your editor — free**

- **Autocomplete** of real Strapi references (UIDs, services, controllers,
  policies, middlewares, components) inside magic-string call sites.
- **Diagnostics** for invalid/unknown references with quick fixes, plus warnings
  for Strapi v4 patterns (`entityService`) used in a v5 project.
- **Go-to-definition** that resolves the correct target by context (service,
  controller, schema, route handler → action method, plugin chains, …).
- **Find All References + CodeLens** — a "N references (Strapi)" lens on every
  definition, including **per-method** (counts `strapi.service('x').method()`
  calls and route handlers the TypeScript server can't resolve).
- **Hover** describing the resolved entity, plus signatures for service methods
  and docs for built-in Strapi API methods.

**For your AI agent (MCP) — free**

- A bundled **MCP server**, auto-registered in VS Code, Cursor, Windsurf and
  Antigravity, exposing the project's real values (read & analyse tools) so agents
  stop hallucinating magic strings.

**Pro**

- **Rename (F2)** — renames an entity **or a method** and propagates to every
  call-site (and route-handler action) plus the underlying file/folder
  (content-types also rename their coupled service/controller).
- MCP refactors as reviewable plans (`plan_*`) plus a verified, transactional
  **apply**. Unlock both surfaces with one licence key.

Multi-project discovery by content; Strapi v4 and v5 support; JavaScript and
TypeScript parity.
