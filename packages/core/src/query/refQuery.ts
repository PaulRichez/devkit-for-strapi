/**
 * Ref-keyed query API: answer questions about a Strapi project keyed by a bare
 * UID / magic string (not a cursor position). This is the surface an MCP server
 * (or a future LSP) exposes — the engine's other entry points are position-based
 * (filePath + offset), which suits an editor but not an agent asking
 * "what is `api::page.page`?". All functions are pure over one `StrapiProject`.
 */

import { normalize } from '../fs/paths';
import { autoCrudActions } from '../model/constants';
import type {
  ArtifactKind,
  AttributeInfo,
  CodeArtifact,
  ReferenceLocation,
  StrapiProject,
} from '../model/types';
import { isFrameworkRef, parseAddress, parseHandlerRef, parseRef } from '../model/uid';
import { closest } from '../util/levenshtein';

export interface ContentTypeSummary {
  uid: string;
  kind: 'collectionType' | 'singleType';
  displayName: string;
  schemaPath: string;
}

export interface ComponentSummary {
  uid: string;
  displayName: string;
  jsonPath: string;
}

export interface ArtifactSummary {
  ref: string;
  kind: ArtifactKind;
  scope: string;
  name: string;
  filePath: string;
  /** Custom method names (services/controllers), if any. */
  methods?: string[];
}

export interface SchemaAttribute {
  name: string;
  type: string;
  /** Relation target UID. */
  target?: string;
  /** Component UID (`type: 'component'`). */
  component?: string;
  /** Component UIDs (`type: 'dynamiczone'`). */
  components?: string[];
}

export interface SchemaInfo {
  uid: string;
  kind: 'collectionType' | 'singleType' | 'component';
  displayName: string;
  attributes: SchemaAttribute[];
  /** True for a `src/extensions/…` schema: a merge overlay over the plugin's
   * original (unindexed) schema — the attributes listed are the extension's own. */
  extension?: boolean;
}

export type TargetKind = 'content-type' | 'component' | ArtifactKind;

export interface ResolvedTarget {
  kind: TargetKind;
  filePath: string;
  offset?: number;
}

export type ValidationStatus = 'valid' | 'unknown' | 'external';

export interface ValidationResult {
  status: ValidationStatus;
  /** Kinds the ref resolves to (a UID can be both a content-type and a service). */
  kinds: TargetKind[];
  /** Nearest known reference, only when `status === 'unknown'`. */
  didYouMean?: string;
}

const artifactMaps = (p: StrapiProject): Record<ArtifactKind, Map<string, CodeArtifact>> => ({
  service: p.index.services,
  controller: p.index.controllers,
  policy: p.index.policies,
  middleware: p.index.middlewares,
});

const ARTIFACT_KINDS: ArtifactKind[] = ['service', 'controller', 'policy', 'middleware'];

function attrsOf(attributes: Record<string, AttributeInfo>): SchemaAttribute[] {
  return Object.values(attributes).map((a) => ({
    name: a.name,
    type: a.type,
    ...(a.target ? { target: a.target } : {}),
    ...(a.component ? { component: a.component } : {}),
    ...(a.components ? { components: a.components } : {}),
  }));
}

/** Every content-type UID of the project (the real ones, for F1 autocomplete). */
export function listContentTypes(project: StrapiProject): ContentTypeSummary[] {
  return [...project.index.contentTypes.values()].map((ct) => ({
    uid: ct.uid,
    kind: ct.kind,
    displayName: ct.info.displayName ?? ct.ctName,
    schemaPath: ct.schemaPath,
  }));
}

export function listComponents(project: StrapiProject): ComponentSummary[] {
  return [...project.index.components.values()].map((c) => ({
    uid: c.uid,
    displayName: c.info.displayName ?? c.name,
    jsonPath: c.jsonPath,
  }));
}

/** Services / controllers / policies / middlewares (optionally one kind). */
export function listArtifacts(project: StrapiProject, kind?: ArtifactKind): ArtifactSummary[] {
  const maps = artifactMaps(project);
  const kinds = kind ? [kind] : ARTIFACT_KINDS;
  const out: ArtifactSummary[] = [];
  for (const k of kinds) {
    for (const a of maps[k].values()) {
      out.push({
        ref: a.ref,
        kind: a.kind,
        scope: a.scope,
        name: a.name,
        filePath: a.filePath,
        ...(a.actions?.length ? { methods: a.actions.map((x) => x.name) } : {}),
      });
    }
  }
  return out;
}

