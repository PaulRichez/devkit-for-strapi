#!/usr/bin/env node
/**
 * The site's Changelog page, made from the extension's CHANGELOG.md at build time —
 * one source of truth, so the page can't drift from what ships. The generated page is
 * not committed (see .gitignore). Runs before `astro dev` and `astro build`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '../../packages/vscode/CHANGELOG.md');
const target = join(here, '../src/content/docs/changelog.md');

const text = readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
// The page has its own title: drop the file's "# Changelog".
const body = text.replace(/^# Changelog\n+/, '');
if (body === text) throw new Error(`${source}: expected it to start with "# Changelog"`);

const page = `---
title: Changelog
description: What changed in each release of DevKit for Strapi — the VS Code extension and its MCP server.
# Generated from packages/vscode/CHANGELOG.md by site/scripts/changelog.mjs — edit that file instead.
lastUpdated: false
editUrl: false
---

${body}`;

writeFileSync(target, page);
console.log(`changelog: ${target.replace(/\\/g, '/')} from packages/vscode/CHANGELOG.md`);
