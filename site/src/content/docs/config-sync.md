---
title: Config Sync
description: What DevKit reads of strapi-plugin-config-sync in your project — its options, where they come from, and the files of its sync directory — without starting Strapi.
---

For projects using [strapi-plugin-config-sync](https://github.com/pluginpal/strapi-plugin-config-sync),
DevKit reads the plugin's options and the files of its sync directory. It reads your
files only: Strapi is not started and the database is not read, so what is already
imported isn't known here.

## The options

DevKit reads the plugin's entry in `config/plugins`, following imports and the
`({ env }) => ({ … })` form, and says where each option comes from: your config, the
plugin's default, or a value DevKit can't read statically. For that last one it
assumes the default and says so.

A short `excludedConfig` doesn't replace the plugin's default list. Strapi merges
the two **index by index**, so the first entries of the defaults are overwritten
and the others stay. With `excludedConfig: ['core-store.plugin_upload_metrics']`,
for example, `core-store.plugin_users-permissions_grant` is no longer excluded. DevKit
applies that merge and warns about it.

DevKit also warns about:

- a `syncDir` without a trailing slash: the plugin then prefixes the file names with
  it instead of writing into a folder;
- a plugin major that doesn't match the project's Strapi (config-sync 1.x is for
  Strapi 4, 2.x and 3.x for Strapi 5);
- `config/env/<env>/plugins.*` files, which may change the options for that
  environment (DevKit lists them, it doesn't merge them).

## The files

Each file of the sync directory, with a readable name ("View — Article", "Role
Public", "Upload settings") and its status:

- **ok**: config-sync reads it;
- **excluded** by the options (`excludedTypes`, `excludedConfig`): the import and the
  export ignore it;
- **invalid**: not valid JSON, or empty — config-sync can't read it;
- **unknown type**: no config type of that name is registered here (a plugin may
  register it when Strapi runs).

## In VS Code

A **Config Sync** view shows up in the DevKit panel when a project uses the plugin:
the plugin, its version and the sync directory (the options and where they come from
in the tooltip), the files config-sync can't read, and every file grouped into
content-manager views, roles, admin roles, locales, settings and custom types. A file
config-sync can't read is also an error in the file. Other views link to it:

- **Model** shows a type's content-manager view when it is in `config/sync`;
- **Routes** shows, on the auth step, which roles in `config/sync` allow the route.
  The database may differ until these files are imported;
- **Health** lists the files config-sync can't read.

## For your AI agent

- [`config_sync_status`](/mcp-tools/) returns the plugin, its options and where they
  come from, and the files by status; `files: true` lists them with readable names,
  `key` returns one file's content.
- `project_info` says when a project uses config-sync, with a note asking the agent to
  prefer an export to editing `config/sync` by hand: config-sync compares each file as
  written with the database.
- `list_routes` with `pipeline: true` adds the roles of `config/sync` that allow each
  route (`syncedRoles`).

## Pro — through your Strapi

With Pro, DevKit asks **config-sync itself**: it loads your project's own Strapi the
way the plugin's CLI does — no server, no port, no admin account — and calls the
plugin. The answers are the plugin's, whatever the versions of Strapi and config-sync.
Checked on Strapi 5.54 with config-sync 3.2.0 (JavaScript and TypeScript, on SQLite
and PostgreSQL) and on Strapi 4.26 with 1.2.6 (JavaScript, on SQLite).

- **Compare with the database**: the diff config-sync's admin page shows — each
  entry *different*, *only in the database* or *only in config/sync*, with what
  differs in a few words. A click opens VS Code's diff editor: the database on the
  left, the file on the right. What a start of Strapi changes on its own is in it (a
  new field in a content-manager view, the super-admin's permissions…): after a
  change to a schema, a controller or a route, these are the entries to export.
- **Export** entry by entry, a selection, or every difference: the plugin's own
  export, the exact form it compares — so the files stop showing as different.
- **Import** entry by entry or from a list, never everything blindly. The
  confirmation says, for each entry, whether it is updated, created or deleted in
  the database. Afterwards, the entries still different are exported back: the
  database has just applied them, so what differs is its own form of them (a
  generated `documentId`…), and the diff converges. What you confirmed is checked again
  when it runs: an entry whose state changed since the comparison (a checkout deleted
  its file, and importing it would now delete it from the database) is left alone,
  and said. With config-sync's `soft` option,
  the plugin leaves the entries already in the database as they are: DevKit says
  which, and keeps their files.
- **From the diff itself**: with an entry open — its diff, or the one side it has —
  the editor's title bar has the same **Export** and **Import** buttons, for that
  entry. Partial changes stay by hand: edit the file in the diff (the right side is
  the real file), then import it.
- **For your agent**: `config_sync_diff`, `config_sync_export`, `config_sync_import`.
  The loop: change the code, `config_sync_diff`, export the entries the change
  caused, commit them with the code. To change a role or a content-manager view:
  edit its file, import it, and the plugin writes it back in its own form.
- **Refactors follow**: renaming or moving a content-type, a component, a controller
  or one of its actions, or renaming a field, also updates the `config/sync` files it
  concerns — the actions of the roles' permissions, the subjects and fields of the
  admin roles, the content-manager views (the file and its key, the fields of the
  layouts and their settings; a label still equal to the old field name follows).
  They are in the same plan as the code — the Refactor Preview lists them, the
  agent's plan names them — so they are committed with it, on its branch. The
  database follows when you import them (DevKit's import loads Strapi with the new
  code); nothing is imported without you, since the local database is shared by
  every branch.
  When `config/sync` is not yours to change in a project (exported from another
  environment), turn **`strapiDevkit.configSync.followRefactors`** off: plans then
  leave those files, and say which still use the old names — importing them would
  restore the permissions and views under those names. An agent can choose per call
  with `configSync: true` or `false`.

### What it runs, and what it refuses

Loading the project runs its code (its `register()`, its plugins), and does to the
database what a start of `strapi develop` does: the schema follows the code, pending
migrations run. So:

- in VS Code, it only runs in a **trusted workspace**, after you agree once per
  project; for an agent, the tools say they run the project's code, the import is
  marked destructive, and each call goes through your MCP client's tool approval;
- it only loads Strapi on a **local development database** (localhost, a socket, a
  SQLite file in the project; a database URL such as `DATABASE_URL` is judged by the
  host it points to) — unless you allow remote ones explicitly;
- it **refuses**, before Strapi's bootstrap — where it writes to the database: a SQLite file that doesn't exist (Strapi would
  create a new, empty one), a Strapi 4 database under Strapi 5 code (DevKit never runs
  the 4 → 5 migration, which can't be undone), an import when `NODE_ENV` is
  `production` (for the load, where DevKit runs, or in the project's `.env`), and an
  export from a database with no Strapi table yet (it would write a fresh
  install's defaults into `config/sync`);
- it warns when a Strapi server already answers on the same SQLite database: both
  write to it. It works — checked with `strapi develop` running on Strapi 5.54: the
  diff is right, and the server applies an imported permission at once.

When a load fails, DevKit says at which step (compiling, loading the code, checking
the database, starting Strapi), with Strapi's or the plugin's own message, its last
output, and what to do.

### Settings

| Setting | Default | |
|---|---|---|
| `strapiDevkit.runtime.nodePath` | `node` on the PATH | The Node your project's dependencies were installed with (native modules are built for it). User settings only. |
| `strapiDevkit.runtime.timeoutSeconds` | 180 | A first TypeScript compilation can take over a minute. |
| `strapiDevkit.configSync.environment` | `development` | `NODE_ENV` of the load. |
| `strapiDevkit.configSync.envPath` | the project's `.env` | The `.env` Strapi loads. |
| `strapiDevkit.configSync.allowRemoteDatabase` | off | Load Strapi on a database that is not on this machine. |
| `strapiDevkit.configSync.followRefactors` | on | Renames and moves also update the `config/sync` files they concern. Per project (it can go in `.vscode/settings.json`). |

The bundled MCP server uses the same settings. A standalone one reads `DEVKIT_NODE`,
`DEVKIT_CONFIG_SYNC_ENV`, `DEVKIT_CONFIG_SYNC_ENV_PATH`, `DEVKIT_ALLOW_REMOTE_DATABASE=1`
and `DEVKIT_RUNTIME_TIMEOUT_S`, and `DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS=0` to leave
`config/sync` out of refactors by default.