/** The real attributes/relations of a content-type or component UID (F1). */
export function getSchema(project: StrapiProject, uid: string): SchemaInfo | undefined {
  const ct = project.index.contentTypes.get(uid);
  if (ct) {
    return {
      uid: ct.uid,
      kind: ct.kind,
      displayName: ct.info.displayName ?? ct.ctName,
      attributes: attrsOf(ct.attributes),
      ...(ct.extension ? { extension: true } : {}),
    };
  }
  const comp = project.index.components.get(uid);
  if (comp) {
    return {
      uid: comp.uid,
      kind: 'component',
      displayName: comp.info.displayName ?? comp.name,
      attributes: attrsOf(comp.attributes),
    };
  }
  return undefined;
}

/** Service/controller method (`api::x.y#method`) → its declaration, tagged by kind. */
function resolveMethod(project: StrapiProject, ref: string, method: string): ResolvedTarget[] {
  const out: ResolvedTarget[] = [];
  const svc = project.index.services.get(ref);
  const svcAction = svc?.actions?.find((a) => a.name === method);
  if (svc && svcAction) out.push({ kind: 'service', filePath: svc.filePath, offset: svcAction.offset });
  const ctrl = project.index.controllers.get(ref);
  const ctrlAction = ctrl?.actions?.find((a) => a.name === method);
  if (ctrl && ctrlAction) out.push({ kind: 'controller', filePath: ctrl.filePath, offset: ctrlAction.offset });
  // Schema-only content-type: an api CT's core action (by kind) is served by the
  // auto-generated controller. A plugin CT / singleType findOne|create → no target.
  const ct = !out.length ? project.index.contentTypes.get(ref) : undefined;
  if (ct && autoCrudActions(ct).has(method)) {
    out.push({ kind: 'controller', filePath: ct.schemaPath, offset: ct.defOffset });
  }
  return out;
}

/** Resolve a fully-qualified ref (or `ref#method`) to its defining file(s), tagged by kind (F3). */
export function resolveRef(project: StrapiProject, address: string): ResolvedTarget[] {
  const { ref, method } = parseAddress(address);
  if (method) return resolveMethod(project, ref, method);
  const out: ResolvedTarget[] = [];
  const ct = project.index.contentTypes.get(ref);
  if (ct) out.push({ kind: 'content-type', filePath: ct.schemaPath, offset: ct.defOffset });
  const comp = project.index.components.get(ref);
  if (comp) out.push({ kind: 'component', filePath: comp.jsonPath, offset: comp.defOffset });
  const maps = artifactMaps(project);
  for (const k of ARTIFACT_KINDS) {
    const a = maps[k].get(ref);
    if (a) out.push({ kind: k, filePath: a.filePath, offset: a.defOffset });
  }
  // Route-handler form `api::x.y.find` → the action method in the controller.
  // parseHandlerRef: the action is the LAST segment, so a nested controller
  // (`api::x.a.b.find`) isn't misread as controller `a` + action `b`. Only
  // consulted when the whole ref didn't already resolve as an entity.
  const handler = out.length === 0 ? parseHandlerRef(ref) : null;
  if (handler) {
    const controller = project.index.controllers.get(handler.controllerRef);
    if (controller) {
      const action = controller.actions?.find((x) => x.name === handler.action);
      out.push({ kind: 'controller', filePath: controller.filePath, offset: action?.offset });
    } else {
      // Schema-only content-type → an api CT's core action (by kind) resolves to the
      // auto-generated controller. Plugin CTs / singleType findOne|create → no target.
      const ct = project.index.contentTypes.get(handler.controllerRef);
      if (ct && autoCrudActions(ct).has(handler.action)) {
        out.push({ kind: 'controller', filePath: ct.schemaPath, offset: ct.defOffset });
      }
    }
  }
  return out;
}

function* entityRefKeys(project: StrapiProject): Iterable<string> {
  yield* project.index.contentTypes.keys();
  yield* project.index.services.keys();
  yield* project.index.controllers.keys();
  yield* project.index.policies.keys();
  yield* project.index.middlewares.keys();
}

/**
 * Is `address` a real reference in this project? (F2 — the agent self-checks
 * before writing.) Accepts `ref` or `ref#method`. *Garantir, ne pas deviner*: a
 * ref to a plugin **not in the workspace** can't be verified → `status:
 * 'external'` (never a false "unknown").
 */
