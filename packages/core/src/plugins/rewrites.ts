/**
 * Runtime rewrites of plugins by code DevKit doesn't evaluate — the project's
 * own `src/**`, local plugins (wherever `resolve` puts them), other plugins'
 * server code: a write into `strapi.plugin('x').controllers`, a registry
 * `.add/.set/.extend`, a plugin handle handed to code that may write into it…
 *
 * Syntactic and conservative: plugin handles are followed through aliases
 * (declared, assigned, destructured, defaulted, returned by a named function),
 * and any flow it can't follow (a handle passed to a call, stored in an object,
 * exported) counts as a rewrite. A rewritten plugin is no longer verifiable.
 */

import ts from 'typescript';
import { scriptKindFor } from '../analyze/parse';
import { type FileSystem, FileType } from '../fs/FileSystem';
import { join, normalize } from '../fs/paths';
import { readPluginsConfig, type PluginsConfig } from './config';
import { resolveDots } from './evaluate';

/** What some code rewrites at runtime in plugins. */
export interface PluginRewrites {
  /** Plugins whose collections gain/lose entries (`'*'`: not literal) — no longer exhaustive. */
  plugins: Set<string>;
  /** Artifacts/content-types extended in place (`'*'`: not literal) — their method/attribute lists are partial. */
  artifacts: Set<string>;
}

/** The project-side scan: one entry per file that rewrites something. */
export interface ProjectRewrites {
  files: Map<string, PluginRewrites>;
  /** Directories scanned: `src` and every local plugin `resolve`d outside it. */
  dirs: string[];
  /** Not every file could be scanned (file limit, a non-literal `resolve`): anything may be rewritten. */
  truncated: boolean;
}

/** Plugin collections a write can extend (`strapi.plugin('x').controllers.y = …`). */
const COLLECTION_KEYS = new Set(['controllers', 'services', 'routes', 'policies', 'middlewares', 'contentTypes', 'content-types']);
const REGISTRIES = new Set(['content-types', 'controllers', 'services', 'policies', 'middlewares']);
const WRITE_METHODS = new Set(['push', 'unshift', 'splice', 'set', 'add', 'extend', 'assign', 'merge', 'defineProperty', 'pop', 'shift', 'delete', 'clear']);
/** `strapi.controller('plugin::x.y')`, `plugin.service('y')`… */
const GETTERS = new Set(['controller', 'service', 'policy', 'middleware', 'contentType']);
/** External calls that only read what they're handed (by full name, or by lodash-style member name). */
const READ_ONLY_CALLS = /^(console\.\w+|JSON\.stringify|Object\.(keys|isFrozen|getOwnPropertyNames)|Array\.isArray|String|Number|Boolean|require)$/;
const PURE_READERS = new Set(['keys', 'keysIn', 'has', 'hasIn', 'isEmpty', 'size', 'isNil', 'isNull', 'isUndefined', 'isObject', 'isPlainObject', 'isFunction', 'isString', 'isArray', 'includes']);
/** External utilities that write into their first argument (by member name). */
const MUTATOR_NAMES = new Set(['assign', 'assignIn', 'assignWith', 'assignInWith', 'extend', 'extendWith', 'merge', 'mergeWith', 'defaults', 'defaultsDeep', 'set', 'setWith', 'unset', 'update', 'updateWith', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'deleteProperty', 'remove', 'pull', 'pullAll', 'pullAt']);
/** External calls returning the members of what they're handed: `Object.values(strapi.plugins)`. */
const MEMBER_CALLS = new Set(['values', 'entries', 'toPairs', 'filter', 'find', 'groupBy', 'keyBy', 'pickBy', 'omitBy', 'pick', 'omit', 'freeze', 'from', 'get', 'sortBy', 'orderBy', 'uniq', 'compact', 'flatten']);
/** Array/lodash iteration methods: their callback's first parameter is a member. */
const ITERATORS = new Set(['forEach', 'map', 'filter', 'find', 'findLast', 'some', 'every', 'flatMap', 'each', 'forOwn', 'forIn', 'mapValues', 'sortBy', 'groupBy', 'keyBy']);

/** Cheap text pre-filter: can this file touch a plugin at all? */
// Only syntax that can yield a plugin handle: `.plugin(` / `['plugin']`, a bare or destructured
// `plugin`, `plugins`, a getter call (`service(`…), a registry `.get('controllers')`.
export const MAY_REWRITE_PLUGINS =
  /\.plugins?\b|\[\s*['"`]plugins?['"`]\s*\]|\bplugin\s*[(:,}]|[{,]\s*plugin\b|\bplugins\b|\b(controller|service|policy|middleware|contentType)\s*\(|\.get\(\s*['"`](content-types|controllers|services|policies|middlewares)['"`]/;

/** Files above this size aren't parsed — they count as rewriting anything. */
const MAX_FILE_BYTES = 2_000_000;
export const REWRITE_SCAN_LIMIT = 5_000;

type Handle = {
  /** `member`: something inside a collection (an artifact, a route) reached by key or iteration. */
  kind: 'plugin' | 'collection' | 'member' | 'artifact' | 'plugins';
  plugin: string;
  ref?: string;
  /** `ct:` for a content-type (its attributes), `''` for a code artifact (its methods). */
  ns?: string;
  /** `strapi.service(uid)` with a computed UID: any artifact of any plugin (or of the API). */
  dynamic?: boolean;
};

const isAssignOp = (k: ts.SyntaxKind): boolean => k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment;

function strip(e: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e) ||
    ts.isAwaitExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function keyOf(e: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) return e.argumentExpression.text;
  return undefined;
}

