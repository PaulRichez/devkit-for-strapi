import { collectConstantCallSites, collectReferences, collectRelativeImports, collectUnclassifiedUidLiterals, collectUnresolvedCalls } from '../analyze/callSite';
import { hasContentType } from '../index/codeContentTypes';
import { collectMemberReferences, collectThisMemberReferences } from '../analyze/memberRefs';
import { MAX_PARSE_CHARS } from '../analyze/parse';
import { collectRelationFieldUsages } from '../analyze/relationUsage';
import { type FileSystem, FileType } from '../fs/FileSystem';
import { basename, dirname, extname, join, normalize, stripExt } from '../fs/paths';
import { factoryObjectRange } from '../index/actions';
import { isTestPath } from '../index/loaderNames';
import { collectCoreRouterHandlers } from '../index/routes';
import type { CodeArtifact, ReferenceContext, ReferenceLocation, StrapiProject } from '../model/types';
import { parseHandlerRef, qualifyPluginRef } from '../model/uid';
import { owningApiName, owningPluginName, qualifyRouteHandler } from '../resolve/owner';
import { lineStarts, positionAt } from '../util/lines';

/** The service/controller artifact a file *defines* (so `this.x()` resolves to it). */
function artifactDefinedInFile(project: StrapiProject, filePath: string): CodeArtifact | undefined {
  for (const map of [project.index.services, project.index.controllers]) {
    for (const a of map.values()) if (sameFile(a.filePath, filePath)) return a;
  }
  return undefined;
}

/** Relation fields of a content-type and their targets — the guardrail for relation-field usage detection. */
function relationFieldsOf(project: StrapiProject, uid: string): Map<string, string | undefined> | undefined {
  const ct = project.index.contentTypes.get(uid);
  if (!ct) return undefined;
  const out = new Map<string, string | undefined>();
  for (const a of Object.values(ct.attributes)) if (a.type === 'relation') out.set(a.name, a.target);
  return out;
}

/** The reference keys of every entity registered under exactly `uid` (a content-type, a service, …). */
function entityKeysOf(project: StrapiProject, uid: string): string[] {
  const idx = project.index;
  const keys: string[] = [];
  if (hasContentType(idx, uid)) keys.push(`ct:${uid}`);
  if (idx.services.has(uid)) keys.push(`service:${uid}`);
  if (idx.controllers.has(uid)) keys.push(`controller:${uid}`);
  if (idx.policies.has(uid)) keys.push(`policy:${uid}`);
  if (idx.middlewares.has(uid)) keys.push(`middleware:${uid}`);
  return keys;
}

/** A UID written as a plain value in a file (see {@link resyncWeakLiterals}). */
export interface WeakLiteral {
  uid: string;
  loc: ReferenceLocation;
}

/** The references of one file: its keyed call-sites, and its weak literals (keyed at query time). */
interface FileReferences {
  refs: Array<{ key: string; loc: ReferenceLocation }>;
  literals: WeakLiteral[];
}

