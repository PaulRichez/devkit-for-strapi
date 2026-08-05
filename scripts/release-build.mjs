#!/usr/bin/env node
/**
 * Release build — produces the publishable artifacts (`.vsix` + npm tarball).
 *
 * WHY THIS EXISTS
 * ---------------
 * This repository is the open-core half of DevKit. `packages/pro` here is an
 * MIT **stub**: it keeps the API surface so the free tier compiles and runs, but
 * every refactor throws. The real Pro engine lives in a separate private
 * package. A build made straight from this repo therefore ships a *free-tier*
 * extension — publishing that would silently break refactors for paying users.
 *
 * So the release build overlays the real Pro package on top of the stub, and
 * this script exists to make that step impossible to forget.
 *
 * THE TWO RULES
 * -------------
 * 1. **Pro is required by default.** If the private package is missing, this
 *    script STOPS. It never "falls back" to a free build — a silent fallback is
 *    exactly how a stubbed build reaches the Marketplace. Pass `--free` when you
 *    genuinely want the free-tier artifact (e.g. to see what a contributor gets).
 * 2. **The working tree is never touched.** The build runs on a pristine copy
 *    produced by `git archive` (tracked files at HEAD only — no node_modules, no
 *    `private/`, no local edits). That copy is not a git repository, so the
 *    proprietary code overlaid into it cannot be committed or pushed by accident.
 *
 * Afterwards the artifacts are verified: a Pro build must NOT contain the stub's
 * runtime marker, and a `--free` build must. Publishing stays a manual step —
 * the commands are printed at the end.
 *
 * Usage:
 *   node scripts/release-build.mjs                      # Pro build (default)
 *   node scripts/release-build.mjs --free               # free-tier build
 *   node scripts/release-build.mjs --pro=../some/path   # custom Pro location
 *   node scripts/release-build.mjs --allow-dirty        # skip the clean-tree check
 */

import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = join(REPO, '.release');

/**
 * The stub's runtime message. It survives minification (unlike the comments), so
 * it is a reliable way to tell a stubbed bundle from a real one.
 */
const STUB_MARKER = 'is not included in the open-source build';

const args = process.argv.slice(2);
const FREE = args.includes('--free');
const ALLOW_DIRTY = args.includes('--allow-dirty');
const PRO_SRC = resolve(
  REPO,
  args.find((a) => a.startsWith('--pro='))?.slice('--pro='.length) ?? '../devkit-for-strapi-pro',
);

const log = (msg) => console.log(msg);
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
function die(msg) {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}
function run(cmd, cwd) {
  execSync(cmd, { cwd, stdio: 'inherit' });
}

log(`DevKit release build — ${FREE ? 'FREE tier (explicit --free)' : 'PRO (real engine)'}`);

// ---------------------------------------------------------------------------
// 1. The working tree must be clean: `git archive` exports HEAD, so uncommitted
//    work would be silently missing from the artifact you publish.
// ---------------------------------------------------------------------------
step(1, 'Checking the working tree is clean…');
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim();
if (dirty && !ALLOW_DIRTY) {
  die(
    `Uncommitted changes — they would NOT be in the build (git archive exports HEAD):\n${dirty}\n\n` +
      `Commit them, or re-run with --allow-dirty if you really mean to build HEAD as-is.`,
  );
}
log(dirty ? '  ! dirty tree, continuing because --allow-dirty' : '  ✓ clean');

// ---------------------------------------------------------------------------
// 2. Locate the real Pro package — and refuse to continue without it.
// ---------------------------------------------------------------------------
step(2, 'Resolving the Pro engine…');
if (FREE) {
  log('  → skipped: --free was passed, building the free tier on purpose.');
} else {
  if (!existsSync(PRO_SRC)) {
    die(
      `Pro package not found at:\n    ${PRO_SRC}\n\n` +
        `This build would ship the MIT stub, so refactors would throw for paying users.\n` +
        `Fix the path with --pro=<path>, or pass --free if you really want a free-tier build.`,
    );
  }
  const proEntry = join(PRO_SRC, 'src', 'rename', 'rename.ts');
  if (!existsSync(proEntry)) die(`${PRO_SRC} exists but has no src/rename/rename.ts — wrong folder?`);
  if (readFileSync(proEntry, 'utf8').includes(STUB_MARKER)) {
    die(`${PRO_SRC} is itself a STUB, not the real engine. Point --pro at the private package.`);
  }
  log(`  ✓ real engine found: ${PRO_SRC}`);
}

// ---------------------------------------------------------------------------
// 3. Pristine copy of HEAD (tracked files only). Not a git repo → the
//    proprietary overlay below can never be committed from here.
// ---------------------------------------------------------------------------
step(3, 'Exporting a clean copy of HEAD…');
rmSync(RELEASE_DIR, { recursive: true, force: true });
mkdirSync(RELEASE_DIR, { recursive: true });
const tarball = join(RELEASE_DIR, '_head.tar');
run(`git archive --format=tar HEAD -o "${tarball}"`, REPO);
run(`tar -xf "${tarball}" -C "${RELEASE_DIR}"`, REPO);
rmSync(tarball, { force: true });
if (existsSync(join(RELEASE_DIR, '.git'))) die('The export unexpectedly contains .git — aborting.');
log(`  ✓ exported to ${RELEASE_DIR}`);

