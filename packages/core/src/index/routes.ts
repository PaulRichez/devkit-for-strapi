/**
 * Static route table: parse `src/api/<api>/routes/*` files into a list of HTTP
 * routes — both **explicit** routes (`export default { routes: [...] }`) and the
 * **auto-CRUD** routes Strapi generates from `createCoreRouter('api::x.x')`
 * (synthesized from the content-type's `pluralName`). Purely static — never
 * boots Strapi (a CLI/runtime "exact resolution" mode incl. plugin routes is a
 * separate, opt-in concern). *Garantir* : implicit CRUD paths are an
 * approximation when `pluralName` is absent.
 */

import ts from 'typescript';
import { isCalleeNamed, literalText, parseSource } from '../analyze/parse';
import type { FileSystem } from '../fs/FileSystem';
import { FileType } from '../fs/FileSystem';
import { join } from '../fs/paths';
import { CORE_ACTIONS } from '../model/constants';
import type { RouteInfo, StrapiProject } from '../model/types';
import { StaticEvaluator } from '../plugins/evaluate';
import { type PluginRoute, readApiPrefix, readPluginRoutes } from '../plugins/installed';
import { pluginLayoutOf } from './indexer';

interface CoreRouter {
  uid: string;
  perAction: Map<string, { policies?: string[]; middlewares?: string[] }>;
  only?: string[];
  except?: string[];
  prefix?: string;
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'exports' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module'
  );
}

/** The `export default <expr>` / `module.exports = <expr>` value, if any. */
function exportExpression(sf: ts.SourceFile): ts.Expression | undefined {
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt)) return stmt.expression;
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(stmt.expression.left)
    ) {
      return stmt.expression.right;
    }
  }
  return undefined;
}

function propName(p: ts.PropertyAssignment): string | undefined {
  return ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) ? p.name.text : undefined;
}

function findProp(obj: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  for (const p of obj.properties) if (ts.isPropertyAssignment(p) && propName(p) === name) return p;
  return undefined;
}

function strProp(obj: ts.ObjectLiteralExpression, name: string): string | undefined {
  const p = findProp(obj, name);
  return p ? literalText(p.initializer) : undefined;
}

