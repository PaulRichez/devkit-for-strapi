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
