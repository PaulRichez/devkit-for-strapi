/**
 * What a request to a route goes through, in Strapi's order — read in Strapi 4.13.5
 * (`@strapi/strapi/lib/services/server/compose-endpoint.js`) and 5.48
 * (`@strapi/core/dist/services/server/compose-endpoint.js`), identical in both:
 *
 *   the `config/middlewares` stack (app-level, before the router)
 *   → authenticate → authorize → the route's policies → the route's middlewares → the handler.
 *
 * Every step says whether DevKit found what it names the way Strapi will (`ok`), found
 * it only under another name Strapi won't try (`not-found-by-strapi`: Strapi throws at
 * startup), didn't find it (`unknown`), or can't tell (`unverified`, `unread`, `inline`).
 */

import { join } from '../fs/paths';
import type { GlobalMiddlewares } from '../index/globalMiddlewares';
import { autoCrudActions, CORE_ACTION_SET } from '../model/constants';
import { INLINE_ENTRY, type RouteInfo, type StrapiProject, type TargetLocation, UNREAD_ENTRY } from '../model/types';
import { isFrameworkRef, parseHandlerRef } from '../model/uid';
import { isVerifiablePlugin } from '../plugins/merge';
import { lookupStrapiName, type RouteOwner, ownerOf, type ScopedKind, whyNotFound } from '../resolve/strapiNames';

export type StepStatus = 'ok' | 'not-found-by-strapi' | 'unknown' | 'unverified' | 'unread' | 'inline';

export interface PipelineStep {
  phase: 'global-middleware' | 'auth' | 'policy' | 'route-middleware' | 'handler';
  /** As written in the code (a name, a `resolve` path, `<inline>`, `<unread>`), or the auth summary. */
  name: string;
  status: StepStatus;
  /** What DevKit resolved it to, when it differs from `name` (`global::x`, a qualified handler). */
  ref?: string;
  /** Where it is defined (may be in node_modules: read-only). */
  target?: TargetLocation;
  /** Where it is written: the `config/middlewares` entry, the route declaration. */
  declaredAt?: TargetLocation;
  /** One plain sentence: why a status, what the auth step means, a core action. */
  note?: string;
}

export interface RoutePipeline {
  /** The `config/middlewares` stack this pipeline starts with (see {@link GlobalMiddlewares}). */
  global: Pick<GlobalMiddlewares, 'status' | 'file' | 'envFiles'>;
  steps: PipelineStep[];
}

/** A route's handler, qualified the way Strapi does (`page.find` in api::page → `api::page.page.find`). */
export function qualifiedHandler(route: Pick<RouteInfo, 'handler' | 'owner'>): string {
  const h = route.handler;
  return h.includes('::') || !route.owner || h === INLINE_ENTRY ? h : `${route.owner}.${h}`;
}

/**
 * Whether `query` designates the route path `routePath`: the same pattern, a concrete
 * URL it serves (`/api/articles/12` for `/api/articles/:id`), or a part of it.
 */
