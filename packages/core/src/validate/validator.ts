import { collectReferences } from '../analyze/callSite';
import type {
  CodeArtifact,
  DiagnosticEntry,
  DiagnosticQuickFix,
  ReferenceContext,
  StrapiProject,
} from '../model/types';
import { isFrameworkRef, parseComponentUid, parseEntityRef, parseHandlerRef, parseRef } from '../model/uid';
import { isVerifiablePlugin } from '../plugins/merge';
import { contentTypeUids, hasContentType } from '../index/codeContentTypes';
import { autoCrudActions, CORE_ACTION_SET } from '../model/constants';
import { closest } from '../util/levenshtein';
import { owningApiName, owningPluginName, qualifyRouteHandler } from '../resolve/owner';
import { lookupStrapiName, whyNotFound } from '../resolve/strapiNames';
import { isUnverifiable, loaderNameOf, refStatus } from './refStatus';

export const DiagnosticCode = {
  UnknownContentType: 'devkit-for-strapi.unknown-content-type',
  UnknownService: 'devkit-for-strapi.unknown-service',
  UnknownController: 'devkit-for-strapi.unknown-controller',
  UnknownAction: 'devkit-for-strapi.unknown-action',
  UnknownComponent: 'devkit-for-strapi.unknown-component',
  UnknownPolicy: 'devkit-for-strapi.unknown-policy',
  UnknownMiddleware: 'devkit-for-strapi.unknown-middleware',
  /** A policy/middleware DevKit finds, but not under the name Strapi looks up (it throws at startup). */
  NotFoundByStrapi: 'devkit-for-strapi.not-found-by-strapi',
  Malformed: 'devkit-for-strapi.malformed-ref',
  V4InV5: 'devkit-for-strapi.v4-in-v5',
} as const;

function diag(
  ref: ReferenceContext,
  message: string,
  code: string,
  severity: DiagnosticEntry['severity'],
  suggestion?: string,
  replacement?: string,
): DiagnosticEntry {
  const entry: DiagnosticEntry = {
    message,
    code,
    severity,
    start: ref.range.start,
    end: ref.range.end,
  };
  if (suggestion) {
    const fix: DiagnosticQuickFix = {
      title: `Replace with '${suggestion}'`,
      replacement: replacement ?? suggestion,
    };
    entry.quickFixes = [fix];
  }
  return entry;
}

/** A plugin whose refs can be verified: local, or installed and read exhaustively. */
function isLocalPlugin(project: StrapiProject, name: string): boolean {
  return isVerifiablePlugin(project.index, name);
}

/** The read-only surface of an index map used during validation. */
interface RefIndex {
  has(key: string): boolean;
  keys(): IterableIterator<string>;
}

/** Entity-shaped ref check shared by content-type / service / controller. */
function validateEntityRef(
  project: StrapiProject,
  ref: ReferenceContext,
  map: RefIndex,
  code: string,
  label: 'content-type' | 'service' | 'controller',
): DiagnosticEntry | undefined {
  // Plugin sub-accessor (`strapi.plugin('a').controller('b')`): a bare name
  // qualified by a plugin. Verify only when the plugin is local.
  if (ref.pluginName && !ref.text.includes('::')) {
    if (!isLocalPlugin(project, ref.pluginName)) return undefined;
    const full = `plugin::${ref.pluginName}.${ref.text}`;
    if (refStatus(project, label, full) !== 'unknown') return undefined;
    const inPlugin = [...map.keys()].filter((k) => k.startsWith(`plugin::${ref.pluginName}.`));
    const suggestion = closest(full, inPlugin);
    return diag(
      ref,
      `Unknown ${label} '${ref.text}' in plugin '${ref.pluginName}'.`,
      code,
      'error',
      suggestion,
      suggestion?.slice(`plugin::${ref.pluginName}.`.length),
    );
  }

  // Framework-owned refs (`admin::user`, `strapi::core-store`) are real but live
  // outside the workspace — unverifiable, never flagged (like an external plugin).
  if (isFrameworkRef(ref.text)) return undefined;

  const parsed = parseEntityRef(ref.text);
  if (!parsed || parsed.namespace === 'global') {
    return diag(ref, `Malformed ${label} reference '${ref.text}'.`, DiagnosticCode.Malformed, 'error');
  }
  // The shared verdict (refStatus): an external plugin, a registry DevKit couldn't
  // read whole, a content-type's generated service/controller are never flagged.
  if (refStatus(project, label, ref.text) !== 'unknown') return undefined;
  const suggestion = loaderNameOf(ref.text, map) ?? closest(ref.text, map.keys());
  return diag(ref, `Unknown ${label} '${ref.text}'.`, code, 'error', suggestion);
}

