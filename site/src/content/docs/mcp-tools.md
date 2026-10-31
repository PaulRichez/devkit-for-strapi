---
title: MCP tool reference
description: Every MCP tool an AI agent can call — read, analyse, and refactor a Strapi project with verified, real values.
---

The MCP server exposes **37 stdio tools** (35 active + 2 deprecated aliases) so an AI agent works from your project's
**real values** instead of grepping for them. Four layers: **Know** (read the truth),
**Understand** (health & graph), **Config sync through your Strapi** (Pro), **Refactor**
(plan → review → apply).

See [For your AI agent (MCP)](/mcp/) for setup. In VS Code, Cursor, Windsurf and
Antigravity the server is bundled and auto-registered — no config.

## Choosing a project (multi-project workspaces)

Every tool accepts two optional selectors:

- **`from`** — a path **inside** the target project (e.g. the file you're editing). Disambiguates a multi-project workspace.
- **`project`** — a project name or root to select among discovered projects.

If a tool returns **`noProject`**, the project isn't indexed yet — call
`add_project` and retry. (`from`/`project` only *choose* among already-discovered
projects; they don't add new roots.)

### `add_project`
Register and index a Strapi project on demand from an **absolute path** — the
project root, or any file/folder inside it (the server walks up to the root; a
folder is also scanned downward for monorepos). Idempotent, and persisted so it
survives server respawns. Returns the projects now known.

## Know — read the project's truth

| Tool | Params | What it returns |
|---|---|---|
| `list_projects` | — | The Strapi projects in the workspace (name, root, version, counts). Call first in a multi-project workspace. |
| `project_info` | `from?` \| `project?` | One project in full: Strapi version (installed / declared), TypeScript or JavaScript, package manager, API prefix, counts (APIs, content-types by kind, components, services, controllers, policies, middlewares, routes), every local and installed plugin with whether its refs are verified and, when not, **why** (no `node_modules`, rewritten at boot by a project file, a `src/extensions` override, Enterprise-only code…), health (broken refs, refs into unverified plugins), `configSync` when the project uses strapi-plugin-config-sync, and `freshness`. The answer to "why is this plugin ref `external`?" |
| `list_content_types` | — | Real content-type UIDs (e.g. `api::article.article`). Use these exact UIDs. |
| `list_components` | — | Real component UIDs (e.g. `shared.seo`). |
| `list_artifacts` | `kind?` | Real refs of services / controllers / policies / middlewares (optionally one kind). |
| `get_schema` | `uid` \| `uids[]` | The real attributes (fields, relations, components) of a content-type/component. Batchable. Use instead of guessing field names. |
| `resolve` | `ref` | The defining file(s) of a reference, tagged by kind. |
| `validate_reference` | `ref` | `valid` \| `unknown` (+ `didYouMean`) \| `external`: a plugin DevKit can't verify — not installed, not read completely, rewritten at boot by the project, or still being read just after startup (`project_info` says which and why). Installed plugins read completely are checked like your own code. Call before writing a magic string. |
| `find_references` | `ref` \| `refs[]`, `compact?`, `limit?`, `offset?` | Every call-site of a UID / service / controller / handler (or `ref#method`) in the project's own code (`src/`, `config/`; `node_modules` and build output aren't searched). Returns `total`, then a page of up to `limit` hits (default 50; `truncated: true` when more remain): `path:line:col [via] snippet`. |
| `list_routes` | `plugins?`, `admin?`, `method?`, `path?`, `handler?`, `pipeline?` | The HTTP route table: method, path, mounted `fullPath`, handler, policies, middlewares, `public` (`auth: false`), `auth` when customized, and where each route is declared (`filePath`/`offset`). Explicit routes, auto-CRUD from `createCoreRouter`, and the routes local and installed plugins declare (`origin`; `plugins: false` to leave them out). Admin-panel routes only with `admin: true`. Filter by `method`, `path` (a pattern, part of it, or a concrete URL such as `/api/articles/12`) or `handler`. With `pipeline: true` (needs a filter, at most 20 routes): what a request goes through, in Strapi's order — the `config/middlewares` stack, auth, policies, route middlewares, handler — each step `ok`, `not-found-by-strapi` (it exists under a name Strapi won't try: Strapi throws at startup), `unknown`, `unverified`, `unread` or `inline`; with config-sync, the auth step adds the roles of `config/sync` that allow the route (`syncedRoles`). Static, no Strapi boot. |
| `refresh` | `cold?` | Re-scan every discovered project from disk and rebuild the index; `cold: true` also drops the cached plugin reads and reads every installed plugin again. Rarely needed (see below). Returns the projects with their `freshness`. |
| `server_info` | — | The running server: `version`, licence `tier`, how many tools are actually callable, the Pro-only tool names, the indexed roots, and how current each project's index is (`freshness`). `tools/list` advertises the Pro tools too — this says which ones will really run. Also the only way for an agent to name a version in a bug report (the version lives in the MCP handshake, which clients don't always display). |