/** Collect this file's references as line/character locations (no editor needed later). */
function collectFileReferences(project: StrapiProject, filePath: string, text: string): FileReferences {
  const starts = lineStarts(text);
  /** The trimmed source line at a char offset (so callers needn't re-read the file). */
  const snippetAt = (offset: number): string => {
    const line = positionAt(starts, offset).line;
    const from = starts[line] ?? 0;
    const to = starts[line + 1] ?? text.length;
    return text.slice(from, to).replace(/\r?\n$/, '').trim();
  };
  const out: Array<{ key: string; loc: ReferenceLocation }> = [];
  // The magic strings, and the string constants at their call sites — a constant's
  // declaration is not a use (`const X = 'api::x.y'` counts where X is passed).
  const contexts = [...collectReferences(filePath, text).filter((ctx) => !ctx.constant), ...collectConstantCallSites(filePath, text)];
  for (const ctx of contexts) {
    const key = canonicalKey(project, ctx, filePath);
    if (!key) continue;
    const loc: ReferenceLocation = {
      filePath,
      start: positionAt(starts, ctx.range.start),
      end: positionAt(starts, ctx.range.end),
      snippet: snippetAt(ctx.range.start),
    };
    // Category of the call-site, so insights can break the count down later.
    if (ctx.apiStyle) loc.via = ctx.apiStyle;
    out.push({ key, loc });
  }
  // A plain value that looks like a UID (a registry map, a config entry): a weak
  // reference (`via: 'literal'`) — counted, never rewritten by a refactor. Kept
  // apart and keyed by what the index holds now, so it follows definition changes.
  const literals: WeakLiteral[] = collectUnclassifiedUidLiterals(filePath, text).map((lit) => ({
    uid: lit.text,
    loc: { filePath, start: positionAt(starts, lit.start), end: positionAt(starts, lit.end), via: 'literal', snippet: snippetAt(lit.start) },
  }));
  // Method calls on a resolved service/controller (`…service('x').method()`).
  for (const m of collectMemberReferences(filePath, text)) {
    out.push({
      key: m.key,
      loc: { filePath, start: positionAt(starts, m.start), end: positionAt(starts, m.end), via: m.via, snippet: snippetAt(m.start) },
    });
  }
  // `this.method()` inside a service/controller → a self-reference to that method,
  // so a sibling-only method isn't mistaken for dead code. Guarded to real actions.
  const self = artifactDefinedInFile(project, filePath);
  if (self) {
    const actions = new Set((self.actions ?? []).map((a) => a.name));
    // Only `this.x()` bound to the artifact's OWN factory object — never a
    // nested object literal that has its own `this` (guards against over-count).
    const factory = factoryObjectRange(filePath, text);
    for (const t of collectThisMemberReferences(filePath, text)) {
      if (!actions.has(t.name)) continue;
      if (factory && t.ownerObjectStart !== factory.start) continue;
      out.push({
        key: `method:${self.ref}.${t.name}`,
        loc: { filePath, start: positionAt(starts, t.start), end: positionAt(starts, t.end), via: 'this', snippet: snippetAt(t.start) },
      });
    }
  }
  // Auto-CRUD route handlers implied by `createCoreRouter` — no explicit string,
  // so synthesize them as `method:<uid>.<action>` route references.
  for (const h of collectCoreRouterHandlers(filePath, text, project)) {
    out.push({
      key: `method:${h.uid}.${h.action}`,
      loc: { filePath, start: positionAt(starts, h.start), end: positionAt(starts, h.end), via: 'route', snippet: snippetAt(h.start) },
    });
  }
  // Relation-field usages (`populate`/`filters` by relation name) — only real
  // relation fields of the call's content-type, never a guessed key.
  for (const u of collectRelationFieldUsages(filePath, text, (uid) => relationFieldsOf(project, uid))) {
    out.push({
      key: `relation-field:${u.uid}.${u.field}`,
      loc: { filePath, start: positionAt(starts, u.start), end: positionAt(starts, u.end), via: 'relation-field', snippet: snippetAt(u.start), ...(u.shorthand ? { shorthand: true } : {}) },
    });
  }
  // Calls DevKit can't read the UID of: what may complete a result (see `unresolvedCallsOf`).
  for (const ctx of collectUnresolvedCalls(filePath, text)) {
    const loc: ReferenceLocation = { filePath, start: positionAt(starts, ctx.range.start), end: positionAt(starts, ctx.range.end), snippet: snippetAt(ctx.range.start) };
    if (ctx.apiStyle) loc.via = ctx.apiStyle;
    if (ctx.text) loc.scope = ctx.text;
    out.push({ key: `${UNRESOLVED_PREFIX}${ctx.kind}`, loc });
  }
  // A file loaded by its path: its module is used whatever its Strapi name (see `requirersOf`).
  for (const m of collectRelativeImports(filePath, text)) {
    const loc: ReferenceLocation = { filePath, start: positionAt(starts, m.start), end: positionAt(starts, m.end), via: 'require', snippet: snippetAt(m.start) };
    out.push({ key: `${MODULE_PREFIX}${resolveDots(join(dirname(filePath), m.spec)).toLowerCase()}`, loc });
  }
  if (isArchivedMigration(project, filePath)) {
    for (const r of out) r.loc.archived = true;
    for (const l of literals) l.loc.archived = true;
  }
  return { refs: out, literals };
}

/** Add `loc` under `key`. */
function addRef(refs: Map<string, ReferenceLocation[]>, key: string, loc: ReferenceLocation): void {
  const arr = refs.get(key);
  if (arr) arr.push(loc);
  else refs.set(key, [loc]);
}

