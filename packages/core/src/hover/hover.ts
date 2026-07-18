import type { ApiMemberRef } from '../analyze/apiMember';
import type { MemberAccessRef } from '../analyze/member';
import { STRAPI_APIS, lookupApiMethod } from '../model/strapiApi';
import type { HoverInfo, ReferenceContext, StrapiProject } from '../model/types';
import { qualifyPluginRef } from '../model/uid';
import { buildModelMaps, componentInsights, contentTypeInsights } from '../reference/insights';
import { memberArtifact, resolveDefinition } from '../resolve/resolver';

const plural = (n: number): string => (n === 1 ? '' : 's');

/** A compact "Used: M incoming relations · K route handlers · D data usages" line. */
function contentTypeUsageLine(project: StrapiProject, uid: string): string {
  const ins = contentTypeInsights(project, uid, buildModelMaps(project));
  const parts: string[] = [];
  if (ins.incomingRelations.length) parts.push(`${ins.incomingRelations.length} incoming relation${plural(ins.incomingRelations.length)}`);
  if (ins.routeHandlers) parts.push(`${ins.routeHandlers} route handler${plural(ins.routeHandlers)}`);
  if (ins.dataUsages) parts.push(`${ins.dataUsages} data usage${plural(ins.dataUsages)}`);
  return parts.length ? `\n\n_Used: ${parts.join(' · ')}_` : '';
}

function rel(project: StrapiProject, filePath: string): string {
  const prefix = project.root.endsWith('/') ? project.root : project.root + '/';
  return filePath.toLowerCase().startsWith(prefix.toLowerCase()) ? filePath.slice(prefix.length) : filePath;
}

function header(emoji: string, label: string, code: string): string {
  return `${emoji} **${label}** · \`${code}\``;
}

function unknown(label: string, code: string): string {
  return `⚠️ Unknown ${label} · \`${code}\``;
}

/** Human-readable description of the reference under the cursor, for hover. */
export function describeHover(
  project: StrapiProject,
  ctx: ReferenceContext,
  filePath: string,
): HoverInfo | undefined {
  const idx = project.index;
  const targets = resolveDefinition(project, ctx, filePath);
  const target = targets[0];
  let md: string | undefined;

  switch (ctx.kind) {
    case 'content-type-uid': {
      if (ctx.apiStyle === 'entityService' && project.version === 5) {
        md = `⚠️ \`strapi.entityService\` was removed in **Strapi v5** — use \`strapi.documents()\`.`;
        break;
      }
      const ct = idx.contentTypes.get(qualifyPluginRef(ctx.text, ctx.pluginName));
      if (ct) {
        const n = Object.keys(ct.attributes).length;
        const name = ct.info.displayName ? ` · "${ct.info.displayName}"` : '';
        md = `${header('📦', 'Content type', ct.uid)}\n\n${ct.kind} · ${n} attribute${n === 1 ? '' : 's'}${name}\n\n_${rel(project, ct.schemaPath)}_${contentTypeUsageLine(project, ct.uid)}`;
        break;
      }
      // A bare `<category>.<name>` here is a component (db.query/getModel accept
      // components) — describe it as one rather than "Unknown content type".
      const comp = !ctx.text.includes('::') ? idx.components.get(ctx.text) : undefined;
      if (comp) {
        const ci = componentInsights(project, comp.uid, buildModelMaps(project));
        const used = ci.usedByCount ? `\n\n_Used in ${ci.usedByCount} content type${plural(ci.usedByCount)}_` : '';
        md = `${header('🧩', 'Component', comp.uid)}\n\n_${rel(project, comp.jsonPath)}_${used}`;
      } else {
        md = unknown('content type', ctx.text);
      }
      break;
    }
    case 'component-uid': {
      const comp = idx.components.get(ctx.text);
      if (comp) {
        const ci = componentInsights(project, comp.uid, buildModelMaps(project));
        const used = ci.usedByCount ? `\n\n_Used in ${ci.usedByCount} content type${plural(ci.usedByCount)}_` : '';
        md = `${header('🧩', 'Component', comp.uid)}\n\n_${rel(project, comp.jsonPath)}_${used}`;
      } else {
        md = unknown('component', ctx.text);
      }
      break;
    }
    case 'service-ref':
      md = target ? `${header('🔧', 'Service', ctx.text)}\n\n_${rel(project, target.filePath)}_` : unknown('service', ctx.text);
      break;
    case 'controller-ref':
      md = target ? `${header('🎛️', 'Controller', ctx.text)}\n\n_${rel(project, target.filePath)}_` : unknown('controller', ctx.text);
      break;
    case 'plugin-service-ref':
      md = target
        ? `${header('🔌', 'Plugin service', `${ctx.pluginName}.${ctx.text}`)}\n\n_${rel(project, target.filePath)}_`
        : unknown('plugin service', `${ctx.pluginName ?? '?'}.${ctx.text}`);
      break;
    case 'controller-action':
      md = target ? `${header('⚡', 'Controller action', ctx.text)}\n\n_${rel(project, target.filePath)}_` : unknown('action', ctx.text);
      break;
    case 'policy-ref':
      md = target ? `${header('🛡️', 'Policy', ctx.text)}\n\n_${rel(project, target.filePath)}_` : unknown('policy', ctx.text);
      break;
    case 'middleware-ref':
      md = target ? `${header('🧱', 'Middleware', ctx.text)}\n\n_${rel(project, target.filePath)}_` : unknown('middleware', ctx.text);
      break;
    case 'plugin-name':
      md = idx.pluginNames.has(ctx.text)
        ? `${header('🔌', 'Local plugin', ctx.text)}`
        : `🔌 **Plugin** · \`${ctx.text}\``;
      break;
    default:
      md = undefined;
  }

  return md ? { markdown: md, range: ctx.range } : undefined;
}

/** Hover for a method call on a resolved service/controller. */
export function describeMemberHover(
  project: StrapiProject,
  member: MemberAccessRef,
): HoverInfo | undefined {
  const artifact = memberArtifact(project, member);
  if (!artifact) return undefined;
  const action = artifact.actions?.find((a) => a.name === member.method);

  const label = member.kind === 'controller-member' ? 'Controller method' : 'Service method';
  const owner =
    member.kind === 'plugin-service-member'
      ? `plugin::${member.pluginName}.${member.ref}`
      : member.ref;

  const lines = [header('⚡', label, member.method), `on \`${owner}\``];
  if (action?.signature) {
    lines.push('```ts\n' + action.signature + '\n```');
    if (/^async\b/.test(action.signature) && !/:\s*Promise/.test(action.signature)) {
      lines.push('_returns a `Promise`_');
    }
  }
  lines.push(`_${rel(project, artifact.filePath)}_`);
  return { markdown: lines.join('\n\n'), range: member.range };
}

/** Hover for a built-in Strapi data API method (`findMany`, `create`, …). */
export function describeApiMemberHover(member: ApiMemberRef): HoverInfo | undefined {
  const summary = lookupApiMethod(member.api, member.method);
  if (!summary) return undefined; // unknown method → don't guess
  const api = STRAPI_APIS[member.api];
  const target = member.uid ? `\n\nTarget: \`${member.uid}\`` : '';
  return {
    markdown:
      `${header('📘', api.label, member.method)}\n\n${summary}${target}\n\n` +
      `[Strapi docs ↗](${api.docsUrl})`,
    range: member.range,
  };
}
