---
title: MCP tool reference
description: Every MCP tool an AI agent can call — read, analyse, and refactor a Strapi project with verified, real values.
---

The MCP server exposes **29 stdio tools** (27 active + 2 deprecated aliases) so an AI agent works from your project's
**real values** instead of inventing them. Three layers: **Know** (read the truth),
**Understand** (health & graph), **Refactor** (plan → review → apply).

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
| `list_content_types` | — | Real content-type UIDs (e.g. `api::article.article`). Use these exact UIDs. |
| `list_components` | — | Real component UIDs (e.g. `shared.seo`). |
| `list_artifacts` | `kind?` | Real refs of services / controllers / policies / middlewares (optionally one kind). |
| `get_schema` | `uid` \| `uids[]` | The real attributes (fields, relations, components) of a content-type/component. Batchable. Use instead of guessing field names. |
| `resolve` | `ref` | The defining file(s) of a reference, tagged by kind. |
| `validate_reference` | `ref` | `valid` \| `unknown` (+ `didYouMean`) \| `external` (a plugin not in the workspace — unverifiable). Call before writing a magic string. |
| `find_references` | `ref` \| `refs[]`, `compact?`, `limit?`, `offset?` | Every call-site of a UID / service / controller / handler (or `ref#method`). Returns `total`, then a page of up to `limit` hits (default 50; `truncated: true` when more remain): `path:line:col [via] snippet`. |
| `list_routes` | — | The HTTP route table (method, path, handler, policies, middlewares) — explicit + auto-CRUD from `createCoreRouter`. Static, no Strapi boot. |

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

## Refactor — plan → review → apply (Pro)

These tools require a **[Pro](/pro/)** licence — without one they stay visible to
your agent but return a structured **“Pro required”** result instead of running, so
the agent can relay it rather than fail silently.

Writes are a **contract**. A `plan_*` tool computes the exact edits and returns a
**`planId`** — it writes nothing. You review the plan, then `apply_edits` applies
**exactly that plan**, after re-verifying every touched file's fingerprint (a stale
plan is rejected), confined to the project root (symlink-resolved), best-effort
transactional, and **self-verifying** for broken refs afterward.

| Tool | Params | What it plans |
|---|---|---|
| `plan_rename_method` | `ref`, `method`, `newName` | Rename a service/controller method — declaration, every `strapi.service(...).method()` call-site, and (controllers) the route-handler action segment. |
| `plan_rename_entity` | `ref`, `newName` | Rename a content-type / service / controller / policy / middleware / component — every call-site & route handler, plus file/folder renames. |
| `plan_move` | `ref`, `toNamespace` | Move an artifact, or a whole content-type resource (CT + service + controller + routes), to another namespace; repoints relation `target`s and `strapi.plugin(...)` chains. |
| `plan_move_entities` | `refs[]`, `toNamespace` | Like `plan_move` for several refs to one destination, in one coherent pass. |
| `plan_change_relation` | `uid`, `field`, `newTarget` | Retarget a relation field to another content-type (precise `schema.json` edit). Warns about a now-orphaned inverse. |
| `plan_rename_attribute` | `uid`, `oldName`, `newName` | Rename an attribute in `schema.json` + (relation) its `populate`/`filters` usages. ⚠️ Does **not** rewrite `entity.field` object access — always warns. |
| `create_plugin` | `name` | Scaffold a new local plugin (`strapi-server.js`, `config/plugins`). |
| `extract_to_plugin` | `refs[]`, `name` | Scaffold a plugin **and** move artifacts into it — in one plan. The one-pass extraction primitive. |
| `apply_edits` | `planId` \| `plan` | ⚠️ **Writes.** Apply a reviewed plan. Verified against disk first; a changed file → nothing is written. |
| `apply_rename` | `ref`, `newName`, `method?` | ⚠️ **Writes.** Convenience: plan + apply a rename in one call. Prefer `plan_rename_*` + `apply_edits` to review first. |

> Deprecated aliases (kept for transition): `change_relation` → `plan_change_relation`, `rename_attribute` → `plan_rename_attribute`.

## Addressing & guarantees

- **Entities**: `api::article.article`, `shared.seo`, `plugin::billing.invoice`.
- **Methods**: `ref#method` (e.g. `api::page.notifier#notify`) in `resolve` / `validate_reference` / `find_references`.
- **Guarantee, don't guess**: an unverifiable external-plugin ref is reported as `external`, never invented; refactors are all-or-nothing; warnings are never silent.
