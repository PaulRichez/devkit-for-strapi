import * as esbuild from 'esbuild';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Neutralise the DEVKIT_DEV dogfood override in the published bin so it can't be
// flipped on via an env var. A --watch dev build keeps it live (local dogfood).
const define = watch ? {} : { 'process.env.DEVKIT_DEV': '"0"' };

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