/**
 * Re-key every weak literal of the project (`via: 'literal'`) by what the index
 * holds now: a UID that became an entity counts for it, one whose entity is gone
 * counts for nothing — the same answer a full build gives. Called after each batch
 * of changes, since a definition change doesn't re-read the files that name it.
 */
export function resyncWeakLiterals(project: StrapiProject): void {
  for (const [key, arr] of project.references) {
    if (!arr.some((l) => l.via === 'literal')) continue;
    const kept = arr.filter((l) => l.via !== 'literal');
    if (kept.length) project.references.set(key, kept);
    else project.references.delete(key);
  }
  for (const literals of project.weakLiterals?.values() ?? []) {
    for (const { uid, loc } of literals) for (const key of entityKeysOf(project, uid)) addRef(project.references, key, loc);
  }
}

/**
 * Key prefix of the Strapi calls whose UID DevKit can't read, by reference kind
 * (`unresolved:service-ref`) — not a reference to an entity: consumers walking
 * every key skip them ({@link isEntityKey}).
 */
export const UNRESOLVED_PREFIX = 'unresolved:';

/**
 * Key prefix of a relative `require`/`import` of a file, by the path it resolves
 * to (lower-cased, as written: no extension added) — not a reference to an
 * entity ({@link isEntityKey}); {@link requirersOf} reads them.
 */
export const MODULE_PREFIX = 'module:';

/** True for a reference key that points at an entity (not a call whose UID is unknown, nor a file loaded by its path). */
export function isEntityKey(key: string): boolean {
  return !key.startsWith(UNRESOLVED_PREFIX) && !key.startsWith(MODULE_PREFIX);
}

/** `a/./b/../c` → `a/c` (a path's `.` and `..` segments resolved; one above the root is kept). */
function resolveDots(p: string): string {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '.') continue;
    if (seg === '..' && out.length && out[out.length - 1] !== '..' && !/^[a-z]:$/i.test(out[out.length - 1]!) && out[out.length - 1] !== '') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

/**
 * The relative `require`s/`import`s that load `filePath` — by its path with or
 * without its extension, or its folder for an `index` file. A module loaded so
 * is used even when nothing calls its Strapi name. In a local plugin, the files
 * that register its artifacts (its server entry, its indexes: any file of the
 * plugin that isn't an artifact's own, or is an `index`) require them to register
 * them: not counted.
 */
export function requirersOf(project: StrapiProject, filePath: string): ReferenceLocation[] {
  const f = normalize(filePath).toLowerCase();
  const bare = join(dirname(f), stripExt(basename(f)));
  const forms = new Set([f, bare]);
  // TypeScript's ESM style names the compiled file: `import x from './x.js'` loads `x.ts`.
  const compiled: Record<string, string[]> = { '.ts': ['.js'], '.mts': ['.mjs', '.js'], '.cts': ['.cjs', '.js'] };
  for (const ext of compiled[extname(f)] ?? []) forms.add(`${bare}${ext}`);
  if (stripExt(basename(f)) === 'index' && extname(f) !== '.json') forms.add(dirname(f));
  const plugin = owningPluginName(project, filePath);
  const registers = (from: string): boolean =>
    plugin !== undefined && owningPluginName(project, from) === plugin && (stripExt(basename(from)) === 'index' || !isArtifactFile(project, from));
  // A test that loads it doesn't make it used.
  const test = (from: string): boolean => isTestPath(normalize(from));
  return [...forms].flatMap((p) => project.references.get(`${MODULE_PREFIX}${p}`) ?? []).filter((l) => !registers(l.filePath) && !test(l.filePath));
}

/** Is `filePath` the file of a service, a controller, a policy or a middleware? */
function isArtifactFile(project: StrapiProject, filePath: string): boolean {
  const idx = project.index;
  return [idx.services, idx.controllers, idx.policies, idx.middlewares].some((m) => [...m.values()].some((a) => sameFile(a.filePath, filePath)));
}

/** Strapi's migrations folder: it runs the `.js` files at its root, never a subfolder. */
function migrationsDir(project: StrapiProject): string {
  return join(project.root, 'database', 'migrations');
}

