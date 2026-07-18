---
title: In your editor
description: Autocomplete, diagnostics, navigation, references and rename for Strapi magic strings.
---

Inside a Strapi project — zero config, no type generation.

## Autocomplete

Inside a [magic string](/concepts/), suggests the real values for the context at
your cursor: UIDs, services, controllers, policies, middlewares, components, and a
content-type’s route actions.

```ts
strapi.service('api::|')   // ← suggests every real content-type UID in your project
```

## Diagnostics

Underlines references that don’t exist (with quick fixes that suggest the closest
match), and flags Strapi **v4 patterns** (e.g. `strapi.entityService`) used in a
**v5** project.

```ts
strapi.documents('api::artcle.artcle')
// ✗ unknown UID — quick fix: did you mean 'api::article.article'?
```

## Go to definition

Ctrl/Cmd-click a string to jump to the right target: a UID → its `schema.json`, a
service/controller/policy/middleware → its file, a route `handler` → the
controller **method**, a component → its JSON, a `plugin('a').service('b')` chain
→ the plugin’s service.

```ts
// Ctrl/Cmd-click the UID → opens the content-type's schema.json
strapi.documents('api::article.article')
```

## Find references & CodeLens

A “N references (Strapi)” lens on every definition, including **per-method** usages
(`strapi.service('x').find()` calls and route handlers) the TypeScript server
can’t see, because `strapi.service(...)` is typed `any`. A second
“N incoming relations” lens on `schema.json`.

## Rename — Pro

Renaming an entity **or a method** propagates to every call-site and route
handler, renames the underlying file/folder, and updates relation `target`s — no
grep-and-pray. See [Pro](/pro/).

## Hover

Describes what a string resolves to, with the signature for service methods and
usage insights (incoming relations, route handlers, data usages).

---

Every feature here can be tuned in [Configuration](/configuration/) — diagnostic
severity, the references CodeLens, the per-method lens, and project-discovery
exclusions.
