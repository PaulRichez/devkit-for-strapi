# devkit-for-strapi-mcp

An **MCP server** that gives AI coding agents the *truth* about your Strapi project. It reads your real `schema.json` files and exposes the actual UIDs, schemas, and references — so the model stops guessing magic strings like `api::article.article`, service names, or field names.

Same engine as the [DevKit for Strapi](https://github.com/PaulRichez/devkit-for-strapi) VS Code extension, exposed to agents instead of humans. The read/analyse tools are free; the refactor tools (rename, move, extract) are Pro. Works on Strapi v4 and v5, in JS and TS, with no codegen.

## Tools

30 stdio tools in three layers. The **read/analyse** tools are free; the **refactor** tools are Pro (without a licence they return a "Pro required" upsell).

**Know** — the project's truth *(free)*
`list_projects` · `list_content_types` · `list_components` · `list_artifacts` · `get_schema` · `resolve` · `validate_reference` · `find_references` · `list_routes` · `refresh`

**Understand** — health & impact *(free)*
`list_unused` (dead code) · `list_broken_refs` · `coverage` · `find_relation_usages` · `list_refs` (glob) · `dependencies` / `dependents` (the dependency graph)

**Refactor** — plan → review → apply *(Pro)*
`plan_rename_method` / `plan_rename_entity` · `plan_move` / `plan_move_entities` · `plan_change_relation` · `plan_rename_attribute` · `create_plugin` · `extract_to_plugin`, then `apply_edits` / `apply_rename`. Every refactor returns a reviewable, fingerprinted plan; applying is root-confined and transactional.

In a multi-project workspace, pass `from` (a path inside the project you're working in) or `project` (its name) to disambiguate — the server never guesses between two projects.

## Use it

The server indexes the **workspace root** and discovers the Strapi project(s) inside it (a monorepo with several apps works). It takes the root from explicit path arguments, otherwise the current working directory.

### Claude Code / Cursor / Claude Desktop

```jsonc
{
  "mcpServers": {
    "devkit-for-strapi": { "command": "npx", "args": ["-y", "devkit-for-strapi-mcp"] }
  }
}
```

Run the client from your project directory (or pass the path: `"args": ["-y", "devkit-for-strapi-mcp", "/path/to/workspace"]`).

### VS Code

Install the **DevKit for Strapi** extension — it bundles this server and registers it automatically (no config). It also passes your workspace folders, so multi-root works out of the box.

## License

The read/analyse tools are **free (MIT)**. The Pro refactor tools (`plan_*` / `apply_*`,
`create_plugin`, `extract_to_plugin`) require a licence key. The bundled `LICENSE` covers both:
**MIT** for the free parts, **PolyForm Shield 1.0.0** for the Pro engine. Get Pro:
<https://devkit-for-strapi.paulrichez.fr/pro/>