function validateContentType(project: StrapiProject, ref: ReferenceContext): DiagnosticEntry | undefined {
  if (project.version === 5 && ref.apiStyle === 'entityService') {
    return diag(
      ref,
      `'strapi.entityService' is deprecated in Strapi v5. Use 'strapi.documents()' instead.`,
      DiagnosticCode.V4InV5,
      'warning',
    );
  }
  // A bare `<category>.<name>` (no `::`) is a **component** UID, not a malformed
  // content-type. Strapi's DB-layer APIs (`db.query`/`query`/`getModel`, and v4
  // `entityService`) accept components — they're registered models. If it matches
  // an indexed component → valid; if it's component-shaped but unknown → "Unknown
  // component" (with a did-you-mean), never the wrong "Malformed content-type".
  if (!ref.text.includes('::') && !isFrameworkRef(ref.text)) {
    const comp = parseComponentUid(ref.text);
    if (comp) {
      if (project.index.components.has(ref.text)) return undefined;
      const suggestion = closest(ref.text, project.index.components.keys());
      return diag(ref, `Unknown component '${ref.text}'.`, DiagnosticCode.UnknownComponent, 'error', suggestion);
    }
  }
  const idx = project.index;
  const contentTypes: RefIndex = { has: (k) => hasContentType(idx, k), keys: () => contentTypeUids(idx).values() };
  return validateEntityRef(project, ref, contentTypes, DiagnosticCode.UnknownContentType, 'content-type');
}

function validatePluginService(project: StrapiProject, ref: ReferenceContext): DiagnosticEntry | undefined {
  if (!ref.pluginName || !isLocalPlugin(project, ref.pluginName)) return undefined;
  const full = `plugin::${ref.pluginName}.${ref.text}`;
  if (refStatus(project, 'service', full) !== 'unknown') return undefined;
  const pluginServices = [...project.index.services.keys()].filter((k) =>
    k.startsWith(`plugin::${ref.pluginName}.`),
  );
  const suggestion = closest(full, pluginServices);
  return diag(
    ref,
    `Unknown service '${ref.text}' in plugin '${ref.pluginName}'.`,
    DiagnosticCode.UnknownService,
    'error',
    suggestion,
    suggestion?.slice(`plugin::${ref.pluginName}.`.length),
  );
}

function validateComponent(project: StrapiProject, ref: ReferenceContext): DiagnosticEntry | undefined {
  if (project.index.components.has(ref.text)) return undefined;
  if (!parseComponentUid(ref.text)) {
    return diag(ref, `Malformed component UID '${ref.text}'. Expected '<category>.<name>'.`, DiagnosticCode.Malformed, 'error');
  }
  const suggestion = closest(ref.text, project.index.components.keys());
  return diag(ref, `Unknown component '${ref.text}'.`, DiagnosticCode.UnknownComponent, 'error', suggestion);
}

