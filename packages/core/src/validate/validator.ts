import { collectReferences } from '../analyze/callSite';
import type {
  CodeArtifact,
  DiagnosticEntry,
  DiagnosticQuickFix,
  ReferenceContext,
  StrapiProject,
} from '../model/types';
import { isFrameworkRef, parseComponentUid, parseEntityRef, parseHandlerRef, parseRef } from '../model/uid';
import { autoCrudActions, CORE_ACTION_SET } from '../model/constants';
import { closest } from '../util/levenshtein';
import { owningApiName, owningPluginName, qualifyRouteHandler } from '../resolve/owner';

export const DiagnosticCode = {
  UnknownContentType: 'devkit-for-strapi.unknown-content-type',
  UnknownService: 'devkit-for-strapi.unknown-service',
  UnknownController: 'devkit-for-strapi.unknown-controller',
  UnknownAction: 'devkit-for-strapi.unknown-action',
  UnknownComponent: 'devkit-for-strapi.unknown-component',
  UnknownPolicy: 'devkit-for-strapi.unknown-policy',
  UnknownMiddleware: 'devkit-for-strapi.unknown-middleware',
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

function isLocalPlugin(project: StrapiProject, name: string): boolean {
  return project.index.pluginNames.has(name);
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
  label: string,
): DiagnosticEntry | undefined {
  // Plugin sub-accessor (`strapi.plugin('a').controller('b')`): a bare name
  // qualified by a plugin. Verify only when the plugin is local.
  if (ref.pluginName && !ref.text.includes('::')) {
    if (!isLocalPlugin(project, ref.pluginName)) return undefined;
    const full = `plugin::${ref.pluginName}.${ref.text}`;
    if (map.has(full)) return undefined;
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
  // External (installed) plugins aren't in the workspace — we can't verify them.
  if (parsed.namespace === 'plugin' && !isLocalPlugin(project, parsed.scope)) return undefined;
  if (map.has(ref.text)) return undefined;
  // A service/controller ref naming a real content-type is valid even with no
  // service/controller *file*: Strapi auto-generates the core service/controller
  // for every content-type. (For a content-type ref, `map` IS contentTypes, so
  // this is a redundant-but-safe no-op.)
  if (project.index.contentTypes.has(ref.text)) return undefined;
  const suggestion = closest(ref.text, map.keys());
  return diag(ref, `Unknown ${label} '${ref.text}'.`, code, 'error', suggestion);
}

function validateContentType(project: StrapiProject, ref: ReferenceContext): DiagnosticEntry | undefined {
  if (project.version === 5 && ref.apiStyle === 'entityService') {
    return diag(
      ref,
      `'strapi.entityService' was removed in Strapi v5. Use 'strapi.documents()' instead.`,
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
  return validateEntityRef(project, ref, project.index.contentTypes, DiagnosticCode.UnknownContentType, 'content-type');
}

function validatePluginService(project: StrapiProject, ref: ReferenceContext): DiagnosticEntry | undefined {
  if (!ref.pluginName || !isLocalPlugin(project, ref.pluginName)) return undefined;
  const full = `plugin::${ref.pluginName}.${ref.text}`;
  if (project.index.services.has(full)) return undefined;
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
  label: string,
): DiagnosticEntry | undefined {
  const text = ref.text;
  // Framework built-in policy/middleware (`admin::isAuthenticatedAdmin`,
  // `strapi::*`) — registered by Strapi core, not in the workspace → never flag.
  if (isFrameworkRef(text)) return undefined;
  // strapi.plugin('a').policy('b'): bare name qualified by a plugin.
  if (ref.pluginName && !text.includes('::')) {
    if (!isLocalPlugin(project, ref.pluginName)) return undefined;
    const full = `plugin::${ref.pluginName}.${text}`;
    if (map.has(full)) return undefined;
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
    if (parsed.namespace === 'plugin' && !isLocalPlugin(project, parsed.scope)) return undefined;
    if (map.has(text)) return undefined;
    const suggestion = closest(text, map.keys());
    return diag(ref, `Unknown ${label} '${text}'.`, code, 'error', suggestion);
  }
  // Bare name: resolvable within the owning API, the owning plugin, or globally.
  const api = owningApiName(project, filePath);
  const plugin = owningPluginName(project, filePath);
  const candidates: string[] = [];
  if (api) candidates.push(`api::${api}.${text}`);
  if (plugin) candidates.push(`plugin::${plugin}.${text}`);
  candidates.push(`global::${text}`);
  if (candidates.some((c) => map.has(c))) return undefined;
  const suggestion = closest(candidates[0]!, map.keys());
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
