import { type FileSystem, FileType } from '../fs/FileSystem';
import { join, normalize, stripExt } from '../fs/paths';
import {
  type ArtifactKind,
  type ArtifactScope,
  type CodeArtifact,
  type ComponentDef,
  type ContentType,
  emptyIndex,
  type FileDefEntry,
  type StrapiIndex,
} from '../model/types';
import { buildArtifactRef } from '../model/uid';
import { analyzeArtifact, definitionAnchorOffset } from './actions';
import { indexCodeContentTypes } from './codeContentTypes';
import { parseComponentFile } from './components';
import { isGlobalArtifactFile, isTestPath, normalizeApiName } from './loaderNames';
import { layoutDir, type PluginLayout, pluginLayoutOf } from './pluginLayout';
import { parseSchemaFile } from './schema';
import { readLocalPluginRegistry } from '../plugins/localRegistry';

const CODE_EXT = ['.ts', '.js', '.tsx', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

function isCodeFile(name: string): boolean {
  return CODE_EXT.some((e) => name.endsWith(e)) && !name.endsWith('.d.ts');
}

async function listDirs(fs: FileSystem, dir: string): Promise<string[]> {
  try {
    const entries = await fs.readDirectory(dir);
    return entries.filter((e) => e.type === FileType.Directory).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listFiles(
  fs: FileSystem,
  dir: string,
  predicate: (name: string) => boolean,
): Promise<string[]> {
  try {
    const entries = await fs.readDirectory(dir);
    return entries.filter((e) => e.type === FileType.File && predicate(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Code files under `dir`, **recursively**, as POSIX paths relative to `dir` (test files and mocks left out). */
async function listCodeFilesRec(fs: FileSystem, dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readDirectory(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (isTestPath(rel)) continue;
      if (e.type === FileType.Directory) await walk(join(d, e.name), rel);
      else if (e.type === FileType.File && isCodeFile(e.name)) out.push(rel);
    }
  };
  await walk(dir, '');
  return out;
}

/**
 * Artifact name of a plugin file by the **folder convention** — the rule of the
 * loader DevKit scaffolds, and the fallback when a plugin's registry can't be
 * read: nested files are keyed by their dotted path (`error/catch.js` →
 * `error.catch`), a trailing `index` denotes the folder (`error/index.js` →
 * `error`), the top-level `index` aggregator yields `undefined` (skipped).
 */
export function conventionName(relPath: string): string | undefined {
  if (isTestPath(relPath)) return undefined;
  const segs = stripExt(relPath).split('/');
  if (segs[segs.length - 1] === 'index') segs.pop();
  return segs.length ? segs.join('.') : undefined;
}

/**
 * The name Strapi registers a project file under (see `loaderNames.ts`), from
 * its path relative to the kind folder — `undefined` when Strapi doesn't load
 * it as an artifact: a file in a subfolder of an API or of `src/{policies,middlewares}`,
 * a global file that isn't `.js`/`.ts`, a test file, the `index` aggregator.
 * A plugin's files follow the folder convention (its registry, when read, overrides it).
 */
export function artifactName(scope: ArtifactScope, relPath: string): string | undefined {
  if (scope === 'plugin') return conventionName(relPath);
  if (relPath.includes('/') || isTestPath(relPath)) return undefined; // Strapi never loads a subfolder of these
  const base = stripExt(relPath);
  if (base === 'index') return undefined;
  if (scope === 'global') return isGlobalArtifactFile(relPath) ? base : undefined;
  return normalizeApiName(base);
}

interface ArtifactOwner {
  scope: ArtifactScope;
  apiName?: string;
  pluginName?: string;
}

/** The `StrapiIndex` map name (plural) for an `ArtifactKind` (singular). */
function mapNameForKind(kind: ArtifactKind): FileDefEntry['map'] {
  switch (kind) {
    case 'service': return 'services';
    case 'controller': return 'controllers';
    case 'policy': return 'policies';
    case 'middleware': return 'middlewares';
  }
}

/** The artifact map on the index for a given kind. */
function mapForKind(index: StrapiIndex, kind: ArtifactKind): Map<string, CodeArtifact> {
  switch (kind) {
    case 'service': return index.services;
    case 'controller': return index.controllers;
    case 'policy': return index.policies;
    case 'middleware': return index.middlewares;
  }
}

/** Record a definition entry in the reverse index (`fileDefs`). */
function recordDef(
  index: StrapiIndex,
  filePath: string,
  map: FileDefEntry['map'],
  key: string,
): void {
  const norm = normalize(filePath);
  const arr = index.fileDefs.get(norm);
  const entry: FileDefEntry = { map, key };
  if (arr) arr.push(entry);
  else index.fileDefs.set(norm, [entry]);
}

/**
 * Read an artifact's file to anchor UI on its definition line; services and
 * controllers also get their navigable methods (both from one AST parse).
 */
async function describeArtifact(fs: FileSystem, artifact: CodeArtifact): Promise<void> {
  try {
    const text = await fs.readFile(artifact.filePath);
    if (artifact.kind === 'controller' || artifact.kind === 'service') {
      const info = analyzeArtifact(artifact.filePath, text);
      artifact.defOffset = info.anchorOffset;
      artifact.actions = info.methods;
      if (info.hasSpread) artifact.hasSpread = true;
    } else {
      artifact.defOffset = definitionAnchorOffset(artifact.filePath, text);
    }
  } catch {
    if (artifact.kind === 'controller' || artifact.kind === 'service') artifact.actions = [];
  }
}

async function indexArtifactDir(
  fs: FileSystem,
  dir: string,
  kind: ArtifactKind,
  owner: ArtifactOwner,
  index: StrapiIndex,
  /** The names come from the folder convention without a loader that follows it (see `CodeArtifact.unconfirmed`). */
  unconfirmed = false,
): Promise<void> {
  const map = mapForKind(index, kind);
  // Only a plugin's own loader can reach into subfolders; an API's or the global
  // folders are read flat by Strapi (see artifactName).
  const files = owner.scope === 'plugin' ? await listCodeFilesRec(fs, dir) : await listFiles(fs, dir, isCodeFile);
  for (const file of files) {
    const name = artifactName(owner.scope, file);
    if (name === undefined) continue;
    const filePath = join(dir, file);
    const ref = buildArtifactRef(owner.scope, name, owner);
    const artifact: CodeArtifact = { ref, kind, filePath, scope: owner.scope, name };
    if (owner.apiName) artifact.apiName = owner.apiName;
    if (owner.pluginName) artifact.pluginName = owner.pluginName;
    if (unconfirmed) artifact.unconfirmed = true;
    await describeArtifact(fs, artifact);
    map.set(ref, artifact);
    recordDef(index, filePath, mapNameForKind(kind), ref);
  }
}

async function indexContentTypeDir(
  fs: FileSystem,
  ctDir: string,
  owner: { source: 'api' | 'plugin'; apiName: string; pluginName?: string; extension?: boolean },
  index: StrapiIndex,
): Promise<void> {
  for (const ct of await listDirs(fs, ctDir)) {
    const schemaPath = join(ctDir, ct, 'schema.json');
    if (!(await fs.exists(schemaPath))) continue;
    const ctDef = parseSchemaFile(await fs.readFile(schemaPath), {
      schemaPath,
      // An API's content-type folders are keyed like its other files (normalizeName).
      ctName: owner.source === 'api' ? normalizeApiName(ct) : ct,
      source: owner.source,
      apiName: owner.apiName,
      ...(owner.pluginName ? { pluginName: owner.pluginName } : {}),
    });
    if (!ctDef) continue;
    if (owner.extension) ctDef.extension = true;
    index.contentTypes.set(ctDef.uid, ctDef);
    recordDef(index, schemaPath, 'contentTypes', ctDef.uid);
  }
}

async function indexApis(fs: FileSystem, srcDir: string, index: StrapiIndex): Promise<void> {
  const apiDir = join(srcDir, 'api');
  for (const folder of await listDirs(fs, apiDir)) {
    if (folder.startsWith('.')) continue; // Strapi skips dot folders
    const apiPath = join(apiDir, folder);
    const apiName = normalizeApiName(folder);
    await indexContentTypeDir(fs, join(apiPath, 'content-types'), { source: 'api', apiName }, index);
    const owner: ArtifactOwner = { scope: 'api', apiName };
    await indexArtifactDir(fs, join(apiPath, 'services'), 'service', owner, index);
    await indexArtifactDir(fs, join(apiPath, 'controllers'), 'controller', owner, index);
    await indexArtifactDir(fs, join(apiPath, 'policies'), 'policy', owner, index);
    await indexArtifactDir(fs, join(apiPath, 'middlewares'), 'middleware', owner, index);
  }
}

async function indexComponents(fs: FileSystem, srcDir: string, index: StrapiIndex): Promise<void> {
  const compDir = join(srcDir, 'components');
  for (const category of await listDirs(fs, compDir)) {
    for (const file of await listFiles(fs, join(compDir, category), (n) => n.endsWith('.json'))) {
      const name = stripExt(file);
      const jsonPath = join(compDir, category, file);
      const comp = parseComponentFile(await fs.readFile(jsonPath), jsonPath, category, name);
      if (comp) {
        index.components.set(comp.uid, comp);
        recordDef(index, jsonPath, 'components', comp.uid);
      }
    }
  }
}

/**
 * Content-types **extended** under `src/extensions/<plugin>/content-types/<ct>/schema.json`
 * — Strapi's standard mechanism to extend an installed plugin's content-type
 * (`users-permissions.user` being the canonical, near-universal case). Indexed
 * under `plugin::<plugin>.<ct>` with `extension: true` (the schema is a merge
 * overlay — partial by nature). NOTE: the extended plugin is NOT added to
 * `pluginNames` — it stays an *external* plugin (its services/controllers are
 * unverifiable), only its extended content-type schemas become visible.
 */
async function indexExtensions(fs: FileSystem, srcDir: string, index: StrapiIndex): Promise<void> {
  const extDir = join(srcDir, 'extensions');
  for (const pluginName of await listDirs(fs, extDir)) {
    await indexContentTypeDir(
      fs,
      join(extDir, pluginName, 'content-types'),
      { source: 'plugin', apiName: pluginName, pluginName, extension: true },
      index,
    );
  }
}

async function indexGlobals(fs: FileSystem, srcDir: string, index: StrapiIndex): Promise<void> {
  const owner: ArtifactOwner = { scope: 'global' };
  await indexArtifactDir(fs, join(srcDir, 'policies'), 'policy', owner, index);
  await indexArtifactDir(fs, join(srcDir, 'middlewares'), 'middleware', owner, index);
}

export { type PluginLayout, pluginLayoutOf } from './pluginLayout';

async function indexPlugins(fs: FileSystem, srcDir: string, index: StrapiIndex): Promise<void> {
  const pluginsDir = join(srcDir, 'plugins');
  for (const pluginName of await listDirs(fs, pluginsDir)) {
    index.pluginNames.add(pluginName);
    const base = join(pluginsDir, pluginName);
    const serverDir = layoutDir(base, await pluginLayoutOf(fs, srcDir, pluginName));
    await indexContentTypeDir(
      fs,
      join(serverDir, 'content-types'),
      { source: 'plugin', apiName: pluginName, pluginName },
      index,
    );
    // Content-types declared in code (`content-types/index.ts`), after the schema.json folders.
    await indexCodeContentTypes(fs, join(serverDir, 'content-types'), pluginName, index);
    await indexPluginArtifacts(fs, srcDir, pluginName, serverDir, index);
  }
}

const PLUGIN_KIND_DIRS: ReadonlyArray<readonly [ArtifactKind, string]> = [
  ['service', 'services'],
  ['controller', 'controllers'],
  ['policy', 'policies'],
  ['middleware', 'middlewares'],
];

/**
 * A local plugin's services/controllers/policies/middlewares, named as Strapi
 * registers them: the keys of its server entry's collections when DevKit reads
 * them (`plugins/localRegistry.ts`), else the folder convention. In an *open*
 * collection, the files no key accounts for keep their folder-convention name,
 * `unconfirmed` (navigable, never reported unused).
 */
async function indexPluginArtifacts(
  fs: FileSystem,
  srcDir: string,
  pluginName: string,
  serverDir: string,
  index: StrapiIndex,
): Promise<void> {
  const registry = await readLocalPluginRegistry(fs, srcDir, pluginName);
  const owner: ArtifactOwner = { scope: 'plugin', pluginName };
  for (const [kind, dirName] of PLUGIN_KIND_DIRS) {
    const read = registry.collections[kind];
    const dir = join(serverDir, dirName);
    if (read.open) {
      index.openCollections ??= new Map();
      const kinds = index.openCollections.get(pluginName) ?? new Set<ArtifactKind>();
      kinds.add(kind);
      index.openCollections.set(pluginName, kinds);
    }
    if (read.mode === 'convention') {
      await indexArtifactDir(fs, dir, kind, owner, index, read.open);
      continue;
    }
    const map = mapForKind(index, kind);
    for (const e of read.entries) {
      const ref = buildArtifactRef('plugin', e.name, owner);
      const artifact: CodeArtifact = { ref, kind, filePath: e.filePath ?? e.keyFile, scope: 'plugin', name: e.name, pluginName };
      if (e.filePath) {
        await describeArtifact(fs, artifact);
      } else {
        // Defined inline in the index: its methods aren't read (never a false "unknown action").
        artifact.defOffset = e.keyPos;
        if (kind === 'service' || kind === 'controller') {
          artifact.actions = [];
          artifact.hasSpread = true;
        }
      }
      map.set(ref, artifact);
      recordDef(index, artifact.filePath, mapNameForKind(kind), ref);
    }
    if (!read.open) continue;
    const covered = new Set(read.entries.map((e) => e.filePath).filter((f): f is string => f !== undefined));
    for (const file of await listCodeFilesRec(fs, dir)) {
      const filePath = join(dir, file);
      const name = conventionName(file);
      if (name === undefined || covered.has(normalize(filePath))) continue;
      const ref = buildArtifactRef('plugin', name, owner);
      if (map.has(ref)) continue; // a key the plugin really registers wins
      const artifact: CodeArtifact = { ref, kind, filePath, scope: 'plugin', name, pluginName, unconfirmed: true };
      await describeArtifact(fs, artifact);
      map.set(ref, artifact);
      recordDef(index, filePath, mapNameForKind(kind), ref);
    }
  }
}

/** Drop one definition entry from the reverse index (`fileDefs`). */
function dropFileDef(index: StrapiIndex, filePath: string, map: FileDefEntry['map'], key: string): void {
  const norm = normalize(filePath);
  const kept = (index.fileDefs.get(norm) ?? []).filter((d) => d.map !== map || d.key !== key);
  if (kept.length) index.fileDefs.set(norm, kept);
  else index.fileDefs.delete(norm);
}

/**
 * Re-index every artifact of one local plugin — what {@link indexPluginArtifacts}
 * gives in a full build, so the incremental index keeps parity with it: the
 * plugin's registry can change with any of its files (an index, a spread
 * sub-index, a new file under an auto-loader). Built aside, then swapped in
 * synchronously (no reader sees the plugin half-updated).
 */
async function reindexPluginArtifacts(fs: FileSystem, project: { srcDir: string; index: StrapiIndex }, pluginName: string): Promise<void> {
  const srcDir = normalize(project.srcDir);
  const base = join(srcDir, 'plugins', pluginName);
  const fresh = emptyIndex();
  if (await fs.exists(base)) {
    await indexPluginArtifacts(fs, srcDir, pluginName, layoutDir(base, await pluginLayoutOf(fs, srcDir, pluginName)), fresh);
  }
  const index = project.index;
  for (const mapName of ['services', 'controllers', 'policies', 'middlewares'] as const) {
    const map = index[mapName];
    for (const [key, a] of map) {
      if (a.installed || a.scope !== 'plugin' || a.pluginName !== pluginName) continue;
      map.delete(key);
      dropFileDef(index, a.filePath, mapName, key);
    }
    for (const [key, a] of fresh[mapName]) map.set(key, a);
  }
  for (const [file, defs] of fresh.fileDefs) index.fileDefs.set(file, [...(index.fileDefs.get(file) ?? []), ...defs]);
  index.openCollections?.delete(pluginName);
  const open = fresh.openCollections?.get(pluginName);
  if (open) (index.openCollections ??= new Map()).set(pluginName, open);
}

/** Re-read the code-defined content-types of one local plugin (after an edit under its content-types dir). */
export async function refreshCodeContentTypes(fs: FileSystem, project: { srcDir: string; index: StrapiIndex }, pluginName: string): Promise<void> {
  const base = join(project.srcDir, 'plugins', pluginName);
  if (!(await fs.exists(base))) {
    await indexCodeContentTypes(fs, join(base, '__missing__'), pluginName, project.index);
    return;
  }
  const serverDir = layoutDir(base, await pluginLayoutOf(fs, project.srcDir, pluginName));
  await indexCodeContentTypes(fs, join(serverDir, 'content-types'), pluginName, project.index);
}

/** Build the full in-memory index for one Strapi project. */
export async function buildIndex(fs: FileSystem, srcDir: string): Promise<StrapiIndex> {
  const index = emptyIndex();
  await indexApis(fs, srcDir, index);
  await indexComponents(fs, srcDir, index);
  await indexGlobals(fs, srcDir, index);
  await indexPlugins(fs, srcDir, index);
  await indexExtensions(fs, srcDir, index);
  return index;
}

// ---------------------------------------------------------------------------
// Incremental definition index — update a single file without re-walking src/
// ---------------------------------------------------------------------------

/** The kind of definition a file carries, derived from its path. */
type DefKind =
  | { kind: 'content-type'; source: 'api' | 'plugin'; apiName: string; pluginName?: string; extension?: boolean; ctName: string; pluginLayout?: PluginLayout }
  | { kind: 'component'; category: string; name: string }
  | { kind: 'artifact'; artifactKind: ArtifactKind; owner: ArtifactOwner; relPath: string; pluginLayout?: PluginLayout }
  | { kind: 'none' };

function artifactKindOfDir(dir: string): ArtifactKind | undefined {
  switch (dir) {
    case 'services': return 'service';
    case 'controllers': return 'controller';
    case 'policies': return 'policy';
    case 'middlewares': return 'middleware';
    default: return undefined;
  }
}

/**
 * Classify a file by its path to determine what definition(s) it contributes.
 * Mirrors the directory structure {@link buildIndex} walks — a file that doesn't
 * match any definition pattern returns `{ kind: 'none' }` (routes, configs, …).
 */
function classifyDefinitionFile(filePath: string, project: { srcDir: string }): DefKind {
  const f = normalize(filePath);
  const src = normalize(project.srcDir);
  if (!f.startsWith(src + '/')) return { kind: 'none' };
  const rel = f.slice(src.length + 1); // path relative to src/

  // src/extensions/<plugin>/content-types/<ct>/schema.json
  const extMatch = rel.match(/^extensions\/([^/]+)\/content-types\/([^/]+)\/schema\.json$/);
  if (extMatch) {
    const [, pluginName, ctName] = extMatch;
    return { kind: 'content-type', source: 'plugin', apiName: pluginName!, pluginName: pluginName, extension: true, ctName: ctName! };
  }

  // src/api/<api>/content-types/<ct>/schema.json
  const apiCtMatch = rel.match(/^api\/([^/.][^/]*)\/content-types\/([^/]+)\/schema\.json$/);
  if (apiCtMatch) {
    const [, apiFolder, ctFolder] = apiCtMatch;
    return { kind: 'content-type', source: 'api', apiName: normalizeApiName(apiFolder!), ctName: normalizeApiName(ctFolder!) };
  }

  // src/plugins/<plugin>/(server/(src/)?)?content-types/<ct>/schema.json
  const pluginCtMatch = rel.match(/^plugins\/([^/]+)\/(server\/(?:src\/)?)?content-types\/([^/]+)\/schema\.json$/);
  if (pluginCtMatch) {
    const [, pluginName, serverSeg, ctName] = pluginCtMatch;
    return { kind: 'content-type', source: 'plugin', apiName: pluginName!, pluginName, ctName: ctName!, pluginLayout: layoutOfSeg(serverSeg) };
  }

  // src/components/<category>/<name>.json
  const compMatch = rel.match(/^components\/([^/]+)\/([^/]+)\.json$/);
  if (compMatch) {
    const [, category, name] = compMatch;
    return { kind: 'component', category: category!, name: name! };
  }

  // src/api/<api>/{services,controllers,policies,middlewares}/<file>  — the file must be a
  // real code file (same gate as buildIndex's listCodeFilesRec: a `.d.ts`, `.md`, `.json`,
  // etc. under a services/ dir is NOT an artifact and must never become a phantom definition).
  const apiArtMatch = rel.match(/^api\/([^/.][^/]*)\/(services|controllers|policies|middlewares)\/(.+)$/);
  if (apiArtMatch) {
    const [, apiFolder, kindDir, relPath] = apiArtMatch;
    const artifactKind = artifactKindOfDir(kindDir!);
    if (artifactKind && isArtifactCodeFile(relPath!)) {
      return { kind: 'artifact', artifactKind, owner: { scope: 'api', apiName: normalizeApiName(apiFolder!) }, relPath: relPath! };
    }
  }

  // A local plugin's artifacts are re-indexed per plugin (see updateIndexForFile).

  // src/{policies,middlewares}/<file>  (global)
  const globalArtMatch = rel.match(/^(policies|middlewares)\/(.+)$/);
  if (globalArtMatch) {
    const [, kindDir, relPath] = globalArtMatch;
    const artifactKind = artifactKindOfDir(kindDir!);
    if (artifactKind && isArtifactCodeFile(relPath!)) {
      return { kind: 'artifact', artifactKind, owner: { scope: 'global' }, relPath: relPath! };
    }
  }

  return { kind: 'none' };
}

function layoutOfSeg(seg: string | undefined): PluginLayout {
  if (!seg) return 'root';
  return seg === 'server/src/' ? 'server/src' : 'server';
}

/** True if the artifact's file (last path segment) is a code file buildIndex would index. */
function isArtifactCodeFile(relPath: string): boolean {
  return isCodeFile(relPath.split('/').pop() ?? relPath);
}

/** Extract a plugin name from a path under `src/plugins/<name>/…`, if any. */
function pluginNameOfPath(filePath: string, srcDir: string): string | undefined {
  if (!filePath.startsWith(srcDir + '/')) return undefined;
  const rel = filePath.slice(srcDir.length + 1);
  const match = rel.match(/^plugins\/([^/]+)\//);
  return match ? match[1] : undefined;
}

/** The on-disk path the current entry at `map[key]` was built from (for ownership checks). */
function entryOwnerPath(index: StrapiIndex, map: FileDefEntry['map'], key: string): string | undefined {
  if (map === 'contentTypes') return index.contentTypes.get(key)?.schemaPath;
  if (map === 'components') return index.components.get(key)?.jsonPath;
  return index[map].get(key)?.filePath;
}

/**
 * Remove a file's old definition entries from the index (via the reverse index).
 * *Ownership-aware*: two files can legitimately produce the SAME canonical ref
 * (a flat `x.js` and a `x/index.js`, or a `.js` and a `.ts` during a migration).
 * Only delete the map key if the entry currently there was built from THIS file —
 * otherwise another file owns it and deleting would wipe a still-valid definition
 * (which the validator would then flag "Unknown" — a false positive).
 */
function removeDefsForFile(index: StrapiIndex, normPath: string): void {
  const old = index.fileDefs.get(normPath);
  if (!old) return;
  for (const { map, key } of old) {
    if (entryOwnerPath(index, map, key) === normPath) index[map].delete(key);
  }
  index.fileDefs.delete(normPath);
}

/** Parsed definition data for a single file (produced in the async phase). */
interface ParsedDef {
  contentType?: ContentType;
  component?: ComponentDef;
  artifact?: { ref: string; artifact: CodeArtifact; mapName: FileDefEntry['map'] };
}

/**
 * Incrementally update the definition index for a single changed or deleted file.
 * Removes the file's old entries (via the reverse index `fileDefs`), then — if
 * the file still exists and is a definition file — re-indexes it alone (1 read +
 * 1 parse). No full `src/` walk: O(1) removal + O(1) add instead of O(all defs).
 *
 * **Atomicity (per file)**: the read+parse happens *before* any mutation, so a
 * parse failure leaves the index intact, and the single-file swap (remove old +
 * add new) is synchronous — no reader sees a *file* half-applied. Across a *batch*
 * of files (`onFilesChanged` loops with an `await` per file) the index is mutated
 * in place, so a concurrent read can see file A already updated while file B is
 * not yet. Each map key stays individually consistent, so a per-entity query
 * (the only kind the providers make) always gets a coherent answer — the batch is
 * simply not one whole-index atomic swap like the old full rebuild was.
 *
 * **Caveat (shadowing)**: adding/removing a policy or middleware can change the
 * bare-name resolution (`api > global > plugin`) of refs in *other* files. This
 * is the same staleness already accepted for the incremental reference index
 * (documented in CLAUDE.md); a manual `rescan` is the safety net. Content-types,
 * services, controllers and components use fully-qualified UIDs — no shadowing.
 */
export async function updateIndexForFile(
  fs: FileSystem,
  project: { srcDir: string; index: StrapiIndex },
  filePath: string,
  /** The plugins already re-read in this batch of changes (each is re-read once per batch). */
  pluginsDone?: Set<string>,
): Promise<void> {
  const norm = normalize(filePath);
  const index = project.index;
  const srcNorm = normalize(project.srcDir);

  // A local plugin's code file can change what the plugin registers (an index, a
  // spread sub-index, a file under an auto-loader): its artifacts are re-read as a
  // whole, exactly as buildIndex reads them — once per batch (a checkout touches
  // many files of a plugin), and never for its admin panel's code.
  const plugin = pluginNameOfPath(norm, srcNorm);
  const inAdmin = plugin !== undefined && norm.startsWith(`${join(srcNorm, 'plugins', plugin)}/admin/`);
  if (plugin && !inAdmin && isCodeFile(norm.slice(norm.lastIndexOf('/') + 1))) {
    if (pluginsDone?.has(plugin)) return;
    pluginsDone?.add(plugin);
    await reindexPluginArtifacts(fs, project, plugin);
    if (await fs.exists(join(srcNorm, 'plugins', plugin))) index.pluginNames.add(plugin);
    else index.pluginNames.delete(plugin);
    return;
  }

  // 1. Classify the file by path (synchronous, no IO).
  let def = classifyDefinitionFile(filePath, project);

  // Plugin layout precedence: buildIndex reads ONE server dir per local plugin
  // (`server/src` > `server` > root, see pluginLayoutOf). A file in a shadowed
  // layout must be a non-definition — otherwise we'd index a phantom entry
  // buildIndex never produces.
  if ((def.kind === 'artifact' || def.kind === 'content-type') && def.pluginLayout !== undefined) {
    const pluginName = def.kind === 'artifact' ? def.owner.pluginName : def.pluginName;
    if (pluginName && (await pluginLayoutOf(fs, srcNorm, pluginName)) !== def.pluginLayout) {
      def = { kind: 'none' };
    }
  }

  // 2. Read + parse the new content FIRST (async, may throw).
  //    If the file was deleted or is not a definition file, parsed stays null.
  let parsed: ParsedDef | null = null;

  if (def.kind !== 'none') {
    try {
      if (def.kind === 'content-type') {
        const ctDef = parseSchemaFile(await fs.readFile(norm), {
          schemaPath: norm,
          ctName: def.ctName,
          source: def.source,
          apiName: def.apiName,
          ...(def.pluginName ? { pluginName: def.pluginName } : {}),
        });
        if (ctDef) {
          if (def.extension) ctDef.extension = true;
          parsed = { contentType: ctDef };
        }
      } else if (def.kind === 'component') {
        const comp = parseComponentFile(await fs.readFile(norm), norm, def.category, def.name);
        if (comp) parsed = { component: comp };
      } else if (def.kind === 'artifact') {
        // The artifact name comes from the path RELATIVE to the kind dir — the same
        // value buildIndex derives via its recursive walk. `classifyDefinitionFile`
        // already captured it (`relPath`); recomputing it here with `lastIndexOf`
        // would break when the kind-dir name recurs in a subfolder
        // (`services/services/bar.js` → wrong ref `x.bar` instead of `x.services.bar`).
        const name = artifactName(def.owner.scope, def.relPath);
        if (name) {
          const ref = buildArtifactRef(def.owner.scope, name, def.owner);
          const artifact: CodeArtifact = { ref, kind: def.artifactKind, filePath: norm, scope: def.owner.scope, name };
          if (def.owner.apiName) artifact.apiName = def.owner.apiName;
          if (def.owner.pluginName) artifact.pluginName = def.owner.pluginName;
          // readFile throws on a deleted file → outer catch → parsed stays null (removal only).
          const text = await fs.readFile(norm);
          try {
            if (def.artifactKind === 'controller' || def.artifactKind === 'service') {
              const info = analyzeArtifact(norm, text);
              artifact.defOffset = info.anchorOffset;
              artifact.actions = info.methods;
              if (info.hasSpread) artifact.hasSpread = true;
            } else {
              artifact.defOffset = definitionAnchorOffset(norm, text);
            }
          } catch {
            if (def.artifactKind === 'controller' || def.artifactKind === 'service') artifact.actions = [];
          }
          parsed = { artifact: { ref, artifact, mapName: mapNameForKind(def.artifactKind) } };
        }
      }
    } catch {
      // Read/parse failed (deleted file, transient IO error, malformed JSON).
      // parsed stays null → we'll just remove the old entries (if any).
    }
  }

  // 3. Synchronous swap: remove old entries + add new ones.
  //    No await here → no reader can observe this file half-updated.
  removeDefsForFile(index, norm);

  if (parsed?.contentType) {
    const ct = parsed.contentType;
    index.contentTypes.set(ct.uid, ct);
    recordDef(index, norm, 'contentTypes', ct.uid);
  } else if (parsed?.component) {
    const comp = parsed.component;
    index.components.set(comp.uid, comp);
    recordDef(index, norm, 'components', comp.uid);
  } else if (parsed?.artifact) {
    const { ref, artifact, mapName } = parsed.artifact;
    switch (mapName) {
      case 'services': index.services.set(ref, artifact); break;
      case 'controllers': index.controllers.set(ref, artifact); break;
      case 'policies': index.policies.set(ref, artifact); break;
      case 'middlewares': index.middlewares.set(ref, artifact); break;
      default: break;
    }
    recordDef(index, norm, mapName, ref);
  }

  // 4. pluginNames: mirror buildIndex, which registers a plugin iff its
  //    `src/plugins/<name>` directory exists. Recompute membership from the dir's
  //    existence (not add-only) so a deleted plugin is dropped (else its refs stay
  //    wrongly "local" → validated → false "Unknown", a false positive) and a new
  //    plugin is registered even if its first touched file isn't itself a definition.
  const pluginName = pluginNameOfPath(norm, srcNorm);
  if (pluginName) {
    if (await fs.exists(join(srcNorm, 'plugins', pluginName))) index.pluginNames.add(pluginName);
    else index.pluginNames.delete(pluginName);
  }
}