function propKey(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

/** The name a function is called by (declaration, bound variable, method / property key). */
function nameOfFunction(fn: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name.text;
  if (ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)) return propKey(fn.name);
  let x: ts.Node = fn;
  while (x.parent && ts.isParenthesizedExpression(x.parent)) x = x.parent;
  const p = x.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && p.initializer === x) return propKey(p.name);
  if (p && ts.isBinaryExpression(p) && p.right === x && ts.isIdentifier(p.left)) return p.left.text;
  return undefined;
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  switch (n.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.Constructor:
      return true;
    default:
      return false;
  }
}

/** A node that can declare names: a function, a block, a file, a loop's / catch's own binding. */
function isScopeNode(n: ts.Node): boolean {
  switch (n.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.FunctionExpression:
    case ts.SyntaxKind.ArrowFunction:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
    case ts.SyntaxKind.Constructor:
    case ts.SyntaxKind.Block:
    case ts.SyntaxKind.SourceFile:
    case ts.SyntaxKind.ModuleBlock:
    case ts.SyntaxKind.CaseClause:
    case ts.SyntaxKind.DefaultClause:
    case ts.SyntaxKind.ForStatement:
    case ts.SyntaxKind.ForOfStatement:
    case ts.SyntaxKind.ForInStatement:
    case ts.SyntaxKind.CatchClause:
      return true;
    default:
      return false;
  }
}

function calleeText(e0: ts.Expression): string | undefined {
  const e = strip(e0);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return `${e.expression.text}.${e.name.text}`;
  return undefined;
}

/**
 * What a source file rewrites at runtime in plugins. Variables are resolved to
 * their declarations (scopes); a function returning a handle is known by name.
 * `trace` reports each rewrite with the node that caused it (diagnostics).
 */