// ---------------------------------------------------------------------------
// 4. Overlay the real Pro package over the stub (in the copy only).
// ---------------------------------------------------------------------------
if (!FREE) {
  step(4, 'Overlaying the real Pro engine…');
  const dest = join(RELEASE_DIR, 'packages', 'pro');
  // src/ is replaced wholesale so a stub file can't survive alongside real ones.
  rmSync(join(dest, 'src'), { recursive: true, force: true });
  cpSync(join(PRO_SRC, 'src'), join(dest, 'src'), { recursive: true });
  // package.json carries the PolyForm licence; LICENSE must match it.
  cpSync(join(PRO_SRC, 'package.json'), join(dest, 'package.json'));
  if (existsSync(join(PRO_SRC, 'LICENSE'))) cpSync(join(PRO_SRC, 'LICENSE'), join(dest, 'LICENSE'));
  log('  ✓ packages/pro replaced with the private engine');
} else {
  step(4, 'Overlay skipped (--free).');
}

// ---------------------------------------------------------------------------
// 5. Install & build.
// ---------------------------------------------------------------------------
step(5, 'Installing dependencies…');
// Not --frozen-lockfile: the Pro package.json differs from the stub's.
run('pnpm install --no-frozen-lockfile', RELEASE_DIR);

step(6, 'Building all packages…');
run('pnpm -r build', RELEASE_DIR);

// ---------------------------------------------------------------------------
// 7. Verify what actually got compiled in, before anything is packaged.
// ---------------------------------------------------------------------------
step(7, 'Verifying the built bundles…');
const bundles = [
  join(RELEASE_DIR, 'packages', 'vscode', 'dist', 'extension.js'),
  join(RELEASE_DIR, 'packages', 'mcp', 'dist', 'cli.cjs'),
];
for (const bundle of bundles) {
  if (!existsSync(bundle)) die(`Expected build output missing: ${bundle}`);
  const stubbed = readFileSync(bundle, 'utf8').includes(STUB_MARKER);
  const name = bundle.replace(RELEASE_DIR, '').replace(/\\/g, '/');
  if (!FREE && stubbed) {
    die(
      `${name} still contains the Pro STUB after the overlay.\n` +
        `Publishing this would break refactors for paying users. Aborting.`,
    );
  }
  if (FREE && !stubbed) {
    die(`${name} does NOT contain the stub marker, but --free was requested. Aborting.`);
  }
  log(`  ✓ ${name} — ${stubbed ? 'free tier (stub)' : 'Pro engine'}`);
}

// ---------------------------------------------------------------------------
// 8. Package the artifacts.
// ---------------------------------------------------------------------------
step(8, 'Packaging…');
const vscodeDir = join(RELEASE_DIR, 'packages', 'vscode');
const mcpDir = join(RELEASE_DIR, 'packages', 'mcp');
run('pnpm run package', vscodeDir);
run('npm pack', mcpDir);

const vsix = readdirSync(vscodeDir).filter((f) => f.endsWith('.vsix'));
const tgz = readdirSync(mcpDir).filter((f) => f.endsWith('.tgz'));
if (!vsix.length) die('No .vsix produced.');
if (!tgz.length) die('No npm tarball produced.');

// `vsce package` re-runs `vscode:prepublish`, which rebuilds the bundle — so the
// check in step 7 validated a file that has since been regenerated. Re-check the
// bundle as it stands *after* packaging: that is the one inside the .vsix.
step(9, 'Re-verifying after packaging…');
for (const bundle of bundles) {
  const stubbed = readFileSync(bundle, 'utf8').includes(STUB_MARKER);
  const name = bundle.replace(RELEASE_DIR, '').replace(/\\/g, '/');
  if (!FREE && stubbed) die(`${name} was rebuilt as a STUB during packaging. Aborting.`);
  if (FREE && !stubbed) die(`${name} lost its stub marker during packaging, but --free was requested.`);
  log(`  ✓ ${name} — still ${stubbed ? 'free tier (stub)' : 'Pro engine'}`);
}

const size = (p) => `${(statSync(p).size / 1024 / 1024).toFixed(2)} MB`;

// ---------------------------------------------------------------------------
// Done — publishing stays manual and deliberate.
// ---------------------------------------------------------------------------
const vsixPath = join(vscodeDir, vsix[0]);
const tgzPath = join(mcpDir, tgz[0]);

console.log(`\n${'─'.repeat(70)}`);
console.log(`✓ ${FREE ? 'FREE-TIER' : 'PRO'} build ready\n`);
console.log(`  extension : ${vsixPath}  (${size(vsixPath)})`);
console.log(`  mcp       : ${tgzPath}  (${size(tgzPath)})`);

if (FREE) {
  console.log(`\n⚠ This is a FREE-TIER artifact — do NOT publish it.`);
} else {
  console.log(`\nPublish (run these yourself — they need your tokens and are irreversible):\n`);
  console.log(`  cd "${vscodeDir}"`);
  console.log(`  npx vsce publish --packagePath "${vsix[0]}"`);
  console.log(`  npx ovsx publish "${vsix[0]}" -p <OPEN_VSX_TOKEN>\n`);
  console.log(`  cd "${mcpDir}"`);
  console.log(`  npm publish "${tgz[0]}" --access public\n`);
  console.log(`Then: git tag v<version> && git push --tags, and delete ${RELEASE_DIR}`);
}
console.log(`${'─'.repeat(70)}\n`);
