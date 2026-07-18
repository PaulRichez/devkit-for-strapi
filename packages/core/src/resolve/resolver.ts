import type { MemberAccessRef } from '../analyze/member';
import { autoCrudActions } from '../model/constants';
import type { CodeArtifact, ReferenceContext, StrapiProject, TargetLocation } from '../model/types';
import { parseComponentUid, parseHandlerRef, qualifyPluginRef } from '../model/uid';
import { owningApiName, owningPluginName, qualifyRouteHandler } from './owner';

function fileTarget(artifact: CodeArtifact | undefined): TargetLocation[] {
  return artifact ? [{ filePath: artifact.filePath }] : [];
}

/**
 * A service/controller target: its file when one exists, else — for a
 * schema-only content-type — the content-type's schema (Strapi auto-generates
 * the core service/controller, so `strapi.service('api::x.x')` is valid and
 * "goes to" the resource's schema, consistent with the auto-CRUD handler).
 */
function artifactOrSchema(artifact: CodeArtifact | undefined, project: StrapiProject, ref: string): TargetLocation[] {
  if (artifact) return [{ filePath: artifact.filePath }];
  const ct = project.index.contentTypes.get(ref);
  return ct ? [{ filePath: ct.schemaPath }] : [];
}

const qualifiedRef = (ctx: ReferenceContext): string => qualifyPluginRef(ctx.text, ctx.pluginName);

/** Resolve a policy/middleware ref (bare, qualified, or plugin sub-accessor) against its map. */
function resolveScoped(
  ctx: ReferenceContext,
  map: Map<string, CodeArtifact>,
  project: StrapiProject,
  filePath: string,
): TargetLocation[] {
  const text = ctx.text;
  // strapi.plugin('a').policy('b') → plugin::a.b
  if (ctx.pluginName && !text.includes('::')) return fileTarget(map.get(qualifiedRef(ctx)));
  if (text.includes('::')) return fileTarget(map.get(text));

  const candidates: string[] = [];
  const api = owningApiName(project, filePath);
  const plugin = owningPluginName(project, filePath);
  if (api) candidates.push(`api::${api}.${text}`);
  if (plugin) candidates.push(`plugin::${plugin}.${text}`);
  candidates.push(`global::${text}`);

  const targets: TargetLocation[] = [];
  for (const key of candidates) {
    const artifact = map.get(key);
    if (artifact) targets.push({ filePath: artifact.filePath });
  }
  return targets;
}

function resolveControllerAction(project: StrapiProject, filePath: string, text: string): TargetLocation[] {
  const handler = parseHandlerRef(qualifyRouteHandler(project, filePath, text));
  if (!handler) return [];
  const controllerRef = handler.controllerRef;
  const controller = project.index.controllers.get(controllerRef);
  if (!controller) {
    // Schema-only content-type with an auto-generated core controller (kind/source-aware):
    // navigate to the schema — consistent with the validator and MCP resolve.
    const ct = project.index.contentTypes.get(controllerRef);
    return ct && autoCrudActions(ct).has(handler.action) ? [{ filePath: ct.schemaPath }] : [];
  }
  const action = controller.actions?.find((a) => a.name === handler.action);
  if (action) {
    return [{ filePath: controller.filePath, offset: action.offset, length: handler.action.length }];
  }
  // Core action (find/findOne/…) not explicitly overridden → jump to the file.
  return [{ filePath: controller.filePath }];
}

/** Resolve a reference context to its definition target(s). */
export function resolveDefinition(
  project: StrapiProject,
  ctx: ReferenceContext,
  filePath: string,
): TargetLocation[] {
  const index = project.index;
  switch (ctx.kind) {
    case 'content-type-uid': {
      const ref = qualifiedRef(ctx);
      const ct = index.contentTypes.get(ref);
      if (ct) return [{ filePath: ct.schemaPath }];
      // A bare `<category>.<name>` in a DB-layer content-type context is a
      // component (db.query/getModel accept components) → resolve to its JSON.
      if (!ref.includes('::') && parseComponentUid(ref)) {
        const comp = index.components.get(ref);
        if (comp) return [{ filePath: comp.jsonPath }];
      }
      return [];
    }
    case 'component-uid': {
      const comp = index.components.get(ctx.text);
      return comp ? [{ filePath: comp.jsonPath }] : [];
    }
    case 'service-ref':
      return artifactOrSchema(index.services.get(qualifiedRef(ctx)), project, qualifiedRef(ctx));
    case 'controller-ref':
      return artifactOrSchema(index.controllers.get(qualifiedRef(ctx)), project, qualifiedRef(ctx));
    case 'plugin-service-ref':
      return ctx.pluginName
        ? fileTarget(index.services.get(`plugin::${ctx.pluginName}.${ctx.text}`))
        : [];
    case 'policy-ref':
      return resolveScoped(ctx, index.policies, project, filePath);
    case 'middleware-ref':
      return resolveScoped(ctx, index.middlewares, project, filePath);
    case 'controller-action':
      return resolveControllerAction(project, filePath, ctx.text);
    case 'plugin-name':
      return []; // navigating to a plugin root is out of scope for the MVP
    default:
      return [];
  }
}

/** The service/controller artifact a member call targets, if indexed. */
export function memberArtifact(project: StrapiProject, m: MemberAccessRef): CodeArtifact | undefined {
  if (m.kind === 'service-member') return project.index.services.get(m.ref);
  if (m.kind === 'controller-member') return project.index.controllers.get(m.ref);
  if (m.kind === 'plugin-service-member' && m.pluginName) {
    return project.index.services.get(`plugin::${m.pluginName}.${m.ref}`);
  }
  return undefined;
}

/** Resolve a method call on a resolved service/controller to that method. */
export function resolveMember(project: StrapiProject, m: MemberAccessRef): TargetLocation[] {
  const artifact = memberArtifact(project, m);
  if (!artifact) return [];
  const action = artifact.actions?.find((a) => a.name === m.method);
  if (action) return [{ filePath: artifact.filePath, offset: action.offset, length: m.method.length }];
  // The service/controller exists but the method isn't a custom one — land in the file.
  return [{ filePath: artifact.filePath }];
}
