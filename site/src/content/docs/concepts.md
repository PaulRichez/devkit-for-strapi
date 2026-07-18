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

When something can’t be proven — a non-literal string, an unverifiable external
plugin — DevKit **stays silent** rather than show a false positive. A wrong
diagnostic destroys trust; that’s worse than no diagnostic.

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