:::note[Changes made outside the session]
The server has no file watcher, so before answering each call it compares the
project's files with the disk (a few milliseconds) and re-indexes what was
created, edited or deleted outside it: a manual edit, another tool, a
`git checkout`/`pull`, a branch switch. Installed plugins are re-read after an
install. `server_info` and `list_projects` report each project's `freshness`
(when it was indexed, last compared with the disk, when its plugins were read and
how many came from the read cache). On a project too large to compare (over
20,000 files) `freshness.diskTracking` is `off`: call `refresh` after editing
files outside the session. `refresh({ cold: true })` also reads every installed
plugin again. Every answer carries the same `freshness` in its MCP `_meta`
(`devkit-for-strapi/freshness`), and a visible `Freshness:` line is appended only
when something limits it.
:::

Each reference is tagged with a **`via`** — how the call reaches the entity: the
call form (`service`, `documents`, `query`, `schema` relation, `route` handler,
`relation-field`, …) or an internal `this` / `member-var` self-call. Run `coverage`
for the full list of indexed forms.

## Understand — health & dependency graph

| Tool | Params | What it returns |
|---|---|---|
| `list_unused` | `file?`, `kinds?` | Definitions with **0 Strapi references** (dead methods, content-types, components, services, policies, middlewares). Counts Strapi refs only — a method called directly in TS still appears, so verify before deleting. |
| `list_broken_refs` | — | Magic strings that resolve to nothing — the inverse of `list_unused`, and the safety net after a move/rename (target: 0). |
| `coverage` | — | The call forms the engine indexes (+ a `via` tag) and the ones it does **not** yet (`indexed: false`). Use it to know whether `find_references`/`list_unused` can be trusted for a pattern. |
| `find_relation_usages` | `uid`, `field?` | Where a content-type's relation fields are used by name (`populate`/`filters`). Indispensable before retargeting or removing a relation. |
| `list_refs` | `pattern` | Entity refs matching a glob — `plugin::billing.*` for a plugin's whole surface, `api::*`, `*`. |
| `dependencies` | `ref`, `transitive?` | What `ref` **uses** (outgoing edges: relations, calls). Half of the cut-analysis for modularization. |
| `dependents` | `ref`, `transitive?` | What **uses** `ref` (incoming edges) — what would break if it moved. The other half of cut-analysis. |
| `config_sync_status` | `key?`, `files?` | For a project using strapi-plugin-config-sync, read from the files (Strapi is not started, the database is not read): the plugin's version, its options and where each comes from (with the warnings, such as a short `excludedConfig` merged index by index with the defaults), the sync directory, and its files by status — `ok`, `excluded`, `invalid` (config-sync can't read it), or of a type not registered here. `files: true` lists them with readable names; `key` returns one file's content. See [Config Sync](/config-sync/). |
| `get_model_diagram` *(Pro)* | `components?`, `allPlugins?`, `media?`, `strapiFields?`, `focus?[]` | The data model as a Mermaid `erDiagram`: content-types (and components) with their fields, one line per association with its cardinalities, media fields linked to the upload plugin's File, the plugin types they link to; with `strapiFields`, what Strapi adds to every content-type (`createdAt`, `updatedAt`, `publishedAt`, `createdBy`/`updatedBy` → `admin::user`). `focus` narrows it to some types and their neighbours. Read from the schemas. |
| `config_sync_diff` *(Pro)* | `key?`, `type?`, `env?` | The real diff between config/sync and the database, from config-sync itself: each entry `different`, `only-in-db` or `only-in-sync-dir`, with what differs in a few words — what a start of Strapi changes on its own included. With `key`, every difference, and both sides in full when they fit in one answer; `type` lists one type only (`admin-role`, `user-role`…). Loads the project's Strapi the way the plugin's CLI does (runs its code; local development database only). |
| `config_sync_export` *(Pro)* | `keys?`, `env?` | ⚠️ **Writes config/sync.** The plugin's own export of the entries that differ (`keys` narrows it): the exact form it compares. |
| `config_sync_import` *(Pro)* | `keys`, `reexport?`, `env?` | ⚠️ **Writes the database.** The plugin's own import of `keys` (required: never everything at once); then the entries still different are exported back in the database's form. Refused with `NODE_ENV=production`. |

