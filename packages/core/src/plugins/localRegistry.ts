/**
 * The services, controllers, policies and middlewares a **local** plugin
 * registers — read from its server entry the way Strapi does, statically.
 *
 * Strapi never names a plugin's artifacts after its files: it registers the keys
 * of the objects the server entry exports (`controllers: { myController:
 * require('./my-controller') }` registers `myController`; a spread of a sub-index
 * registers that index's keys). So DevKit evaluates the entry with the same
 * sound-or-silent evaluator it uses for installed plugins (`evaluate.ts`):
 *
 * - an object it reads exhaustively → its keys are the names, nothing else is an
 *   artifact (a `__tests__` file the index doesn't list isn't one);
 * - an object with keys it couldn't see (a helper call spread into it) → the keys
 *   it sees are names, and the collection is **open**: a name DevKit doesn't see
 *   there is unverifiable, never reported;
 * - no object at all: DevKit's scaffolded folder loader (`loadDir('services')`)
 *   keys files by the folder convention, which DevKit follows; any other loader
 *   is unknown → folder convention, but **open** and the names unconfirmed.
 *
 * A plugin with no server entry keeps the folder convention, as before.
 */

import type { FileSystem } from '../fs/FileSystem';
import { join, normalize } from '../fs/paths';
import { localPluginEntry } from '../index/pluginLayout';
import type { ArtifactKind } from '../model/types';
import { configModuleValue } from './config';
import { isCallable, type ObjValue, StaticEvaluator, UNKNOWN, type Value } from './evaluate';
import { strapiExternals } from './shims';

/** One name a plugin registers. */
export interface RegistryEntry {
  /** The key the plugin registers — the artifact's name. */
  name: string;
  /** The module that defines it when it lives in its own file (`require('./x')`), else absent (inline). */
  filePath?: string;
  /** Char offset of the definition (the factory, the exported object) in `filePath`. */
  defOffset?: number;
  /** Where the key is written. */
  keyFile: string;
  keyPos: number;
}

/** Where code DevKit couldn't read builds a collection (an open one). */
export interface CollectionSite {
  file: string;
  pos: number;
  /** 1-based line of `pos`, when the file was parsed. */
  line?: number;
}

/** What DevKit knows of one collection (`services`, `controllers`, …) of a local plugin. */
export type CollectionRead =
  /** Names are the keys of the registered object; `open` when it may hold keys DevKit couldn't see (`where`). */
  | { mode: 'keys'; entries: RegistryEntry[]; open: boolean; where?: CollectionSite }
  /** Names come from the folder convention; `open` when the plugin's loader isn't a recognised folder loader (`where`). */
  | { mode: 'convention'; open: boolean; where?: CollectionSite };

export interface LocalPluginRegistry {
  /** The server entry evaluated, if any. */
  entry?: string;
  collections: Record<ArtifactKind, CollectionRead>;
}

const COLLECTIONS: ReadonlyArray<readonly [ArtifactKind, string]> = [
  ['service', 'services'],
  ['controller', 'controllers'],
  ['policy', 'policies'],
  ['middleware', 'middlewares'],
];