export function pluginWriteTargets(sf: ts.SourceFile, trace?: (what: string, at: ts.Node) => void): PluginRewrites {
  const out: PluginRewrites = { plugins: new Set(), artifacts: new Set() };
  let changed = true;

  // --- scopes ----------------------------------------------------------------
  const scopeDecls = new Map<ts.Node, Map<string, ts.Node>>();
  /** Declarations a scope node introduces: its own let/const/function/class/import, plus every `var` of a function body / file. */
  const declsOf = (n: ts.Node): Map<string, ts.Node> => {
    let m = scopeDecls.get(n);
    if (m) return m;
    m = new Map();
    const map = m;
    const put = (name: ts.BindingName, decl: ts.Node): void => {
      for (const id of bindingIds(name)) if (!map.has(id.text)) map.set(id.text, decl);
    };
    const isVarScope = ts.isSourceFile(n) || (n.parent !== undefined && isFunctionLike(n.parent) && (n.parent as ts.FunctionLikeDeclaration).body === n);
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      for (const st of n.statements) {
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) put(d.name, d);
        if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) map.set(st.name.text, st);
        if (ts.isImportDeclaration(st) && st.importClause) {
          const ic = st.importClause;
          if (ic.name) map.set(ic.name.text, ic);
          const nb = ic.namedBindings;
          if (nb && ts.isNamespaceImport(nb)) map.set(nb.name.text, nb);
          if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) map.set(el.name.text, el);
        }
      }
    }
    if (isVarScope) {
      // `var` anywhere inside (not in nested functions) belongs here
      const walkVars = (x: ts.Node): void => {
        if (isFunctionLike(x) || ts.isClassLike(x)) return;
        if (ts.isVariableDeclarationList(x) && !(x.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) for (const d of x.declarations) put(d.name, d);
        ts.forEachChild(x, walkVars);
      };
      ts.forEachChild(n, walkVars);
    }
    if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) put(d.name, d);
    }
    if (ts.isCatchClause(n) && n.variableDeclaration) put(n.variableDeclaration.name, n.variableDeclaration);
    scopeDecls.set(n, m);
    return m;
  };
  const declCache = new Map<ts.Identifier, ts.Node | null>();
  const scopeResolution = new Map<ts.Node, Map<string, ts.Node | null>>();
  /** `name` as seen from scope node `n` (inclusive) outward — memoized per scope. */
  const resolveIn = (n: ts.Node, name: string): ts.Node | undefined => {
    let m = scopeResolution.get(n);
    if (!m) scopeResolution.set(n, (m = new Map()));
    const hit = m.get(name);
    if (hit !== undefined) return hit ?? undefined;
    let found: ts.Node | undefined;
    if (isFunctionLike(n)) {
      for (const p of n.parameters) if (bindsName(p.name, name)) found = p;
      if (!found && (ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n.name?.text === name) found = n;
    }
    if (!found) found = declsOf(n).get(name);
    if (!found) {
      let p = n.parent;
      while (p && !isScopeNode(p)) p = p.parent;
      if (p) found = resolveIn(p, name);
    }
    m.set(name, found ?? null);
    return found;
  };
  /** The declaration an identifier refers to (innermost scope first); undefined for a global. */
  const declarationOf = (id: ts.Identifier): ts.Node | undefined => {
    const hit = declCache.get(id);
    if (hit !== undefined) return hit ?? undefined;
    let n: ts.Node | undefined = id.parent;
    while (n && !isScopeNode(n)) n = n.parent;
    const found = n ? resolveIn(n, id.text) : undefined;
    declCache.set(id, found ?? null);
    return found;
  };
  const scopeKey = (id: ts.Identifier): ts.Node => declarationOf(id) ?? sf;

  /** Variables holding a handle (by declaration, then name). */
  const aliasMap = new Map<ts.Node, Map<string, Handle>>();
  /** Names that hold something somewhere in the file: any other identifier is resolved without a scope lookup. */
  const aliasNames = new Set<string>();
  const boundNames = new Set<string>();
  const strapiNames = new Set<string>();
  const getAlias = (id: ts.Identifier): Handle | undefined => (aliasNames.has(id.text) ? aliasMap.get(scopeKey(id))?.get(id.text) : undefined);
  const setAlias = (id: ts.Identifier, h: Handle): void => {
    aliasNames.add(id.text);
    const k = scopeKey(id);
    let m = aliasMap.get(k);
    if (!m) aliasMap.set(k, (m = new Map()));
    if (m.has(id.text)) return;
    m.set(id.text, h);
    changed = true;
    handleMemo.clear();
  };
  /** Variables bound to a getter function: `const { service } = strapi`, `const p = strapi.plugin.bind(strapi)`. */
  const boundGetters = new Map<ts.Node, Map<string, { getter: string; plugin?: string }>>();
  const getBound = (id: ts.Identifier): { getter: string; plugin?: string } | undefined => (boundNames.has(id.text) ? boundGetters.get(scopeKey(id))?.get(id.text) : undefined);
  const setGetter = (id: ts.Identifier, getter: string, plugin?: string): void => {
    boundNames.add(id.text);
    const k = scopeKey(id);
    let m = boundGetters.get(k);
    if (!m) boundGetters.set(k, (m = new Map()));
    if (m.has(id.text)) return;
    m.set(id.text, { getter, ...(plugin ? { plugin } : {}) });
    changed = true;
    handleMemo.clear();
  };
  /** Variables holding the `strapi` runtime object under another name. */
  const strapiAliases = new Map<ts.Node, Set<string>>();
  const markStrapi = (id: ts.Identifier): void => {
    strapiNames.add(id.text);
    const k = scopeKey(id);
    let m = strapiAliases.get(k);
    if (!m) strapiAliases.set(k, (m = new Set()));
    if (m.has(id.text)) return;
    m.add(id.text);
    changed = true;
    handleMemo.clear();
  };
  /** Is this the `strapi` runtime object (`strapi`, an alias of it, `this.strapi`, `ctx.strapi`…)? */
  const isStrapi = (e0: ts.Expression): boolean => {
    const e = strip(e0);
    if (ts.isIdentifier(e)) return e.text === 'strapi' || (strapiNames.has(e.text) && (strapiAliases.get(scopeKey(e))?.has(e.text) ?? false));
    return keyOf(e) === 'strapi';
  };
  /** Functions returning a handle, by name. */
  const returning = new Map<string, Handle>();
  /** Functions declared in this file, by name (a handle passed to one is followed into its parameter). */
  const localFns = new Map<string, ts.FunctionLikeDeclaration>();
  /** `const X = 'literal'` in this file. */
  const consts = new Map<string, string>();
  const visitDecls = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) localFns.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = strip(n.initializer);
      if ((ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.body) localFns.set(n.name.text, init);
      if (ts.isStringLiteralLike(init) && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) consts.set(n.name.text, init.text);
    }
    ts.forEachChild(n, visitDecls);
  };
  visitDecls(sf);
  const literalOf = (e: ts.Expression | undefined): string | undefined => {
    if (!e) return undefined;
    const x = strip(e);
    if (ts.isStringLiteralLike(x)) return x.text;
    if (ts.isIdentifier(x)) return consts.get(x.text);
    return undefined;
  };

  const getterOfCallee = (c0: ts.Expression): { getter: string; owner?: Handle; plugin?: string } | undefined => {
    const c = strip(c0);
    if (ts.isIdentifier(c)) {
      const g = getBound(c);
      if (g) return g;
      // `plugin('x')` from `({ strapi: { plugin } })`, a bare `service('plugin::x.y')`
      return c.text === 'plugin' || GETTERS.has(c.text) ? { getter: c.text } : undefined;
    }
    const k = keyOf(c);
    if (k === undefined || !(k === 'plugin' || GETTERS.has(k))) return undefined;
    const base = (c as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
    const owner = handleOf(base);
    if (owner?.kind === 'plugin' && k !== 'plugin') return { getter: k, owner };
    return isStrapi(base) ? { getter: k } : undefined;
  };
  const member = (h: Handle, key: string | undefined): Handle | undefined => {
    if (h.kind === 'plugins') return { kind: 'plugin', plugin: key ?? '*' };
    if (h.kind === 'plugin') return key === undefined || COLLECTION_KEYS.has(key) ? { kind: 'collection', plugin: h.plugin } : undefined;
    if (h.kind === 'collection') return { kind: 'member', plugin: h.plugin };
    if (h.kind === 'artifact') return { ...h, kind: 'member' }; // inside a named artifact: writes extend it
    return h;
  };
  /** What iterating a handle yields. */
  const membersOf = (h: Handle): Handle =>
    h.kind === 'plugins' ? { kind: 'plugin', plugin: '*' } : h.kind === 'plugin' ? { kind: 'collection', plugin: h.plugin } : h.kind === 'collection' ? { kind: 'member', plugin: h.plugin } : h;

  /** An expression's handle only changes when an alias / getter / `strapi` alias is learnt (which clears this). */
  const handleMemo = new Map<ts.Node, Handle | null>();
  const handleOf = (e0: ts.Expression, depth = 0): Handle | undefined => {
    const hit = handleMemo.get(e0);
    if (hit !== undefined) return hit ?? undefined;
    const h = handleOfUncached(e0, depth);
    handleMemo.set(e0, h ?? null);
    return h;
  };
  const handleOfUncached = (e0: ts.Expression, depth: number): Handle | undefined => {
    if (depth > 30) return undefined;
    const e = strip(e0);
    if (ts.isConditionalExpression(e)) return handleOf(e.whenTrue, depth + 1) ?? handleOf(e.whenFalse, depth + 1);
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) return handleOf(e.left, depth + 1) ?? handleOf(e.right, depth + 1);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) return handleOf(e.right, depth + 1);
      return undefined;
    }
    if (ts.isCallExpression(e)) {
      const c = strip(e.expression);
      // `strapi.plugin.call(strapi, 'x')`, `.apply(strapi, ['x'])`
      if (ts.isPropertyAccessExpression(c) && (c.name.text === 'call' || c.name.text === 'apply') && getterOfCallee(c.expression)?.getter === 'plugin') {
        return { kind: 'plugin', plugin: literalOf(e.arguments[1]) ?? '*' };
      }
      const name = ts.isIdentifier(c) ? c.text : keyOf(c);
      const g = getterOfCallee(c);
      if (g) {
        const lit = literalOf(e.arguments[0]);
        if (g.getter === 'plugin') return { kind: 'plugin', plugin: lit ?? '*' };
        const ns = g.getter === 'contentType' ? 'ct:' : '';
        const ownerPlugin = g.owner?.kind === 'plugin' ? g.owner.plugin : g.plugin;
        if (ownerPlugin !== undefined) return { kind: 'artifact', plugin: ownerPlugin, ns, ...(lit && ownerPlugin !== '*' ? { ref: `plugin::${ownerPlugin}.${lit}` } : {}) };
        if (lit === undefined) return { kind: 'artifact', plugin: '*', ns, dynamic: true };
        const mm = /^plugin::([^.]+)\./.exec(lit);
        if (mm) return { kind: 'artifact', plugin: mm[1]!, ns, ref: lit };
        if (name === undefined || !returning.has(name)) return undefined;
      }
      if (name !== undefined && returning.has(name)) return returning.get(name);
      // `Object.values(strapi.plugins)`, `_.map(collection, …)`: the members
      if (name !== undefined && MEMBER_CALLS.has(name) && e.arguments[0] && (ts.isIdentifier(c) || (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)))) {
        const h = handleOf(e.arguments[0], depth + 1);
        if (h && h.kind !== 'artifact') return membersOf(h);
      }
      // `Object.values(…).map(…)`, `routes.filter(…)`: still members
      if ((ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)) && name !== undefined && MEMBER_CALLS.has(name)) {
        const h = handleOf(c.expression, depth + 1);
        if (h && (h.kind === 'collection' || h.kind === 'member' || h.kind === 'plugins')) return membersOf(h);
      }
      return undefined;
    }
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const key = ts.isElementAccessExpression(e) ? literalOf(e.argumentExpression) : keyOf(e);
      const owner = handleOf(e.expression, depth + 1);
      if (owner) return member(owner, key);
      if (key === 'plugins' && isStrapi(e.expression)) return { kind: 'plugins', plugin: '*' };
      return undefined;
    }
    if (ts.isIdentifier(e)) return getAlias(e);
    return undefined;
  };

  // --- aliases, to a fixpoint ---------------------------------------------
  /**
   * Bind the names of a pattern to what `h` holds. Getter keys (`plugin`,
   * `service`…) bind getter functions when the source is `strapi` or a plugin.
   */
  const bindPattern = (name: ts.BindingName, h: Handle | undefined, fromStrapi: boolean): void => {
    if (ts.isIdentifier(name)) {
      if (h) setAlias(name, h);
      return;
    }
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      const key = ts.isObjectBindingPattern(name) ? (el.propertyName ? propKey(el.propertyName) : propKey(el.name)) : undefined;
      if (el.dotDotDotToken) {
        if (h) bindPattern(el.name, h, false); // the rest holds everything left
        continue;
      }
      if (key !== undefined && (fromStrapi || h?.kind === 'plugin') && (key === 'plugin' || GETTERS.has(key)) && ts.isIdentifier(el.name)) {
        setGetter(el.name, key, h?.kind === 'plugin' ? h.plugin : undefined);
        continue;
      }
      if (key === 'strapi' && ts.isIdentifier(el.name)) {
        markStrapi(el.name); // `({ strapi: s })`
        continue;
      }
      if (el.initializer) {
        const dh = handleOf(el.initializer);
        if (dh) bindPattern(el.name, dh, false);
      }
      const sub = h ? (ts.isObjectBindingPattern(name) ? member(h, key) : h) : undefined;
      if (sub) bindPattern(el.name, sub, false);
      else if (!ts.isIdentifier(el.name)) bindPattern(el.name, undefined, key === 'strapi');
      else if (key === 'plugins' && fromStrapi) setAlias(el.name, { kind: 'plugins', plugin: '*' });
    }
  };
  const getterValue = (e0: ts.Expression): { getter: string; plugin?: string } | undefined => {
    let e = strip(e0);
    // `strapi.plugin.bind(strapi)`
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'bind') e = strip(e.expression.expression);
    if (ts.isIdentifier(e)) return getBound(e);
    const k = keyOf(e);
    if (k === undefined || !(k === 'plugin' || GETTERS.has(k))) return undefined;
    const base = (e as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression;
    const owner = handleOf(base);
    if (owner?.kind === 'plugin' && k !== 'plugin') return { getter: k, plugin: owner.plugin };
    return isStrapi(base) ? { getter: k } : undefined;
  };
  const returnsMemo = new Map<ts.Node, ts.Expression[]>();
  const returnsOf = (fn: ts.FunctionLikeDeclaration): ts.Expression[] => {
    const hit = returnsMemo.get(fn);
    if (hit) return hit;
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
      returnsMemo.set(fn, [fn.body]);
      return [fn.body];
    }
    const res: ts.Expression[] = [];
    returnsMemo.set(fn, res);
    const walk = (n: ts.Node): void => {
      if (n !== fn && isFunctionLike(n)) return;
      if (ts.isReturnStatement(n) && n.expression) res.push(n.expression);
      ts.forEachChild(n, walk);
    };
    if (fn.body) walk(fn.body);
    return res;
  };
  /** The callback argument a call hands members to (`forEach(cb)`, `_.forEach(h, cb)`). */
  const callbackOf = (call: ts.CallExpression): { receiver: ts.Expression; cb: ts.Expression } | undefined => {
    const c = strip(call.expression);
    if (!ts.isPropertyAccessExpression(c) || !ITERATORS.has(c.name.text)) return undefined;
    const lodashStyle = calleeText(c)?.startsWith('_.') && call.arguments.length >= 2;
    if (lodashStyle) return { receiver: call.arguments[0]!, cb: call.arguments[1]! };
    return call.arguments[0] ? { receiver: c.expression, cb: call.arguments[0] } : undefined;
  };
  /** One alias-learning step on a node (see the fixpoint below). */
  const learn = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      const fromStrapi = isStrapi(n.initializer);
      if (fromStrapi && ts.isIdentifier(n.name)) markStrapi(n.name);
      bindPattern(n.name, handleOf(n.initializer), fromStrapi);
      const g = getterValue(n.initializer);
      if (g && ts.isIdentifier(n.name)) setGetter(n.name, g.getter, g.plugin);
    } else if ((ts.isParameter(n) || ts.isBindingElement(n)) && n.initializer) {
      const h = handleOf(n.initializer);
      if (h) bindPattern(n.name, h, false);
    } else if (ts.isParameter(n) && !ts.isIdentifier(n.name)) {
      bindPattern(n.name, undefined, false); // `({ strapi: { plugin } })`
    } else if (ts.isBinaryExpression(n) && isAssignOp(n.operatorToken.kind)) {
      const left = strip(n.left);
      const h = handleOf(n.right);
      if (ts.isIdentifier(left)) {
        if (h) setAlias(left, h);
        const g = getterValue(n.right);
        if (g) setGetter(left, g.getter, g.plugin);
        if (isStrapi(n.right)) markStrapi(left);
      } else if (h && (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left))) {
        // `({ controllers } = strapi.plugin('x'))`
        const visit = (x: ts.Node): void => {
          if (ts.isIdentifier(x) && !(ts.isPropertyAssignment(x.parent) && x.parent.name === x)) setAlias(x, h.kind === 'plugin' ? { kind: 'collection', plugin: h.plugin } : h);
          ts.forEachChild(x, visit);
        };
        visit(left);
      }
    } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && ts.isVariableDeclarationList(n.initializer)) {
      const h = ts.isForOfStatement(n) ? handleOf(n.expression) : undefined;
      if (h) for (const d of n.initializer.declarations) bindPattern(d.name, membersOf(h), false);
    } else if (ts.isCallExpression(n)) {
      // a handle handed to a function of this file: its parameter holds it
      const c = strip(n.expression);
      const local = ts.isIdentifier(c) ? localFns.get(c.text) : undefined;
      if (local) {
        n.arguments.forEach((a, i) => {
          const param = local.parameters[i];
          if (!param || ts.isSpreadElement(a)) return;
          const h = handleOf(a);
          if (h) bindPattern(param.name, h, false);
          if (isStrapi(a)) {
            if (ts.isIdentifier(param.name)) markStrapi(param.name);
            else bindPattern(param.name, undefined, true);
          }
        });
      }
      // `Object.values(strapi.plugins).forEach((p) => …)`: the callback's first parameter is a member
      const it = callbackOf(n);
      const h = it && handleOf(it.receiver);
      const cb = it && strip(it.cb);
      if (h && h.kind !== 'artifact' && cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) bindPattern(cb.parameters[0].name, membersOf(h), false);
    } else if (isFunctionLike(n)) {
      const name = nameOfFunction(n);
      if (name !== undefined && !returning.has(name)) {
        for (const r of returnsOf(n)) {
          const h = handleOf(r);
          if (h) {
            returning.set(name, h);
            changed = true;
            handleMemo.clear();
            break;
          }
        }
      }
    }
  };
  // The nodes a learning step can use, gathered once (in source order); the fixpoint re-runs on them only.
  const learners: ts.Node[] = [];
  const gather = (n: ts.Node): void => {
    switch (n.kind) {
      case ts.SyntaxKind.VariableDeclaration:
      case ts.SyntaxKind.Parameter:
      case ts.SyntaxKind.BindingElement:
      case ts.SyntaxKind.BinaryExpression:
      case ts.SyntaxKind.ForOfStatement:
      case ts.SyntaxKind.ForInStatement:
      case ts.SyntaxKind.CallExpression:
        learners.push(n);
        break;
      default:
        if (isFunctionLike(n)) learners.push(n);
    }
    ts.forEachChild(n, gather);
  };
  gather(sf);
  for (let round = 0; changed && round < 8; round++) {
    changed = false;
    for (const n of learners) learn(n);
  }

  // --- writes and escapes ---------------------------------------------------
  const record = (h: Handle | undefined, at: ts.Node, why: string): void => {
    if (!h) return;
    if (h.kind === 'artifact' || (h.kind === 'member' && (h.ref !== undefined || h.ns !== undefined))) {
      const key = `${h.ns ?? ''}${h.ref ?? (h.plugin === '*' ? '*' : `plugin::${h.plugin}.*`)}`;
      out.artifacts.add(key);
      trace?.(`${why}: artifact ${key}`, at);
    } else {
      out.plugins.add(h.plugin);
      trace?.(`${why}: plugin ${h.plugin}`, at);
    }
  };
  /** A write into `target` (the object written to) under `key`. */
  const writeInto = (target: ts.Expression, key: string | undefined, at: ts.Node): void => {
    const h = handleOf(target);
    if (h?.kind === 'plugin') {
      // `strapi.plugin('x').provider = …` is not a collection; `….controllers = …` is.
      if (key === undefined || COLLECTION_KEYS.has(key)) record(h, at, 'written');
      return;
    }
    if (h?.kind === 'plugins') {
      record({ kind: 'plugin', plugin: key ?? '*' }, at, 'written');
      return;
    }
    record(h, at, 'written');
  };
  const writeTargets = (t0: ts.Expression, at: ts.Node): void => {
    const t = strip(t0);
    if (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) writeInto(t.expression, ts.isElementAccessExpression(t) ? literalOf(t.argumentExpression) : keyOf(t), at);
    else if (ts.isObjectLiteralExpression(t)) {
      for (const pr of t.properties) {
        if (ts.isPropertyAssignment(pr)) writeTargets(pr.initializer, at);
        else if (ts.isSpreadAssignment(pr)) writeTargets(pr.expression, at);
      }
    } else if (ts.isArrayLiteralExpression(t)) {
      for (const el of t.elements) writeTargets(ts.isSpreadElement(el) ? el.expression : el, at);
    } else if (ts.isBinaryExpression(t) && t.operatorToken.kind === ts.SyntaxKind.EqualsToken) writeTargets(t.left, at); // a default in a pattern
  };
  /** Does a `return` (or concise arrow body) hand the handle back to named callers (tracked by `returning`)? */
  const returnedByName = (e: ts.Node): boolean => {
    let fn: ts.Node | undefined = ts.isArrowFunction(e) ? e : e.parent;
    while (fn && !isFunctionLike(fn)) fn = fn.parent;
    const name = fn ? nameOfFunction(fn) : undefined;
    return name !== undefined && returning.has(name);
  };
  /**
   * Who a call hands its arguments to: a function of this file (`local`: followed
   * into its parameter), the runtime or a library (`external`: trusted, except
   * the `mutator` utilities), or code of another module of the project/plugin
   * (`internal`: not followed).
   */
  const calleeClass = (call: ts.CallExpression | ts.NewExpression): 'local' | 'external' | 'reader' | 'mutator' | 'internal' => {
    let c = strip(call.expression);
    if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.CommaToken) c = strip(c.right);
    const text = calleeText(c);
    if (text && READ_ONLY_CALLS.test(text)) return 'reader';
    if (ts.isIdentifier(c) && localFns.has(c.text)) return ts.isCallExpression(call) ? 'local' : 'internal';
    const name = ts.isIdentifier(c) ? c.text : keyOf(c);
    let root: ts.Expression = c;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isCallExpression(root)) root = strip(root.expression);
    if (!ts.isIdentifier(root)) return 'internal';
    const origin = originOf(root);
    if (origin === 'internal') return 'internal';
    if (name !== undefined && MUTATOR_NAMES.has(name)) return 'mutator';
    if (name !== undefined && PURE_READERS.has(name)) return 'reader';
    return 'external';
  };
  /** Where a callee's root identifier comes from: a package/global/parameter (`external`) or this project (`internal`). */
  const originOf = (id: ts.Identifier, depth = 0): 'external' | 'internal' => {
    if (isStrapi(id)) return 'external';
    const decl = declarationOf(id);
    if (!decl) return 'external'; // a global (`Object`, `strapi`) or a parameter
    if (ts.isImportClause(decl) || ts.isNamespaceImport(decl) || ts.isImportSpecifier(decl)) {
      let imp: ts.Node = decl;
      while (!ts.isImportDeclaration(imp)) imp = imp.parent;
      const spec = imp.moduleSpecifier;
      return ts.isStringLiteralLike(spec) && !spec.text.startsWith('.') ? 'external' : 'internal';
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer) {
      let init = strip(decl.initializer);
      while (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) init = strip(init.expression);
      // `_interopDefault(require('lodash'))`, `__importDefault(require('lodash'))`
      if (ts.isCallExpression(init) && !(ts.isIdentifier(init.expression) && init.expression.text === 'require') && init.arguments.length === 1) {
        const a0 = strip(init.arguments[0]!);
        if (ts.isCallExpression(a0) && ts.isIdentifier(a0.expression) && a0.expression.text === 'require') init = a0;
        else if (ts.isIdentifier(a0) && depth < 8) return originOf(a0, depth + 1); // `_interopDefault(require$$0)`
      }
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require') {
        const spec = init.arguments[0];
        return spec && ts.isStringLiteralLike(spec) && !spec.text.startsWith('.') ? 'external' : 'internal';
      }
      if (ts.isIdentifier(init) && depth < 8) return originOf(init, depth + 1); // `const _ = require$$0`
    }
    if (ts.isParameter(decl)) return 'external';
    return 'internal';
  };

  /** Does the (maximal) handle expression `n` flow somewhere it can't be followed? Returns why. */
  const escapes = (n: ts.Expression): string | undefined => {
    let e: ts.Node = n;
    for (;;) {
      const p = e.parent;
      if (!p) return undefined;
      if (ts.isParenthesizedExpression(p) || ts.isNonNullExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p) || ts.isAwaitExpression(p)) {
        e = p;
        continue;
      }
      if (ts.isConditionalExpression(p) && p.condition !== e) {
        e = p;
        continue;
      }
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || ((op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.CommaToken) && p.right === e)) {
          e = p;
          continue;
        }
      }
      break;
    }
    const p = e.parent!;
    // part of a longer chain (`h.controllers.x`, `h.service('y')`): judged there
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e) return undefined;
    if (ts.isCallExpression(p) && p.expression === e) return undefined;
    const call = (ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(e as ts.Expression) ? p : ts.isSpreadElement(p) && (ts.isCallExpression(p.parent) || ts.isNewExpression(p.parent)) ? p.parent : undefined;
    if (call) {
      const k = calleeClass(call);
      if (k === 'local' || k === 'reader' || k === 'external') return undefined;
      if (k === 'mutator') return call.arguments?.[0] === e ? 'written by a utility' : undefined;
      return 'handed to code of another module';
    }
    if (ts.isSpreadElement(p)) return 'spread';
    if (ts.isVariableDeclaration(p) && p.initializer === e) {
      const stmt = p.parent?.parent;
      return stmt && ts.isVariableStatement(stmt) && (ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false) ? 'exported' : undefined;
    }
    if (ts.isBinaryExpression(p) && p.right === e && isAssignOp(p.operatorToken.kind)) {
      const left = strip(p.left);
      return ts.isIdentifier(left) || ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left) ? undefined : 'stored into an object';
    }
    if (ts.isBinaryExpression(p) && p.left === e) return undefined; // an alias rebound
    if ((ts.isParameter(p) || ts.isBindingElement(p)) && p.initializer === e) return undefined;
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.expression === e) return undefined;
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === e)) return returnedByName(p) ? undefined : 'returned from an anonymous function';
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isArrayLiteralExpression(p)) return 'kept in an object';
    if (ts.isExportAssignment(p) || ts.isExportSpecifier(p) || ts.isYieldExpression(p) || ts.isThrowStatement(p)) return 'exported';
    return undefined; // read: a condition, a comparison, a template, a discarded expression…
  };
  /** A reference to a bound plugin getter function used as a value (not called). */
  const isBoundGetterRef = (n: ts.Expression): boolean => {
    const e = strip(n);
    return ts.isIdentifier(e) && isReference(e) && getBound(e)?.getter === 'plugin';
  };

  const walk = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && isAssignOp(n.operatorToken.kind)) {
      writeTargets(n.left, n);
    } else if (ts.isDeleteExpression(n)) {
      writeTargets(n.expression, n);
    } else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      writeTargets(n.operand, n);
    } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      writeTargets(n.initializer as ts.Expression, n);
    } else if (ts.isCallExpression(n)) {
      const c = strip(n.expression);
      const method = ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c) ? keyOf(c) : undefined;
      if ((ts.isPropertyAccessExpression(c) || ts.isElementAccessExpression(c)) && method !== undefined && WRITE_METHODS.has(method)) {
        // collection.push(…) — a mutating method on a collection (or something inside it).
        // On an artifact it's an ordinary call to that service/controller (`service('x').add(…)`).
        const h = handleOf(c.expression);
        if (h?.kind === 'collection' || h?.kind === 'member') record(h, n, `'${method}' called`);
        if (h?.kind === 'plugins') record({ kind: 'plugin', plugin: '*' }, n, `'${method}' called`);
        // strapi.get('<registry>').add|set|extend('plugin::x.y', …)
        const reg = strip(c.expression);
        if (
          (method === 'add' || method === 'set' || method === 'extend') &&
          ts.isCallExpression(reg) &&
          keyOf(strip(reg.expression)) === 'get' &&
          reg.arguments[0] &&
          ts.isStringLiteralLike(reg.arguments[0]) &&
          REGISTRIES.has(reg.arguments[0].text)
        ) {
          const a0 = n.arguments[0];
          // The UID's literal head decides: `api::${x}` (i18n v4 extending API controllers) is not a plugin.
          const literal = literalOf(a0);
          const head = literal ?? (a0 && ts.isTemplateExpression(a0) ? a0.head.text : undefined);
          const m = head !== undefined ? /^plugin::([^.$]+)\./.exec(head) : null;
          const pluginScoped = head === undefined || head.startsWith('plugin::') || !head.includes('::');
          if (method === 'extend') {
            // Extending an existing entry changes its methods/attributes, never adds a UID.
            // Content-types (attributes) and code artifacts (methods) are tracked apart.
            const ns = reg.arguments[0].text === 'content-types' ? 'ct:' : '';
            const key = literal && m ? `${ns}${literal}` : pluginScoped ? `${ns}${m ? `plugin::${m[1]}.*` : '*'}` : undefined;
            if (key) {
              out.artifacts.add(key);
              trace?.(`registry extend: artifact ${key}`, n);
            }
          } else if (m) {
            record({ kind: 'plugin', plugin: m[1]! }, n, 'registry add');
          } else if (pluginScoped) {
            record({ kind: 'plugin', plugin: '*' }, n, 'registry add');
          }
        }
      }
    }
    // A handle flowing where it can't be followed: handed to another module's code, kept in an object, exported…
    if (ts.isExpression(n) && !(ts.isIdentifier(n) && !isReference(n))) {
      const h = handleOf(n);
      // Copies of a collection's members (routes, controllers read while iterating) can't add UIDs:
      // only the plugin, its collections and named artifacts are followed out of the file.
      if ((h && !h.dynamic && h.kind !== 'member') || isBoundGetterRef(n)) {
        const why = escapes(n);
        // A service/controller instance kept around is just a reference: only code of another
        // module (or a mutating utility) receiving it may extend it.
        if (why && (h?.kind !== 'artifact' || why === 'handed to code of another module' || why === 'written by a utility')) record(h ?? { kind: 'plugin', plugin: '*' }, n, why);
      }
    }
    ts.forEachChild(n, walk);
  };

  walk(sf);
  return out;
}

