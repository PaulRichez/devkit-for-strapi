import type { MemberCompletion } from '../analyze/memberCompletion';
import { autoCrudActions, CORE_ACTION_SET } from '../model/constants';
import { STRAPI_APIS } from '../model/strapiApi';
import type {
  CodeArtifact,
  CompletionEntry,
  ReferenceContext,
  StrapiProject,
} from '../model/types';
import { owningApiName, owningPluginName } from '../resolve/owner';

function value(label: string, detail?: string): CompletionEntry {
  return detail
    ? { label, insertText: label, detail, kind: 'value' }
    : { label, insertText: label, kind: 'value' };
}

function artifactEntries(map: Map<string, CodeArtifact>): CompletionEntry[] {
  return [...map.values()].map((a) => value(a.ref, a.kind));
}

/**
 * Append the content-types that have no service/controller *file* — Strapi
 * auto-generates their core service/controller, so `strapi.service('api::x.x')`
 * is valid on them (same truth the validator accepts).
 */
function withImplicitCoreEntries(
  out: CompletionEntry[],
  map: Map<string, CodeArtifact>,
  project: StrapiProject,
  detail: string,
): CompletionEntry[] {
  for (const uid of project.index.contentTypes.keys()) {
    if (!map.has(uid)) out.push(value(uid, detail));
  }
  return out;
}

/** Bare names of a plugin's entries (for `strapi.plugin('a').controller('|')`). */
function pluginBareEntries(
  map: { keys(): IterableIterator<string> },
  pluginName: string,
  detail: string,
): CompletionEntry[] {
  const prefix = `plugin::${pluginName}.`;
  return [...map.keys()].filter((k) => k.startsWith(prefix)).map((k) => value(k.slice(prefix.length), detail));
}

function scopedEntries(
  map: Map<string, CodeArtifact>,
  ctx: ReferenceContext,
  project: StrapiProject,
  filePath: string,
): CompletionEntry[] {
  const out: CompletionEntry[] = [...map.values()].map((a) => ({
    label: a.ref,
    insertText: a.ref,
    detail: a.scope,
    kind: 'reference' as const,
  }));
  // In route config, a bare name resolves within the owning API — or the
  // owning plugin (the same scoping the validator/resolver apply).
  if (ctx.apiStyle === 'route') {
    const api = owningApiName(project, filePath);
    if (api) {
      for (const a of map.values()) {
        if (a.scope === 'api' && a.apiName === api) {
          out.push({ label: a.name, insertText: a.name, detail: `api::${api}`, kind: 'reference' });
        }
      }
    }
    const plugin = owningPluginName(project, filePath);
    if (plugin) {
      for (const a of map.values()) {
        if (a.scope === 'plugin' && a.pluginName === plugin) {
          out.push({ label: a.name, insertText: a.name, detail: `plugin::${plugin}`, kind: 'reference' });
        }
      }
    }
  }
  return out;
}

/** Controller ref `ns::scope.name` from a partial handler string being typed. */
function controllerPrefixOf(text: string): string | undefined {
  const sep = text.indexOf('::');
  if (sep <= 0) return undefined;
  const ns = text.slice(0, sep);
  if (ns !== 'api' && ns !== 'plugin') return undefined;
  const parts = text.slice(sep + 2).split('.');
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  return `${ns}::${parts[0]}.${parts[1]}`;
}

