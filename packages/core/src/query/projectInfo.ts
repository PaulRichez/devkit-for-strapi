/**
 * One project, described for an agent before it acts: what it is (Strapi version,
 * language, package manager, API prefix), what it holds, which plugins DevKit can
 * verify — and, for each one it can't, why (that is what makes a plugin ref come
 * back `external`) — plus its health and how current the index is.
 */

import { type FileSystem, FileType } from '../fs/FileSystem';
import { basename, join } from '../fs/paths';
import { listRoutes } from '../index/routes';
import type { ProjectSummary, RouteInfo, StrapiProject } from '../model/types';
import { isFrameworkRef, parseRef } from '../model/uid';
import { StaticEvaluator } from '../plugins/evaluate';
import { readApiPrefix } from '../plugins/installed';
import { isVerifiablePlugin } from '../plugins/merge';
import { configSyncStatus, type ConfigSyncStaticStatus } from '../configSync/status';
import { listBrokenRefs, validateRef } from './refQuery';

export interface PluginInfo {
  name: string;
  /** `local`: in the project (`src/plugins`, or `resolve`d in config/plugins); `installed`: read from node_modules. */
  source: 'local' | 'installed';
  package?: string;
  version?: string;
  /** For installed plugins: Strapi's own (`internal`) or a dependency. */
  origin?: 'internal' | 'dependency';
  /** Refs into it are checked; otherwise they come back `external` (never reported). */
  verified: boolean;
  /** Why it isn't verified. */
  why?: string[];
}

export interface ProjectInfo {
  name: string;
  root: string;
  strapi: { major: number; installed?: string; declared?: string };
  language: 'typescript' | 'javascript';
  packageManager?: 'npm' | 'yarn' | 'pnpm' | 'bun';
  /** `@strapi/strapi` is installed: installed plugins can be read and verified. */
  nodeModules: boolean;
  /** The content API prefix (`/api` unless config/api says otherwise; absent when not literal). */
  apiPrefix?: string;
  counts: {
    apis: number;
    contentTypes: { collectionTypes: number; singleTypes: number; fromPlugins: number };
    components: number;
    services: number;
    controllers: number;
    policies: number;
    middlewares: number;
    routes: { api: number; plugins: number };
  };
  plugins: PluginInfo[];
  health: {
    /** Refs that resolve to nothing (see list_broken_refs). */
    brokenRefs: number;
    /** Distinct refs into plugins DevKit can't verify (answered `external`), by plugin. */
    unverifiedPluginRefs: number;
    unverifiedByPlugin?: Record<string, number>;
  };
  /** strapi-plugin-config-sync is used: its version, its sync directory, its files (config_sync_status lists them). */
  configSync?: { version?: string; syncDir: string; files: number; invalid: number };
  /** Plain-language caveats an agent should know before trusting a `valid`/`unknown`. */
  notes: string[];
  freshness: ProjectSummary['freshness'];
}

const LOCKFILES: Array<[string, NonNullable<ProjectInfo['packageManager']>]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