function bindsName(name: ts.BindingName, text: string): boolean {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindsName(el.name, text));
}

function bindingIds(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) out.push(...bindingIds(el.name));
  return out;
}

/** Is this identifier a reference to a binding (not a property name, a declaration name…)? */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isPropertySignature(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  if (ts.isTypeReferenceNode(p) || ts.isTypeQueryNode(p)) return false;
  return true;
}

/** Code files under `dir` (recursive, bounded), skipping dependency/build folders and `skip(dir)` ones. */
async function codeFilesUnder(fs: FileSystem, dir: string, limit: number, skip: (dir: string) => boolean): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;
  const ignored = new Set(['node_modules', '.git', '.cache', 'build', '.strapi', '.tmp', 'public']);
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readDirectory(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      const path = join(d, e.name);
      if (e.type === FileType.Directory) {
        if (!ignored.has(e.name) && !skip(path)) await walk(path);
      } else if (e.type === FileType.File && isCodeFile(e.name)) {
        if (files.length >= limit) {
          truncated = true;
          return;
        }
        files.push(path);
      }
    }
  };
  await walk(dir);
  return { files, truncated };
}

function isCodeFile(name: string): boolean {
  return /\.(m|c)?(j|t)sx?$/.test(name) && !name.endsWith('.d.ts');
}

