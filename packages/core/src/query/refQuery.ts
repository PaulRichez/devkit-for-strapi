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
  ReferenceKind,
  ReferenceLocation,
  StrapiProject,
} from '../model/types';
import { UNRESOLVED_PREFIX } from '../reference/references';
import { isFrameworkRef, parseAddress, parseHandlerRef } from '../model/uid';
import { lookupContentType } from '../index/codeContentTypes';
import { closest } from '../util/levenshtein';
import { isUnverifiable, loaderNameOf, refStatus, type StatusKind } from '../validate/refStatus';

export interface ContentTypeSummary {
  uid: string;
  kind: 'collectionType' | 'singleType';
  displayName: string;
  schemaPath: string;
  /** Defined by an installed plugin in node_modules (not the project's code). */
  installed?: true;
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
  /** Defined by an installed plugin in node_modules (not the project's code). */
  installed?: true;
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
    ...(ct.installed ? { installed: true as const } : {}),
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
        ...(a.installed ? { installed: true as const } : {}),
      });
    }
  }
  return out;
}

/** The real attributes/relations of a content-type or component UID (F1). */
export function getSchema(project: StrapiProject, uid: string): SchemaInfo | undefined {
  const ct = lookupContentType(project.index, uid);
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
  const ct = lookupContentType(project.index, ref);
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

/** Every kind {@link validateRef} checks a ref without a kind against. */
const ANY_KIND: StatusKind[] = ['content-type', 'component', 'service', 'controller', 'policy', 'middleware', 'method'];

/**
 * Is `address` a real reference in this project? (F2 — the agent self-checks
 * before writing.) Accepts `ref` or `ref#method`; `kind` narrows the check to
 * one kind (what {@link listBrokenRefs} reports). *Garantir, ne pas deviner*: a
 * ref DevKit can't verify (a plugin not in the workspace, a registry it couldn't
 * read whole, a framework built-in) → `status: 'external'`, never a false
 * "unknown" — the verdict is {@link refStatus}, shared with the diagnostics.
 */
export function validateRef(project: StrapiProject, address: string, kind?: StatusKind): ValidationResult {
  const { ref, method } = parseAddress(address);
  if (kind && !method) {
    // The handler form names its entity before the last dot.
    const handler = kind === 'method' ? parseHandlerRef(ref) : null;
    const status = refStatus(project, kind, handler?.controllerRef ?? ref);
    if (status !== 'unknown') return { status, kinds: status === 'valid' && kind !== 'method' ? [kind] : [] };
    if (handler) {
      // Suggest the entity, keeping the action (never a ref that drops it).
      const idx = project.index;
      const entities = { has: (k: string) => idx.controllers.has(k) || idx.services.has(k) || idx.contentTypes.has(k) };
      const pool = [...idx.controllers.keys(), ...idx.services.keys(), ...idx.contentTypes.keys()];
      const entity = loaderNameOf(handler.controllerRef, entities) ?? closest(handler.controllerRef, pool);
      return entity ? { status: 'unknown', kinds: [], didYouMean: `${entity}.${handler.action}` } : { status: 'unknown', kinds: [] };
    }
  } else {
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
    const entity = method ? ref : (parseHandlerRef(ref)?.controllerRef ?? ref);
    if (ANY_KIND.some((k) => isUnverifiable(project, k, k === 'method' ? entity : ref))) return { status: 'external', kinds: [] };
  }
  // A method address only ever resolves to a service/controller action.
  if (method) {
    const pool = [...resolveRef(project, ref).flatMap((t) => methodNames(project, ref, t.kind))];
    const didYouMean = closest(method, pool);
    return didYouMean ? { status: 'unknown', kinds: [], didYouMean } : { status: 'unknown', kinds: [] };
  }
  const pool = ref.includes('::') ? entityRefKeys(project) : project.index.components.keys();
  const idx = project.index;
  const known = { has: (k: string) => [idx.contentTypes, idx.services, idx.controllers, idx.policies, idx.middlewares].some((m) => m.has(k)) };
  const didYouMean = loaderNameOf(ref, known) ?? closest(ref, pool);
  return didYouMean ? { status: 'unknown', kinds: [], didYouMean } : { status: 'unknown', kinds: [] };
}

/** Method names declared on the service/controller backing `ref` (for did-you-mean). */
function methodNames(project: StrapiProject, ref: string, kind: TargetKind): string[] {
  const map = kind === 'service' ? project.index.services : kind === 'controller' ? project.index.controllers : undefined;
  return map?.get(ref)?.actions?.map((a) => a.name) ?? [];
}

export interface CallFormCoverage {
  /** The `via` tag emitted for this form (matches `ReferenceLocation.via`); `-` for a form not indexed. */
  via: string;
  /** What the form references. */
  references: 'content-type' | 'component' | 'service' | 'controller' | 'policy' | 'middleware' | 'plugin' | 'any';
  /** A representative call-site. */
  example: string;
  /** Whether this form is actually indexed (so an agent never assumes false completeness). */
  indexed: boolean;
  /** How the form is counted, or why it isn't. */
  note?: string;
}

/**
 * The call forms the engine indexes (and the notable ones it does *not* yet),
 * so an agent can self-check coverage instead of assuming completeness. Static
 * knowledge — independent of any project. *Garantir, ne pas deviner*: forms that
 * aren't indexed are listed with `indexed: false`, never silently omitted; the
 * calls of a project that fall in them are {@link unresolvedCallsOf}.
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
    { via: 'route', references: 'middleware', example: "config: { middlewares: ['api::x.y', { name: 'api::x.z', config: {} }] } (policies alike)", indexed: true },
    { via: 'member', references: 'service', example: "strapi.service('api::x.y').method()", indexed: true },
    { via: 'member-var', references: 'service', example: "const e = strapi.service('api::x.y'); e.method()", indexed: true },
    { via: 'this', references: 'service', example: 'this.method() inside a service/controller', indexed: true },
    { via: 'schema', references: 'content-type', example: 'schema.json relation `target` / component link', indexed: true },
    { via: 'config', references: 'middleware', example: "config/middlewares stack: ['global::x']", indexed: true },
    {
      via: 'relation-field',
      references: 'content-type',
      example: "populate: { author: { populate: { avatar: true } } } / populate: ['author.avatar'] / filters: { author: { name: … } } / where",
      indexed: true,
      note: "nested levels are followed through each relation's target",
    },
    {
      via: "(the call's)",
      references: 'any',
      example: "const UID = 'api::x.y'; strapi.db.query(UID)",
      indexed: true,
      note: 'a const initialised with a string literal, in scope in the same file: counted at the call, renamed at the literal',
    },
    {
      via: 'literal',
      references: 'any',
      example: "{ adapters: { a: 'plugin::x.a-adapter' } } / const TARGETS = { foo: 'api::x.y' }",
      indexed: true,
      note: 'a string equal to a known UID that no Strapi call receives directly: a weak reference — counted, never rewritten by a refactor (the plan says so)',
    },
    {
      via: "(the call's)",
      references: 'any',
      example: 'database/migrations/<date>.<name>.js',
      indexed: true,
      note: 'Strapi runs the files at the root only; a subfolder is archived: its references are listed (archived: true) but make nothing used',
    },
    { via: '-', references: 'any', example: "const { UID } = require('./uids'); strapi.db.query(UID)", indexed: false, note: 'a constant from another module is not followed' },
    {
      via: '-',
      references: 'any',
      example: 'strapi.service(`api::${name}.${name}`) / let uid = …; strapi.service(uid)',
      indexed: false,
      note: 'a UID built at runtime, a let, a parameter: such calls are listed by find_references / list_unused as `unresolvedCalls`',
    },
    {
      via: '-',
      references: 'service',
      example: "const getService = (name) => strapi.plugin('p').service(name); getService('x').run()",
      indexed: false,
      note: 'a helper wrapping a Strapi call: its inner call is an unresolved call',
    },
    { via: '-', references: 'service', example: "const { run } = strapi.service('api::x.y'); run()", indexed: false, note: 'a method taken by destructuring' },
  ];
}

/** The reference kinds a Strapi call of each target kind is classified under. */
const CALL_KINDS: Record<TargetKind | 'method', ReferenceKind[]> = {
  'content-type': ['content-type-uid'],
  component: ['component-uid', 'content-type-uid'],
  service: ['service-ref', 'plugin-service-ref'],
  controller: ['controller-ref', 'controller-action'],
  policy: ['policy-ref'],
  middleware: ['middleware-ref'],
  method: ['service-ref', 'plugin-service-ref', 'controller-ref'],
};

/**
 * The Strapi calls of the project whose UID DevKit can't read (`strapi.service(uid)`
 * with `uid` a parameter, a template, an import…) and that could reach a target of
 * one of `kinds` — what may complete a find-references or an unused list. Archived
 * migrations aside.
 */
export function unresolvedCallsOf(project: StrapiProject, kinds: Array<TargetKind | 'method'>): ReferenceLocation[] {
  const out: ReferenceLocation[] = [];
  for (const rk of new Set(kinds.flatMap((k) => CALL_KINDS[k]))) {
    for (const loc of project.references.get(`${UNRESOLVED_PREFIX}${rk}`) ?? []) if (!loc.archived) out.push(loc);
  }
  return out;
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
  /** The entity ref, or for a `method` entry the handler form (`api::x.y.run`). */
  ref: string;
  /** `method`: a route handler or member call whose service/controller exists nowhere. */
  kind: TargetKind | 'method';
  locations: ReferenceLocation[];
  /** Calls to methods of this broken entity (`strapi.service('x').run()`), grouped under it. */
  methods?: Array<{ name: string; locations: ReferenceLocation[] }>;
}

/** Reference-index key prefix → the kind its ref is checked as. */
const KEY_KINDS: ReadonlyArray<readonly [string, StatusKind]> = [
  ['ct:', 'content-type'],
  ['component:', 'component'],
  ['service:', 'service'],
  ['controller:', 'controller'],
  ['policy:', 'policy'],
  ['middleware:', 'middleware'],
  ['method:', 'method'],
];

/**
 * Magic strings that point at **nothing** — the inverse of {@link listUnused}, and
 * the safety net after a move/rename (target should be 0). The verdict is
 * {@link refStatus}, the one the editor diagnostics and {@link validateRef} use: a
 * component UID in a content-type call, a service generated for a content-type, a
 * plugin DevKit can't read whole are never reported. For `method:<uid>.<action>`
 * keys (route handlers / member calls) only the owning **entity** is checked —
 * never the action itself, so a dynamic/spread method is never a false positive.
 * A broken entity's method calls are grouped under it (`methods`), not reported
 * a second time. A call in an archived migration (never run) is not a broken ref.
 */
export function listBrokenRefs(project: StrapiProject): BrokenRef[] {
  const out: BrokenRef[] = [];
  const methodCalls: Array<{ entity: string; name: string; ref: string; locations: ReferenceLocation[] }> = [];
  for (const [key, all] of project.references) {
    // An archived migration never runs: what it calls can't break anything.
    const locations = all.filter((l) => !l.archived);
    if (!locations.length) continue;
    const entry = KEY_KINDS.find(([prefix]) => key.startsWith(prefix));
    if (!entry) continue;
    const [prefix, kind] = entry;
    const ref = key.slice(prefix.length);
    if (kind === 'method') {
      // The action is the LAST segment, so a nested controller (`api::x.a.b.find`) keeps its name.
      const h = parseHandlerRef(ref);
      if (h && refStatus(project, 'method', h.controllerRef) === 'unknown') {
        methodCalls.push({ entity: h.controllerRef, name: h.action, ref, locations });
      }
      continue;
    }
    if (refStatus(project, kind, ref) === 'unknown') out.push({ ref, kind, locations });
  }
  for (const call of methodCalls) {
    const owner = out.find((b) => b.ref === call.entity && b.kind !== 'component');
    if (owner) (owner.methods ??= []).push({ name: call.name, locations: call.locations });
    else out.push({ ref: call.ref, kind: 'method', locations: call.locations });
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
  /** Its only callers are migrations Strapi never runs (a subfolder of `database/migrations`). */
  onlyArchivedCallers?: string[];
}

const DEFAULT_UNUSED_KINDS: UnusedKind[] = ['method', 'content-type', 'component', 'service', 'policy', 'middleware'];

/**
 * Definitions with **0 Strapi references** — likely dead code (the agent-facing
 * version of the Model Explorer's Issues, extended to methods). *Garantir, ne
 * pas deviner*: "unused" counts Strapi call-sites + route handlers only; a method
 * called **directly in TS** still shows here, so verify before deleting. An
 * artifact whose registered name DevKit couldn't confirm (`unconfirmed`: a local
 * plugin's registry it couldn't read) is never listed — its callers may use
 * another name. Pure / static — needs the reference index (`whenReferencesReady`) built.
 */
export function listUnused(project: StrapiProject, opts?: { kinds?: UnusedKind[]; file?: string }): UnusedItem[] {
  const kinds = new Set(opts?.kinds ?? DEFAULT_UNUSED_KINDS);
  const file = opts?.file ? normalize(opts.file).toLowerCase() : undefined;
  // Installed-plugin entries (node_modules) are not the project's code: never "dead".
  const inFile = (p: string): boolean => !p.includes('/node_modules/') && (!file || normalize(p).toLowerCase() === file);
  // A reference from an archived migration (never run) doesn't make its target used.
  const unused = (key: string): boolean => !(project.references.get(key) ?? []).some((l) => !l.archived);
  const out: UnusedItem[] = [];
  const item = (key: string, it: UnusedItem): UnusedItem => {
    const archived = [...new Set((project.references.get(key) ?? []).map((l) => l.filePath))];
    return archived.length ? { ...it, onlyArchivedCallers: archived } : it;
  };

  if (kinds.has('method')) {
    for (const map of [project.index.services, project.index.controllers]) {
      for (const a of map.values()) {
        if (!inFile(a.filePath) || a.unconfirmed) continue;
        for (const action of a.actions ?? []) {
          if (unused(`method:${a.ref}.${action.name}`)) {
            out.push(item(`method:${a.ref}.${action.name}`, { kind: 'method', ref: `${a.ref}.${action.name}`, filePath: a.filePath, offset: action.offset }));
          }
        }
      }
    }
  }
  if (kinds.has('content-type')) {
    for (const ct of project.index.contentTypes.values()) {
      if (inFile(ct.schemaPath) && unused(`ct:${ct.uid}`)) {
        out.push(item(`ct:${ct.uid}`, { kind: 'content-type', ref: ct.uid, filePath: ct.schemaPath, offset: ct.defOffset ?? 0 }));
      }
    }
  }
  if (kinds.has('component')) {
    for (const c of project.index.components.values()) {
      if (inFile(c.jsonPath) && unused(`component:${c.uid}`)) {
        out.push(item(`component:${c.uid}`, { kind: 'component', ref: c.uid, filePath: c.jsonPath, offset: c.defOffset ?? 0 }));
      }
    }
  }
  if (kinds.has('service')) {
    for (const s of project.index.services.values()) {
      // A *resource* service (one backing a content-type) is wired by the
      // framework's auto-CRUD even with no explicit `strapi.service()` call —
      // only a *standalone* custom service with 0 refs is genuinely dead.
      if (inFile(s.filePath) && !s.unconfirmed && !project.index.contentTypes.has(s.ref) && unused(`service:${s.ref}`)) {
        out.push(item(`service:${s.ref}`, { kind: 'service', ref: s.ref, filePath: s.filePath, offset: s.defOffset ?? 0 }));
      }
    }
  }
  if (kinds.has('policy')) {
    for (const p of project.index.policies.values()) {
      if (inFile(p.filePath) && !p.unconfirmed && unused(`policy:${p.ref}`)) {
        out.push(item(`policy:${p.ref}`, { kind: 'policy', ref: p.ref, filePath: p.filePath, offset: p.defOffset ?? 0 }));
      }
    }
  }
  if (kinds.has('middleware')) {
    for (const m of project.index.middlewares.values()) {
      if (inFile(m.filePath) && !m.unconfirmed && unused(`middleware:${m.ref}`)) {
        out.push(item(`middleware:${m.ref}`, { kind: 'middleware', ref: m.ref, filePath: m.filePath, offset: m.defOffset ?? 0 }));
      }
    }
  }
  return out;
}
