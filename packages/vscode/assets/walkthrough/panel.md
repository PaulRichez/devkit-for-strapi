# The DevKit panel

The **DevKit for Strapi** icon in the activity bar opens four views, read from your code without starting Strapi:

- **Health** — what's wrong in the whole project: broken references, policies or middlewares Strapi won't find at startup, definitions nothing references.
- **Routes** — every route, and under each one what a request goes through, in Strapi's order: global middlewares, auth, policies, route middlewares, handler.
- **Model** — your content-types and components: their fields, the relations pointing at each one, the routes exposing it.
- **Plugins** — the plugins in your project, what each adds, and whether DevKit checks the refs into it.

The views show the saved files.
