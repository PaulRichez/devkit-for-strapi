/**
 * Detect `strapi-plugin-config-sync` in a project, statically: declared / installed,
 * its version (1.x → Strapi 4, 2.x and 3.x → Strapi 5: their peer dependencies), its options from
 * `config/plugins.*` (evaluated statically: imports and config functions followed)
 * and where its sync directory is. Reads files only — no boot.
 *
 * An option DevKit cannot read for certain (`env(...)`, a spread, an unknown import)
 * is `unresolved` and the plugin default is assumed — said, never dressed up as a fact. Checked against config-sync 3.2.0
 * (`dist/server/index.js`: defaults, `syncDir` concatenated with file names).
 */

import type { FileSystem } from '../fs/FileSystem';
import { isAbsolute, join, normalize } from '../fs/paths';
import type { StrapiProject } from '../model/types';
import { configModuleValue, envConfigFiles, findConfigFile } from '../plugins/config';
import { StaticEvaluator, type Value } from '../plugins/evaluate';
import { findPackageDir } from '../plugins/installed';

export const CONFIG_SYNC_PACKAGE = 'strapi-plugin-config-sync';
export const CONFIG_SYNC_PLUGIN = 'config-sync';
/** The plugin's default (1.x and 3.x). */
export const DEFAULT_SYNC_DIR = 'config/sync/';
/** The plugin's default `excludedConfig` (1.x and 3.x). */
export const DEFAULT_EXCLUDED_CONFIG = [
  'core-store.plugin_users-permissions_grant',
  'core-store.plugin_upload_metrics',
  'core-store.plugin_upload_api-folder',
  'core-store.strapi_content_types_schema',
  'core-store.ee_information',
];

export type OptionSource = 'default' | 'config' | 'unresolved';
type OptionName = 'syncDir' | 'excludedConfig' | 'excludedTypes' | 'customTypes' | 'importOnBootstrap' | 'soft' | 'minify';

export interface ConfigSyncOptions {
  syncDir: string;
  excludedConfig: string[];
  excludedTypes: string[];
  /** `configName`s of the `customTypes` (their full shape needs the runtime). */
  customTypes: string[];
  importOnBootstrap: boolean;
  soft: boolean;
  minify: boolean;
  /** Where each option comes from. */
  sources: Record<OptionName, OptionSource>;
}

export interface ConfigSyncDetection {
  /** In package.json (dependencies or devDependencies). */
  declared: boolean;
  declaredRange?: string;
  /** The installed plugin's version (hoisted installs included). */
  installedVersion?: string;
  /** The Strapi major the installed (or declared) plugin targets. */
  targetsStrapi?: 4 | 5;
  /** The plugin major doesn't match the project's Strapi major. */
  versionMismatch: boolean;
  /** The `config/plugins.*` configuring it, and the offset of its key there. */
  configFile?: string;
  configOffset?: number;
  /** `enabled: false` (a literal). */
  disabled: boolean;
  options: ConfigSyncOptions;
  /** The sync directory as the plugin resolves it (relative to the app root). */
  syncDirPath: string;
  syncDirExists: boolean;
  /** `config/env/<env>/plugins.*` files: they may change the options for that NODE_ENV. */
  envOverrides: string[];
  warnings: string[];
}

function safeJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function depRange(pkg: Record<string, unknown> | undefined): string | undefined {
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg?.[field];
    if (deps && typeof deps === 'object') {
      const range = (deps as Record<string, unknown>)[CONFIG_SYNC_PACKAGE];
      if (typeof range === 'string') return range;
    }
  }
  return undefined;
}

export function defaultConfigSyncOptions(): ConfigSyncOptions {
  const sources = { syncDir: 'default', excludedConfig: 'default', excludedTypes: 'default', customTypes: 'default', importOnBootstrap: 'default', soft: 'default', minify: 'default' } as const;
  return { syncDir: DEFAULT_SYNC_DIR, excludedConfig: [...DEFAULT_EXCLUDED_CONFIG], excludedTypes: [], customTypes: [], importOnBootstrap: false, soft: false, minify: false, sources: { ...sources } };
}

/**
 * The options of the `config-sync` entry of `config/plugins`, evaluated statically
 * (imports, `({ env }) => ({ … })`, constants followed). Strapi deep-merges the user
 * config over the plugin defaults (`fp.defaultsDeep`): a key the user didn't set keeps its
 * default, and arrays merge index by index (see `excludedConfig` below).
 */