export function pathMatches(routePath: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  if (routePath === q || routePath.toLowerCase().includes(q.toLowerCase())) return true;
  const re = routePath
    .split('/')
    .map((seg) => (seg.startsWith(':') ? (seg.endsWith('?') ? '[^/]*' : '[^/]+') : seg === '*' || seg === '(.*)' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${re}/?$`).test(q.split('?')[0]!);
}

/** Every route by the controller action it calls (`api::article.article.find` → routes). */
export function routesByAction(routes: readonly RouteInfo[]): Map<string, RouteInfo[]> {
  const out = new Map<string, RouteInfo[]>();
  for (const r of routes) {
    if (r.handler === INLINE_ENTRY) continue;
    const key = qualifiedHandler(r);
    const list = out.get(key);
    if (list) list.push(r);
    else out.set(key, [r]);
  }
  return out;
}

/** The ordered pipeline of `route` (its `global` stack read once per project with `readGlobalMiddlewares`). */
export function routePipeline(project: StrapiProject, route: RouteInfo, global: GlobalMiddlewares): RoutePipeline {
  const owner = ownerOf(route.owner);
  const steps: PipelineStep[] = [];
  for (const e of global.entries) {
    const declaredAt = global.file ? { declaredAt: { filePath: global.file, offset: e.offset } } : {};
    if (e.form === 'name') steps.push({ phase: 'global-middleware', ...scoped(project, 'middleware', e.name, {}, true), ...declaredAt });
    else if (e.form === 'resolve') steps.push({ phase: 'global-middleware', name: e.name, ...resolvedPath(project, e.name), ...declaredAt });
    else steps.push({ phase: 'global-middleware', name: e.name, status: e.form === 'inline' ? 'inline' : 'unread', ...declaredAt });
  }
  const at = route.filePath ? { declaredAt: { filePath: route.filePath, offset: route.offset ?? 0 } } : {};
  steps.push({ ...authStep(project, route), ...at });
  for (const p of route.policies ?? []) steps.push({ phase: 'policy', ...entry(project, 'policy', p, owner), ...at });
  for (const m of route.middlewares ?? []) steps.push({ phase: 'route-middleware', ...entry(project, 'middleware', m, owner), ...at });
  steps.push({ ...handlerStep(project, route), ...at });
  return { global: { status: global.status, file: global.file, envFiles: global.envFiles }, steps };
}

type Resolved = Omit<PipelineStep, 'phase'>;

function entry(project: StrapiProject, kind: ScopedKind, name: string, owner: RouteOwner): Resolved {
  if (name === INLINE_ENTRY) return { name, status: 'inline', note: 'Declared as a function in the route.' };
  if (name === UNREAD_ENTRY) return { name, status: 'unread', note: 'Not a literal: DevKit cannot read it statically.' };
  return scoped(project, kind, name, owner, false);
}

/** A policy or middleware by name, looked up the way Strapi does. */
function scoped(project: StrapiProject, kind: ScopedKind, name: string, owner: RouteOwner, appLevel: boolean): Resolved {
  const idx = project.index;
  if (name.startsWith('strapi::') && kind === 'middleware') {
    const fw = idx.frameworkMiddlewares;
    if (!fw) return { name, status: 'unverified', note: "Strapi's built-in middlewares were not read (is Strapi installed?)." };
    const def = fw.get(name);
    return def ? { name, status: 'ok', target: { filePath: def.filePath, offset: def.offset } } : { name, status: 'unknown', note: `Not a built-in middleware of the installed Strapi.` };
  }
  if (isFrameworkRef(name)) return { name, status: 'unverified', note: 'Registered by Strapi itself: not checked.' };
  const map = kind === 'policy' ? idx.policies : idx.middlewares;
  const pluginOf = (ref: string): string | undefined => (ref.startsWith('plugin::') ? ref.slice(8, ref.indexOf('.')) : undefined);
  const named = pluginOf(name) ?? (name.includes('::') ? undefined : owner.plugin);
  const found = lookupStrapiName((k) => map.has(k), kind, name, owner);
  if (found.status === 'found') {
    const a = map.get(found.ref)!;
    return { name, status: 'ok', ...(found.ref !== name ? { ref: found.ref } : {}), target: { filePath: a.filePath, offset: a.defOffset ?? 0 } };
  }
  if (found.status === 'not-found-by-strapi') {
    const a = map.get(found.ref)!;
    return {
      name,
      status: 'not-found-by-strapi',
      ref: found.ref,
      target: { filePath: a.filePath, offset: a.defOffset ?? 0 },
      note: `${whyNotFound(kind, name, owner)}: Strapi throws at startup. Use \`${found.ref}\`.`,
    };
  }
  if (named && !isVerifiablePlugin(idx, named)) return { name, status: 'unverified', note: `The plugin \`${named}\` is not verified by DevKit: its ${kind === 'policy' ? 'policies' : 'middlewares'} aren't checked.` };
  return { name, status: 'unknown', note: appLevel ? `No middleware \`${name}\` is registered: Strapi throws at startup.` : `No ${kind} \`${name}\` found where Strapi looks: it throws at startup.` };
}

/** A `{ resolve: './path' }` stack entry (a path from the project, or a package name). */
function resolvedPath(project: StrapiProject, path: string): Omit<Resolved, 'name'> {
  if (path.startsWith('.') || path.startsWith('/')) {
    return { status: 'unverified', target: { filePath: join(project.root, path) }, note: 'Loaded from this path at startup (relative to the built app).' };
  }
  return { status: 'unverified', note: 'A package resolved at startup.' };
}