function actionEntries(project: StrapiProject, ctx: ReferenceContext): CompletionEntry[] {
  const controllerRef = controllerPrefixOf(ctx.text);
  if (controllerRef) {
    const controller = project.index.controllers.get(controllerRef);
    if (controller) {
      const names = new Set<string>([
        ...(controller.actions?.map((a) => a.name) ?? []),
        ...CORE_ACTION_SET,
      ]);
      return [...names].map((n) => ({
        label: `${controllerRef}.${n}`,
        insertText: `${controllerRef}.${n}`,
        detail: 'action',
        kind: 'method',
      }));
    }
    // Schema-only content-type → suggest its auto-generated core actions (kind/source-aware),
    // so the user can discover the very handlers the validator accepts.
    const ct = project.index.contentTypes.get(controllerRef);
    const actions = ct ? autoCrudActions(ct) : undefined;
    if (actions?.size) {
      return [...actions].map((n) => ({
        label: `${controllerRef}.${n}`,
        insertText: `${controllerRef}.${n}`,
        detail: 'action',
        kind: 'method',
      }));
    }
  }
  // Fall back to listing controllers so the user can pick one first.
  return [...project.index.controllers.values()].map((c) => value(c.ref, 'controller'));
}

/** Produce completion candidates for a reference context. */
export function complete(
  project: StrapiProject,
  ctx: ReferenceContext,
  filePath: string,
): CompletionEntry[] {
  const idx = project.index;
  switch (ctx.kind) {
    case 'content-type-uid': {
      if (ctx.pluginName) return pluginBareEntries(idx.contentTypes, ctx.pluginName, 'plugin content-type');
      const out = [...idx.contentTypes.values()].map((ct) => value(ct.uid, ct.info.displayName ?? ct.kind));
      // DB-layer call forms (db.query/query/getModel, v4 entityService) accept
      // component UIDs too — suggest what the validator accepts.
      const dbLayer = ctx.apiStyle === 'db.query' || ctx.apiStyle === 'query' || ctx.apiStyle === 'getModel' || ctx.apiStyle === 'entityService';
      if (dbLayer) for (const c of idx.components.values()) out.push(value(c.uid, 'component'));
      return out;
    }
    case 'service-ref':
      return withImplicitCoreEntries(artifactEntries(idx.services), idx.services, project, 'core service (auto-generated)');
    case 'controller-ref':
      return ctx.pluginName
        ? pluginBareEntries(idx.controllers, ctx.pluginName, 'plugin controller')
        : withImplicitCoreEntries(artifactEntries(idx.controllers), idx.controllers, project, 'core controller (auto-generated)');
    case 'plugin-service-ref': {
      if (!ctx.pluginName) return [];
      const prefix = `plugin::${ctx.pluginName}.`;
      return [...idx.services.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => value(k.slice(prefix.length), 'plugin service'));
    }
    case 'component-uid':
      return [...idx.components.values()].map((c) => value(c.uid, c.info.displayName));
    case 'policy-ref':
      return ctx.pluginName
        ? pluginBareEntries(idx.policies, ctx.pluginName, 'plugin policy')
        : scopedEntries(idx.policies, ctx, project, filePath);
    case 'middleware-ref':
      return ctx.pluginName
        ? pluginBareEntries(idx.middlewares, ctx.pluginName, 'plugin middleware')
        : scopedEntries(idx.middlewares, ctx, project, filePath);
    case 'controller-action':
      return actionEntries(project, ctx);
    case 'plugin-name':
      return [...idx.pluginNames].map((n) => ({ label: n, insertText: n, kind: 'module' }));
    default:
      return [];
  }
}

/** Methods to suggest after `.` on a resolved service/controller/API. */
export function completeMembers(project: StrapiProject, mc: MemberCompletion): CompletionEntry[] {
  if (mc.target === 'api') {
    const api = STRAPI_APIS[mc.api];
    return Object.entries(api.methods).map(([name, summary]) => ({
      label: name,
      insertText: name,
      detail: api.label,
      documentation: summary,
      kind: 'method',
    }));
  }
  let artifact: CodeArtifact | undefined;
  if (mc.target === 'plugin-service') {
    artifact = project.index.services.get(`plugin::${mc.pluginName}.${mc.ref}`);
  } else if (mc.target === 'controller') {
    artifact = project.index.controllers.get(mc.ref);
  } else {
    artifact = project.index.services.get(mc.ref);
  }
  if (!artifact?.actions) return [];
  return artifact.actions.map((a) => ({ label: a.name, insertText: a.name, detail: 'method', kind: 'method' }));
}