## Refactor — plan → review → apply (Pro)

These tools require a **[Pro](/pro/)** licence — without one they stay visible to
your agent but return a structured **“Pro required”** result instead of running, so
the agent can relay it rather than fail silently.

Writes are a **contract**. A `plan_*` tool computes the exact edits and returns a
**`planId`** — it writes nothing. Its answer is the plan to review: each edit on one
line with the text it replaces (`25: "api::restaurant.restaurant" → "api::restaurant.eatery"`),
the file renames, new files and deletes, paths relative to the project. You review it,
then `apply_edits` applies **exactly that plan** — only a plan DevKit computed this
session, by its `planId` — after re-verifying every touched file's fingerprint (a stale
plan is rejected), confined to the project root (symlink-resolved), best-effort
transactional, and **self-verifying** for broken refs afterward.

| Tool | Params | What it plans |
|---|---|---|
| `plan_rename_method` | `ref`, `method`, `newName` | Rename a service/controller method — declaration, every `strapi.service(...).method()` call-site, and (controllers) the route-handler action segment. |
| `plan_rename_entity` | `ref`, `newName` | Rename a content-type / service / controller / policy / middleware / component — every call-site & route handler, plus file/folder renames. The plan's `warnings` list the UIDs Strapi also stores **in the database** (permissions, media links, components): the plan edits code and files only, so migrate those rows on a project that already has data. With config-sync, the plan also updates the sync files of those permissions and views (see `configSync` below). |
| `plan_move` | `ref`, `toNamespace` | Move an artifact, or a whole content-type resource (CT + service + controller + routes), to another namespace; repoints relation `target`s and `strapi.plugin(...)` chains. |
| `plan_move_entities` | `refs[]`, `toNamespace` | Like `plan_move` for several refs to one destination, in one coherent pass. |
| `plan_change_relation` | `uid`, `field`, `newTarget` | Retarget a relation field to another content-type (precise `schema.json` edit). Warns about a now-orphaned inverse. |
| `plan_rename_attribute` | `uid`, `oldName`, `newName` | Rename an attribute in `schema.json` + (relation) its `populate`/`filters` usages. ⚠️ Does **not** rewrite `entity.field` object access — always warns. |
| `create_plugin` | `name` | Scaffold a new local plugin (`strapi-server.js`, `config/plugins`). |
| `extract_to_plugin` | `refs[]`, `name` | Scaffold a plugin **and** move artifacts into it — in one plan. The one-pass extraction primitive. |
| `apply_edits` | `planId` | ⚠️ **Writes.** Apply a reviewed plan. Verified against disk first; a changed file → nothing is written. |
| `apply_rename` | `ref`, `newName`, `method?` | ⚠️ **Writes.** Convenience: plan + apply a rename in one call. Prefer `plan_rename_*` + `apply_edits` to review first. |

> Deprecated aliases (kept for transition): `change_relation` → `plan_change_relation`, `rename_attribute` → `plan_rename_attribute`.

**`configSync`** — with strapi-plugin-config-sync, the renames and moves
(`plan_rename_*`, `plan_move*`, `plan_rename_attribute`, `extract_to_plugin`,
`apply_rename`) also update the `config/sync` files they concern: the roles'
permissions, the admin roles, the content-manager views. Pass `configSync: false` to
leave them (a project whose `config/sync` comes from another environment). The default
is the user's `strapiDevkit.configSync.followRefactors` setting — on unless turned off
(`DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS=0` for a standalone server). Either way a
`warnings` entry says which sync files the plan updates, or leaves with the old names.
Importing them is the user's call: the local database is shared by every branch.

## Addressing & guarantees

- **Entities**: `api::article.article`, `shared.seo`, `plugin::billing.invoice`.
- **Methods**: `ref#method` (e.g. `api::page.notifier#notify`) in `resolve` / `validate_reference` / `find_references`.
- **Guarantee, don't guess**: a ref into a plugin DevKit couldn't read completely is reported as `external`, never invented; refactors are all-or-nothing and never touch `node_modules`; warnings are never silent.