function validateScoped(
  project: StrapiProject,
  ref: ReferenceContext,
  filePath: string,
  map: Map<string, CodeArtifact>,
  code: string,
  label: 'policy' | 'middleware',
): DiagnosticEntry | undefined {
  const text = ref.text;
  // `strapi::<name>` middlewares: verifiable when Strapi's own registry was read
  // exhaustively from node_modules (see plugins/installed.ts), silent otherwise.
  const builtins = project.index.frameworkMiddlewares;
  if (label === 'middleware' && text.startsWith('strapi::') && builtins) {
    if (builtins.has(text)) return undefined;
    const suggestion = closest(text, builtins.keys());
    return diag(ref, `Unknown Strapi middleware '${text}'.`, code, 'error', suggestion);
  }
  // Framework built-in policy/middleware (`admin::isAuthenticatedAdmin`,
  // `strapi::*`) — registered by Strapi core, not in the workspace → never flag.
  if (isFrameworkRef(text)) return undefined;
  // strapi.plugin('a').policy('b'): bare name qualified by a plugin.
  if (ref.pluginName && !text.includes('::')) {
    if (!isLocalPlugin(project, ref.pluginName)) return undefined;
    const full = `plugin::${ref.pluginName}.${text}`;
    if (refStatus(project, label, full) !== 'unknown') return undefined;
    const inPlugin = [...map.keys()].filter((k) => k.startsWith(`plugin::${ref.pluginName}.`));
    const suggestion = closest(full, inPlugin);
    return diag(
      ref,
      `Unknown ${label} '${text}' in plugin '${ref.pluginName}'.`,
      code,
      'error',
      suggestion,
      suggestion?.slice(`plugin::${ref.pluginName}.`.length),
    );
  }
  if (text.includes('::')) {
    const parsed = parseRef(text);
    if (!parsed) return diag(ref, `Malformed ${label} reference '${text}'.`, DiagnosticCode.Malformed, 'error');
    if (refStatus(project, label, text) !== 'unknown') return undefined;
    const suggestion = loaderNameOf(text, map) ?? closest(text, map.keys());
    return diag(ref, `Unknown ${label} '${text}'.`, code, 'error', suggestion);
  }
  // Bare name: resolvable within the owning API, the owning plugin, or globally.
  const api = owningApiName(project, filePath);
  const plugin = owningPluginName(project, filePath);
  // In a route's config or config/middlewares, Strapi is narrower (see resolve/strapiNames):
  // a name DevKit finds but Strapi won't throws at startup → say so. A policy needs the
  // route's owner; outside an API or local plugin folder it isn't known → as before.
  if ((ref.apiStyle === 'route' || ref.apiStyle === 'config') && (label === 'middleware' || api || plugin)) {
    const kind = label === 'middleware' ? 'middleware' : 'policy';
    const owner = { api, plugin };
    const found = lookupStrapiName((k) => map.has(k), kind, text, owner);
    if (found.status === 'not-found-by-strapi') {
      return diag(
        ref,
        `Strapi won't find the ${label} '${text}' at startup: ${whyNotFound(kind, text, owner)}. Use '${found.ref}'.`,
        DiagnosticCode.NotFoundByStrapi,
        'error',
        found.ref,
      );
    }
  }
  const candidates: string[] = [];
  if (api) candidates.push(`api::${api}.${text}`);
  if (plugin) candidates.push(`plugin::${plugin}.${text}`);
  candidates.push(`global::${text}`);
  if (candidates.some((c) => map.has(c))) return undefined;
  // The owning plugin may register the name in a way DevKit couldn't read.
  if (plugin && isUnverifiable(project, label, `plugin::${plugin}.${text}`)) return undefined;
  const suggestion = loaderNameOf(candidates[0]!, map) ?? closest(candidates[0]!, map.keys());
  return diag(ref, `Unknown ${label} '${text}'.`, code, 'error', suggestion);
}

