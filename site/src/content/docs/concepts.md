---
title: Strapi magic strings
description: What DevKit for Strapi understands — UIDs, refs, route handlers, components.
---

Strapi runs on _magic strings_ — identifiers that look like ordinary text to your
editor and your compiler, but that Strapi resolves at runtime:

- **Content-type UIDs** — `api::article.article`, `plugin::users-permissions.user`
- **Service / controller refs** — `strapi.service('api::article.article')`
- **Policy & middleware names** — `global::is-authenticated`, `api::article.is-owner`
- **Component UIDs** — `shared.seo`
- **Route handlers** — `handler: 'api::article.article.find'`
- **Config stacks** — `config/middlewares.ts` entries like `'strapi::logger'`

A typo in any of these compiles fine and **fails silently at runtime**. DevKit
reads the **real** content-types, components, services, controllers, policies,
middlewares and routes of every Strapi project in your workspace and turns those
strings into first-class, verified code.

## Guarantee, don’t guess

When something can’t be proven — a non-literal string, a plugin DevKit couldn’t
read exhaustively — DevKit **stays silent** rather than show a false positive. A
wrong diagnostic destroys trust; that’s worse than no diagnostic.

## Installed plugins

Refs into installed plugins (`plugin::users-permissions.user`, `plugin::upload.file`,
`strapi::cors`…) are checked against the plugins actually in `node_modules`. DevKit
reads them the way Strapi’s own loader does: Strapi’s internal plugins, the
`package.json` dependencies that declare themselves Strapi plugins, the rules of
`config/plugins` (a plugin disabled there is ignored), and each plugin’s
`strapi-server` entry. It follows their code **statically — nothing is executed**,
no server is started.

A plugin is only used to report an unknown ref when it was read **completely**. If
anything can’t be followed (a computed export, an `env()`-dependent setting, a
`src/extensions/<plugin>/strapi-server` override), its refs stay silent, as they
always were. Without `node_modules`, nothing changes.

Code that rewrites a plugin at boot (your `src/**`, a local plugin, another plugin
writing into `strapi.plugin('x').controllers`, directly or through a variable or a
helper) makes that plugin unverifiable too. One assumption: Strapi’s runtime and the
libraries a plugin calls don’t modify what they’re handed, except the known merging
utilities (`Object.assign`, lodash’s `merge`/`set`…), which DevKit does follow.

This reading is checked against real Strapi in DevKit’s own test suite: on six real
projects from Strapi 4.13 to 5.54, every plugin DevKit reads completely matched what
Strapi registers — content-types, services, controllers, policies, middlewares and
routes. Plugins whose server depends on the Enterprise edition (content-manager’s
history feature, content-releases, review-workflows) stay unverified, since what they
register depends on your licence.

## Multi-project, v4 and v5

DevKit discovers every Strapi project in the workspace **by content** (scanning
each `package.json` for an `@strapi/strapi` dependency), never assuming
_workspace root = Strapi root_. References resolve against the project that
**owns** the edited file; an ambiguous request returns candidates, never a silent
choice. The version is detected per project, and v4-only patterns used in a v5
project (e.g. `strapi.entityService`) are flagged.

## Next

DevKit turns these strings into first-class, verified code — autocomplete,
go-to-definition, find references, typo diagnostics and hover — in
[your editor](/editor/), and exposes the same truth to [your AI agent](/mcp/).
