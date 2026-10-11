import * as esbuild from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Single source of truth for the version the server reports in the MCP handshake:
// package.json. Hard-coding it in server.ts silently drifted (it still said 0.1.0
// at 0.1.3), which made every client — and every bug report — name the wrong version.
const pkg = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));

/** The licence overrides a published build must not read (see below). */
export const RELEASE_DEFINES = {
  'process.env.DEVKIT_DEV': '"0"',
  'process.env.DEVKIT_POLAR_ORG_ID': 'undefined',
  'process.env.DEVKIT_LICENSE_CACHE': 'undefined',
};

// Neutralise the licence's dev overrides in the published bin so none can be set
// through an env var: the DEVKIT_DEV dogfood key, another Polar organisation (a
// $0 product of one's own would validate), another licence cache file. A --watch
// dev build keeps them live (local dogfood, a sandbox org).
const define = {
  __DEVKIT_MCP_VERSION__: JSON.stringify(pkg.version),
  ...(watch ? {} : RELEASE_DEFINES),
};

// Bundle core + the MCP SDK into a single Node file. CJS (`.cjs`) — `typescript`
// (bundled, for AST parsing) does dynamic `require()`, which an ESM bundle can't
// support; CJS handles it, and `.cjs` stays loadable in this `type: module` pkg.
/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(here, 'src/cli.ts')],
  bundle: true,
  outfile: resolve(here, 'dist/cli.cjs'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  define,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching mcp…');
} else {
  // Clean prior artifacts first so a stale bundle (e.g. an old dist/cli.js from a
  // renamed entry point) can't linger and ship to npm via files:["dist"].
  rmSync(resolve(here, 'dist'), { recursive: true, force: true });
  await esbuild.build(options);
}