/** `routes`: the project's route table (non-admin) when the caller has it cached — else it is read. */
export async function projectInfo(
  fs: FileSystem,
  project: StrapiProject,
  summary: ProjectSummary,
  /** What the caller already has: the routes, the config-sync status (`null`: config-sync isn't used). */
  cached?: { routes?: readonly RouteInfo[]; configSync?: ConfigSyncStaticStatus | null },
): Promise<ProjectInfo> {
  const idx = project.index;
  const root = project.root;
  const rel = (p: string): string => (p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  const isFile = async (p: string): Promise<boolean> => (await fs.stat(p))?.type === FileType.File;

  let packageManager: ProjectInfo['packageManager'];
  for (const [file, pm] of LOCKFILES) {
    if (await isFile(join(root, file))) {
      packageManager = pm;
      break;
    }
  }
  const apiPrefix = project.installed ? project.installed.apiPrefix : await readApiPrefix(fs, root, new StaticEvaluator(fs, { roots: [root] })).catch(() => undefined);

  // Content-types: the project's own by kind, and those plugins bring.
  let collectionTypes = 0;
  let singleTypes = 0;
  let fromPlugins = 0;
  const apis = new Set<string>();
  for (const ct of idx.contentTypes.values()) {
    if (ct.uid.startsWith('plugin::')) fromPlugins++;
    else if (ct.kind === 'singleType') singleTypes++;
    else collectionTypes++;
    const m = /^api::([^.]+)\./.exec(ct.uid);
    if (m) apis.add(m[1]!);
  }
  for (const map of [idx.services, idx.controllers]) {
    for (const ref of map.keys()) {
      const m = /^api::([^.]+)\./.exec(ref);
      if (m) apis.add(m[1]!);
    }
  }
  let routes = { api: 0, plugins: 0 };
  try {
    for (const r of cached?.routes ?? (await listRoutes(fs, project, { plugins: true }))) {
      if (r.owner?.startsWith('plugin::')) routes.plugins++;
      else routes.api++;
    }
  } catch {
    routes = { api: 0, plugins: 0 };
  }

  // Plugins, and why each one DevKit can't verify isn't.
  const rewritten = idx.rewrittenPlugins;
  const loading = summary.freshness.pluginsLoading === true;
  const rewriteSources = (name: string): string[] => {
    const out: string[] = [];
    for (const [file, r] of project.rewrites?.files ?? []) if (r.plugins.has(name) || r.plugins.has('*')) out.push(rel(file));
    return out;
  };
  const whyNot = (name: string, gaps: string[]): string[] => {
    const why: string[] = [];
    if (loading) why.push('plugins are still being read (a few seconds after startup)');
    else if (!project.rewrites) why.push('the plugins could not be read (see refresh)');
    else if (rewritten?.has(name) || rewritten?.has('*')) {
      const files = rewriteSources(name);
      if (files.length) why.push(`rewritten at boot by ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` (+${files.length - 3})` : ''}`);
      else if (project.rewrites?.truncated) why.push('too many project files to scan for plugin rewrites');
      else why.push('rewritten at boot by another plugin');
    }
    for (const g of gaps) {
      if (g.startsWith('rewritten at runtime')) continue; // said above, with the file
      const short = plainGap(g.replace(/\(([^)]*node_modules\/)/g, '(').split(`${root}/`).join(''));
      if (!why.includes(short)) why.push(short);
    }
    return why.slice(0, 5);
  };
  const plugins: PluginInfo[] = [];
  const localNames = new Set(idx.pluginNames);
  for (const name of [...localNames].sort()) {
    const verified = isVerifiablePlugin(idx, name);
    plugins.push({ name, source: 'local', verified, ...(verified ? {} : { why: whyNot(name, []) }) });
  }
  for (const p of [...(project.installed?.plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
    if (localNames.has(p.name)) continue; // a local plugin of the same name replaces it
    const verified = isVerifiablePlugin(idx, p.name);
    plugins.push({
      name: p.name,
      source: 'installed',
      package: p.packageName,
      ...(p.version ? { version: p.version } : {}),
      origin: p.origin,
      verified,
      ...(verified ? {} : { why: whyNot(p.name, p.gaps) }),
    });
  }

  // Health: broken refs, and refs DevKit can't check because their plugin isn't verified.
  const brokenRefs = listBrokenRefs(project).length;
  // Refs into unverified plugins that validate_reference really answers `external` for (each ref once,
  // whatever forms it is used under; field keys aside).
  const unverifiedByPlugin: Record<string, number> = {};
  let unverifiedPluginRefs = 0;
  const seen = new Set<string>();
  for (const [key, locations] of project.references) {
    if (!locations.length || key.startsWith('relation-field:') || key.startsWith('plugin:')) continue;
    const ref = key.slice(key.indexOf(':') + 1).split('#')[0]!;
    if (seen.has(ref) || isFrameworkRef(ref)) continue;
    seen.add(ref);
    const parsed = parseRef(ref);
    if (!parsed || parsed.namespace !== 'plugin' || isVerifiablePlugin(idx, parsed.scope)) continue;
    if (validateRef(project, ref).status !== 'external') continue;
    unverifiedByPlugin[parsed.scope] = (unverifiedByPlugin[parsed.scope] ?? 0) + 1;
    unverifiedPluginRefs++;
  }

  // Installed plugins were found (node_modules may be hoisted above the project, in a monorepo).
  const installedVersion = project.installed?.strapiVersion ?? project.strapiVersion;
  const nodeModules = project.installed !== undefined || project.strapiVersion !== undefined;
  const notes: string[] = [];
  if (!nodeModules) notes.push('@strapi/strapi is not installed (no node_modules): refs into installed plugins (users-permissions, upload, i18n…) come back `external`, never checked. Install the dependencies to verify them.');
  if (loading) notes.push('Installed plugins are still being read: plugin refs come back `external` for a few more seconds.');
  if (unverifiedPluginRefs) notes.push(`${unverifiedPluginRefs} distinct ref(s) into unverified plugins come back \`external\`: neither confirmed nor reported (see plugins[].why).`);
  let configSync: ProjectInfo['configSync'];
  const cs = cached?.configSync !== undefined ? (cached.configSync ?? undefined) : await configSyncStatus(fs, project).catch(() => undefined);
  if (cs && !cs.detection.disabled) {
    const v = cs.detection.installedVersion;
    configSync = { ...(v ? { version: v } : {}), syncDir: rel(cs.detection.syncDirPath), files: cs.files.length, invalid: cs.files.filter((f) => f.status === 'invalid').length };
    notes.push('config-sync is used: config_sync_status lists its files. Prefer an export (the admin Config Sync page, `npx config-sync export`) to editing config/sync/*.json by hand: config-sync compares each file as written with the database.');
  }
  if (summary.freshness.diskTracking === 'off') notes.push('Too many files to compare with the disk on each call: call refresh after editing files outside this session.');

  return {
    name: basename(root),
    root,
    strapi: { major: project.version, ...(installedVersion ? { installed: installedVersion } : {}), ...(project.versionSignals.spec ? { declared: project.versionSignals.spec } : {}) },
    language: (await isFile(join(root, 'tsconfig.json'))) ? 'typescript' : 'javascript',
    ...(packageManager ? { packageManager } : {}),
    nodeModules,
    ...(apiPrefix ? { apiPrefix } : {}),
    counts: {
      apis: apis.size,
      contentTypes: { collectionTypes, singleTypes, fromPlugins },
      components: idx.components.size,
      services: idx.services.size,
      controllers: idx.controllers.size,
      policies: idx.policies.size,
      middlewares: idx.middlewares.size,
      routes,
    },
    plugins,
    health: { brokenRefs, unverifiedPluginRefs, ...(unverifiedPluginRefs ? { unverifiedByPlugin } : {}) },
    ...(configSync ? { configSync } : {}),
    notes,
    freshness: summary.freshness,
  };
}

/** The reader's gap, said plainly (kept as is when not recognised). */
function plainGap(gap: string): string {
  const at = /\(([^)]+)\)$/.exec(gap)?.[1];
  if (gap.startsWith('server entry:') || gap.startsWith('server object')) return "its server entry can't be read without running it (it branches on runtime conditions, e.g. the Enterprise edition)";
  const collection = /^(services|controllers|routes|policies|middlewares|contentTypes|content-types): /.exec(gap)?.[1];
  if (collection) return `its ${collection} can't all be listed without running it`;
  if (gap.startsWith("a module writes into another module's exports")) return `one of its modules patches another one at load${at ? ` (${at})` : ''}`;
  if (gap === 'read budget exceeded' || gap === 'not read (overall time budget)') return 'too large to read within the time budget';
  if (gap === 'not every file of the plugin could be read') return 'some of its files could not be read';
  if (gap === 'enabled state not literal') return 'config/plugins enables it conditionally (env…)';
  if (gap.startsWith('extended by src/extensions/')) return `overridden by ${gap.slice('extended by '.length)}`;
  return gap;
}