async function readOptions(
  fs: FileSystem,
  root: string,
  file: string,
  warnings: string[],
): Promise<{ found: boolean; options: ConfigSyncOptions; disabled: boolean; offset?: number }> {
  const options = defaultConfigSyncOptions();
  const unresolvedAll = (why: string): void => {
    for (const k of Object.keys(options.sources) as OptionName[]) options.sources[k] = 'unresolved';
    warnings.push(why);
  };
  const ev = new StaticEvaluator(fs, { roots: [root] });
  const mod = await configModuleValue(ev, file);
  if (mod.k !== 'obj' || !mod.props.has(CONFIG_SYNC_PLUGIN)) return { found: false, options, disabled: false };
  const loc = mod.keyLocs.get(CONFIG_SYNC_PLUGIN);
  const offset = loc && normalize(loc.file) === normalize(file) ? loc.pos : undefined;
  const entry = await ev.getProp(mod, CONFIG_SYNC_PLUGIN);
  const at = offset !== undefined ? { offset } : {};
  if (entry.k === 'bool') return { found: true, options, disabled: !entry.v, ...at };
  if (entry.k !== 'obj') {
    unresolvedAll('The config-sync entry of config/plugins is not readable statically: the plugin defaults are assumed.');
    return { found: true, options, disabled: false, ...at };
  }
  const enabled = entry.props.has('enabled') ? await ev.getProp(entry, 'enabled') : undefined;
  const disabled = enabled?.k === 'bool' && !enabled.v;
  if (!entry.props.has('config')) {
    if (entry.open) unresolvedAll('The config-sync entry may hold options DevKit cannot see: the plugin defaults are assumed.');
    return { found: true, options, disabled, ...at };
  }
  const cfg = await ev.getProp(entry, 'config');
  if (cfg.k === 'nil') return { found: true, options, disabled, ...at };
  if (cfg.k !== 'obj') {
    unresolvedAll('The config-sync options are not readable statically: the plugin defaults are assumed.');
    return { found: true, options, disabled, ...at };
  }
  const strings = async (v: Value): Promise<string[] | undefined> => {
    if (v.k !== 'arr' || v.open) return undefined;
    const out: string[] = [];
    for (const it of v.items) {
      const x = await it();
      if (x.k !== 'str') return undefined;
      out.push(x.v);
    }
    return out;
  };
  const configNames = async (v: Value): Promise<string[] | undefined> => {
    if (v.k !== 'arr' || v.open) return undefined;
    const out: string[] = [];
    for (const it of v.items) {
      const x = await it();
      const n = x.k === 'obj' ? await ev.getProp(x, 'configName') : undefined;
      if (n?.k !== 'str') return undefined;
      out.push(n.v);
    }
    return out;
  };
  const read: { [K in OptionName]: (v: Value) => Promise<ConfigSyncOptions[K] | undefined> } = {
    syncDir: async (v) => (v.k === 'str' ? v.v : undefined),
    excludedConfig: strings,
    excludedTypes: strings,
    customTypes: configNames,
    importOnBootstrap: async (v) => (v.k === 'bool' ? v.v : undefined),
    soft: async (v) => (v.k === 'bool' ? v.v : undefined),
    minify: async (v) => (v.k === 'bool' ? v.v : undefined),
  };
  for (const key of Object.keys(read) as OptionName[]) {
    if (!cfg.props.has(key)) {
      if (cfg.open) options.sources[key] = 'unresolved';
      continue;
    }
    const value = await (read[key] as (v: Value) => Promise<unknown>)(await ev.getProp(cfg, key));
    if (value === undefined) {
      options.sources[key] = 'unresolved';
      warnings.push(`The config-sync option \`${key}\` is not readable statically: its default is assumed.`);
    } else if (key === 'excludedConfig') {
      // Strapi merges a plugin's config with `fp.defaultsDeep(default, user)`
      // (@strapi/core/dist/loaders/plugins/index.js): arrays are merged index by index,
      // so a user list shorter than the default keeps the default's tail.
      const user = value as string[];
      options.excludedConfig = DEFAULT_EXCLUDED_CONFIG.length > user.length ? [...user, ...DEFAULT_EXCLUDED_CONFIG.slice(user.length)] : [...user];
      options.sources.excludedConfig = 'config';
      if (DEFAULT_EXCLUDED_CONFIG.length > user.length) {
        const kept = DEFAULT_EXCLUDED_CONFIG.slice(user.length);
        const dropped = DEFAULT_EXCLUDED_CONFIG.slice(0, user.length).filter((d) => !user.includes(d));
        warnings.push(
          `excludedConfig has ${user.length} entr${user.length === 1 ? 'y' : 'ies'}: Strapi merges it with the plugin's defaults index by index, so ${kept.map((k) => `\`${k}\``).join(', ')} still ${kept.length === 1 ? 'applies' : 'apply'}${dropped.length ? `, but ${dropped.map((k) => `\`${k}\``).join(', ')} no longer ${dropped.length === 1 ? 'does' : 'do'}` : ''}.`,
        );
      }
    } else {
      (options as unknown as Record<string, unknown>)[key] = value;
      options.sources[key] = 'config';
    }
  }
  if (cfg.open) warnings.push('The config-sync options may hold keys DevKit cannot see (a spread or a computed key).');
  return { found: true, options, disabled, ...at };
}

