# devkit-for-strapi-mcp

An **MCP server** that gives AI coding agents the *truth* about your Strapi project. It reads your real `schema.json` files and exposes the actual UIDs, schemas, and references — so an agent looks up magic strings like `api::article.article`, service names, or field names instead of grepping for them.

Same engine as the [DevKit for Strapi](https://github.com/PaulRichez/devkit-for-strapi) VS Code extension, exposed to agents instead of humans. The read/analyse tools are free; the refactor tools (rename, move, extract) are Pro. Works on Strapi v4 and v5, in JS and TS, with no codegen.

### Not Strapi's own MCP server — they do different jobs

Strapi ships an [official MCP server](https://docs.strapi.io/cms/features/strapi-mcp-server) that
acts on your **content**: CRUD on entries in a **running** instance, over HTTP, with an admin token
(Strapi ≥ 5.47).

This one acts on your **codebase**: it reads your `schema.json` and source files — no server, no
token, no network — and answers *"what code uses `api::article.article`?"*, *"is this ref valid?"*,
*"what breaks if I move this?"*. It also keeps working when the app doesn't: mid-migration, on a
failing build, in CI, or on Strapi v4.

> **Use Strapi's MCP to work _with_ your content. Use DevKit to work _on_ your code.**
> Many projects want both connected at once.

## Tools

31 stdio tools in three layers. The **read/analyse** tools are free; the **refactor** tools are Pro (without a licence they return a "Pro required" upsell).

**Know** — the project's truth *(free)*
`server_info` (version, licence tier, which tools actually run) · `list_projects` · `list_content_types` · `list_components` · `list_artifacts` · `get_schema` · `resolve` · `validate_reference` · `find_references` · `list_routes` · `refresh`

**Understand** — health & impact *(free)*
`list_unused` (dead code) · `list_broken_refs` · `coverage` · `find_relation_usages` · `list_refs` (glob) · `dependencies` / `dependents` (the dependency graph)

**Refactor** — plan → review → apply *(Pro)*
`plan_rename_method` / `plan_rename_entity` · `plan_move` / `plan_move_entities` · `plan_change_relation` · `plan_rename_attribute` · `create_plugin` · `extract_to_plugin`, then `apply_edits` / `apply_rename`. Every refactor returns a reviewable, fingerprinted plan; applying is root-confined and transactional.

In a multi-project workspace, pass `from` (a path inside the project you're working in) or `project` (its name) to disambiguate — the server never guesses between two projects.

## Use it

The server indexes the **workspace root** and discovers the Strapi project(s) inside it (a monorepo with several apps works).

The path argument is **optional**. Roots are resolved in this order: explicit path arguments, then the client's `roots` capability (Claude Code and Cursor advertise the folder you opened), then the current working directory. Passing the path explicitly is the most reliable — it's indexed at startup, so the first tool call already works on any client.

### Claude Code / Cursor / Claude Desktop

```jsonc
{
  "mcpServers": {
    "devkit-for-strapi": { "command": "npx", "args": ["-y", "devkit-for-strapi-mcp@latest"] }
  }
}
```

Run the client from your project directory (or pass the path: `"args": ["-y", "devkit-for-strapi-mcp@latest", "/path/to/workspace"]`).

> [!IMPORTANT]
> **Keep the `@latest`.** `npx` caches what it downloads and will keep running that copy for
> months — even with no version pin. If you set this server up earlier, you may still be on an
> early build with bugs that are long fixed.
>
> Ask your agent to call **`server_info`**: it reports the version actually running. If it is
> behind, clear the npx cache and restart your client — `rm -rf ~/.npm/_npx` on macOS/Linux,
> `rmdir /s /q "%LOCALAPPDATA%\npm-cache\_npx"` on Windows. With `@latest` the tag is resolved
> from the registry on every start, so it will not drift again.

### VS Code

Install the **[DevKit for Strapi](https://marketplace.visualstudio.com/items?itemName=paul-richez.devkit-for-strapi)** extension — it bundles this server and registers it automatically (no config). It also passes your workspace folders, so multi-root works out of the box.

## License

The read/analyse tools are **free (MIT)**. The Pro refactor tools (`plan_*` / `apply_*`,
`create_plugin`, `extract_to_plugin`) require a licence key. The bundled `LICENSE` covers both:
**MIT** for the free parts, **PolyForm Shield 1.0.0** for the Pro engine. Get Pro:
<https://devkit-for-strapi.paulrichez.fr/pro/>