/** Wall-clock budget for reading one local plugin's registry. */
const BUDGET_MS = 3_000;
/** A loader that lists its folders at boot (`fs.readdirSync`). */
const READDIR_LOADER = /\breaddir(Sync)?\b/;
/** The folder loader DevKit scaffolds (since its first version): `function loadDir(dir)`. */
const LOAD_DIR_FUNCTION = /\bfunction\s+loadDir\s*\(/;

/**
 * True when the collection `key` is built by DevKit's scaffolded folder loader
 * (`<key>: loadDir('<key>')`, with a `loadDir` that lists its folder), whose names
 * follow the folder convention. Any other loader is unknown: a `readdir` somewhere
 * in the plugin (a seed at bootstrap) says nothing about how a collection is keyed.
 */
function isScaffoldedLoader(texts: string[], key: string): boolean {
  const call = new RegExp(`\\b${key}\\s*:\\s*loadDir\\(\\s*['"\`]${key}['"\`]\\s*\\)`);
  return texts.some((t) => LOAD_DIR_FUNCTION.test(t) && READDIR_LOADER.test(t) && call.test(t));
}

function everyKind(read: CollectionRead): Record<ArtifactKind, CollectionRead> {
  return { service: read, controller: read, policy: read, middleware: read };
}

/** `import x from './x'` of an ES module → its default export. */
async function unwrapDefault(ev: StaticEvaluator, v: Value): Promise<Value> {
  if (v.k === 'obj' && v.esModule && v.props.has('default')) return ev.getProp(v, 'default');
  return v;
}

async function entriesOf(ev: StaticEvaluator, coll: ObjValue, fallbackFile: string): Promise<RegistryEntry[]> {
  const out: RegistryEntry[] = [];
  for (const [name, thunk] of coll.props) {
    const keyLoc = coll.keyLocs.get(name);
    const keyFile = normalize(keyLoc?.file ?? fallbackFile);
    const entry: RegistryEntry = { name, keyFile, keyPos: keyLoc?.pos ?? 0 };
    const value = await unwrapDefault(ev, await thunk());
    const loc = value.k === 'fn' ? value.loc : value.k === 'obj' ? value.loc : undefined;
    if (loc && normalize(loc.file) !== keyFile) {
      entry.filePath = normalize(loc.file);
      entry.defOffset = loc.pos;
    }
    out.push(entry);
  }
  return out;
}

/** Read what a local plugin (`src/plugins/<name>`) registers, by kind (see the module doc). */
export async function readLocalPluginRegistry(fs: FileSystem, srcDir: string, pluginName: string): Promise<LocalPluginRegistry> {
  const entry = await localPluginEntry(fs, srcDir, pluginName);
  if (!entry) return { collections: everyKind({ mode: 'convention', open: false }) };
  const ev = new StaticEvaluator(fs, { roots: [join(srcDir, 'plugins', pluginName)], timeBudgetMs: BUDGET_MS }, strapiExternals);
  let server: Value;
  try {
    server = await configModuleValue(ev, entry);
  } catch {
    return { entry, collections: everyKind({ mode: 'convention', open: true, where: { file: entry, pos: 0 } }) };
  }
  const atEntry: CollectionSite = { file: entry, pos: 0 };
  const siteOf = (key: string): CollectionSite => (server.k === 'obj' ? (server.keyLocs.get(key) ?? server.loc) : undefined) ?? atEntry;
  const unknownLoader = (key: string): CollectionRead => {
    const open = !isScaffoldedLoader(ev.parsedFiles().map((sf) => sf.text), key);
    return open ? { mode: 'convention', open, where: siteOf(key) } : { mode: 'convention', open };
  };

  const collections = {} as Record<ArtifactKind, CollectionRead>;
  for (const [kind, key] of COLLECTIONS) {
    if (server.k !== 'obj') {
      collections[kind] = unknownLoader(key);
      continue;
    }
    if (!server.props.has(key)) {
      // Strapi's default is an empty collection; an open server object may hide the key.
      collections[kind] = server.open ? { mode: 'convention', open: true, where: server.loc ?? atEntry } : { mode: 'keys', entries: [], open: false };
      continue;
    }
    let v = await ev.getProp(server, key);
    if (isCallable(v)) v = await ev.call(v, [UNKNOWN('{ strapi }')]);
    if (v.k !== 'obj') {
      collections[kind] = unknownLoader(key);
      continue;
    }
    const entries = await entriesOf(ev, v, entry);
    collections[kind] = v.open ? { mode: 'keys', entries, open: true, where: v.loc ?? siteOf(key) } : { mode: 'keys', entries, open: false };
  }
  // Cut by the budget: what was read is real, but more may exist.
  if (ev.exhausted) {
    for (const [kind] of COLLECTIONS) {
      const c = collections[kind];
      collections[kind] = c.mode === 'keys' ? { ...c, open: true, where: c.where ?? atEntry } : { mode: 'convention', open: true, where: c.where ?? atEntry };
    }
  }
  // Each open collection's site with its line, for the messages that name it.
  const lineOf = (site: CollectionSite): CollectionSite => {
    const sf = ev.parsedFiles().find((f) => normalize(f.fileName) === normalize(site.file));
    return sf ? { ...site, line: sf.getLineAndCharacterOfPosition(site.pos).line + 1 } : site;
  };
  for (const [kind] of COLLECTIONS) {
    const c = collections[kind];
    if (c.where) collections[kind] = { ...c, where: lineOf(c.where) };
  }
  return { entry, collections };
}
