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

Refs into [installed plugins](/concepts/#installed-plugins) are checked too, and so
are Strapi’s built-in middlewares in `config/middlewares`:

```ts
strapi.service('plugin::users-permissions.jwtt')
// ✗ unknown service — did you mean 'plugin::users-permissions.jwt'?
export default ['strapi::errors', 'strapi::corss'];
// ✗ unknown Strapi middleware — did you mean 'strapi::cors'?
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

## The DevKit panel

The **DevKit for Strapi** icon in the activity bar opens four views. They are read
from your code (schemas, route files, `config/`, the plugins in `node_modules`)
without starting Strapi, and show the saved files.

### Health

What's wrong in the **whole project**, not only in the open files:

- **Broken references**: UIDs, services, controllers, policies… that resolve to
  nothing, with the closest real name to replace them with.
- **Names Strapi won't find at startup**: a policy or a middleware that exists, but
  not under the name you wrote. Strapi looks a route's policy up by its exact name,
  then in the route's own API or plugin, never in `global::`; a middleware only by
  its full name. Strapi 4 and 5 both throw at startup; the diagnostic in the file
  has the quick fix.
- **Refs DevKit can't check** (into plugins it couldn't read completely), and why.
- **No Strapi reference**: definitions no magic string or route uses. A direct call
  or a computed name can still use them, so check before deleting.

The badge on the panel counts the problems. **Check the Whole Project** fills the
Problems panel for the files that aren't open.

### Routes

Every route of the project (your API, then the routes plugins declare), and under
each one, **what a request goes through, in Strapi's order**:

1. the `config/middlewares` stack;
2. auth: `auth: false` (public), the default strategies, or a custom scope;
3. the route's policies;
4. its middlewares;
5. the handler.

Each step says whether Strapi will find it and links to its definition. With the
default auth, access then depends on the role's or the API token's permissions,
which are set in the admin. Filters show only some methods, the public routes, the
guarded ones, or the ones with a problem.

Above each controller action, a CodeLens lists the routes it handles
(`GET /api/articles · PUT /api/articles/:id`).

### Model

Your content-types and components, with what no single schema shows:

- their fields (relation kind, required, unique, private);
- the fields of other types pointing at each one;
- the routes exposing it;
- how much code uses it;
- the components nothing uses.

The types installed plugins bring are there too, read-only: the fields of
`plugin::users-permissions.user`, for one.

### Plugins

Local and installed plugins:

- what each one adds;
- whether DevKit checks the refs into it, and when not, why;
- the ones disabled in `config/plugins`;
- the ones your code rewrites or extends.

### Relations diagram — Pro

Every type and its links, live:

- an **MCD** view: entities listing their fields, straight links with their
  cardinalities (1 / n);
- or a compact **graph**.

Options:

- components;
- plugin types;
- media fields;
- the fields Strapi adds to every content-type (`createdAt`, `updatedAt`,
  `publishedAt`, `createdBy`/`updatedBy` → `admin::user`).

Export as Markdown (a Mermaid `erDiagram`, which renders on GitHub), PNG or SVG.

### Refactor from the panel — Pro

Right-click a content-type, a component, a field or a controller action in the
panel. You can rename it, retarget a relation, move a content-type into a plugin, or
scaffold a plugin. Each refactor first lists what it doesn't do, such as the UIDs
Strapi also stores in the database. Then it opens VS Code's **Refactor Preview**:
nothing is written until you apply it.

## Go to a Strapi name

**Ctrl+T** (Go to Symbol in Workspace) finds content-type and component UIDs,
services, controllers and their actions, policies, middlewares and routes
(`GET /api/articles`). **Reveal in DevKit Panel** opens the schema or controller of
the editor in the panel. With the Model or Routes view open, the panel follows the
editor on its own.

---

Every feature here can be tuned in [Configuration](/configuration/) — diagnostic
severity, the references and routes CodeLenses, the per-method lens, the plugin
types in the Model view, following the editor, and project-discovery exclusions.