/** True for a file in a subfolder of `database/migrations` — kept, but never run by Strapi. */
export function isArchivedMigration(project: StrapiProject, filePath: string): boolean {
  const dir = migrationsDir(project) + '/';
  const f = normalize(filePath);
  return f.toLowerCase().startsWith(dir.toLowerCase()) && f.slice(dir.length).includes('/');
}

const PRUNE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', '.next', '.turbo', 'coverage']);
// Kept in sync with the indexer's code extensions (+ `.json` for schema refs)
// so a call-site is never missed just because of an unusual module extension.
const EXT = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.json'];

function isSourceFile(name: string): boolean {
  return EXT.some((e) => name.endsWith(e)) && !name.endsWith('.d.ts');
}

/** All source/JSON files under `dir`, pruning heavy directories. */
async function walkSourceFiles(fs: FileSystem, dir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readDirectory(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.type === FileType.Directory) {
        if (!PRUNE.has(e.name)) await visit(p);
      } else if (isSourceFile(e.name)) {
        out.push(p);
      }
    }
  };
  await visit(dir);
  return out;
}

/**
 * Canonical full ref for a bare or qualified policy/middleware reference, resolved
 * by owning scope (api → global → plugin) against the existing index entries.
 * Exported so the move planner resolves a bare `policies: ['is-owner']` to the
 * same target the index does (and can warn when it points at a moved artifact).
 */
export function scopedKey(
  map: Map<string, CodeArtifact>,
  ctx: ReferenceContext,
  filePath: string,
  project: StrapiProject,
): string {
  const text = ctx.text;
  if (ctx.pluginName && !text.includes('::')) return `plugin::${ctx.pluginName}.${text}`;
  if (text.includes('::')) return text;
  const api = owningApiName(project, filePath);
  if (api && map.has(`api::${api}.${text}`)) return `api::${api}.${text}`;
  if (map.has(`global::${text}`)) return `global::${text}`;
  const plugin = owningPluginName(project, filePath);
  if (plugin && map.has(`plugin::${plugin}.${text}`)) return `plugin::${plugin}.${text}`;
  return api ? `api::${api}.${text}` : `global::${text}`;
}

/**
 * Stable key identifying the *definition* a reference points to. Two call-sites
 * share a key iff they reference the same entity (kind-namespaced so a
 * content-type and a service with the same UID don't collide).
 */
export function canonicalKey(
  project: StrapiProject,
  ctx: ReferenceContext,
  filePath: string,
): string | undefined {
  switch (ctx.kind) {
    case 'content-type-uid':
      return `ct:${qualifyPluginRef(ctx.text, ctx.pluginName)}`;
    case 'component-uid':
      return `component:${ctx.text}`;
    case 'service-ref':
      return `service:${qualifyPluginRef(ctx.text, ctx.pluginName)}`;
    case 'plugin-service-ref':
      return ctx.pluginName ? `service:plugin::${ctx.pluginName}.${ctx.text}` : undefined;
    case 'controller-ref':
      return `controller:${qualifyPluginRef(ctx.text, ctx.pluginName)}`;
    case 'controller-action': {
      // Short-form handler ('controller.action', Strapi's documented custom-route
      // form) is scoped to the file's own api/plugin — qualify before parsing.
      // parseHandlerRef keeps a nested controller name intact (`api::foo.a.b`).
      const h = parseHandlerRef(qualifyRouteHandler(project, filePath, ctx.text));
      // Same key space as member calls → a method's refs include route handlers too.
      return h ? `method:${h.controllerRef}.${h.action}` : undefined;
    }
    case 'policy-ref':
      return `policy:${scopedKey(project.index.policies, ctx, filePath, project)}`;
    case 'middleware-ref':
      return `middleware:${scopedKey(project.index.middlewares, ctx, filePath, project)}`;
    case 'plugin-name':
      return `plugin:${ctx.text}`;
    default:
      return undefined;
  }
}