export function validateRef(project: StrapiProject, address: string): ValidationResult {
  const { ref, method } = parseAddress(address);
  // Framework built-in (`admin::user`, `strapi::core-store`) — real but outside
  // the workspace, so unverifiable → `external`, never a false `unknown`.
  if (isFrameworkRef(ref)) return { status: 'external', kinds: [] };
  // Local resolution wins over the external classification: an extension schema
  // (`src/extensions/…` → e.g. plugin::users-permissions.user) IS indexed even
  // though its plugin isn't local — it must answer `valid`, not `external`.
  const targets = resolveRef(project, address);
  if (targets.length) {
    return { status: 'valid', kinds: [...new Set(targets.map((t) => t.kind))] };
  }
  const parsed = parseRef(ref);
  if (parsed && parsed.namespace === 'plugin' && !project.index.pluginNames.has(parsed.scope)) {
    return { status: 'external', kinds: [] };
  }
  // A method address only ever resolves to a service/controller action.
  if (method) {
    const pool = [...resolveRef(project, ref).flatMap((t) => methodNames(project, ref, t.kind))];
    const didYouMean = closest(method, pool);
    return didYouMean ? { status: 'unknown', kinds: [], didYouMean } : { status: 'unknown', kinds: [] };
  }
  const pool = ref.includes('::') ? entityRefKeys(project) : project.index.components.keys();
  const didYouMean = closest(ref, pool);
  return didYouMean ? { status: 'unknown', kinds: [], didYouMean } : { status: 'unknown', kinds: [] };
}

/** Method names declared on the service/controller backing `ref` (for did-you-mean). */
function methodNames(project: StrapiProject, ref: string, kind: TargetKind): string[] {
  const map = kind === 'service' ? project.index.services : kind === 'controller' ? project.index.controllers : undefined;
  return map?.get(ref)?.actions?.map((a) => a.name) ?? [];
}

export interface CallFormCoverage {
  /** The `via` tag emitted for this form (matches `ReferenceLocation.via`). */
  via: string;
  /** What the form references. */
  references: 'content-type' | 'component' | 'service' | 'controller' | 'policy' | 'middleware' | 'plugin';
  /** A representative call-site. */
  example: string;
  /** Whether this form is actually indexed (so an agent never assumes false completeness). */
  indexed: boolean;
}

/**
 * The call forms the engine indexes (and the notable ones it does *not* yet),
 * so an agent can self-check coverage instead of assuming completeness. Static
 * knowledge — independent of any project. *Garantir, ne pas deviner*: forms that
 * aren't indexed are listed with `indexed: false`, never silently omitted.
 */
export function callFormCoverage(): CallFormCoverage[] {
  return [
    { via: 'service', references: 'service', example: "strapi.service('api::x.y')", indexed: true },
    { via: 'controller', references: 'controller', example: "strapi.controller('api::x.y')", indexed: true },
    { via: 'plugin', references: 'service', example: "strapi.plugin('a').service('b')", indexed: true },
    { via: 'entityService', references: 'content-type', example: "strapi.entityService.findMany('api::x.y')", indexed: true },
    { via: 'documents', references: 'content-type', example: "strapi.documents('api::x.y')", indexed: true },
    { via: 'db.query', references: 'content-type', example: "strapi.db.query('api::x.y')", indexed: true },
    { via: 'query', references: 'content-type', example: "strapi.query('api::x.y')", indexed: true },
    { via: 'contentType', references: 'content-type', example: "strapi.contentType('api::x.y')", indexed: true },
    { via: 'getModel', references: 'content-type', example: "strapi.getModel('api::x.y')", indexed: true },
    { via: 'factory', references: 'content-type', example: "createCoreService('api::x.y')", indexed: true },
    { via: 'route', references: 'controller', example: "{ handler: 'api::x.y.find' } + createCoreRouter auto-CRUD", indexed: true },
    { via: 'member', references: 'service', example: "strapi.service('api::x.y').method()", indexed: true },
    { via: 'member-var', references: 'service', example: "const e = strapi.service('api::x.y'); e.method()", indexed: true },
    { via: 'this', references: 'service', example: 'this.method() inside a service/controller', indexed: true },
    { via: 'schema', references: 'content-type', example: 'schema.json relation `target` / component link', indexed: true },
    { via: 'config', references: 'middleware', example: "config/middlewares stack: ['global::x']", indexed: true },
    // Top-level populate/filters by relation field name (nested populate trees: not yet).
    { via: 'relation-field', references: 'content-type', example: 'populate: { author } / filters: { author: … }', indexed: true },
  ];
}

