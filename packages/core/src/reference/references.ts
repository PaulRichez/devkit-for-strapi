import { collectReferences } from '../analyze/callSite';
import { collectMemberReferences, collectThisMemberReferences } from '../analyze/memberRefs';
import { MAX_PARSE_CHARS } from '../analyze/parse';
import { collectRelationFieldUsages } from '../analyze/relationUsage';
import { type FileSystem, FileType } from '../fs/FileSystem';
import { join, normalize } from '../fs/paths';
import { factoryObjectRange } from '../index/actions';
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

/** Relation field names of a content-type — the guardrail for relation-field usage detection. */
function relationFieldsOf(project: StrapiProject, uid: string): Set<string> | undefined {
  const ct = project.index.contentTypes.get(uid);
  if (!ct) return undefined;
  const out = new Set<string>();
  for (const a of Object.values(ct.attributes)) if (a.type === 'relation') out.add(a.name);
  return out;
}

/** Collect this file's references as line/character locations (no editor needed later). */
function collectFileReferences(
  project: StrapiProject,
  filePath: string,
  text: string,
): Array<{ key: string; loc: ReferenceLocation }> {
  const starts = lineStarts(text);
  /** The trimmed source line at a char offset (so callers needn't re-read the file). */
  const snippetAt = (offset: number): string => {
    const line = positionAt(starts, offset).line;
    const from = starts[line] ?? 0;
    const to = starts[line + 1] ?? text.length;
    return text.slice(from, to).replace(/\r?\n$/, '').trim();
  };
  const out: Array<{ key: string; loc: ReferenceLocation }> = [];
  for (const ctx of collectReferences(filePath, text)) {
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
      loc: { filePath, start: positionAt(starts, u.start), end: positionAt(starts, u.end), via: 'relation-field', snippet: snippetAt(u.start) },
    });
  }
  return out;
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
  // Walk src/ (where definitions live) plus the root config/ — the middleware
  // stack in config/middlewares references middlewares from outside src/.
  const seen = new Set<string>();
  const files = [
    ...(await walkSourceFiles(fs, project.srcDir)),
    ...(await walkSourceFiles(fs, join(project.root, 'config'))),
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
    for (const { key, loc } of collectFileReferences(project, filePath, text)) {
      const arr = refs.get(key);
      if (arr) arr.push(loc);
      else refs.set(key, [loc]);
    }
  }
  return refs;
}

/** Drop every reference contributed by `filePath` from the index. */
export function removeReferencesForFile(
  references: Map<string, ReferenceLocation[]>,
  filePath: string,
): void {
  const f = normalize(filePath);
  for (const [key, arr] of references) {
    const kept = arr.filter((r) => normalize(r.filePath) !== f);
    if (kept.length) references.set(key, kept);
    else references.delete(key);
  }
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
  removeReferencesForFile(project.references, filePath);
  for (const { key, loc } of collectFileReferences(project, normalize(filePath), text)) {
    const arr = project.references.get(key);
    if (arr) arr.push(loc);
    else project.references.set(key, [loc]);
  }
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