function objProp(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralExpression | undefined {
  const p = findProp(obj, name);
  return p && ts.isObjectLiteralExpression(p.initializer) ? p.initializer : undefined;
}

/** A string array, accepting both `'x'` and `{ name: 'x' }` elements (policy/mw forms). */
function strArrayProp(obj: ts.ObjectLiteralExpression, name: string): string[] | undefined {
  const p = findProp(obj, name);
  if (!p || !ts.isArrayLiteralExpression(p.initializer)) return undefined;
  const out: string[] = [];
  for (const el of p.initializer.elements) {
    const s = literalText(el);
    if (s !== undefined) out.push(s);
    else if (ts.isObjectLiteralExpression(el)) {
      const n = strProp(el, 'name');
      if (n) out.push(n);
    }
  }
  return out;
}

function parseCustomRoutes(obj: ts.ObjectLiteralExpression, filePath: string, sf: ts.SourceFile): RouteInfo[] {
  const routesProp = findProp(obj, 'routes');
  if (!routesProp || !ts.isArrayLiteralExpression(routesProp.initializer)) return [];
  const out: RouteInfo[] = [];
  for (const el of routesProp.initializer.elements) {
    if (!ts.isObjectLiteralExpression(el)) continue;
    const method = strProp(el, 'method');
    const path = strProp(el, 'path');
    const handler = strProp(el, 'handler');
    if (!method || !path || !handler) continue;
    const config = objProp(el, 'config');
    const route: RouteInfo = { method, path, handler, source: 'router-file', filePath, offset: el.getStart(sf) };
    const auth = config && findProp(config, 'auth');
    if (auth && auth.initializer.kind === ts.SyntaxKind.FalseKeyword) route.public = true;
    const policies = config && strArrayProp(config, 'policies');
    const middlewares = config && strArrayProp(config, 'middlewares');
    if (policies?.length) route.policies = policies;
    if (middlewares?.length) route.middlewares = middlewares;
    out.push(route);
  }
  return out;
}

function parseCoreRouter(call: ts.CallExpression): CoreRouter | undefined {
  const uid = literalText(call.arguments[0]);
  if (!uid) return undefined;
  const cr: CoreRouter = { uid, perAction: new Map() };
  const opts = call.arguments[1];
  if (opts && ts.isObjectLiteralExpression(opts)) {
    cr.only = strArrayProp(opts, 'only');
    cr.except = strArrayProp(opts, 'except');
    cr.prefix = strProp(opts, 'prefix');
    const config = objProp(opts, 'config');
    if (config) {
      for (const action of CORE_ACTIONS) {
        const ac = objProp(config, action);
        if (ac) cr.perAction.set(action, { policies: strArrayProp(ac, 'policies'), middlewares: strArrayProp(ac, 'middlewares') });
      }
    }
  }
  return cr;
}

const COLLECTION_CRUD: { action: string; method: string; suffix: string }[] = [
  { action: 'find', method: 'GET', suffix: '' },
  { action: 'findOne', method: 'GET', suffix: '/:id' },
  { action: 'create', method: 'POST', suffix: '' },
  { action: 'update', method: 'PUT', suffix: '/:id' },
  { action: 'delete', method: 'DELETE', suffix: '/:id' },
];
// A singleType has no `:id` resource: only find/update/delete on the singular path.
const SINGLE_TYPE_CRUD: { action: string; method: string; suffix: string }[] = [
  { action: 'find', method: 'GET', suffix: '' },
  { action: 'update', method: 'PUT', suffix: '' },
  { action: 'delete', method: 'DELETE', suffix: '' },
];

function synthesizeCrud(cr: CoreRouter, project: StrapiProject, filePath?: string, offset?: number): RouteInfo[] {
  const ct = project.index.contentTypes.get(cr.uid);
  const single = ct?.kind === 'singleType';
  const name = single
    ? (ct?.info.singularName ?? ct?.ctName)
    : (ct?.info.pluralName ?? ct?.ctName);
  const base = `${cr.prefix ?? ''}/${name ?? (cr.uid.split('.').pop() ?? cr.uid)}`;
  return (single ? SINGLE_TYPE_CRUD : COLLECTION_CRUD).filter(
    (r) => (!cr.only || cr.only.includes(r.action)) && (!cr.except || !cr.except.includes(r.action)),
  ).map((r) => {
    const cfg = cr.perAction.get(r.action);
    const route: RouteInfo = { method: r.method, path: base + r.suffix, handler: `${cr.uid}.${r.action}`, source: 'core-router' };
    if (filePath !== undefined) route.filePath = filePath;
    if (offset !== undefined) route.offset = offset;
    if (cfg?.policies?.length) route.policies = cfg.policies;
    if (cfg?.middlewares?.length) route.middlewares = cfg.middlewares;
    return route;
  });
}

function routesOfFile(filePath: string, text: string, project: StrapiProject): RouteInfo[] {
  const sf = parseSource(filePath, text);
  let expr = exportExpression(sf);
  // `const customRoutes = { routes: [...] }; export default customRoutes;` — follow a
  // top-level const of the same file (the only indirection Strapi route files use).
  if (expr && ts.isIdentifier(expr)) expr = localConstInitializer(sf, expr.text);
  if (!expr) return [];
  if (ts.isCallExpression(expr) && isCalleeNamed(expr, 'createCoreRouter')) {
    const cr = parseCoreRouter(expr);
    return cr ? synthesizeCrud(cr, project, filePath, expr.getStart(sf)) : [];
  }
  if (ts.isObjectLiteralExpression(expr)) return parseCustomRoutes(expr, filePath, sf);
  return [];
}

/** The initializer of a top-level `const`/`let`/`var <name> = …` in `sf`, if unique. */
function localConstInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  let count = 0;
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
        found = d.initializer;
        count++;
      }
    }
  }
  if (count !== 1 || !found) return undefined;
  while (ts.isParenthesizedExpression(found) || ts.isAsExpression(found) || ts.isSatisfiesExpression(found)) found = found.expression;
  return found;
}