function validateControllerAction(
  project: StrapiProject,
  ref: ReferenceContext,
  filePath: string,
): DiagnosticEntry | undefined {
  // Strapi's documented short form for custom routes ('controller.action', no
  // '::') is scoped to the route file's own api/plugin — qualify it from the
  // file location before parsing (a plugin route with a dynamically-loaded
  // controller was flagged "Malformed" for using this valid, common form).
  const qualified = qualifyRouteHandler(project, filePath, ref.text);
  // Framework handler (`admin::…`) → unverifiable, never flag.
  if (isFrameworkRef(qualified)) return undefined;
  // A short handler outside an API or local plugin folder (e.g. a route pushed into a
  // plugin from `src/extensions`): Strapi qualifies it with the router's owner, which
  // the file location doesn't tell → unverifiable, never "malformed".
  if (!qualified.includes('::') && !owningApiName(project, filePath) && !owningPluginName(project, filePath)) return undefined;
  // parseHandlerRef: the action is the LAST segment; everything before is the
  // controller ref, which may be a nested/dotted name (`api::foo.a.b`). Using it
  // (not parseRef) stops a nested controller from being misparsed as name+action
  // — the misparse that produced a bogus "Unknown" + a corrupting quickfix.
  const handler = parseHandlerRef(qualified);
  if (!handler) {
    return diag(ref, `Malformed route handler '${ref.text}'.`, DiagnosticCode.Malformed, 'error');
  }
  const parsed = { ...handler.parsed, action: handler.action };
  if (parsed.namespace === 'plugin' && !isLocalPlugin(project, parsed.scope)) return undefined;
  const controllerRef = handler.controllerRef;
  const controller = project.index.controllers.get(controllerRef);
  if (!controller) {
    // Schema-only content-type: an `api` CT has an auto-generated core controller, so
    // its core actions (by kind — a singleType has no findOne/create) are valid; a
    // non-core action genuinely doesn't exist. A local PLUGIN CT is NOT auto-CRUD'd
    // (the plugin registers its own) → can't verify statically → no-op (never assert).
    const ct = project.index.contentTypes.get(controllerRef);
    if (ct) {
      const actions = autoCrudActions(ct);
      if (!actions.size) return undefined; // plugin content-type → unverifiable → skip
      if (actions.has(parsed.action)) return undefined;
      const sug = closest(parsed.action, [...actions]);
      return diag(
        ref,
        `Unknown action '${parsed.action}' on controller '${controllerRef}'.`,
        DiagnosticCode.UnknownAction,
        'error',
        sug ? `${controllerRef}.${sug}` : undefined,
        sug ? `${controllerRef}.${sug}` : undefined,
      );
    }
    if (isUnverifiable(project, 'controller', controllerRef)) return undefined;
    const suggestion = closest(controllerRef, project.index.controllers.keys());
    return diag(
      ref,
      `Unknown controller '${controllerRef}'.`,
      DiagnosticCode.UnknownController,
      'error',
      suggestion ? `${suggestion}.${parsed.action}` : undefined,
      suggestion ? `${suggestion}.${parsed.action}` : undefined,
    );
  }
  const actionNames = [...(controller.actions?.map((a) => a.name) ?? []), ...CORE_ACTION_SET];
  if (actionNames.includes(parsed.action)) return undefined;
  // The factory spreads (`...shared`) → the action list is provably incomplete;
  // suppress rather than emit a false "Unknown action" (garantir, ne pas deviner).
  if (controller.hasSpread) return undefined;
  const suggestion = closest(parsed.action, actionNames);
  return diag(
    ref,
    `Unknown action '${parsed.action}' on controller '${controllerRef}'.`,
    DiagnosticCode.UnknownAction,
    'error',
    suggestion ? `${controllerRef}.${suggestion}` : undefined,
    suggestion ? `${controllerRef}.${suggestion}` : undefined,
  );
}

function validateRef(
  project: StrapiProject,
  ref: ReferenceContext,
  filePath: string,
): DiagnosticEntry | undefined {
  switch (ref.kind) {
    case 'content-type-uid':
      return validateContentType(project, ref);
    case 'service-ref':
      return validateEntityRef(project, ref, project.index.services, DiagnosticCode.UnknownService, 'service');
    case 'controller-ref':
      return validateEntityRef(project, ref, project.index.controllers, DiagnosticCode.UnknownController, 'controller');
    case 'plugin-service-ref':
      return validatePluginService(project, ref);
    case 'component-uid':
      return validateComponent(project, ref);
    case 'policy-ref':
      return validateScoped(project, ref, filePath, project.index.policies, DiagnosticCode.UnknownPolicy, 'policy');
    case 'middleware-ref':
      return validateScoped(project, ref, filePath, project.index.middlewares, DiagnosticCode.UnknownMiddleware, 'middleware');
    case 'controller-action':
      return validateControllerAction(project, ref, filePath);
    case 'plugin-name':
      return undefined; // external plugins can't be verified
    default:
      return undefined;
  }
}

/** Produce diagnostics for a file: invalid references + obsolete v4 patterns. */
export function validateDocument(
  project: StrapiProject,
  filePath: string,
  text: string,
): DiagnosticEntry[] {
  const out: DiagnosticEntry[] = [];
  for (const ref of collectReferences(filePath, text)) {
    const entry = validateRef(project, ref, filePath);
    if (entry) out.push(entry);
  }
  return out;
}