/** Admin-panel code runs in the browser: it can't touch the server's plugins. */
function isAdminDir(dir: string, roots: string[]): boolean {
  for (const r of roots) {
    if (dir === `${r}/admin`) return true; // src/admin, a resolved plugin's admin/
    if (dir.startsWith(`${r}/plugins/`) && /^[^/]+\/admin$/.test(dir.slice(r.length + 9))) return true; // src/plugins/<x>/admin
  }
  return false;
}

/** Per file system, per file: the last scan and the mtime it was made at. */
const fileScans = new WeakMap<FileSystem, Map<string, { mtime: number; rewrites: PluginRewrites | undefined }>>();

/** What one file rewrites (undefined: nothing). Unreadable files count as nothing (they don't run either). */
export async function rewritesOfFile(fs: FileSystem, file: string): Promise<PluginRewrites | undefined> {
  let cache = fileScans.get(fs);
  if (!cache) fileScans.set(fs, (cache = new Map()));
  const mtime = (await fs.stat(file))?.mtime;
  const hit = mtime !== undefined ? cache.get(file) : undefined;
  if (hit && hit.mtime === mtime) return hit.rewrites;
  const rewrites = await scanFile(fs, file);
  if (mtime !== undefined) cache.set(file, { mtime, rewrites });
  return rewrites;
}

