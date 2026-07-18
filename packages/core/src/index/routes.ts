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

function parseCustomRoutes(obj: ts.ObjectLiteralExpression): RouteInfo[] {
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
    const route: RouteInfo = { method, path, handler, source: 'router-file' };
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

function synthesizeCrud(cr: CoreRouter, project: StrapiProject): RouteInfo[] {
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
    if (cfg?.policies?.length) route.policies = cfg.policies;
    if (cfg?.middlewares?.length) route.middlewares = cfg.middlewares;
    return route;
  });
}

function routesOfFile(filePath: string, text: string, project: StrapiProject): RouteInfo[] {
  const expr = exportExpression(parseSource(filePath, text));
  if (!expr) return [];
  if (ts.isCallExpression(expr) && isCalleeNamed(expr, 'createCoreRouter')) {
    const cr = parseCoreRouter(expr);
    return cr ? synthesizeCrud(cr, project) : [];
  }
  if (ts.isObjectLiteralExpression(expr)) return parseCustomRoutes(expr);
  return [];
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

/** The HTTP route table of a project (static parse of `src/api/<api>/routes/*`). */
export async function listRoutes(fs: FileSystem, project: StrapiProject): Promise<RouteInfo[]> {
  const out: RouteInfo[] = [];
  const apiDir = join(project.srcDir, 'api');
  for (const api of await entries(fs, apiDir)) {
    if (api.type !== FileType.Directory) continue;
    const routesDir = join(apiDir, api.name, 'routes');
    for (const f of await entries(fs, routesDir)) {
      if (f.type !== FileType.File || !ROUTE_FILE.test(f.name) || f.name.endsWith('.d.ts')) continue;
      const file = join(routesDir, f.name);
      try {
        out.push(...routesOfFile(file, await fs.readFile(file), project));
      } catch {
        /* unreadable route file — skip */
      }
    }
  }
  return out;
}
