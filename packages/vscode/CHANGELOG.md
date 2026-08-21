# Changelog

## 0.1.5

An urgent fix for standalone MCP users, plus a way to tell what you're running.

**If you run the MCP server with `npx`, update your config**

- `npx` caches what it downloads and keeps serving that copy — for months, with no
  version pin involved. A real cache inspected here still held **0.1.0 from launch
  day**, seven weeks and four releases later. Anyone who wired up the standalone
  server early has been running the first release ever published.
- Every documented invocation now uses **`devkit-for-strapi-mcp@latest`**, which
  resolves the tag from the registry on each start. Verified against a stale cache:
  the bare name kept serving 0.1.0, `@latest` returned the current version.
- Advice that led into the trap is gone — the docs used to suggest pinning an exact
  version to match the installed extension, which is exactly what freezes you out
  of fixes.
- **Already set up?** Ask your agent for `server_info` (below) to see the version
  actually running, and clear the npx cache if it's behind: `rm -rf ~/.npm/_npx`,
  or `rmdir /s /q "%LOCALAPPDATA%\npm-cache\_npx"` on Windows.

**New: `server_info`**

- Reports the running version, the licence tier, how many tools are genuinely
  callable, and the indexed roots. MCP puts the version in the initialize
  handshake, which clients consume and don't always display — so neither you nor
  your agent could answer "which version is this?", the one thing a bug report
  needs. Now a tool call answers it.
- It also tells an agent which tools will really run: without a licence the twelve
  Pro tools are still advertised and only return an upsell when called.

**Clearer: this is not Strapi's MCP server**

- Strapi's own MCP server reached GA in 5.49 and does something different: it acts
  on your **content** (CRUD over entries in a *running* instance, admin token,
  Strapi ≥ 5.47). DevKit acts on your **codebase** — it reads `schema.json` and
  source files, needs no server, token or network, works on v4 as well as v5, and
  keeps working when the app doesn't. The docs now say so plainly, including a
  comparison table. Use Strapi's MCP to work *with* your content; use DevKit to
  work *on* your code.

**Housekeeping**

- Bug reports and questions now point at GitHub issues from the Marketplace Q&A tab
  too, so nothing lands somewhere unwatched.
- Listed under the **AI** category.

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