export interface RelationFieldUsage {
  field: string;
  locations: ReferenceLocation[];
}

/**
 * Where a content-type's relation fields are used by name in queries
 * (`populate`/`filters`). With `field`, just that field; otherwise every relation
 * field that has usages. Reads the `relation-field:<uid>.<field>` index (J4).
 */
export function relationUsagesOf(project: StrapiProject, uid: string, field?: string): RelationFieldUsage[] {
  const prefix = `relation-field:${uid}.`;
  if (field) return [{ field, locations: project.references.get(`${prefix}${field}`) ?? [] }];
  const out: RelationFieldUsage[] = [];
  for (const [key, locations] of project.references) {
    if (key.startsWith(prefix)) out.push({ field: key.slice(prefix.length), locations });
  }
  return out.sort((a, b) => a.field.localeCompare(b.field));
}

/** Every call-site that references `address` (`ref` or `ref#method`), across all kinds (F4). */
export function referencesOf(project: StrapiProject, address: string): ReferenceLocation[] {
  const { ref, method } = parseAddress(address);
  // A method address targets only that method's call-sites + route handlers.
  const keys = method
    ? [`method:${ref}.${method}`]
    : [`ct:${ref}`, `component:${ref}`, `service:${ref}`, `controller:${ref}`, `policy:${ref}`, `middleware:${ref}`, `plugin:${ref}`];
  // Handler form (`api::x.y.find`, incl. a nested controller `api::x.a.b.find`):
  // parseHandlerRef keeps the key aligned with canonicalKey's `method:` keys.
  if (!method && parseHandlerRef(ref)) {
    keys.push(`method:${ref}`);
  }

  const seen = new Set<string>();
  const out: ReferenceLocation[] = [];
  for (const key of keys) {
    for (const loc of project.references.get(key) ?? []) {
      const id = `${loc.filePath}:${loc.start.line}:${loc.start.character}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push(loc);
      }
    }
  }
  return out;
}

export interface BrokenRef {
  ref: string;
  kind: TargetKind;
  locations: ReferenceLocation[];
}

/**
 * Magic strings that point at **nothing** — the inverse of {@link listUnused}, and
 * the safety net after a move/rename (target should be 0). *Garantir, ne pas
 * deviner*: skips refs to plugins **outside** the workspace (unverifiable) and
 * `plugin:`/`relation-field:` keys (external/field noise); treats a resource
 * service/controller implied by a content-type as valid. For `method:<uid>.<action>`
 * keys (route handlers / member calls) it checks only that the owning **entity**
 * (`<uid>`) still exists — never the action itself, so a dynamic/spread method is
 * never a false positive — which catches a stale handler after a move (entity gone).
 */
export function listBrokenRefs(project: StrapiProject): BrokenRef[] {
  const idx = project.index;
  /** Entity uid behind a `method:` key (`api::x.y.find` → `api::x.y`) — the
   * action is the LAST segment (parseHandlerRef), so a nested controller's
   * handler (`api::x.a.b.find` → entity `api::x.a.b`) is never a false broken. */
  const methodEntityExists = (r: string): boolean => {
    const h = parseHandlerRef(r);
    if (!h) return true; // unparseable → don't flag (conservative)
    const uid = h.controllerRef;
    return idx.controllers.has(uid) || idx.services.has(uid) || idx.contentTypes.has(uid);
  };
  const checks: Array<{ prefix: string; kind: TargetKind; has: (ref: string) => boolean }> = [
    { prefix: 'ct:', kind: 'content-type', has: (r) => idx.contentTypes.has(r) },
    { prefix: 'component:', kind: 'component', has: (r) => idx.components.has(r) },
    { prefix: 'service:', kind: 'service', has: (r) => idx.services.has(r) || idx.contentTypes.has(r) },
    { prefix: 'controller:', kind: 'controller', has: (r) => idx.controllers.has(r) || idx.contentTypes.has(r) },
    { prefix: 'policy:', kind: 'policy', has: (r) => idx.policies.has(r) },
    { prefix: 'middleware:', kind: 'middleware', has: (r) => idx.middlewares.has(r) },
    { prefix: 'method:', kind: 'controller', has: methodEntityExists },
  ];
  const out: BrokenRef[] = [];
  for (const [key, locations] of project.references) {
    if (!locations.length) continue;
    const c = checks.find((x) => key.startsWith(x.prefix));
    if (!c) continue;
    const ref = key.slice(c.prefix.length);
    if (isFrameworkRef(ref)) continue; // framework built-in (admin::/strapi::) — unverifiable
    const parsed = parseRef(ref);
    if (parsed && parsed.namespace === 'plugin' && !idx.pluginNames.has(parsed.scope)) continue; // external
    if (c.has(ref)) continue; // resolves → fine
    out.push({ ref, kind: c.kind, locations });
  }
  return out;
}

export type UnusedKind = 'method' | 'content-type' | 'component' | 'service' | 'policy' | 'middleware';

export interface UnusedItem {
  kind: UnusedKind;
  /** `method` → `api::x.y.name` ; otherwise the entity's uid/ref. */
  ref: string;
  filePath: string;
  /** Char offset of the definition / method name. */
  offset: number;
}

const DEFAULT_UNUSED_KINDS: UnusedKind[] = ['method', 'content-type', 'component', 'service', 'policy', 'middleware'];

/**
 * Definitions with **0 Strapi references** — likely dead code (the agent-facing
 * version of the Model Explorer's Issues, extended to methods). *Garantir, ne
 * pas deviner*: "unused" counts Strapi call-sites + route handlers only; a method
 * called **directly in TS** still shows here, so verify before deleting. Pure /
 * static — needs the reference index (`whenReferencesReady`) built.
 */
export function listUnused(project: StrapiProject, opts?: { kinds?: UnusedKind[]; file?: string }): UnusedItem[] {
  const kinds = new Set(opts?.kinds ?? DEFAULT_UNUSED_KINDS);
  const file = opts?.file ? normalize(opts.file).toLowerCase() : undefined;
  const inFile = (p: string): boolean => !file || normalize(p).toLowerCase() === file;
  const unused = (key: string): boolean => (project.references.get(key) ?? []).length === 0;
  const out: UnusedItem[] = [];

  if (kinds.has('method')) {
    for (const map of [project.index.services, project.index.controllers]) {
      for (const a of map.values()) {
        if (!inFile(a.filePath)) continue;
        for (const action of a.actions ?? []) {
          if (unused(`method:${a.ref}.${action.name}`)) {
            out.push({ kind: 'method', ref: `${a.ref}.${action.name}`, filePath: a.filePath, offset: action.offset });
          }
        }
      }
    }
  }
  if (kinds.has('content-type')) {
    for (const ct of project.index.contentTypes.values()) {
      if (inFile(ct.schemaPath) && unused(`ct:${ct.uid}`)) {
        out.push({ kind: 'content-type', ref: ct.uid, filePath: ct.schemaPath, offset: ct.defOffset ?? 0 });
      }
    }
  }
  if (kinds.has('component')) {
    for (const c of project.index.components.values()) {
      if (inFile(c.jsonPath) && unused(`component:${c.uid}`)) {
        out.push({ kind: 'component', ref: c.uid, filePath: c.jsonPath, offset: c.defOffset ?? 0 });
      }
    }
  }
  if (kinds.has('service')) {
    for (const s of project.index.services.values()) {
      // A *resource* service (one backing a content-type) is wired by the
      // framework's auto-CRUD even with no explicit `strapi.service()` call —
      // only a *standalone* custom service with 0 refs is genuinely dead.
      if (inFile(s.filePath) && !project.index.contentTypes.has(s.ref) && unused(`service:${s.ref}`)) {
        out.push({ kind: 'service', ref: s.ref, filePath: s.filePath, offset: s.defOffset ?? 0 });
      }
    }
  }
  if (kinds.has('policy')) {
    for (const p of project.index.policies.values()) {
      if (inFile(p.filePath) && unused(`policy:${p.ref}`)) {
        out.push({ kind: 'policy', ref: p.ref, filePath: p.filePath, offset: p.defOffset ?? 0 });
      }
    }
  }
  if (kinds.has('middleware')) {
    for (const m of project.index.middlewares.values()) {
      if (inFile(m.filePath) && unused(`middleware:${m.ref}`)) {
        out.push({ kind: 'middleware', ref: m.ref, filePath: m.filePath, offset: m.defOffset ?? 0 });
      }
    }
  }
  return out;
}
