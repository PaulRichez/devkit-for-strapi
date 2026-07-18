---
title: Pro
description: The Strapi refactoring engine — propagated rename, move/extract, safe apply.
---

The free tier makes Strapi magic strings **understandable**. Pro lets DevKit
**change** them for you — safely, across your whole project, in your editor and
through your AI agent.

## What’s in Pro

- **Propagated rename** — rename an entity or a method and DevKit updates every
  call-site and route handler, renames the file/folder, and repoints relation
  `target`s. No grep-and-pray.
- **Move / extract-to-plugin** *(via your AI agent)* — relocate an artifact or a
  whole content-type resource across namespaces; scaffold a new local plugin and
  extract into it in one reviewable plan.
- **Schema edits** *(via your AI agent)* — retarget a relation, rename an attribute
  (and rewrite its `populate`/`filters` usages).
- **Safe apply** — every change is a contractual plan, applied by an executor
  that is root-confined (symlink-resolved), refuses silent overwrites, verifies
  content fingerprints before writing (anti-TOCTOU), is best-effort
  transactional, and self-verifies for broken references afterward.

## Pricing & licence

**€39.99 one-time** — a perpetual licence plus one year of updates, per developer.
One key unlocks both the editor (rename) and the MCP refactor tools.

## **[Get Pro → €39.99](https://buy.polar.sh/polar_cl_SHTELpw7g7PN8ztymJ7rL2tErNrsTadIHxNdr47n4yf)**

Secure checkout via [Polar](https://polar.sh) · your licence key arrives by email ·
also on the [pricing section of the landing page](https://devkit-for-strapi.paulrichez.fr/#pricing).

The licence is **verified online, then cached so it keeps working offline** — it
re-checks periodically (about weekly when online) and tolerates being offline for
up to ~30 days. No telemetry, no code leaving your machine.

Not for you? **14-day money-back, no questions asked** — just email
[pro@paulrichez.fr](mailto:pro@paulrichez.fr).

## Activating your licence

One key unlocks **both** surfaces — your editor and your AI agent.

### In your editor (VS Code · Cursor · Windsurf · Antigravity)

1. Open the Command Palette — `Ctrl/Cmd` + `Shift` + `P`.
2. Run **DevKit for Strapi: Enter License Key**.
3. Paste the key from your Polar receipt email.

To remove or replace a key later, run **DevKit for Strapi: Clear License Key**.

The key is stored in your editor's **secret storage** (the OS keychain) — never in
`settings.json`, so it can't leak into Git or Settings Sync. This unlocks the editor
refactors **and** the bundled MCP server's Pro tools at once: the extension forwards
the key to the MCP server it spawns.

### For your AI agent (standalone MCP)

If you run the `devkit-for-strapi-mcp` server yourself (an agent outside the
extension), set the **`DEVKIT_LICENSE_KEY`** environment variable in its `env` block:

```json
{
  "mcpServers": {
    "devkit-for-strapi": {
      "command": "npx",
      "args": ["-y", "devkit-for-strapi-mcp", "/absolute/path/to/your/strapi-project"],
      "env": { "DEVKIT_LICENSE_KEY": "polar_xxx" }
    }
  }
}
```

Keep this file out of Git — the key is a secret.

### Without a licence — nothing breaks

Every free tool keeps working. The Pro tools stay **visible** to your agent, but
calling one (a `plan_*` refactor or `apply_*`) returns a short **“Pro required”**
result — the feature, where to buy a licence, and how to activate it — so your agent
can relay it to you instead of failing silently. Both the refactor *plan* and its
*apply* are Pro, so an agent can't sidestep the licence by applying a free plan with
its own tools.

:::note
Checkout runs on [Polar](https://polar.sh) (Merchant of Record — VAT sorted for
you). Your licence key arrives by email right after purchase.
:::
