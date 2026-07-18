---
title: FAQ
description: Common questions about DevKit for Strapi.
---

## Does it send my code anywhere?

No. **Your code never leaves your machine** — DevKit reads your project files
locally and answers from them, with **no telemetry**. The one exception is a
[Pro](/pro/) licence: on activation the licence **key** (never your code) is
checked once against the Polar licensing API, then DevKit works offline.

## Strapi v4 or v5?

Both. The version is detected per project, and v4-in-v5 patterns (e.g.
`strapi.entityService`) are flagged.

## What about Strapi 6?

No Strapi 6 is announced yet — the CMS is on v5, and Strapi’s stated 2026 focus
is stabilising v5. DevKit reads your real `schema.json` and detects the version
per project, so it’s built to adapt when v6 lands.

## Which editors are supported?

VS Code and its forks — Cursor, Windsurf, Google Antigravity, VSCodium — via the
VS Code Marketplace and [Open VSX](https://open-vsx.org/extension/paul-richez/devkit-for-strapi).

## JavaScript or TypeScript?

Identical behavior for ESM and CommonJS projects, challenged by a JS⇄TS parity
test in the engine.

## Is it affiliated with Strapi?

No. DevKit for Strapi is an independent, community-built tool — **not affiliated
with, endorsed by, or sponsored by Strapi SAS.** “Strapi” is a trademark of
Strapi SAS, used only to describe compatibility.

## Found a bug, or need help?

Email **[pro@paulrichez.fr](mailto:pro@paulrichez.fr)** — bug reports, questions
and feedback are all welcome. There’s no public issue tracker, so this inbox is
the way to reach me.
