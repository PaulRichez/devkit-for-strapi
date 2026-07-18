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
import { parseComponentFile } from './components';
import { parseSchemaFile } from './schema';

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

/** Code files under `dir`, **recursively**, as POSIX paths relative to `dir`. */
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
      if (e.type === FileType.Directory) await walk(join(d, e.name), rel);
      else if (e.type === FileType.File && isCodeFile(e.name)) out.push(rel);
    }
  };
  await walk(dir, '');
  return out;
}

/**
 * Artifact name from a path relative to its kind dir — Strapi loads services etc.
 * recursively, keying nested files by their dotted path (`error/catch.js` →
 * `error.catch`). A trailing `index` denotes the folder's default (`error/index.js`
 * → `error`); the top-level `index` aggregator yields `undefined` (skipped).
 */
function artifactName(relPath: string): string | undefined {
  const segs = stripExt(relPath).split('/');
  if (segs[segs.length - 1] === 'index') segs.pop();
  return segs.length ? segs.join('.') : undefined;
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

async function indexArtifactDir(
  fs: FileSystem,
  dir: string,
  kind: ArtifactKind,
  owner: ArtifactOwner,
  index: StrapiIndex,
): Promise<void> {
  const map = mapForKind(index, kind);
  for (const file of await listCodeFilesRec(fs, dir)) {
    const name = artifactName(file);
    if (name === undefined) continue; // index aggregator, not an artifact
    const filePath = join(dir, file);
    const ref = buildArtifactRef(owner.scope, name, owner);
    const artifact: CodeArtifact = { ref, kind, filePath, scope: owner.scope, name };
    if (owner.apiName) artifact.apiName = owner.apiName;
    if (owner.pluginName) artifact.pluginName = owner.pluginName;
    // Read the file to anchor UI on the definition line; services/controllers
    // also expose navigable methods (both derived from one AST parse).
    try {
      const text = await fs.readFile(filePath);
      if (kind === 'controller' || kind === 'service') {
        const info = analyzeArtifact(filePath, text);
        artifact.defOffset = info.anchorOffset;
        artifact.actions = info.methods;
        if (info.hasSpread) artifact.hasSpread = true;
      } else {
        artifact.defOffset = definitionAnchorOffset(filePath, text);
      }
    } catch {
      if (kind === 'controller' || kind === 'service') artifact.actions = [];
    }
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
      ctName: ct,
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
  for (const apiName of await listDirs(fs, apiDir)) {
    const apiPath = join(apiDir, apiName);
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

async function indexPlugins(fs: FileSystem, srcDir: string, index: StrapiIndex): Promise<void> {
  const pluginsDir = join(srcDir, 'plugins');
  for (const pluginName of await listDirs(fs, pluginsDir)) {
    index.pluginNames.add(pluginName);
    const base = join(pluginsDir, pluginName);
    const serverDir = (await fs.exists(join(base, 'server'))) ? join(base, 'server') : base;
    await indexContentTypeDir(
      fs,
      join(serverDir, 'content-types'),
      { source: 'plugin', apiName: pluginName, pluginName },
      index,
    );
    const owner: ArtifactOwner = { scope: 'plugin', pluginName };
    await indexArtifactDir(fs, join(serverDir, 'services'), 'service', owner, index);
    await indexArtifactDir(fs, join(serverDir, 'controllers'), 'controller', owner, index);
    await indexArtifactDir(fs, join(serverDir, 'policies'), 'policy', owner, index);
    await indexArtifactDir(fs, join(serverDir, 'middlewares'), 'middleware', owner, index);
  }
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
  | { kind: 'content-type'; source: 'api' | 'plugin'; apiName: string; pluginName?: string; extension?: boolean; ctName: string; pluginUnderServer?: boolean }
  | { kind: 'component'; category: string; name: string }
  | { kind: 'artifact'; artifactKind: ArtifactKind; owner: ArtifactOwner; relPath: string; pluginUnderServer?: boolean }
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
  const apiCtMatch = rel.match(/^api\/([^/]+)\/content-types\/([^/]+)\/schema\.json$/);
  if (apiCtMatch) {
    const [, apiName, ctName] = apiCtMatch;
    return { kind: 'content-type', source: 'api', apiName: apiName!, ctName: ctName! };
  }

  // src/plugins/<plugin>/server/content-types/<ct>/schema.json  OR  src/plugins/<plugin>/content-types/<ct>/schema.json
  const pluginCtMatch = rel.match(/^plugins\/([^/]+)\/(server\/)?content-types\/([^/]+)\/schema\.json$/);
  if (pluginCtMatch) {
    const [, pluginName, serverSeg, ctName] = pluginCtMatch;
    return { kind: 'content-type', source: 'plugin', apiName: pluginName!, pluginName, ctName: ctName!, pluginUnderServer: !!serverSeg };
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
  const apiArtMatch = rel.match(/^api\/([^/]+)\/(services|controllers|policies|middlewares)\/(.+)$/);
  if (apiArtMatch) {
    const [, apiName, kindDir, relPath] = apiArtMatch;
    const artifactKind = artifactKindOfDir(kindDir!);
    if (artifactKind && isArtifactCodeFile(relPath!)) {
      return { kind: 'artifact', artifactKind, owner: { scope: 'api', apiName: apiName! }, relPath: relPath! };
    }
  }

  // src/plugins/<plugin>/(server/)?{services,controllers,policies,middlewares}/<file>
  const pluginArtMatch = rel.match(/^plugins\/([^/]+)\/(server\/)?(services|controllers|policies|middlewares)\/(.+)$/);
  if (pluginArtMatch) {
    const [, pluginName, serverSeg, kindDir, relPath] = pluginArtMatch;
    const artifactKind = artifactKindOfDir(kindDir!);
    if (artifactKind && isArtifactCodeFile(relPath!)) {
      return { kind: 'artifact', artifactKind, owner: { scope: 'plugin', pluginName: pluginName! }, relPath: relPath!, pluginUnderServer: !!serverSeg };
    }
  }

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
): Promise<void> {
  const norm = normalize(filePath);
  const index = project.index;
  const srcNorm = normalize(project.srcDir);

  // 1. Classify the file by path (synchronous, no IO).
  let def = classifyDefinitionFile(filePath, project);

  // Plugin `server/` precedence: buildIndex indexes a plugin's TOP-LEVEL
  // services/content-types dir only when there is no `server/` dir; once
  // `server/` exists it shadows the top-level one. A stray top-level file must
  // therefore be treated as a non-definition when `server/` exists — otherwise
  // we'd index a phantom entry buildIndex never produces.
  if ((def.kind === 'artifact' || def.kind === 'content-type') && def.pluginUnderServer === false) {
    const pluginName = def.kind === 'artifact' ? def.owner.pluginName : def.pluginName;
    if (pluginName && (await fs.exists(join(srcNorm, 'plugins', pluginName, 'server')))) {
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
        const name = artifactName(def.relPath);
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