/** Mount a route path under a prefix the way koa-router does (no `//`, no trailing `/`). */
function mountPath(...parts: string[]): string {
  let p = parts.join('').replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

function fromPluginRoute(r: PluginRoute, origin: 'local-plugin' | 'installed-plugin'): RouteInfo {
  const route: RouteInfo = {
    method: r.method,
    path: r.path,
    handler: r.handler ?? '<inline>',
    source: 'plugin',
    fullPath: r.fullPath,
    type: r.type,
    owner: `plugin::${r.plugin}`,
    origin,
  };
  if (r.policies.length) route.policies = r.policies;
  if (r.middlewares.length) route.middlewares = r.middlewares;
  if (r.public) route.public = true;
  if (r.loc) {
    route.filePath = r.loc.file;
    route.offset = r.loc.pos;
  }
  return route;
}

const ENTRY_NAMES = ['index.ts', 'index.js', 'index.mts', 'index.mjs', 'index.cts', 'index.cjs'];

/** The source entry of a local plugin's server (source first: it is what the developer edits). */
async function localPluginEntry(fs: FileSystem, srcDir: string, name: string): Promise<string | undefined> {
  const base = join(srcDir, 'plugins', name);
  const layout = await pluginLayoutOf(fs, srcDir, name);
  const dirs = layout === 'root' ? [base] : [join(base, layout)];
  for (const d of dirs) {
    for (const n of ENTRY_NAMES) {
      const p = join(d, n);
      if ((await fs.stat(p))?.type === FileType.File) return p;
    }
  }
  for (const n of ['strapi-server.ts', 'strapi-server.js', 'strapi-server.mjs', 'strapi-server.cjs']) {
    const p = join(base, n);
    if ((await fs.stat(p))?.type === FileType.File) return p;
  }
  return undefined;
}

export interface ListRoutesOptions {
  /** Include routes declared by local and installed plugins (default true). */
  plugins?: boolean;
  /** Include `admin`-type routes (the admin panel's own API; default false). */
  admin?: boolean;
}

// Aligned with the reference walk's EXT and the indexer's CODE_EXT (incl. .mts/.cts)
// so list_routes and the reference index agree on which files are route modules.
const ROUTE_FILE = /\.(mts|cts|ts|js|mjs|cjs)$/;

async function entries(fs: FileSystem, dir: string): Promise<{ name: string; type: FileType }[]> {
  try {
    return await fs.readDirectory(dir);
  } catch {
    return [];
  }
}

/** One auto-CRUD route handler synthesized from a `createCoreRouter` call. */
export interface CoreRouterHandlerRef {
  uid: string;
  action: string;
  /** Char range of the UID string contents (where find-references should point). */
  start: number;
  end: number;
}

/** Actions a `singleType` auto-router serves — no `:id` resource → no findOne/create. */
const SINGLE_TYPE_ACTIONS: ReadonlySet<string> = new Set(SINGLE_TYPE_CRUD.map((r) => r.action));

/**
 * Auto-CRUD route handlers (`api::x.x.find`, …) implied by `createCoreRouter`
 * calls in a file — they have no explicit string in the source, so the
 * reference index synthesizes them here so `find_references` / CodeLens /
 * `list_unused` count an overridden core action as actually served.
 * `project` (when given) makes the action set **kind-aware**: a `singleType`
 * has no `findOne`/`create` route, so synthesizing them would fabricate refs
 * to handlers that never exist (same rule as {@link synthesizeCrud}).
 */
export function collectCoreRouterHandlers(filePath: string, text: string, project?: StrapiProject): CoreRouterHandlerRef[] {
  const sf = parseSource(filePath, text);
  const out: CoreRouterHandlerRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isCalleeNamed(node, 'createCoreRouter')) {
      const cr = parseCoreRouter(node);
      const arg0 = node.arguments[0];
      if (cr && arg0 && ts.isStringLiteralLike(arg0)) {
        const start = arg0.getStart(sf) + 1; // inside the quotes
        const end = arg0.getEnd() - 1;
        const single = project?.index.contentTypes.get(cr.uid)?.kind === 'singleType';
        for (const action of CORE_ACTIONS) {
          if (single && !SINGLE_TYPE_ACTIONS.has(action)) continue;
          if ((cr.only && !cr.only.includes(action)) || cr.except?.includes(action)) continue;
          out.push({ uid: cr.uid, action, start, end });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * The HTTP route table of a project: its own API routes (static parse of
 * `src/api/<api>/routes/*`, auto-CRUD synthesized from `createCoreRouter`) and,
 * unless `plugins: false`, the routes local and installed plugins declare —
 * each with its declaration location and mounted path. Never boots Strapi.
 */
export async function listRoutes(fs: FileSystem, project: StrapiProject, opts: ListRoutesOptions = {}): Promise<RouteInfo[]> {
  const out: RouteInfo[] = [];
  const prefix = project.installed ? project.installed.apiPrefix : await readApiPrefix(fs, project.root, new StaticEvaluator(fs, { roots: [project.root] }));
  const apiDir = join(project.srcDir, 'api');
  for (const api of await entries(fs, apiDir)) {
    if (api.type !== FileType.Directory) continue;
    const routesDir = join(apiDir, api.name, 'routes');
    for (const f of await entries(fs, routesDir)) {
      if (f.type !== FileType.File || !ROUTE_FILE.test(f.name) || f.name.endsWith('.d.ts')) continue;
      const file = join(routesDir, f.name);
      try {
        for (const r of routesOfFile(file, await fs.readFile(file), project)) {
          r.owner = `api::${api.name}`;
          r.type = 'content-api';
          r.origin = 'project';
          if (prefix !== undefined) r.fullPath = mountPath(prefix, r.path);
          out.push(r);
        }
      } catch {
        /* unreadable route file — skip */
      }
    }
  }

  // Strapi 4 i18n adds `POST …/localizations` to every localized content-type's core router.
  if (project.version === 4 && project.installed?.plugins.some((p) => p.name === 'i18n')) {
    for (const r of [...out]) {
      if (r.source !== 'core-router' || r.method !== 'GET' || !r.handler.endsWith('.find')) continue;
      const uid = r.handler.slice(0, -'.find'.length);
      const ct = project.index.contentTypes.get(uid);
      if (!ct?.i18nLocalized) continue;
      const path = ct.kind === 'singleType' ? `${r.path}/localizations` : `${r.path}/:id/localizations`;
      const injected: RouteInfo = { ...r, method: 'POST', path, handler: `${uid}.createLocalization`, source: 'plugin-injected' };
      delete injected.policies;
      delete injected.middlewares;
      if (prefix !== undefined) injected.fullPath = mountPath(prefix, path);
      out.push(injected);
    }
  }

  if (opts.plugins !== false) {
    for (const name of [...project.index.pluginNames].sort()) {
      const entry = await localPluginEntry(fs, project.srcDir, name);
      if (!entry) continue;
      try {
        const { routes } = await readPluginRoutes(fs, name, entry, prefix, join(project.srcDir, 'plugins', name));
        out.push(...routes.map((r) => fromPluginRoute(r, 'local-plugin')));
      } catch {
        /* unreadable plugin — skip */
      }
    }
    for (const p of project.installed?.plugins ?? []) {
      if (project.index.pluginNames.has(p.name)) continue; // a local plugin of that name wins
      out.push(...p.routes.map((r) => fromPluginRoute(r, 'installed-plugin')));
    }
  }
  return opts.admin ? out : out.filter((r) => r.type !== 'admin');
}