function authStep(project: StrapiProject, route: RouteInfo): PipelineStep {
  const a = route.auth ?? (route.public ? { mode: 'public' as const } : undefined);
  if (a?.mode === 'public') {
    return { phase: 'auth', name: 'Public', status: 'ok', note: '`auth: false`: Strapi skips authenticate and authorize — anyone can call it.' };
  }
  if (a?.mode === 'unread') {
    return { phase: 'auth', name: 'Not read', status: 'unread', note: '`config.auth` is not a literal: DevKit cannot read it statically.' };
  }
  if (a?.mode === 'custom') {
    const parts = [a.strategies?.length ? `strategies ${a.strategies.join(', ')}` : '', a.scope?.length ? `scope ${a.scope.join(', ')}` : ''].filter(Boolean);
    return { phase: 'auth', name: 'Custom', status: 'ok', note: `\`config.auth\`: ${parts.join('; ') || 'an object'}. Access then depends on the permissions set in the admin.` };
  }
  if (route.type === 'admin') {
    return { phase: 'auth', name: 'Admin', status: 'ok', note: 'Admin panel authentication: access depends on the admin role permissions.' };
  }
  const up = project.index.installedPlugins?.has('users-permissions') || project.index.pluginNames.has('users-permissions');
  return {
    phase: 'auth',
    name: 'Default',
    status: 'ok',
    note: up
      ? "API tokens, or users-permissions — which also lets anonymous requests through with the Public role. Access depends on the role's or token's permissions, set in the admin."
      : "The content API's authentication strategies (API tokens, …). Access depends on the permissions set in the admin.",
  };
}

function handlerStep(project: StrapiProject, route: RouteInfo): PipelineStep {
  if (route.handler === INLINE_ENTRY) return { phase: 'handler', name: route.handler, status: 'inline', note: 'A function declared in the route.' };
  const qualified = qualifiedHandler(route);
  const step = (s: Resolved): PipelineStep => ({ phase: 'handler', ...s, ...(qualified !== route.handler ? { ref: qualified } : {}) });
  if (isFrameworkRef(qualified)) return step({ name: route.handler, status: 'unverified', note: 'Registered by Strapi itself: not checked.' });
  const h = parseHandlerRef(qualified);
  if (!h) return step({ name: route.handler, status: 'unknown', note: 'Not a `<controller>.<action>` handler.' });
  const plugin = h.parsed.namespace === 'plugin' ? h.parsed.scope : undefined;
  if (plugin && !isVerifiablePlugin(project.index, plugin)) {
    return step({ name: route.handler, status: 'unverified', note: `The plugin \`${plugin}\` is not verified by DevKit: its controllers aren't checked.` });
  }
  const controller = project.index.controllers.get(h.controllerRef);
  if (controller) {
    const action = controller.actions?.find((a) => a.name === h.action);
    if (action) return step({ name: route.handler, status: 'ok', target: { filePath: action.filePath ?? controller.filePath, offset: action.offset } });
    if (CORE_ACTION_SET.has(h.action)) {
      return step({ name: route.handler, status: 'ok', target: { filePath: controller.filePath, offset: controller.defOffset ?? 0 }, note: `Core action \`${h.action}\` of \`createCoreController\`, not overridden.` });
    }
    if (controller.hasSpread) return step({ name: route.handler, status: 'unverified', target: { filePath: controller.filePath, offset: controller.defOffset ?? 0 }, note: 'The controller spreads another object: its action list is partial.' });
    return step({ name: route.handler, status: 'unknown', target: { filePath: controller.filePath, offset: controller.defOffset ?? 0 }, note: `No action \`${h.action}\` on \`${h.controllerRef}\`.` });
  }
  const ct = project.index.contentTypes.get(h.controllerRef);
  if (ct) {
    const actions = autoCrudActions(ct);
    if (!actions.size) return step({ name: route.handler, status: 'unverified', note: "A plugin content-type: its controller is the plugin's own, not read." });
    if (actions.has(h.action)) {
      return step({ name: route.handler, status: 'ok', target: { filePath: ct.schemaPath }, note: `Core action \`${h.action}\`: no controller file, Strapi generates it from the content-type.` });
    }
  }
  return step({ name: route.handler, status: 'unknown', note: `No controller \`${h.controllerRef}\`.` });
}