/** Scan every source file of a project and group call-sites by canonical key. */
export async function buildReferenceIndex(
  fs: FileSystem,
  project: StrapiProject,
): Promise<Map<string, ReferenceLocation[]>> {
  const refs = new Map<string, ReferenceLocation[]>();
  const literals = new Map<string, WeakLiteral[]>();
  // Walk src/ (where definitions live) plus the root config/ — the middleware
  // stack in config/middlewares references middlewares from outside src/ — and
  // the migrations Strapi runs (database/migrations; its subfolders as archived).
  const seen = new Set<string>();
  const files = [
    ...(await walkSourceFiles(fs, project.srcDir)),
    ...(await walkSourceFiles(fs, join(project.root, 'config'))),
    ...(await walkSourceFiles(fs, migrationsDir(project))),
  ];
  for (const filePath of files) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    let text: string;
    try {
      text = await fs.readFile(filePath);
    } catch {
      continue;
    }
    if (text.length > MAX_PARSE_CHARS) continue; // skip a pathologically huge file (DoS guard)
    const { refs: fileRefs, literals: fileLiterals } = collectFileReferences(project, filePath, text);
    for (const { key, loc } of fileRefs) addRef(refs, key, loc);
    if (fileLiterals.length) literals.set(normalize(filePath), fileLiterals);
  }
  // The weak literals, keyed by the index as it is now (re-keyed by `resyncWeakLiterals`).
  project.weakLiterals = literals;
  for (const fileLiterals of literals.values()) {
    for (const { uid, loc } of fileLiterals) for (const key of entityKeysOf(project, uid)) addRef(refs, key, loc);
  }
  return refs;
}

/** Drop every reference contributed by `filePath` from the index (and, given the project, its weak literals). */
export function removeReferencesForFile(
  references: Map<string, ReferenceLocation[]>,
  filePath: string,
  project?: StrapiProject,
): void {
  const f = normalize(filePath);
  for (const [key, arr] of references) {
    const kept = arr.filter((r) => normalize(r.filePath) !== f);
    if (kept.length) references.set(key, kept);
    else references.delete(key);
  }
  project?.weakLiterals?.delete(f);
}

/**
 * Incrementally re-index a single changed file: drop its old entries, add the
 * new ones. Avoids re-walking the whole project on every save.
 */
export function updateReferencesForFile(
  project: StrapiProject,
  filePath: string,
  text: string,
): void {
  removeReferencesForFile(project.references, filePath, project);
  const { refs, literals } = collectFileReferences(project, normalize(filePath), text);
  for (const { key, loc } of refs) addRef(project.references, key, loc);
  if (literals.length) (project.weakLiterals ??= new Map()).set(normalize(filePath), literals);
  for (const { uid, loc } of literals) for (const key of entityKeysOf(project, uid)) addRef(project.references, key, loc);
}

export interface DefinitionAnchor {
  key: string;
  /** Char offset to anchor a CodeLens on. */
  offset: number;
}

function sameFile(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

/** Definitions declared in `filePath` (for CodeLens and find-from-definition). */
export function definitionsInFile(project: StrapiProject, filePath: string): DefinitionAnchor[] {
  const f = normalize(filePath);
  const out: DefinitionAnchor[] = [];
  for (const ct of project.index.contentTypes.values()) {
    if (sameFile(ct.schemaPath, f)) out.push({ key: `ct:${ct.uid}`, offset: ct.defOffset ?? 0 });
  }
  for (const c of project.index.components.values()) {
    if (sameFile(c.jsonPath, f)) out.push({ key: `component:${c.uid}`, offset: c.defOffset ?? 0 });
  }
  for (const s of project.index.services.values()) {
    if (!sameFile(s.filePath, f)) continue;
    out.push({ key: `service:${s.ref}`, offset: s.defOffset ?? 0 });
    for (const a of s.actions ?? []) out.push({ key: `method:${s.ref}.${a.name}`, offset: a.offset });
  }
  for (const c of project.index.controllers.values()) {
    if (!sameFile(c.filePath, f)) continue;
    out.push({ key: `controller:${c.ref}`, offset: c.defOffset ?? 0 });
    for (const a of c.actions ?? []) out.push({ key: `method:${c.ref}.${a.name}`, offset: a.offset });
  }
  for (const p of project.index.policies.values()) {
    if (sameFile(p.filePath, f)) out.push({ key: `policy:${p.ref}`, offset: p.defOffset ?? 0 });
  }
  for (const m of project.index.middlewares.values()) {
    if (sameFile(m.filePath, f)) out.push({ key: `middleware:${m.ref}`, offset: m.defOffset ?? 0 });
  }
  return out;
}