async function scanFile(fs: FileSystem, file: string): Promise<PluginRewrites | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch {
    return undefined;
  }
  if (text.length > MAX_FILE_BYTES) return { plugins: new Set(['*']), artifacts: new Set() };
  if (!MAY_REWRITE_PLUGINS.test(text)) return undefined;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const r = pluginWriteTargets(sf);
  return r.plugins.size || r.artifacts.size ? r : undefined;
}

/** Scan the project's own code (src/** and local plugins resolved outside it). */
export async function scanProjectRewrites(fs: FileSystem, root: string, config?: PluginsConfig): Promise<ProjectRewrites> {
  let cfg = config;
  if (!cfg) {
    try {
      cfg = await readPluginsConfig(fs, root);
    } catch {
      cfg = undefined;
    }
  }
  const src = join(root, 'src');
  const dirs = [src];
  let truncated = false;
  for (const d of cfg?.declarations.values() ?? []) {
    if (d.resolve === undefined) continue;
    if (d.resolve === null) {
      truncated = true; // a local plugin somewhere we can't name
      continue;
    }
    const dir = resolveDots(normalize(d.resolve.startsWith('/') || /^[a-zA-Z]:/.test(d.resolve) ? d.resolve : join(root, d.resolve)));
    if (!dirs.some((x) => dir === x || dir.startsWith(`${x}/`))) dirs.push(dir);
  }
  const files = new Map<string, PluginRewrites>();
  let budget = REWRITE_SCAN_LIMIT;
  for (const dir of dirs) {
    const listed = await codeFilesUnder(fs, dir, budget, (d) => isAdminDir(d, dirs));
    budget -= listed.files.length;
    if (listed.truncated) truncated = true;
    for (const f of listed.files) {
      const r = await rewritesOfFile(fs, f);
      if (r) files.set(f, r);
    }
  }
  return { files, dirs, truncated };
}

