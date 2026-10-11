# Changelog

## Unreleased

**Installed plugins are verified, not skipped**

- DevKit now reads the plugins in `node_modules` the way Strapi's loader does: the
  internal plugins, the dependencies that declare themselves Strapi plugins, the
  rules of `config/plugins`, and each plugin's `strapi-server` entry. It follows
  their code statically and never executes it.
- Refs into a plugin read completely are checked like your own:
  `plugin::users-permissions.usr` gets "did you mean `plugin::users-permissions.user`",
  and completion, hover and go-to-definition work on plugin UIDs, services and
  methods. A plugin DevKit can't read completely stays silent, as before.
- Strapi's built-in middlewares are checked in `config/middlewares`: `strapi::corss`
  gets "did you mean `strapi::cors`".
- Checked against real Strapi: on six projects from 4.13 to 5.54, every plugin DevKit
  reads completely matched exactly what Strapi registers. Plugins whose server depends
  on the Enterprise edition (content-manager's history, content-releases,
  review-workflows) stay unverified.
- Installing a plugin is picked up without a reload, through the files npm, yarn and
  pnpm rewrite on install.
- Plugins are read in the background: the editor is ready in well under a second,
  and refs into plugins are checked a few seconds later, never wrongly reported in
  between. A plugin whose files didn't change isn't read again, so editing
  `config/plugins` re-checks a project in a fraction of a second.

**New: the DevKit panel**

- A **DevKit for Strapi** container in the activity bar, read from your code without
  starting Strapi:
  - **Health**: the whole project — broken references (with the closest real name),
    policies and middlewares Strapi won't find at startup, refs DevKit can't check
    and why, definitions no Strapi reference uses, plugins not read completely. A
    badge counts the problems; **Check the Whole Project** fills the Problems panel
    for the files that aren't open.
  - **Routes**: every route (your API, then plugin routes), and under each one what a
    request goes through, in Strapi's order — the `config/middlewares` stack, auth,
    the route's policies, its middlewares, the handler — each step with whether
    Strapi will find it, and a link to its definition. Filters by method, public,
    guarded, with a problem.
  - **Model**: content-types and components with their fields, the fields of other
    types pointing at each one, the routes exposing it, its usage, the components
    nothing uses, and the types installed plugins bring (read-only).
  - **Plugins**: local and installed, what each adds, whether its refs are checked
    and why not, disabled ones, the ones your code rewrites or extends.
- Above each controller action, the routes it handles.
- **Ctrl+T** finds Strapi names: UIDs, services, controllers and their actions,
  policies, middlewares, routes.
- The status bar shows the Strapi version and the problem count; **Reveal in DevKit
  Panel** opens the current schema or controller there, and the open views follow
  the editor.
- **Pro**: refactor from the panel — rename a content-type, component, field or
  controller action, retarget a relation, move a content-type into a plugin,
  scaffold a plugin — with the caveats first, then VS Code's Refactor Preview.
- **Pro**: the relations diagram — an MCD (entities with their fields, straight links
  with 1 / n cardinalities) or a graph; components, plugin types, media and the
  fields Strapi adds to every content-type on demand; export as Markdown (Mermaid),
  PNG or SVG.

**New: Config Sync**

- For projects using strapi-plugin-config-sync, read from the files, without starting
  Strapi or reading the database: the plugin's options and where each comes from (a
  short `excludedConfig` is merged index by index with the plugin's defaults, as
  Strapi does — DevKit says which defaults it no longer excludes), and the files of
  the sync directory with readable names and their status. A file config-sync can't
  read is an error in it.
- A **Config Sync** view in the panel, a content-manager view entry per type in
  **Model**, the roles of `config/sync` that allow a route in **Routes**, the files
  config-sync can't read in **Health**.
- MCP: `config_sync_status`; `project_info` says when a project uses config-sync;
  `list_routes` with `pipeline: true` adds the synced roles on the auth step.

**New, Pro: Config Sync through your Strapi**

- The real diff between `config/sync` and the database, from config-sync itself:
  DevKit loads your project's own Strapi the way the plugin's CLI does (no server,
  no port, no admin account) and asks the plugin — whatever the versions of Strapi
  and config-sync. A **Database** section in the Config Sync view; a click opens
  VS Code's diff editor, the database on the left.
- Export and import entry by entry, with a confirmation saying what each one does
  (updated, created, deleted); after an import, the entries still different are
  exported back in the database's own form, so the diff converges.
- MCP: `config_sync_diff`, `config_sync_export`, `config_sync_import`, and the loop
  in the server's instructions: change the code, diff, export what the change
  caused, commit it with the code.
- Only in a trusted workspace, after your agreement, on a local development
  database. Refused before anything runs: a missing SQLite file, a Strapi 4 database
  under Strapi 5 code, an import in production, an export from an empty database.
- Checked against the plugin itself on Strapi 5.54 (JavaScript and TypeScript) and
  4.26 (JavaScript), on SQLite.

**Routes: what Strapi really does with names**

- Policy and middleware names are checked the way Strapi looks them up (read in
  Strapi 4.13 and 5.48): a route's policy by its exact name, then in the route's own
  API or plugin — never in `global::` — and a middleware by its full name only. A
  short name DevKit used to accept now gets "Strapi won't find … at startup", with a
  quick fix to the full name.
- Routes keep their `auth` (public, custom scope or strategies), per
  `createCoreRouter` action too (`config.find.auth: false` was lost), and policies or
  middlewares declared as functions.
- The MCP `list_routes` tool returns the same table, with `fullPath`, `public`,
  `auth`, the declaration location and plugin routes (admin routes with
  `admin: true`); `method`, `path` (a concrete URL too) and `handler` filters; and
  `pipeline: true` to explain a route.
- New MCP tool `get_model_diagram` (Pro): the data model as a Mermaid `erDiagram`.

**MCP: always answers on the current files**

- The MCP server re-indexes what changed on disk before answering (edits made
  outside the session, a `git checkout`, an `npm install`), so `refresh` is no
  longer needed to avoid stale answers. `server_info` and `list_projects` say how
  current each project's index is; `refresh({ cold: true })` reads everything again.
- Refactors that change a UID Strapi also stores in the database (a content-type,
  a component, a controller or one of its actions) now warn about it: permissions,
  media links and components point at the old UID until those rows are migrated.
  The plans edit code and files only.
- New MCP tool `project_info`: one project in full — versions, TypeScript or
  JavaScript, package manager, API prefix, counts, every plugin with whether its
  refs are verified and, when not, why — plus health (broken refs, refs into
  unverified plugins) and freshness.

**Fixes**

- Renaming a controller action (Pro) failed when a service shared its ref — the
  standard layout (`createCoreService` next to `createCoreController`).
- A short route handler pushed into a plugin from `src/extensions` was reported
  "malformed".

- Local plugins scaffolded with the Strapi 5 plugin SDK (`server/src`) were invisible,
  so valid refs into them were reported unknown.
- Content-types a local plugin declares in code (`content-types/index.ts`) are read.
- A local plugin with its own `package.json` was treated as a separate project.
- Route files that export a variable (`export default customRoutes`) were missing
  from the route list.
- Strapi 4 i18n's `POST …/localizations` routes are listed.

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
