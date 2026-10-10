/**
 * Wire installed-plugin data into a project's index.
 *
 * Installed entries go into the SAME maps as the user's code (so every read path
 * — validation, completion, hover, go-to-definition, the MCP tools — sees them
 * with no per-call-site change), flagged `installed: true`. They never override
 * what the project itself defines (a local plugin, a `src/extensions` schema),
 * and the paths that must ignore them (dead code, the model outline, writes)
 * filter on that flag.
 */

import type { FileSystem } from '../fs/FileSystem';
import { dirname, join } from '../fs/paths';
import type { CodeArtifact, StrapiIndex } from '../model/types';
import type { InstalledPluginsResult } from './installed';

/** Can refs into plugin `name` be verified (a local plugin, or an installed one read exhaustively)? */
export function isVerifiablePlugin(index: StrapiIndex, name: string): boolean {
  return index.pluginNames.has(name) || (index.verifiedPlugins?.has(name) ?? false);
}

function artifactMap(index: StrapiIndex, a: CodeArtifact): Map<string, CodeArtifact> {
  switch (a.kind) {
    case 'service':
      return index.services;
    case 'controller':
      return index.controllers;
    case 'policy':
      return index.policies;
    case 'middleware':
      return index.middlewares;
  }
}

/**
 * Add installed-plugin entries to `index`, without overriding anything the
 * project defines. Idempotent: re-running it only fills what is missing (used
 * after incremental updates, e.g. when a `src/extensions` schema is deleted).
 */
export function mergeInstalled(index: StrapiIndex, result: InstalledPluginsResult | undefined): void {
  if (!result) return;
  index.verifiedPlugins ??= new Set();
  index.installedPlugins ??= new Map();
  if (result.frameworkMiddlewares?.complete && !index.frameworkMiddlewares) {
    index.frameworkMiddlewares = new Map(
      result.frameworkMiddlewares.entries.map((e) => [`strapi::${e.name}`, { filePath: e.filePath, offset: e.offset }]),
    );
  }
  for (const p of result.plugins) {
    // A local plugin of the same name wins (Strapi: a declared `resolve` replaces it).
    if (index.pluginNames.has(p.name)) continue;
    index.installedPlugins.set(p.name, {
      packageName: p.packageName,
      ...(p.version ? { version: p.version } : {}),
      complete: p.complete,
    });
    if (p.complete) index.verifiedPlugins.add(p.name);
    for (const ct of p.contentTypes) {
      if (!index.contentTypes.has(ct.uid)) index.contentTypes.set(ct.uid, ct);
    }
    for (const a of p.artifacts) {
      const map = artifactMap(index, a);
      if (!map.has(a.ref)) map.set(a.ref, a);
    }
  }
}

/** Remove every installed-plugin entry from `index` (before a re-read). */
export function clearInstalled(index: StrapiIndex): void {
  for (const map of [index.contentTypes, index.services, index.controllers, index.policies, index.middlewares] as Array<
    Map<string, { installed?: boolean }>
  >) {
    for (const [key, entry] of map) if (entry.installed) map.delete(key);
  }
  index.verifiedPlugins?.clear();
  index.installedPlugins?.clear();
  delete index.frameworkMiddlewares;
}

const LOCKFILES = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock', 'npm-shrinkwrap.json'];
/** Files every package manager rewrites inside `node_modules` on install. */
const INSTALL_MARKERS = ['.package-lock.json', '.yarn-integrity', '.modules.yaml', '.yarn-state.yml'];
const CONFIG_FILES = ['plugins', 'api'].flatMap((b) => ['.ts', '.js', '.mjs', '.cjs'].map((e) => `${b}${e}`));

/**
 * A cheap fingerprint of everything that can change the installed-plugin
 * picture: package.json, lockfiles, the install markers package managers write
 * into node_modules, the plugins/api config, and the config/env + extensions
 * folders. Stats only (no reads). Changes ⇒ re-read the plugins.
 */
export async function installedStamp(
  fs: FileSystem,
  root: string,
  strapiDir: string | undefined,
  installed?: InstalledPluginsResult,
): Promise<string> {
  const paths = [join(root, 'package.json'), ...LOCKFILES.map((l) => join(root, l))];
  paths.push(...CONFIG_FILES.map((f) => join(root, 'config', f)), join(root, 'config', 'env'), join(root, 'src', 'extensions'));
  // src/index can rewrite plugins at register time.
  for (const ext of ['ts', 'js', 'mjs', 'cjs']) paths.push(join(root, 'src', `index.${ext}`));
  for (const p of installed?.plugins ?? []) {
    // A rebuilt workspace-linked plugin rewrites its entry; an extension entry point can appear in an existing folder.
    if (p.entry) paths.push(p.entry);
    for (const ext of ['js', 'ts', 'mjs', 'cjs']) paths.push(join(root, 'src', 'extensions', p.name, `strapi-server.${ext}`));
  }
  if (strapiDir) {
    const nodeModules = dirname(dirname(strapiDir)); // <nm>/@strapi/strapi → <nm>
    paths.push(join(strapiDir, 'package.json'), ...INSTALL_MARKERS.map((m) => join(nodeModules, m)));
    const owner = dirname(nodeModules);
    if (owner !== root) paths.push(...LOCKFILES.map((l) => join(owner, l)));
  } else {
    paths.push(join(root, 'node_modules', '@strapi', 'strapi', 'package.json'));
  }
  const parts: string[] = [];
  for (const p of paths) {
    const s = await fs.stat(p);
    parts.push(s ? `${s.mtime ?? 'x'}` : '-');
  }
  return parts.join('|');
}
