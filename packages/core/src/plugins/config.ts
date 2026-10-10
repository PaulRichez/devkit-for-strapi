/**
 * Read `config/plugins.{ts,js}` (and its `config/env/<env>/plugins.*` overlays)
 * statically — which plugins are enabled/disabled and where local plugins live.
 *
 * Mirrors Strapi's `getUserPluginsConfig` + `toDetailedDeclaration`: the file's
 * default export (or `module.exports`) is called with `{ env }` when it is a
 * function; each key is either a boolean or `{ enabled, resolve, config }`.
 * Anything not literal (an `env.bool(...)`, a spread, a computed key) is reported
 * as *unknown* — callers must then stay silent rather than guess.
 */

import type { FileSystem } from '../fs/FileSystem';
import { FileType } from '../fs/FileSystem';
import { join } from '../fs/paths';
import { isCallable, StaticEvaluator, UNKNOWN, type Value } from './evaluate';

export interface PluginDeclaration {
  /**
   * `true`/`false` when written literally; `'unset'` when the declaration has no
   * `enabled` key (Strapi then keeps an *installed* plugin on, but leaves a
   * *local* one off); `'unknown'` when the value is not knowable statically.
   */
  enabled: boolean | 'unset' | 'unknown';
  /** `resolve` path as written; `null` when present but not literal. */
  resolve?: string | null;
  /** Mentioned by a `config/env/<env>/plugins.*` overlay (value depends on NODE_ENV). */
  envOverride?: boolean;
}

export interface PluginsConfig {
  /** False when the config could not be read exhaustively (some key may be hidden). */
  exhaustive: boolean;
  declarations: Map<string, PluginDeclaration>;
  /** The config file read, if any. */
  file?: string;
}

const CONFIG_EXT = ['.ts', '.js', '.mjs', '.cjs', '.mts', '.cts'];

async function firstExisting(fs: FileSystem, base: string): Promise<string | undefined> {
  for (const ext of CONFIG_EXT) {
    const p = base + ext;
    if ((await fs.stat(p))?.type === FileType.File) return p;
  }
  return undefined;
}

/** `config/<name>.{ts,js,…}` of a project, if any. */
export function findConfigFile(fs: FileSystem, root: string, name: string): Promise<string | undefined> {
  return firstExisting(fs, join(root, 'config', name));
}

/** The `config/env/<env>/<name>.*` overlays of a project (their effect depends on NODE_ENV). */
export async function envConfigFiles(fs: FileSystem, root: string, name: string): Promise<string[]> {
  let envs: string[] = [];
  try {
    envs = (await fs.readDirectory(join(root, 'config', 'env'))).filter((e) => e.type === FileType.Directory).map((e) => e.name);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const env of envs.sort()) {
    const f = await firstExisting(fs, join(root, 'config', 'env', env, name));
    if (f) out.push(f);
  }
  return out;
}

/** The value Strapi's `loadConfigFile` would produce for a JS/TS config module. */
export async function configModuleValue(ev: StaticEvaluator, file: string): Promise<Value> {
  let v = await ev.moduleExports(file);
  // importDefault: `mod.__esModule ? mod.default : mod`
  if (v.k === 'obj' && v.esModule && v.props.has('default')) v = await ev.getProp(v, 'default');
  if (isCallable(v)) v = await ev.call(v, [UNKNOWN('env')]);
  return v;
}

async function declarationOf(ev: StaticEvaluator, v: Value): Promise<PluginDeclaration> {
  if (v.k === 'bool') return { enabled: v.v };
  if (v.k !== 'obj') return { enabled: 'unknown' };
  const out: PluginDeclaration = { enabled: 'unknown' };
  if (!v.props.has('enabled')) {
    out.enabled = v.open ? 'unknown' : 'unset';
  } else {
    const enabled = await ev.getProp(v, 'enabled');
    if (enabled.k === 'bool') out.enabled = enabled.v;
    else if (enabled.k === 'nil') out.enabled = 'unset';
  }
  if (v.props.has('resolve')) {
    const r = await ev.getProp(v, 'resolve');
    out.resolve = r.k === 'str' ? r.v : null;
  }
  return out;
}

export async function readPluginsConfig(fs: FileSystem, root: string, ev = new StaticEvaluator(fs, { roots: [root] })): Promise<PluginsConfig> {
  const declarations = new Map<string, PluginDeclaration>();
  let exhaustive = true;
  const file = await firstExisting(fs, join(root, 'config', 'plugins'));
  if (file) {
    const v = await configModuleValue(ev, file);
    if (v.k === 'obj') {
      if (v.open) exhaustive = false;
      for (const [name, thunk] of v.props) declarations.set(name, await declarationOf(ev, await thunk()));
    } else if (v.k !== 'nil') {
      exhaustive = false;
    }
  }

  // Environment overlays: their effect depends on NODE_ENV, unknown statically.
  let envDirs: string[] = [];
  try {
    envDirs = (await fs.readDirectory(join(root, 'config', 'env')))
      .filter((e) => e.type === FileType.Directory)
      .map((e) => e.name);
  } catch {
    envDirs = [];
  }
  for (const env of envDirs) {
    const envFile = await firstExisting(fs, join(root, 'config', 'env', env, 'plugins'));
    if (!envFile) continue;
    const v = await configModuleValue(ev, envFile);
    if (v.k !== 'obj' || v.open) {
      exhaustive = false;
      continue;
    }
    for (const name of v.props.keys()) {
      const d = declarations.get(name) ?? { enabled: 'unset' as const };
      d.envOverride = true;
      declarations.set(name, d);
    }
  }
  return { exhaustive, declarations, ...(file ? { file } : {}) };
}