function major(version: string | undefined): number | undefined {
  const m = version?.match(/(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** What config-sync's `importOnBootstrap` does to a database shared between branches (said wherever config-sync is described). */
export const IMPORT_ON_BOOTSTRAP_WARNING =
  'importOnBootstrap is on: every start of Strapi imports the files of the checked-out branch into the database. On a database shared between branches, switching branch and then starting overwrites what the other branches set (roles, permissions, views): export first, or turn it off locally.';

/** config-sync in `project`, or undefined when it is neither declared, installed nor configured. */
export async function detectConfigSync(fs: FileSystem, project: StrapiProject): Promise<ConfigSyncDetection | undefined> {
  const root = project.root;
  const warnings: string[] = [];
  let declaredRange: string | undefined;
  try {
    declaredRange = depRange(safeJson(await fs.readFile(join(root, 'package.json'))));
  } catch {
    /* no package.json: the project would not have been discovered */
  }
  let installedVersion: string | undefined;
  const dir = await findPackageDir(fs, root, CONFIG_SYNC_PACKAGE);
  if (dir) {
    try {
      const v = safeJson(await fs.readFile(join(dir, 'package.json')))?.version;
      if (typeof v === 'string') installedVersion = v;
    } catch {
      /* unreadable manifest */
    }
  }
  const configFile = await findConfigFile(fs, root, 'plugins');
  const read = configFile ? await readOptions(fs, root, configFile, warnings) : undefined;
  if (!declaredRange && !installedVersion && !read?.found) return undefined;
  const options = read?.found ? read.options : defaultConfigSyncOptions();
  const disabled = read?.found ? read.disabled : false;
  const m = major(installedVersion ?? declaredRange);
  // 2.x and 3.x → Strapi 5, 1.x → Strapi 4 (their peer dependencies; 0.x was for Strapi 3: not a DevKit target).
  const targetsStrapi = m === undefined || m === 0 ? undefined : m >= 2 ? 5 : 4;
  const versionMismatch = targetsStrapi !== undefined && targetsStrapi !== project.version;
  if (versionMismatch) warnings.push(`${CONFIG_SYNC_PACKAGE}@${installedVersion ?? declaredRange} is for Strapi ${targetsStrapi}; this project is Strapi ${project.version}.`);
  if (declaredRange && !installedVersion) warnings.push(`${CONFIG_SYNC_PACKAGE} is declared but not installed.`);
  // The plugin writes `${syncDir}${type}.${name}.json`: without a trailing slash, syncDir prefixes file names.
  if (!options.syncDir.endsWith('/')) warnings.push(`syncDir "${options.syncDir}" has no trailing slash: the plugin prefixes the file names with it instead of using a folder.`);
  if (options.importOnBootstrap && !disabled) warnings.push(IMPORT_ON_BOOTSTRAP_WARNING);
  const syncDirPath = normalize(isAbsolute(options.syncDir) ? options.syncDir : join(root, options.syncDir.replace(/^\.\//, '')));
  const syncDirExists = (await fs.stat(syncDirPath)) !== null;
  const envOverrides = await envConfigFiles(fs, root, 'plugins');

  return {
    declared: declaredRange !== undefined,
    ...(declaredRange ? { declaredRange } : {}),
    ...(installedVersion ? { installedVersion } : {}),
    ...(targetsStrapi ? { targetsStrapi } : {}),
    versionMismatch,
    ...(read?.found && configFile ? { configFile, ...(read.offset !== undefined ? { configOffset: read.offset } : {}) } : {}),
    disabled,
    options,
    syncDirPath,
    syncDirExists,
    envOverrides,
    warnings,
  };
}
