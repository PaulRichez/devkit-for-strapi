import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');

// Neutralise the DEVKIT_DEV dogfood override in production bundles so it can't be
// flipped on via an env var by a user. Dev/F5 and --tests keep it live (the
// integration test relies on it to exercise the licensed rename path).
const define = production ? { 'process.env.DEVKIT_DEV': '"0"' } : {};

/** Copy branding assets into the extension package so vsce can bundle them. */
function copyAssets() {
  const dest = resolve(here, 'assets');
  mkdirSync(dest, { recursive: true });
  for (const file of ['icon.svg', 'icon-128.png']) {
    try {
      cpSync(resolve(repoRoot, 'assets', file), resolve(dest, file));
    } catch {
      // icon-128.png may not be generated yet in dev; vsce package requires it.
    }
  }
}

/**
 * Emits the begin/end markers the VS Code task background problem matcher waits
 * for, so F5 knows when the initial build is ready and launches the host.
 * @type {import('esbuild').Plugin}
 */
const watchMarkerPlugin = {
  name: 'watch-markers',
  setup(build) {
    build.onStart(() => console.log('[watch] build started'));
    build.onEnd((result) => {
      for (const e of result.errors) {
        const loc = e.location;
        console.error(loc ? `✘ [ERROR] ${loc.file}:${loc.line}:${loc.column}: ${e.text}` : `✘ [ERROR] ${e.text}`);
      }
      console.log('[watch] build finished');
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [resolve(here, 'src/extension.ts')],
  bundle: true,
  outfile: resolve(here, 'dist/extension.js'),
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  external: ['vscode'],
  define,
  sourcemap: !production,
  minify: production,
  logLevel: 'silent',
  plugins: [watchMarkerPlugin],
};

/** Compile the integration test sources to CJS for @vscode/test-cli. */
async function buildTests() {
  const testDir = resolve(here, 'src/test');
  if (!existsSync(testDir)) return;
  const entryPoints = readdirSync(testDir)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => resolve(testDir, f));
  if (entryPoints.length === 0) return;
  await esbuild.build({
    entryPoints,
    outdir: resolve(here, 'out/test'),
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    external: ['vscode', 'mocha'],
    sourcemap: true,
    logLevel: 'silent',
  });
}

/**
 * Bundle the shared MCP server (`devkit-for-strapi-mcp`) into the extension so
 * the `mcpServerDefinitionProvider` can spawn it with no separate npm install.
 * Same source as the published bin — one implementation, two outputs.
 */
async function buildMcp() {
  await esbuild.build({
    entryPoints: [resolve(here, '../mcp/src/cli.ts')],
    bundle: true,
    outfile: resolve(here, 'dist/mcp.js'),
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    define,
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
  });
}

copyAssets();

// A production bundle ships no source map; remove any left by a prior dev build
// so vsce can't bundle a stale `.map` (defense-in-depth with .vscodeignore).
if (production) {
  rmSync(resolve(here, 'dist'), { recursive: true, force: true });
}

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('[esbuild] watching…');
} else {
  await esbuild.build(options);
  if (tests) await buildTests();
}

// The extension bundle and the MCP server bundle ship together in the .vsix.
await buildMcp();