/** Is `file` a code file the project scan covers (so its edits must update it)? */
export function inRewriteScope(rw: ProjectRewrites, file: string): boolean {
  if (!isCodeFile(file.slice(file.lastIndexOf('/') + 1))) return false;
  const dir = rw.dirs.find((d) => file.startsWith(`${d}/`));
  if (!dir) return false;
  const rel = file.slice(dir.length + 1).split('/');
  if (rel.slice(0, -1).some((seg) => ['node_modules', '.git', '.cache', 'build', '.strapi', '.tmp', 'public'].includes(seg))) return false;
  for (let i = 1; i < rel.length; i++) if (isAdminDir(`${dir}/${rel.slice(0, i).join('/')}`, rw.dirs)) return false;
  return true;
}

/** Everything a set of rewrites touches, merged. */
export function unionRewrites(...parts: Array<PluginRewrites | ProjectRewrites | undefined>): PluginRewrites {
  const out: PluginRewrites = { plugins: new Set(), artifacts: new Set() };
  const add = (r: PluginRewrites): void => {
    for (const x of r.plugins) out.plugins.add(x);
    for (const x of r.artifacts) out.artifacts.add(x);
  };
  for (const p of parts) {
    if (!p) continue;
    if ('files' in p) {
      if (p.truncated) out.plugins.add('*');
      for (const r of p.files.values()) add(r);
    } else add(p);
  }
  return out;
}

/** A stable key of a set of rewrites (to detect changes). */
export function rewritesKey(r: PluginRewrites): string {
  return `${[...r.plugins].sort().join(',')}|${[...r.artifacts].sort().join(',')}`;
}
