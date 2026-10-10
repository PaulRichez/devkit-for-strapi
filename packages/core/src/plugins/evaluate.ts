/**
 * A small, **sound-or-silent** static evaluator for the module graph of a Strapi
 * plugin (or a project config file). It answers questions like "what are the keys
 * of the object this plugin registers as `controllers`?" by following the code the
 * way Node would — `require`/`import`, `module.exports`, bundler wrappers
 * (rollup's `x.__require()`, `getDefaultExportFromCjs`, tsc/Babel helpers),
 * identifiers, property access and simple function calls — **without executing
 * anything**.
 *
 * The contract that makes it safe to build diagnostics on: every step it cannot
 * prove yields `unknown` (or marks an object `open`: "it may have keys I could not
 * see"). Callers only treat a result as exhaustive when nothing on the path was
 * unknown/open. *Garantir, ne pas deviner.* In particular:
 *  - a cycle (module, value or call) answers `unknown`, never waits on itself;
 *  - a function with several different `return`s is `unknown`;
 *  - a variable written in any way not modelled exactly (deep or compound
 *    writes, a reassignment over an initializer, being passed to an unknown
 *    function, a redeclaration) is `unknown`;
 *  - a module whose `exports` are touched in any way not modelled is `open`;
 *  - work is bounded (depth, steps, files, bytes, wall-clock) and confined to
 *    the given roots.
 *
 * Evaluation is lazy: object properties and array items are thunks, forced only
 * when a caller reads them, so reading the key list of an aggregator never
 * evaluates the (possibly large) values behind it. Scope and write tables are
 * built once per file, so cost stays linear in the code actually followed.
 */

import ts from 'typescript';
import { MAX_PARSE_CHARS, scriptKindFor } from '../analyze/parse';
import { type FileSystem, FileType } from '../fs/FileSystem';
import { dirname, isPathInside, join, normalize } from '../fs/paths';

export interface Loc {
  file: string;
  /** Char offset of the node start (leading trivia excluded). */
  pos: number;
}

export type Lazy = () => Promise<Value>;

export interface ObjValue {
  k: 'obj';
  props: Map<string, Lazy>;
  /** Where each key is written (for navigation). */
  keyLocs: Map<string, Loc>;
  /** True when the object may have keys we could not see (unknown spread, computed key, mutation). */
  open: boolean;
  /** A module namespace that came from ESM (or declared `__esModule`). */
  esModule?: boolean;
  loc?: Loc;
}

export interface ArrValue {
  k: 'arr';
  items: Lazy[];
  /** True when the array may hold items we could not see (unknown spread). */
  open: boolean;
  loc?: Loc;
}

export interface FnValue {
  k: 'fn';
  node: ts.SignatureDeclaration & { body?: ts.ConciseBody | ts.Block };
  file: string;
  scope: Scope | undefined;
  loc: Loc;
  /** Declared/bound name, when known (used to recognise interop helpers). */
  name?: string;
}

/** A function implemented by DevKit itself (a model of a known framework helper). */
export interface NativeValue {
  k: 'native';
  name: string;
  impl: (args: Value[]) => Promise<Value>;
}

export type Value =
  | ObjValue
  | ArrValue
  | FnValue
  | NativeValue
  | { k: 'str'; v: string; loc?: Loc }
  | { k: 'num'; v: number }
  | { k: 'bool'; v: boolean }
  | { k: 'nil' }
  | { k: 'unknown'; why: string };

/** Parameter bindings of one active function call. */
export interface Scope {
  fn: ts.Node;
  bindings: Map<string, Value>;
  parent: Scope | undefined;
}

export const UNKNOWN = (why: string): Value => ({ k: 'unknown', why });
const NIL: Value = { k: 'nil' };

const RESOLVE_EXT = ['', '.js', '.cjs', '.mjs', '.ts', '.cts', '.mts', '.json'];
/** Parallel file reads during a crawl. */
const IO_CONCURRENCY = 16;

/** `Promise.all(items.map(fn))` with at most `limit` in flight; results in input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const INDEX_FILES = ['index.js', 'index.cjs', 'index.mjs', 'index.ts', 'index.json'];

/** Resolve `.` / `..` segments (the core's `normalize` keeps them) — one canonical key per file. */
export function resolveDots(p: string): string {
  const n = normalize(p);
  const out: string[] = [];
  for (const seg of n.split('/')) {
    if (seg === '.') continue;
    if (seg === '..' && out.length > 1) {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/') || '/';
}

export interface EvaluatorLimits {
  /** Max nested evaluation depth (guards pathological recursion). */
  maxDepth: number;
  /** Max evaluation steps (AST visits included) for the evaluator's lifetime. */
  maxSteps: number;
  /** Max distinct files parsed. */
  maxFiles: number;
  /** Max total characters parsed. */
  maxBytes: number;
  /** Wall-clock budget (ms) from construction or the last {@link StaticEvaluator.resetBudget}. */
  timeBudgetMs: number;
  /** When set, a relative `require`/`import` must resolve inside one of these directories. */
  roots?: string[];
}

const DEFAULT_LIMITS: EvaluatorLimits = {
  maxDepth: 60,
  maxSteps: 2_000_000,
  maxFiles: 1_500,
  maxBytes: 40_000_000,
  timeBudgetMs: 5_000,
};

/** Models of bare-specifier modules (e.g. `@strapi/utils` helpers), by specifier. */
export type ExternalModules = (spec: string, ev: StaticEvaluator) => Value | undefined;

/** True for a value that can be called. */
export function isCallable(v: Value): v is FnValue | NativeValue {
  return v.k === 'fn' || v.k === 'native';
}

type FunctionLike = ts.FunctionLikeDeclaration;

function isFunctionLike(n: ts.Node): n is FunctionLike {
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

function propName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression;
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e)) return e.text;
  }
  return undefined;
}

/** A node that can declare names: a function, a block, a file, a loop's / catch's own binding. */
function isScopeNode(n: ts.Node): boolean {
  switch (n.kind) {
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
      return isFunctionLike(n);
  }
}

function skipParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/** `module.exports` / `module['exports']` */
function isModuleExports(n: ts.Expression): boolean {
  if (ts.isPropertyAccessExpression(n)) return n.name.text === 'exports' && ts.isIdentifier(n.expression) && n.expression.text === 'module';
  if (ts.isElementAccessExpression(n)) {
    const a = n.argumentExpression;
    return ts.isStringLiteralLike(a) && a.text === 'exports' && ts.isIdentifier(n.expression) && n.expression.text === 'module';
  }
  return false;
}

/** `exports.X` / `exports['X']` (target `exports`) or `module.exports.X` (target `module`) → X */
function exportsMember(n: ts.Expression): { name: string; target: 'exports' | 'module' } | undefined {
  let base: ts.Expression;
  let name: string;
  if (ts.isPropertyAccessExpression(n)) {
    base = n.expression;
    name = n.name.text;
  } else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
    base = n.expression;
    name = n.argumentExpression.text;
  } else {
    return undefined;
  }
  if (ts.isIdentifier(base) && base.text === 'exports') return { name, target: 'exports' };
  if (isModuleExports(base)) return { name, target: 'module' };
  return undefined;
}

function hasExportModifier(n: ts.Node): boolean {
  return (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ?? false;
}

function hasDefaultModifier(n: ts.Node): boolean {
  return (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) ?? false;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    out.push(...bindingNames(el.name));
  }
  return out;
}

/** Visit `node`'s descendants without entering nested function-likes. */
function forEachInScope(node: ts.Node, visit: (n: ts.Node) => void): void {
  const walk = (n: ts.Node): void => {
    visit(n);
    if (isFunctionLike(n)) return;
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
}

/**
 * True if `n` mentions `exports` / `module.exports` in a way that could write
 * them (scope-aware: a function whose parameter or local is named `exports` /
 * `module` — e.g. tsc's `__exportStar(m, exports)` helper — is skipped).
 */
function touchesExports(n: ts.Node, ignore?: ReadonlySet<ts.Node>): boolean {
  let hit = false;
  const shadowed = (fn: FunctionLike, name: string): boolean => fn.parameters.some((p) => bindingNames(p.name).includes(name));
  const walk = (x: ts.Node, shE: boolean, shM: boolean, inFn: boolean): void => {
    if (hit || ignore?.has(x)) return;
    let e = shE;
    let m = shM;
    let f = inFn;
    if (isFunctionLike(x)) {
      e = e || shadowed(x, 'exports');
      m = m || shadowed(x, 'module');
      if (!ts.isArrowFunction(x)) f = true;
    }
    if (ts.isIdentifier(x) && (x.text === 'exports' || x.text === 'module')) {
      const parent = x.parent;
      const isPropName = parent && ((ts.isPropertyAccessExpression(parent) && parent.name === x) || (ts.isQualifiedName(parent) && parent.right === x));
      const isKey =
        parent &&
        (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isGetAccessorDeclaration(parent) || ts.isSetAccessorDeclaration(parent)) &&
        parent.name === x;
      if (!isPropName && !isKey && ((x.text === 'exports' && !e) || (x.text === 'module' && !m))) {
        hit = true;
        return;
      }
    }
    // A write through the module's top-level `this` (=== module.exports).
    if (!f && ts.isBinaryExpression(x) && x.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && x.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      if (accessRoot(x.left).root.kind === ts.SyntaxKind.ThisKeyword) {
        hit = true;
        return;
      }
    }
    ts.forEachChild(x, (c) => walk(c, e, m, f));
  };
  walk(n, false, false, false);
  return hit;
}

/** Is this identifier a reference to a binding (not a property name, a declaration name, a label…)? */
function isReferenceIdentifier(id: ts.Identifier): boolean {
  const p = id.parent;
  if (!p) return false;
  if ((ts.isPropertyAccessExpression(p) && p.name === id) || (ts.isQualifiedName(p) && p.right === id)) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) || ts.isPropertySignature(p) || ts.isEnumMember(p)) && p.name === id) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p) || ts.isClassExpression(p) || ts.isEnumDeclaration(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isNamespaceExport(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

const specifierMemo = new WeakMap<ts.SourceFile, string[]>();

/** Relative module specifiers a file requires/imports (for crawling the graph without evaluating). */
function relativeSpecifiers(sf: ts.SourceFile): string[] {
  const hit = specifierMemo.get(sf);
  if (hit) return hit;
  const out: string[] = [];
  specifierMemo.set(sf, out);
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const a0 = n.arguments[0];
      const isReq = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      const isDyn = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isReq || isDyn) && a0 && ts.isStringLiteralLike(a0) && a0.text.startsWith('.')) out.push(a0.text);
    } else if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier) && n.moduleSpecifier.text.startsWith('.')) {
      out.push(n.moduleSpecifier.text);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

const PURE_METHODS = new Set([
  'hasOwnProperty',
  'toString',
  'valueOf',
  'includes',
  'indexOf',
  'lastIndexOf',
  'join',
  'slice',
  'concat',
  'at',
  'startsWith',
  'endsWith',
  'trim',
  'toLowerCase',
  'toUpperCase',
  'split',
  'charAt',
  'test',
  '__require',
]);

// ---------------------------------------------------------------------------
// Declarations & writes (built once per scope container)
// ---------------------------------------------------------------------------

type BindingStep = { key: string | number; dflt?: ts.Expression };

/** The access path to `target` inside a binding pattern, `'rest'` for a rest element. */
function bindingPath(name: ts.BindingName, target: string): BindingStep[] | 'rest' | undefined {
  if (ts.isIdentifier(name)) return name.text === target ? [] : undefined;
  const els = name.elements;
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    if (ts.isOmittedExpression(el)) continue;
    const sub = bindingPath(el.name, target);
    if (sub === undefined) continue;
    if (el.dotDotDotToken || sub === 'rest') return 'rest';
    let key: string | number | undefined;
    if (ts.isArrayBindingPattern(name)) key = i;
    else if (el.propertyName) key = propName(el.propertyName);
    else if (ts.isIdentifier(el.name)) key = el.name.text;
    if (key === undefined) return 'rest';
    return [{ key, ...(el.initializer ? { dflt: el.initializer } : {}) }, ...sub];
  }
  return undefined;
}

type Declaration =
  | { kind: 'var'; decl: ts.VariableDeclaration; scopeNode: ts.Node; redeclared: boolean }
  | { kind: 'destructured'; decl: ts.VariableDeclaration; path: BindingStep[] }
  | { kind: 'fn'; decl: ts.FunctionDeclaration }
  | { kind: 'param'; fn: FunctionLike; index: number; destructured: boolean }
  | { kind: 'import'; decl: ts.ImportDeclaration; imported: 'default' | 'namespace' | string }
  | { kind: 'opaque'; why: string };

function declarationFromVar(d: ts.VariableDeclaration, name: string, scopeNode: ts.Node, redeclared: boolean): Declaration {
  if (ts.isIdentifier(d.name)) return { kind: 'var', decl: d, scopeNode, redeclared };
  const path = bindingPath(d.name, name);
  if (!path || path === 'rest') return { kind: 'opaque', why: 'rest/complex destructuring' };
  return { kind: 'destructured', decl: d, path };
}

/** One write site found in a scope (keyed by the root identifier it writes through). */
interface WriteSite {
  root: ts.Identifier;
  /** `assign`: `x = v`; `prop`: `x.k = v`; anything else is not modelled. */
  kind: 'assign' | 'prop' | 'unmodelled' | 'arg';
  key?: string;
  rhs?: ts.Expression;
  node: ts.Node;
  /** For `arg`: the call expression the variable is passed to. */
  call?: ts.CallExpression;
}

const SELF_MUTATORS = new Set(['push', 'unshift', 'splice', 'pop', 'shift', 'set', 'delete', 'add', 'clear', 'sort', 'reverse', 'fill', 'copyWithin']);
const PURE_GLOBAL_CALLS = new Set([
  'Object.freeze',
  'Object.keys',
  'Object.values',
  'Object.entries',
  'Object.isFrozen',
  'Object.getOwnPropertyNames',
  'JSON.stringify',
  'Array.isArray',
]);
const INTEROP_NAME = /^_*(interop|importDefault|importStar|getDefaultExport|toESM|toCommonJS)/i;

/** Root identifier of an access chain (`a.b[c].d` → `a`) and its depth. */
function accessRoot(e: ts.Expression): { root: ts.Expression; depth: number } {
  let depth = 0;
  let cur = skipParens(e);
  while (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
    depth++;
    cur = skipParens(cur.expression);
  }
  return { root: cur, depth };
}

function calleeText(e: ts.Expression): string | undefined {
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return `${e.expression.text}.${e.name.text}`;
  return undefined;
}

function collectWrites(container: ts.Node, count: () => void): Map<string, WriteSite[]> {
  const out = new Map<string, WriteSite[]>();
  const add = (site: WriteSite): void => {
    const arr = out.get(site.root.text);
    if (arr) arr.push(site);
    else out.set(site.root.text, [site]);
  };
  const addTarget = (target: ts.Expression, node: ts.Node, op: ts.SyntaxKind, rhs: ts.Expression | undefined): void => {
    const t = skipParens(target);
    if (ts.isIdentifier(t)) {
      add({ root: t, kind: op === ts.SyntaxKind.EqualsToken && rhs ? 'assign' : 'unmodelled', ...(rhs ? { rhs } : {}), node });
      return;
    }
    if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t)) {
      // destructuring assignment: every identifier inside is written in a way we don't model
      const visit = (x: ts.Node): void => {
        if (ts.isIdentifier(x)) add({ root: x, kind: 'unmodelled', node });
        ts.forEachChild(x, visit);
      };
      visit(t);
      return;
    }
    const { root, depth } = accessRoot(t);
    if (!ts.isIdentifier(root)) return;
    if (depth === 1 && op === ts.SyntaxKind.EqualsToken && rhs) {
      let key: string | undefined;
      if (ts.isPropertyAccessExpression(t)) key = t.name.text;
      else if (ts.isElementAccessExpression(t) && ts.isStringLiteralLike(t.argumentExpression)) key = t.argumentExpression.text;
      if (key !== undefined) {
        add({ root, kind: 'prop', key, rhs, node: t });
        return;
      }
    }
    add({ root, kind: 'unmodelled', node });
  };
  const walk = (n: ts.Node): void => {
    count();
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      addTarget(n.left, n, n.operatorToken.kind, n.right);
    } else if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)) {
      addTarget(n.operand, n, ts.SyntaxKind.PlusEqualsToken, undefined);
    } else if (ts.isDeleteExpression(n)) {
      addTarget(n.expression, n, ts.SyntaxKind.PlusEqualsToken, undefined);
    } else if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      addTarget(n.initializer as ts.Expression, n, ts.SyntaxKind.PlusEqualsToken, undefined);
    } else if (ts.isCallExpression(n)) {
      const c = n.expression;
      // x.push(…), x.a.set(…) — a mutating method on something rooted at x
      if (ts.isPropertyAccessExpression(c) && SELF_MUTATORS.has(c.name.text)) {
        const { root } = accessRoot(c.expression);
        if (ts.isIdentifier(root)) add({ root, kind: 'unmodelled', node: n });
      }
      for (const a of n.arguments) {
        const { root } = accessRoot(ts.isSpreadElement(a) ? a.expression : a);
        if (ts.isIdentifier(root)) add({ root, kind: 'arg', node: n, call: n });
      }
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(container, walk);
  return out;
}

export class StaticEvaluator {
  private readonly sources = new Map<string, ts.SourceFile | null>();
  private readonly modules = new Map<string, Promise<Value>>();
  private readonly computing = new Set<string>();
  private readonly inProgress = new Set<ts.Node>();
  private readonly blockDecls = new Map<ts.Node, Map<string, ts.VariableDeclaration[] | Declaration>>();
  private readonly varHoist = new Map<ts.Node, Map<string, ts.VariableDeclaration[]>>();
  private readonly declMemo = new Map<ts.Node, Declaration | null>();
  private readonly writeIndex = new Map<ts.SourceFile, Map<string, WriteSite[]>>();
  private readonly moduleVarCache = new Map<ts.VariableDeclaration, Promise<Value>>();
  private readonly refIndex = new Map<ts.SourceFile, Map<string, ts.Identifier[]>>();
  private readonly escapeCache = new Map<ts.Node, string | null>();
  private readonly callRootedCache = new Map<ts.SourceFile, boolean>();
  private readonly receiverCache = new Map<ts.Node, boolean>();
  private readonly stateReturnCache = new Map<ts.Node, Promise<boolean>>();
  private readonly stateReturnFreshCache = new Map<ts.Node, Promise<boolean>>();
  private readonly stateRunning = new Set<ts.Node>();
  private readonly stateRunningFresh = new Set<ts.Node>();
  private realRoots: string[] | undefined;
  private readonly realpathCache = new Map<string, Promise<string>>();
  private crawlCut = false;
  private steps = 0;
  private lastTimeCheck = 0;
  private depth = 0;
  private bytes = 0;
  private deadline: number;
  private timedOut = false;
  private readonly limits: EvaluatorLimits;
  private roots: string[] | undefined;

  constructor(
    private readonly fs: FileSystem,
    limits: Partial<EvaluatorLimits> = {},
    private readonly externals?: ExternalModules,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.roots = this.limits.roots?.map(resolveDots);
    this.deadline = Date.now() + this.limits.timeBudgetMs;
  }

  /** Number of files parsed so far (diagnostics/tests). */
  get filesParsed(): number {
    return this.sources.size;
  }

  /** Every file parsed so far (for post-read checks). */
  parsedFiles(): ts.SourceFile[] {
    return [...this.sources.values()].filter((s): s is ts.SourceFile => s !== null);
  }

  /** Start a fresh wall-clock budget (e.g. per plugin). */
  resetBudget(ms = this.limits.timeBudgetMs): void {
    this.deadline = Date.now() + ms;
    this.timedOut = false;
  }

  /** True once the wall-clock budget ran out (results computed after that are `unknown`). */
  get exhausted(): boolean {
    return this.timedOut || this.steps > this.limits.maxSteps;
  }

  /** Restrict relative module resolution to these directories (`undefined` lifts it). */
  setRoots(roots: string[] | undefined): void {
    this.roots = roots?.map(resolveDots);
  }

  private overBudget(): string | undefined {
    if (this.steps > this.limits.maxSteps) return 'step budget';
    if (this.steps - this.lastTimeCheck >= 256) {
      this.lastTimeCheck = this.steps;
      if (Date.now() > this.deadline) this.timedOut = true;
    }
    return this.timedOut ? 'time budget' : undefined;
  }

  private count = (): void => {
    this.steps++;
  };

  // -------------------------------------------------------------------------
  // Files & modules
  // -------------------------------------------------------------------------

  private readonly loading = new Map<string, Promise<ts.SourceFile | null>>();

  private source(file: string): Promise<ts.SourceFile | null> {
    const inFlight = this.loading.get(file);
    if (inFlight) return inFlight;
    if (this.sources.has(file)) return Promise.resolve(this.sources.get(file)!);
    if (this.sources.size >= this.limits.maxFiles) return Promise.resolve(null);
    this.sources.set(file, null); // reserves its place: the crawl order stays deterministic
    const p = (async (): Promise<ts.SourceFile | null> => {
      let sf: ts.SourceFile | null = null;
      try {
        const text = await this.fs.readFile(file);
        if (text.length <= MAX_PARSE_CHARS && this.bytes + text.length <= this.limits.maxBytes) {
          this.bytes += text.length;
          sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
        }
      } catch {
        sf = null;
      }
      this.sources.set(file, sf);
      this.loading.delete(file);
      return sf;
    })();
    this.loading.set(file, p);
    return p;
  }

  private inRoots(p: string): boolean {
    return !this.roots || this.roots.some((r) => r === p || isPathInside(r, p));
  }

  /** Real-path confinement (a symlink inside a package must not lead outside it), when the FS can tell. */
  private async inRealRoots(p: string): Promise<boolean> {
    if (!this.roots || !this.fs.realpath) return true;
    try {
      this.realRoots ??= await Promise.all(this.roots.map(async (r) => resolveDots(await this.fs.realpath!(r))));
      let pending = this.realpathCache.get(p);
      if (!pending) {
        pending = this.fs.realpath(p).then(resolveDots);
        this.realpathCache.set(p, pending);
      }
      const rp = await pending;
      return this.realRoots.some((r) => r === rp || isPathInside(r, rp));
    } catch {
      return false;
    }
  }

  /** Resolve a relative module specifier from `fromFile` to an existing file (inside the roots). */
  async resolveRelative(fromFile: string, spec: string): Promise<string | undefined> {
    const base = resolveDots(join(dirname(fromFile), spec));
    if (!this.inRoots(base)) return undefined;
    let pending = this.resolveCache.get(base);
    if (!pending) {
      pending = this.resolveBase(base);
      this.resolveCache.set(base, pending);
    }
    return pending;
  }

  private readonly resolveCache = new Map<string, Promise<string | undefined>>();
  private readonly dirCache = new Map<string, Promise<Map<string, FileType> | undefined>>();

  /** A folder's entries (one listing per folder per read). */
  private listing(dir: string): Promise<Map<string, FileType> | undefined> {
    let pending = this.dirCache.get(dir);
    if (!pending) {
      pending = this.fs.readDirectory(dir).then(
        (entries) => new Map(entries.map((e) => [e.name, e.type])),
        () => undefined,
      );
      this.dirCache.set(dir, pending);
    }
    return pending;
  }

  /** Is `dir/name` of this type? From the folder's listing; a case-only mismatch is left to `stat` (the FS decides). */
  private async isEntry(dir: string, name: string, type: FileType): Promise<boolean> {
    const entries = await this.listing(dir);
    if (!entries) return (await this.fs.stat(join(dir, name)))?.type === type;
    const t = entries.get(name);
    if (t !== undefined) return t === type || (t === FileType.SymbolicLink && (await this.fs.stat(join(dir, name)))?.type === type);
    const lower = name.toLowerCase();
    for (const k of entries.keys()) if (k.toLowerCase() === lower) return (await this.fs.stat(join(dir, name)))?.type === type;
    return false;
  }

  /** Node's resolution of a relative path: the file, `base` + an extension, or the folder's index. */
  private async resolveBase(base: string): Promise<string | undefined> {
    const dir = dirname(base);
    const name = base.slice(dir.length + 1);
    for (const ext of RESOLVE_EXT) {
      if (name + ext === '') continue;
      if (await this.isEntry(dir, name + ext, FileType.File)) return (await this.inRealRoots(base + ext)) ? base + ext : undefined;
    }
    if (await this.isEntry(dir, name, FileType.Directory)) {
      for (const idx of INDEX_FILES) {
        if (await this.isEntry(base, idx, FileType.File)) {
          const p = join(base, idx);
          return (await this.inRealRoots(p)) ? p : undefined;
        }
      }
    }
    return undefined;
  }

  /**
   * Parse (without evaluating) every file reachable through relative
   * `require`/`import` from what was parsed so far — so post-read checks
   * (writes into other modules, plugin rewrites) also see code that was loaded
   * but never followed. `crawlTruncated` is set when a limit cut it short.
   */
  /** Read and parse `file` and everything it reaches, in parallel, ahead of evaluating it. */
  async preload(file: string): Promise<void> {
    await this.source(file);
    await this.parseReachable();
  }

  async parseReachable(): Promise<void> {
    // Breadth-first, one level at a time: a level's files are resolved, then read and parsed, in parallel.
    let frontier = [...this.sources.keys()];
    const seen = new Set(frontier);
    while (frontier.length) {
      const resolved = await mapLimit(frontier, IO_CONCURRENCY, async (f) => {
        const sf = this.sources.get(f);
        if (!sf || f.endsWith('.json')) return [];
        return Promise.all(relativeSpecifiers(sf).map((spec) => this.resolveRelative(f, spec)));
      });
      const next: string[] = [];
      for (const targets of resolved) {
        for (const t of targets) {
          if (!t || seen.has(t)) continue;
          seen.add(t);
          next.push(t);
        }
      }
      if (this.sources.size + next.length > this.limits.maxFiles) {
        this.crawlCut = true;
        return;
      }
      for (const t of next) void this.source(t); // reserve in order
      const parsed = await mapLimit(next, IO_CONCURRENCY, (t) => this.source(t));
      if (parsed.some((x) => !x)) this.crawlCut = true;
      frontier = next;
    }
  }

  /** True when {@link parseReachable} could not parse every reachable file. */
  get crawlTruncated(): boolean {
    return this.crawlCut;
  }

  private async requireModule(fromFile: string, spec: string): Promise<Value> {
    if (!spec.startsWith('.')) return this.externals?.(spec, this) ?? UNKNOWN(`external module '${spec}'`);
    const file = await this.resolveRelative(fromFile, spec);
    if (!file) return UNKNOWN(`unresolved '${spec}'`);
    return this.moduleExports(file);
  }

  /** The value of `module.exports` (CJS) or the module namespace (ESM) of `file`. */
  moduleExports(file: string): Promise<Value> {
    const key = resolveDots(file);
    // Evaluation is one sequential async chain: re-entry while computing is a cycle.
    if (this.computing.has(key)) return Promise.resolve(UNKNOWN('module cycle'));
    const done = this.modules.get(key);
    if (done) return done;
    this.computing.add(key);
    const p = this.computeModuleExports(key)
      .catch(() => UNKNOWN('evaluation error'))
      .finally(() => this.computing.delete(key));
    this.modules.set(key, p);
    return p;
  }

  private async computeModuleExports(file: string): Promise<Value> {
    const sf = await this.source(file);
    if (!sf) return UNKNOWN(`unreadable ${file}`);
    if (file.endsWith('.json')) {
      const stmt = sf.statements[0];
      if (stmt && ts.isExpressionStatement(stmt)) return this.ev(stmt.expression, file, undefined);
      return UNKNOWN('empty json');
    }

    // CommonJS writes, applied in source order the way Node does: `exports.x = …`
    // writes the ORIGINAL exports object; `module.exports = …` replaces the
    // module value (later `exports.x` writes are then lost, `module.exports.x`
    // writes land on the new value).
    type Op =
      | { kind: 'prop'; target: 'exports' | 'module'; name: string; node: ts.Node; thunk: Lazy }
      | { kind: 'base'; rhs: ts.Expression };
    const ops: Op[] = [];
    let esModule = false;
    let open = false;
    const starFrom: string[] = [];
    // ESM namespace props (no ordering subtleties)
    const esmProps = new Map<string, Lazy>();
    const esmLocs = new Map<string, Loc>();
    const setEsm = (name: string, node: ts.Node, thunk: Lazy): void => {
      esmProps.set(name, memo(thunk));
      esmLocs.set(name, { file, pos: node.getStart(sf) });
    };

    /** Register the exports writes along an assignment chain `a = b = … = rhs`; returns the nodes modelled. */
    const assignmentChain = (expr: ts.Expression): Set<ts.Node> | undefined => {
      const lefts: ts.Expression[] = [];
      let e = skipParens(expr);
      while (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        lefts.push(e.left);
        e = skipParens(e.right);
      }
      const rhs = e;
      const modelled = new Set<ts.Node>();
      for (const left of lefts) {
        if (isModuleExports(left)) {
          ops.push({ kind: 'base', rhs });
          modelled.add(left);
          continue;
        }
        const m = exportsMember(left);
        if (!m) continue;
        modelled.add(left);
        if (m.name === '__esModule') {
          const t = rhs.kind === ts.SyntaxKind.TrueKeyword || (ts.isPrefixUnaryExpression(rhs) && rhs.operator === ts.SyntaxKind.ExclamationToken);
          if (t) esModule = true;
          continue;
        }
        ops.push({ kind: 'prop', target: m.target, name: m.name, node: left, thunk: () => this.ev(rhs, file, undefined) });
      }
      return lefts.length && modelled.size ? modelled : undefined;
    };

    const descriptorThunk = (desc: ts.ObjectLiteralExpression): Lazy | undefined => {
      const valueProp = desc.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && propName(q.name) === 'value');
      if (valueProp) return () => this.ev(valueProp.initializer, file, undefined);
      const getter = desc.properties.find((q) => (ts.isPropertyAssignment(q) || ts.isMethodDeclaration(q)) && propName(q.name) === 'get');
      if (!getter) return undefined;
      return async () => {
        const fnNode = ts.isPropertyAssignment(getter) ? getter.initializer : (getter as ts.MethodDeclaration);
        const fn = ts.isMethodDeclaration(fnNode) ? this.fnValue(fnNode, file, undefined) : await this.ev(fnNode, file, undefined);
        return fn.k === 'fn' ? this.call(fn, []) : UNKNOWN('getter');
      };
    };

    for (const stmt of sf.statements) {
      this.steps++;
      if (ts.isExpressionStatement(stmt)) {
        const e = skipParens(stmt.expression);
        if (ts.isStringLiteralLike(e)) continue; // 'use strict'
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const modelled = assignmentChain(e);
          if (modelled) {
            if (touchesExports(stmt, modelled)) open = true;
            continue;
          }
        }
        if (ts.isCallExpression(e)) {
          const callee = e.expression;
          const ct = calleeText(callee);
          const [a0, a1, a2] = e.arguments;
          const isExportsTarget = (x: ts.Expression | undefined): 'exports' | 'module' | undefined =>
            x && ts.isIdentifier(x) && x.text === 'exports' ? 'exports' : x && isModuleExports(x) ? 'module' : undefined;
          if (ct === 'Object.defineProperty' && isExportsTarget(a0) && a1 && ts.isStringLiteralLike(a1)) {
            const target = isExportsTarget(a0)!;
            if (a1.text === '__esModule') esModule = true;
            else {
              const thunk = a2 && ts.isObjectLiteralExpression(a2) ? descriptorThunk(a2) : undefined;
              if (thunk) ops.push({ kind: 'prop', target, name: a1.text, node: a1, thunk });
              else open = true;
            }
            continue;
          }
          if (ct === 'Object.defineProperties' && isExportsTarget(a0)) {
            const target = isExportsTarget(a0)!;
            if (a1 && ts.isObjectLiteralExpression(a1)) {
              for (const p of a1.properties) {
                const pname = ts.isPropertyAssignment(p) ? propName(p.name) : undefined;
                if (pname === undefined) {
                  const isSymbolKey = ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name) && /^Symbol\./.test(p.name.expression.getText(sf));
                  if (!isSymbolKey) open = true;
                  continue;
                }
                if (pname === '__esModule') {
                  esModule = true;
                  continue;
                }
                const desc = (p as ts.PropertyAssignment).initializer;
                const thunk = ts.isObjectLiteralExpression(desc) ? descriptorThunk(desc) : undefined;
                if (thunk) ops.push({ kind: 'prop', target, name: pname, node: p, thunk });
                else open = true;
              }
            } else open = true;
            continue;
          }
          // tsc: __exportStar(require('./x'), exports)
          if (ts.isIdentifier(callee) && /exportStar/i.test(callee.text) && a0 && isExportsTarget(a1)) {
            const r = skipParens(a0);
            if (ts.isCallExpression(r) && ts.isIdentifier(r.expression) && r.expression.text === 'require' && r.arguments[0] && ts.isStringLiteralLike(r.arguments[0])) {
              starFrom.push(r.arguments[0].text);
            } else open = true;
            continue;
          }
          // A bare relative `require('./x')` runs that module for its side effects — it may patch anything.
          if (ts.isIdentifier(callee) && callee.text === 'require' && a0 && ts.isStringLiteralLike(a0) && a0.text.startsWith('.')) {
            open = true;
            continue;
          }
        }
        if (touchesExports(stmt)) open = true;
        continue;
      }

      if (ts.isVariableStatement(stmt) && !hasExportModifier(stmt)) {
        // Babel ≥7.23: `var _default = exports.default = { … }`
        const modelled = new Set<ts.Node>();
        for (const d of stmt.declarationList.declarations) {
          if (!d.initializer) continue;
          const m = assignmentChain(d.initializer);
          if (m) for (const x of m) modelled.add(x);
        }
        if (touchesExports(stmt, modelled)) open = true;
        continue;
      }

      // ---- ES modules -----------------------------------------------------
      if (ts.isImportDeclaration(stmt)) {
        // `import './x'` — run for side effects only
        if (!stmt.importClause && ts.isStringLiteralLike(stmt.moduleSpecifier) && stmt.moduleSpecifier.text.startsWith('.')) open = true;
        continue;
      }
      if (ts.isExportAssignment(stmt)) {
        esModule = true;
        const expr = stmt.expression;
        if (stmt.isExportEquals) ops.push({ kind: 'base', rhs: expr });
        else setEsm('default', stmt, () => this.ev(expr, file, undefined));
        continue;
      }
      if (ts.isExportDeclaration(stmt)) {
        esModule = true;
        if (stmt.isTypeOnly) continue;
        const spec = stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined;
        if (!stmt.exportClause) {
          if (spec) starFrom.push(spec);
          else open = true;
          continue;
        }
        if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.isTypeOnly) continue;
            const exported = el.name.text;
            const local = (el.propertyName ?? el.name).text;
            if (spec) setEsm(exported, el, async () => this.getProp(await this.requireModule(file, spec), local));
            else {
              const id = (el.propertyName ?? el.name) as ts.Identifier;
              setEsm(exported, el, () => this.resolveIdentifierByName(local, id, file, undefined));
            }
          }
        } else {
          const exported = stmt.exportClause.name.text;
          if (spec) setEsm(exported, stmt, () => this.requireModule(file, spec));
        }
        continue;
      }
      if (hasExportModifier(stmt)) {
        esModule = true;
        if (ts.isVariableStatement(stmt)) {
          for (const d of stmt.declarationList.declarations) {
            if (!ts.isIdentifier(d.name)) {
              open = true;
              continue;
            }
            const id = d.name;
            setEsm(id.text, id, () => this.resolveIdentifierByName(id.text, id, file, undefined));
          }
        } else if (ts.isFunctionDeclaration(stmt)) {
          const name = hasDefaultModifier(stmt) ? 'default' : stmt.name?.text;
          if (name) {
            const node = stmt;
            setEsm(name, stmt, () => Promise.resolve(this.fnValue(node, file, undefined, node.name?.text)));
          }
        } else if (ts.isClassDeclaration(stmt)) {
          const name = hasDefaultModifier(stmt) ? 'default' : stmt.name?.text;
          if (name) setEsm(name, stmt, () => Promise.resolve(UNKNOWN('class')));
        } else {
          open = true;
        }
        continue;
      }
      // Any other top-level statement (if/for/while/try/blocks, function
      // declarations writing `exports`…): not modelled → if it touches exports, open.
      if (touchesExports(stmt)) open = true;
    }

    // Apply the CommonJS ops in order.
    const sfLoc = (node: ts.Node): Loc => ({ file, pos: node.getStart(sf) });
    let value: ObjValue | Value = { k: 'obj', props: new Map(), keyLocs: new Map(), open: false, loc: { file, pos: 0 } } as ObjValue;
    let replaced = false;
    for (const op of ops) {
      if (op.kind === 'base') {
        value = await this.ev(op.rhs, file, undefined);
        replaced = true;
        continue;
      }
      // After `module.exports = …`, `exports.x` writes go to the stale object.
      if (replaced && op.target === 'exports') continue;
      if (value.k !== 'obj') {
        value = UNKNOWN('property written on a non-object module value');
        break;
      }
      const next: ObjValue = { ...value, props: new Map(value.props), keyLocs: new Map(value.keyLocs) };
      next.props.set(op.name, memo(op.thunk));
      next.keyLocs.set(op.name, sfLoc(op.node));
      value = next;
    }

    if (value.k !== 'obj') {
      if (esmProps.size || starFrom.length) return UNKNOWN('mixed module shapes');
      return open && value.k !== 'unknown' ? UNKNOWN('module exports not exhaustive') : value;
    }
    const out: ObjValue = { ...value, props: new Map(value.props), keyLocs: new Map(value.keyLocs) };
    if (open) out.open = true;
    if (esModule) out.esModule = true;
    for (const [k, t] of esmProps) out.props.set(k, t);
    for (const [k, l] of esmLocs) out.keyLocs.set(k, l);
    for (const spec of starFrom) {
      const mod = await this.requireModule(file, spec);
      if (mod.k !== 'obj') {
        out.open = true;
        continue;
      }
      if (mod.open) out.open = true;
      for (const [k, thunk] of mod.props) {
        if (k === 'default' || out.props.has(k)) continue;
        out.props.set(k, thunk);
        const kl = mod.keyLocs.get(k);
        if (kl) out.keyLocs.set(k, kl);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Values
  // -------------------------------------------------------------------------

  /** Force a lazily-held property/item. */
  async force(l: Lazy | undefined): Promise<Value> {
    return l ? l() : NIL;
  }

  /** Read `base[key]`. */
  async getProp(base: Value, key: string): Promise<Value> {
    if (base.k === 'obj') {
      const t = base.props.get(key);
      if (t) return t();
      if (key === '__esModule' && base.esModule) return { k: 'bool', v: true };
      return base.open ? UNKNOWN(`open object (no '${key}')`) : NIL;
    }
    if (base.k === 'unknown') return base;
    if (base.k === 'nil') return UNKNOWN(`property '${key}' of nil`);
    return UNKNOWN(`property '${key}' of ${base.k}`);
  }

  fnValue(node: FnValue['node'], file: string, scope: Scope | undefined, name?: string): FnValue {
    const sf = node.getSourceFile();
    const anchor = (node as { name?: ts.Node }).name ?? node;
    return { k: 'fn', node, file, scope, loc: { file, pos: anchor.getStart(sf) }, ...(name ? { name } : {}) };
  }

  /** Is `fn` a bundler interop helper (by name AND by body shape)? */
  private interopKind(fn: FnValue): 'unwrap' | 'namespace' | undefined {
    if (!fn.name || !INTEROP_NAME.test(fn.name)) return undefined;
    const body = fn.node.body;
    if (!body || !body.getText(fn.node.getSourceFile()).includes('__esModule')) return undefined;
    return /getDefaultExport/i.test(fn.name) ? 'unwrap' : 'namespace';
  }

  /** Call a function value with already-evaluated arguments. */
  async call(fn: Value, args: Value[]): Promise<Value> {
    if (fn.k === 'native') return fn.impl(args);
    if (fn.k !== 'fn') return fn.k === 'unknown' ? fn : UNKNOWN(`call of ${fn.k}`);
    const budget = this.overBudget();
    if (budget) return UNKNOWN(budget);
    if (this.depth >= this.limits.maxDepth) return UNKNOWN('max depth');
    if (this.inProgress.has(fn.node)) return UNKNOWN('recursive call');
    const node = fn.node;
    const body = node.body;
    if (!body) return UNKNOWN('no body');
    const bindings = new Map<string, Value>();
    const scope: Scope = { fn: node, bindings, parent: fn.scope };
    this.inProgress.add(node);
    this.depth++;
    try {
      for (let i = 0; i < node.parameters.length; i++) {
        const p = node.parameters[i]!;
        if (!ts.isIdentifier(p.name)) continue;
        let v = args[i] ?? NIL;
        if (v.k === 'nil' && p.initializer) v = await this.ev(p.initializer, fn.file, scope);
        bindings.set(p.name.text, v);
      }
      if (!ts.isBlock(body)) return await this.ev(body, fn.file, scope);
      const returns: ts.ReturnStatement[] = [];
      forEachInScope(body, (n) => {
        if (ts.isReturnStatement(n)) returns.push(n);
      });
      if (returns.length === 0) return NIL;
      if (returns.length > 1) {
        // Only one shape is followed: every return yields the same variable or
        // access path on the same binding (rollup's `if (cached) return x; …; return x;`
        // and its `return m.__module.exports` variant).
        const exprs = returns.map((r) => (r.expression ? skipParens(r.expression) : undefined));
        const sig = (e: ts.Expression | undefined): { text: string; decl: Declaration | undefined } | undefined => {
          if (!e) return undefined;
          const { root } = accessRoot(e);
          if (!ts.isIdentifier(root)) return undefined;
          return { text: e.getText(), decl: this.findDeclaration(root.text, root) };
        };
        const s0 = sig(exprs[0]);
        if (!s0 || !s0.decl) return UNKNOWN('several returns');
        const same = exprs.every((e) => {
          const s1 = sig(e);
          return !!s1 && s1.text === s0.text && sameDeclaration(s1.decl, s0.decl);
        });
        if (!same) return UNKNOWN('several returns');
      }
      const last = returns[returns.length - 1]!;
      return last.expression ? await this.ev(last.expression, fn.file, scope) : NIL;
    } finally {
      this.depth--;
      this.inProgress.delete(node);
    }
  }

  /** Evaluate an expression. */
  async ev(node: ts.Expression, file: string, scope: Scope | undefined): Promise<Value> {
    this.steps++;
    const budget = this.overBudget();
    if (budget) return UNKNOWN(budget);
    if (this.depth >= this.limits.maxDepth) return UNKNOWN('max depth');
    this.depth++;
    try {
      return await this.evInner(node, file, scope);
    } finally {
      this.depth--;
    }
  }

  private async evInner(node: ts.Expression, file: string, scope: Scope | undefined): Promise<Value> {
    const sf = node.getSourceFile();
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    ) {
      return this.ev(node.expression, file, scope);
    }
    if (ts.isStringLiteralLike(node)) return { k: 'str', v: node.text, loc: { file, pos: node.getStart(sf) } };
    if (ts.isNumericLiteral(node)) return { k: 'num', v: Number(node.text) };
    if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: 'bool', v: true };
    if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: 'bool', v: false };
    if (node.kind === ts.SyntaxKind.NullKeyword) return NIL;
    if (ts.isVoidExpression(node)) return NIL;
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      const v = truthy(await this.ev(node.operand, file, scope));
      return v === undefined ? UNKNOWN('!unknown') : { k: 'bool', v: !v };
    }
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(node.operand)) {
      return { k: 'num', v: -Number(node.operand.text) };
    }
    if (ts.isObjectLiteralExpression(node)) return this.evObject(node, file, scope);
    if (ts.isArrayLiteralExpression(node)) return this.evArray(node, file, scope);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      return this.fnValue(node, file, scope, (ts.isFunctionExpression(node) ? node.name?.text : undefined) ?? bindingNameOf(node));
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return NIL;
      return this.resolveIdentifierByName(node.text, node, file, scope);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (isModuleExports(node)) return UNKNOWN('self module.exports');
      const virtual = this.rollupVirtualExports(node);
      if (virtual) {
        if (virtual === 'ambiguous') return UNKNOWN('virtual module written twice');
        const v = await this.ev(virtual.value, file, undefined);
        if (!virtual.props.length || v.k !== 'obj') return v; // props added on a function value don't change what we read
        const out: ObjValue = { ...v, props: new Map(v.props), keyLocs: new Map(v.keyLocs) };
        for (const w of virtual.props) out.props.set(w.key, memo(() => this.ev(w.rhs, file, undefined)));
        return out;
      }
      const base = await this.ev(node.expression, file, scope);
      return this.getProp(base, node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (!ts.isStringLiteralLike(arg) && !ts.isNumericLiteral(arg)) return UNKNOWN('computed access');
      if (isModuleExports(node)) return UNKNOWN('self module.exports');
      const base = await this.ev(node.expression, file, scope);
      if (base.k === 'arr' && ts.isNumericLiteral(arg)) {
        const i = Number(arg.text);
        if (base.open) return UNKNOWN('open array');
        return this.force(base.items[i]);
      }
      return this.getProp(base, arg.text);
    }
    if (ts.isCallExpression(node)) return this.evCall(node, file, scope);
    if (ts.isConditionalExpression(node)) {
      const c = truthy(await this.ev(node.condition, file, scope));
      if (c === undefined) return UNKNOWN('conditional');
      return this.ev(c ? node.whenTrue : node.whenFalse, file, scope);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.CommaToken) return this.ev(node.right, file, scope);
      if (op === ts.SyntaxKind.EqualsToken) return this.ev(node.right, file, scope);
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
        const left = await this.ev(node.left, file, scope);
        const t = truthy(left);
        if (t === undefined) return UNKNOWN('&& on unknown');
        return t ? this.ev(node.right, file, scope) : left;
      }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const left = await this.ev(node.left, file, scope);
        if (left.k === 'unknown') return left;
        if (op === ts.SyntaxKind.QuestionQuestionToken) return left.k === 'nil' ? this.ev(node.right, file, scope) : left;
        const t = truthy(left);
        if (t === undefined) return UNKNOWN('|| on unknown');
        return t ? left : this.ev(node.right, file, scope);
      }
      return UNKNOWN(`binary ${ts.SyntaxKind[op]}`);
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      // Top-level `this` of a CommonJS module is `module.exports` before any write — tsc's
      // `(this && this.__importDefault) || function …` helper guard reads it. Elsewhere: unknown.
      let f: ts.Node | undefined = node.parent;
      while (f && !ts.isSourceFile(f) && !(isFunctionLike(f) && !ts.isArrowFunction(f))) f = f.parent;
      return f && ts.isSourceFile(f) ? { k: 'obj', props: new Map(), keyLocs: new Map(), open: false } : UNKNOWN('this');
    }
    if (ts.isAwaitExpression(node)) return this.ev(node.expression, file, scope);
    if (ts.isTemplateExpression(node)) return UNKNOWN('template');
    if (ts.isClassExpression(node)) return UNKNOWN('class');
    if (ts.isNewExpression(node)) return UNKNOWN('new');
    return UNKNOWN(ts.SyntaxKind[node.kind]);
  }

  private async evObject(node: ts.ObjectLiteralExpression, file: string, scope: Scope | undefined): Promise<ObjValue> {
    const sf = node.getSourceFile();
    const out: ObjValue = { k: 'obj', props: new Map(), keyLocs: new Map(), open: false, loc: { file, pos: node.getStart(sf) } };
    for (const p of node.properties) {
      this.steps++;
      if (ts.isSpreadAssignment(p)) {
        const v = await this.ev(p.expression, file, scope);
        if (v.k === 'obj') {
          if (v.open) out.open = true;
          for (const [k, t] of v.props) {
            out.props.set(k, t);
            const kl = v.keyLocs.get(k);
            if (kl) out.keyLocs.set(k, kl);
          }
        } else if (v.k !== 'nil') {
          out.open = true;
        }
        continue;
      }
      const name = p.name ? propName(p.name) : undefined;
      if (name === undefined) {
        out.open = true;
        continue;
      }
      const keyLoc = { file, pos: p.name!.getStart(sf) };
      if (ts.isPropertyAssignment(p)) {
        const init = p.initializer;
        out.props.set(name, memo(() => this.ev(init, file, scope)));
      } else if (ts.isShorthandPropertyAssignment(p)) {
        const id = p.name;
        out.props.set(name, memo(() => this.resolveIdentifierByName(id.text, id, file, scope)));
      } else if (ts.isMethodDeclaration(p)) {
        const m = p;
        out.props.set(name, memo(() => Promise.resolve(this.fnValue(m, file, scope, name))));
      } else if (ts.isGetAccessorDeclaration(p)) {
        const g = p;
        out.props.set(name, memo(() => this.call(this.fnValue(g, file, scope, name), [])));
      } else {
        continue; // setter only — not a readable value
      }
      out.keyLocs.set(name, keyLoc);
    }
    return out;
  }

  private async evArray(node: ts.ArrayLiteralExpression, file: string, scope: Scope | undefined): Promise<ArrValue> {
    const sf = node.getSourceFile();
    const out: ArrValue = { k: 'arr', items: [], open: false, loc: { file, pos: node.getStart(sf) } };
    for (const el of node.elements) {
      this.steps++;
      if (ts.isSpreadElement(el)) {
        const v = await this.ev(el.expression, file, scope);
        if (v.k === 'arr') {
          if (v.open) out.open = true;
          out.items.push(...v.items);
        } else {
          out.open = true;
        }
        continue;
      }
      if (ts.isOmittedExpression(el)) continue;
      const e = el;
      out.items.push(memo(() => this.ev(e, file, scope)));
    }
    return out;
  }

  private async evCall(node: ts.CallExpression, file: string, scope: Scope | undefined): Promise<Value> {
    const callee = node.expression;
    if (ts.isIdentifier(callee) && callee.text === 'require' && !this.isLocallyDeclared(callee, 'require')) {
      const spec = node.arguments[0];
      if (spec && ts.isStringLiteralLike(spec)) return this.requireModule(file, spec.text);
      return UNKNOWN('dynamic require');
    }
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object') {
      const m = callee.name.text;
      if ((m === 'freeze' || m === 'seal') && node.arguments[0]) return this.ev(node.arguments[0], file, scope);
      if (m === 'assign') return this.assign(node.arguments, file, scope);
      return UNKNOWN(`Object.${m}`);
    }
    const fn = await this.ev(callee, file, scope);
    if (fn.k === 'native') {
      const nargs: Value[] = [];
      for (const a of node.arguments) nargs.push(ts.isSpreadElement(a) ? UNKNOWN('spread arg') : await this.ev(a, file, scope));
      return fn.impl(nargs);
    }
    if (fn.k !== 'fn') return fn.k === 'unknown' ? UNKNOWN(`call: ${fn.why}`) : UNKNOWN(`call of ${fn.k}`);
    const interop = this.interopKind(fn);
    if (interop) {
      const a = node.arguments[0] ? await this.ev(node.arguments[0], file, scope) : NIL;
      return interop === 'unwrap' ? this.unwrapDefault(a) : this.interopNamespace(a);
    }
    const args: Value[] = [];
    for (const a of node.arguments) {
      if (ts.isSpreadElement(a)) {
        args.push(UNKNOWN('spread arg'));
        continue;
      }
      args.push(
        ts.isIdentifier(a) || ts.isObjectLiteralExpression(a) || ts.isStringLiteralLike(a) || ts.isArrowFunction(a) || ts.isFunctionExpression(a)
          ? await this.ev(a, file, scope)
          : UNKNOWN('arg'),
      );
    }
    return this.call(fn, args);
  }

  /** `getDefaultExportFromCjs(x)`: the CJS value Node would hand an ESM importer. */
  private async unwrapDefault(v: Value): Promise<Value> {
    if (v.k === 'obj' && v.esModule && v.props.has('default')) return this.getProp(v, 'default');
    return v;
  }

  /** `__importDefault(x)` / `_interopDefault(x)` / `__importStar(x)`: a namespace whose `.default` is the CJS value. */
  private async interopNamespace(v: Value): Promise<Value> {
    if (v.k === 'obj' && (v.esModule || v.props.has('default'))) return v;
    if (v.k === 'unknown') return v;
    const ns: ObjValue = { k: 'obj', props: new Map(), keyLocs: new Map(), open: false, esModule: true };
    if (v.k === 'obj') {
      for (const [k, t] of v.props) ns.props.set(k, t);
      for (const [k, l] of v.keyLocs) ns.keyLocs.set(k, l);
      ns.open = v.open;
      if (v.loc) ns.loc = v.loc;
    }
    ns.props.set('default', () => Promise.resolve(v));
    return ns;
  }

  private async assign(args: ts.NodeArray<ts.Expression>, file: string, scope: Scope | undefined): Promise<Value> {
    const out: ObjValue = { k: 'obj', props: new Map(), keyLocs: new Map(), open: false };
    for (const a of args) {
      const v = ts.isSpreadElement(a) ? UNKNOWN('spread') : await this.ev(a, file, scope);
      if (v.k === 'obj') {
        if (v.open) out.open = true;
        for (const [k, t] of v.props) out.props.set(k, t);
        for (const [k, l] of v.keyLocs) out.keyLocs.set(k, l);
        if (!out.loc && v.loc) out.loc = v.loc;
      } else if (v.k !== 'nil') {
        out.open = true;
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Identifiers
  // -------------------------------------------------------------------------

  private isLocallyDeclared(id: ts.Identifier, name: string): boolean {
    const d = this.findDeclaration(name, id);
    return d !== undefined && d.kind !== 'opaque';
  }

  /** `var` declarations of a function body / source file (not nested functions), by name. */
  private hoisted(body: ts.Node): Map<string, ts.VariableDeclaration[]> {
    let m = this.varHoist.get(body);
    if (m) return m;
    m = new Map();
    const map = m;
    forEachInScope(body, (n) => {
      this.steps++;
      if (!ts.isVariableDeclaration(n)) return;
      const list = n.parent;
      const isVar = ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      if (!isVar) return;
      for (const name of bindingNames(n.name)) {
        const arr = map.get(name);
        if (arr) arr.push(n);
        else map.set(name, [n]);
      }
    });
    this.varHoist.set(body, m);
    return m;
  }

  /** Direct declarations of a block / source file, by name. */
  private blockScope(block: ts.Node): Map<string, ts.VariableDeclaration[] | Declaration> {
    let m = this.blockDecls.get(block);
    if (m) return m;
    m = new Map();
    const stmts = (block as ts.Block | ts.SourceFile | ts.CaseClause).statements;
    const put = (name: string, d: Declaration): void => {
      if (!m!.has(name)) m!.set(name, d);
    };
    for (const s of stmts) {
      this.steps++;
      if (ts.isVariableStatement(s)) {
        for (const d of s.declarationList.declarations) {
          for (const name of bindingNames(d.name)) {
            const existing = m.get(name);
            if (Array.isArray(existing)) existing.push(d);
            else if (!existing) m.set(name, [d]);
          }
        }
      } else if (ts.isFunctionDeclaration(s) && s.name) {
        put(s.name.text, { kind: 'fn', decl: s });
      } else if (ts.isClassDeclaration(s) && s.name) {
        put(s.name.text, { kind: 'opaque', why: 'class' });
      } else if (ts.isEnumDeclaration(s)) {
        put(s.name.text, { kind: 'opaque', why: 'enum' });
      } else if (ts.isImportDeclaration(s) && s.importClause && !s.importClause.isTypeOnly) {
        const ic = s.importClause;
        if (ic.name) put(ic.name.text, { kind: 'import', decl: s, imported: 'default' });
        const nb = ic.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) put(nb.name.text, { kind: 'import', decl: s, imported: 'namespace' });
        if (nb && ts.isNamedImports(nb)) {
          for (const el of nb.elements) put(el.name.text, { kind: 'import', decl: s, imported: (el.propertyName ?? el.name).text });
        }
      }
    }
    this.blockDecls.set(block, m);
    return m;
  }

  /** The var-scope node a block's declarations belong to (function body or source file). */
  private varScopeOf(n: ts.Node): ts.Node {
    let c: ts.Node | undefined = n;
    while (c && !isFunctionLike(c) && !ts.isSourceFile(c)) c = c.parent;
    if (c && isFunctionLike(c) && c.body) return c.body;
    return c ?? n;
  }

  /** Find the declaration `name` refers to at `at`, walking lexical scopes outward (memoized). */
  private findDeclaration(name: string, at: ts.Node): Declaration | undefined {
    const memoKey = ts.isIdentifier(at) && at.text === name ? at : undefined;
    if (memoKey && this.declMemo.has(memoKey)) return this.declMemo.get(memoKey) ?? undefined;
    const d = this.findDeclarationUncached(name, at);
    if (memoKey) this.declMemo.set(memoKey, d ?? null);
    return d;
  }

  private findDeclarationUncached(name: string, at: ts.Node): Declaration | undefined {
    let n: ts.Node | undefined = at.parent;
    // A function declaration's own name is resolved from outside the function.
    if (n && ts.isFunctionDeclaration(n) && n.name === at) n = n.parent;
    while (n && !isScopeNode(n)) n = n.parent;
    return n ? this.resolveIn(n, name) : undefined;
  }

  private readonly scopeResolution = new Map<ts.Node, Map<string, Declaration | null>>();

  /** `name` as seen from scope node `n` (inclusive) outward — memoized per scope. */
  private resolveIn(n: ts.Node, name: string): Declaration | undefined {
    let m = this.scopeResolution.get(n);
    if (!m) this.scopeResolution.set(n, (m = new Map()));
    const hit = m.get(name);
    if (hit !== undefined) return hit ?? undefined;
    this.steps++;
    let found = this.declaredAt(n, name);
    if (!found) {
      let p = n.parent;
      while (p && !isScopeNode(p)) p = p.parent;
      if (p) found = this.resolveIn(p, name);
    }
    m.set(name, found ?? null);
    return found;
  }

  /** What scope node `n` itself declares as `name`. */
  private declaredAt(n: ts.Node, name: string): Declaration | undefined {
    {
      if (isFunctionLike(n)) {
        const idx = n.parameters.findIndex((p) => bindingNames(p.name).includes(name));
        if (idx >= 0) {
          const p = n.parameters[idx]!;
          return { kind: 'param', fn: n, index: idx, destructured: !ts.isIdentifier(p.name) };
        }
        if (ts.isFunctionDeclaration(n) && n.name?.text === name) return { kind: 'fn', decl: n };
        if (n.body) {
          const vars = this.hoisted(n.body).get(name);
          if (vars?.length) return declarationFromVar(vars[0]!, name, n.body, vars.length > 1);
        }
      }
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
        const entry = this.blockScope(n).get(name);
        if (entry) {
          if (Array.isArray(entry)) {
            const scopeNode = this.varScopeOf(n);
            const first = entry[0]!;
            const list = first.parent;
            const isVar = ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
            const all = isVar ? (this.hoisted(scopeNode).get(name) ?? entry) : entry;
            return declarationFromVar(first, name, scopeNode, all.length > 1 || entry.length > 1);
          }
          return entry;
        }
        if (ts.isSourceFile(n)) {
          const vars = this.hoisted(n).get(name);
          if (vars?.length) return declarationFromVar(vars[0]!, name, n, vars.length > 1);
        }
      }
      if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
        if (n.initializer.declarations.some((d) => bindingNames(d.name).includes(name))) return { kind: 'opaque', why: 'loop variable' };
      }
      if (ts.isCatchClause(n) && n.variableDeclaration && bindingNames(n.variableDeclaration.name).includes(name)) {
        return { kind: 'opaque', why: 'catch variable' };
      }
    }
    return undefined;
  }

  private async resolveIdentifierByName(name: string, at: ts.Identifier, file: string, scope: Scope | undefined): Promise<Value> {
    const d = this.findDeclaration(name, at);
    if (!d) return UNKNOWN(`global '${name}'`);
    switch (d.kind) {
      case 'opaque':
        return UNKNOWN(d.why);
      case 'param': {
        if (d.destructured) return UNKNOWN('destructured param');
        const unsafe = this.paramUnsafe(d, name);
        if (unsafe) return UNKNOWN(`param '${name}' ${unsafe}`);
        for (let s = scope; s; s = s.parent) if (s.fn === d.fn) return s.bindings.get(name) ?? NIL;
        return UNKNOWN(`unbound param '${name}'`);
      }
      case 'fn':
        return this.fnValue(d.decl, file, scope, d.decl.name?.text);
      case 'import': {
        const spec = d.decl.moduleSpecifier;
        if (!ts.isStringLiteralLike(spec)) return UNKNOWN('import');
        const mod = await this.requireModule(file, spec.text);
        if (d.imported === 'namespace') return mod;
        if (d.imported === 'default') {
          if (mod.k === 'obj' && mod.esModule) return this.getProp(mod, 'default');
          return mod;
        }
        return this.getProp(mod, d.imported);
      }
      case 'var':
        return this.evVariable(d, file, scope);
      case 'destructured': {
        if (!d.decl.initializer) return UNKNOWN('destructured without initializer');
        let v = await this.ev(d.decl.initializer, file, scope);
        for (const step of d.path) {
          if (typeof step.key === 'number') v = v.k === 'arr' && !v.open ? await this.force(v.items[step.key]) : UNKNOWN('array pattern');
          else v = await this.getProp(v, step.key);
          if (v.k === 'nil' && step.dflt) v = await this.ev(step.dflt, file, scope);
        }
        return v;
      }
    }
  }

  /** The (once-built) write index of a scope. */
  /**
   * The write sites inside a scope. Built once per FILE (a per-scope build re-walks
   * every nested function: quadratic on bundles), then sliced to the scope's range.
   */
  private writesIn(scopeNode: ts.Node): ScopedIndex<WriteSite> {
    const sf = scopeNode.getSourceFile();
    let all = this.writeIndex.get(sf);
    if (!all) {
      all = collectWrites(sf, this.count);
      for (const list of all.values()) list.sort((a, b) => a.root.pos - b.root.pos);
      this.writeIndex.set(sf, all);
    }
    return this.scoped(all, scopeNode, (w) => w.root.pos);
  }

  private readonly slices = new Map<ts.Node, Map<unknown, Map<string, unknown[]>>>();

  /** `all` (a file's index, sorted by position) restricted to `container`'s range — memoized per container and name. */
  private scoped<T>(all: Map<string, T[]>, container: ts.Node, pos: (x: T) => number): ScopedIndex<T> {
    if (ts.isSourceFile(container)) return all;
    let byIndex = this.slices.get(container);
    if (!byIndex) this.slices.set(container, (byIndex = new Map()));
    let cache = byIndex.get(all) as Map<string, T[]> | undefined;
    if (!cache) byIndex.set(all, (cache = new Map()));
    const memo = cache;
    return {
      get: (name: string): T[] | undefined => {
        const hit = memo.get(name);
        if (hit) return hit;
        const list = all.get(name);
        if (!list) return undefined;
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (pos(list[mid]!) < container.pos) lo = mid + 1;
          else hi = mid;
        }
        let end = lo;
        while (end < list.length && pos(list[end]!) < container.end) end++;
        const out = list.slice(lo, end);
        memo.set(name, out);
        return out;
      },
    };
  }

  /** Writes to the variable `decl`, from the (once-built) write index of its scope. */
  private writesOf(d: Extract<Declaration, { kind: 'var' }>): WriteSite[] {
    const name = (d.decl.name as ts.Identifier).text;
    return (this.writesIn(d.scopeNode).get(name) ?? []).filter((site) => {
      const r = this.findDeclaration(name, site.root);
      return r?.kind === 'var' && r.decl === d.decl;
    });
  }

  /** Every reference to a name inside a scope (indexed once per file, sliced to the scope's range). */
  private refsIn(container: ts.Node): ScopedIndex<ts.Identifier> {
    const sf = container.getSourceFile();
    let all = this.refIndex.get(sf);
    if (!all) {
      const map = new Map<string, ts.Identifier[]>();
      const walk = (n: ts.Node): void => {
        this.steps++;
        if (ts.isTypeNode(n)) return;
        if (ts.isIdentifier(n) && isReferenceIdentifier(n)) {
          const arr = map.get(n.text);
          if (arr) arr.push(n);
          else map.set(n.text, [n]);
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(sf, walk);
      all = map;
      this.refIndex.set(sf, all);
    }
    return this.scoped(all, container, (id) => id.pos);
  }

  /** Does the file write into the RESULT of a call (`get().x = …`)? A value returned by a function may then be mutated. */
  private hasCallRootedWrites(sf: ts.SourceFile): boolean {
    const cached = this.callRootedCache.get(sf);
    if (cached !== undefined) return cached;
    let hit = false;
    const callRoot = (t: ts.Expression): boolean => {
      const r = skipParens(accessRoot(t).root);
      return ts.isCallExpression(r) && !(ts.isIdentifier(r.expression) && r.expression.text === 'require') && this.originOf(r.expression, 0) === 'internal';
    };
    const walk = (n: ts.Node): void => {
      if (hit) return;
      this.steps++;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const t = skipParens(n.left);
        if ((ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) && callRoot(t)) hit = true;
      } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && SELF_MUTATORS.has(n.expression.name.text) && callRoot(n.expression.expression)) {
        hit = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    this.callRootedCache.set(sf, hit);
    return hit;
  }

  /**
   * Is a variable bound to a module object (`require(…)`, an interop of it,
   * `require(…).x`, an import)? `relativeOnly`: only the plugin's own modules
   * (what we read); otherwise any module, external libraries included.
   */
  private isModuleBinding(d: Declaration | undefined, relativeOnly = true): boolean {
    if (!d) return false;
    if (d.kind === 'import') return !relativeOnly || (ts.isStringLiteralLike(d.decl.moduleSpecifier) && d.decl.moduleSpecifier.text.startsWith('.'));
    if (d.kind !== 'var' && d.kind !== 'destructured') return false;
    const init = d.decl.initializer ? skipParens(d.decl.initializer) : undefined;
    if (!init) return false;
    const isRequire = (e: ts.Expression): boolean => {
      const r = skipParens(accessRoot(e).root);
      if (!ts.isCallExpression(r) || !ts.isIdentifier(r.expression) || r.expression.text !== 'require') return false;
      const spec = r.arguments[0];
      return !!spec && ts.isStringLiteralLike(spec) && (!relativeOnly || spec.text.startsWith('.'));
    };
    if (isRequire(init)) return true;
    if (ts.isCallExpression(init) && init.arguments[0] && isRequire(init.arguments[0]) && INTEROP_NAME.test(calleeText(init.expression) ?? '')) return true;
    return false;
  }

  /**
   * Why the value held by a binding can't be read as-is (it may be mutated
   * through another path), if so. Follows aliases a few levels deep.
   */
  private escapeOf(name: string, scopeNode: ts.Node, same: (d: Declaration | undefined) => boolean, isModule: boolean, depth: number, seen: Set<ts.Node>): string | undefined {
    for (const r of this.refsIn(scopeNode).get(name) ?? []) {
      if (!same(this.findDeclaration(name, r))) continue;
      const why = this.escapeAt(r, isModule, depth, seen);
      if (why) return why;
    }
    return undefined;
  }

  /** Is an alias binding (declared by `vd` as `name`) used in a way that could mutate what it holds? */
  private aliasUnsafe(vd: ts.VariableDeclaration, name: string, depth: number, seen: Set<ts.Node>): string | undefined {
    if (depth > 6) return 'aliased too deeply';
    if (seen.has(vd)) return undefined;
    seen.add(vd);
    const scopeNode = this.varScopeOf(vd);
    const same = (d: Declaration | undefined): boolean => (d?.kind === 'var' || d?.kind === 'destructured') && d.decl === vd;
    for (const w of this.writesIn(scopeNode).get(name) ?? []) {
      if (!same(this.findDeclaration(name, w.root))) continue;
      if (w.kind === 'assign') continue; // rebinding the alias doesn't touch the value
      if (w.kind === 'arg' && this.isPureCall(w.call!)) continue;
      return `mutated through alias '${name}'`;
    }
    return this.escapeOf(name, scopeNode, same, false, depth + 1, seen);
  }

  /** `derived`: `r` is not the binding itself but a value obtained from it (a call result, a getter read). */
  private escapeAt(r: ts.Expression, isModule: boolean, depth: number, seen: Set<ts.Node>, derived = false): string | undefined {
    let e: ts.Expression = r;
    let viaAccess = false;
    for (;;) {
      const p = e.parent;
      if (!p) return undefined;
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e) {
        e = p;
        viaAccess = true;
        continue;
      }
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p) || ts.isAwaitExpression(p)) {
        e = p;
        continue;
      }
      if (ts.isConditionalExpression(p) && p.condition !== e) {
        e = p;
        continue;
      }
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.QuestionQuestionToken || (op === ts.SyntaxKind.CommaToken && p.right === e)) {
          e = p;
          continue;
        }
      }
      break;
    }
    return this.escapeContext(e, viaAccess, isModule, depth, seen, derived);
  }

  /** The context an expression holding the binding (or something reached from it) flows into. */
  private escapeContext(e: ts.Expression, viaAccess: boolean, isModule: boolean, depth: number, seen: Set<ts.Node>, derived = false): string | undefined {
    const p = e.parent;
    if (!p) return undefined;
    // Written THROUGH a derived value (`get().a = …`, `s.getter.a = …`); the binding's own
    // writes are its write index's job.
    if (derived && viaAccess && isWriteTarget(e)) return 'written through';
    // Default values: `function f(o = x)`, `const { a = x } = …` — `o`/`a` alias the value.
    if (ts.isParameter(p) && p.initializer === e) {
      const fn = p.parent;
      if (!isFunctionLike(fn) || !fn.body || !ts.isIdentifier(p.name)) return 'default of a parameter it cannot follow';
      const name = p.name.text;
      const idx = fn.parameters.indexOf(p);
      const same = (x: Declaration | undefined): boolean => x?.kind === 'param' && x.fn === fn && x.index === idx;
      for (const w of this.writesIn(fn.body).get(name) ?? []) {
        if (!same(this.findDeclaration(name, w.root))) continue;
        if (w.kind === 'assign') continue;
        if (w.kind === 'arg' && this.isPureCall(w.call!)) continue;
        return `mutated through parameter default '${name}'`;
      }
      return this.escapeOf(name, fn.body, same, false, depth + 1, seen);
    }
    if (ts.isBindingElement(p) && p.initializer === e) {
      let vd: ts.Node | undefined = p.parent;
      while (vd && !ts.isVariableDeclaration(vd) && !ts.isParameter(vd)) vd = vd.parent;
      if (!vd || !ts.isVariableDeclaration(vd) || !ts.isIdentifier(p.name)) return 'default of a binding it cannot follow';
      return this.aliasUnsafe(vd, p.name.text, depth, seen);
    }
    if (ts.isCallExpression(p) && p.expression === e) {
      if (!viaAccess || isModule) return undefined; // calling the function itself / a module's function
      const m = ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
      return m && PURE_METHODS.has(m) ? undefined : `method '${m ?? '[computed]'}' called on it`;
    }
    if (ts.isNewExpression(p) && p.arguments?.includes(e)) return 'passed to new';
    if (ts.isCallExpression(p) && p.arguments.includes(e)) return this.isPureCall(p) ? undefined : 'passed to a function';
    // Inside an object/array literal: what matters is where the whole literal goes.
    if (
      (ts.isPropertyAssignment(p) && p.initializer === e) ||
      ts.isShorthandPropertyAssignment(p) ||
      ts.isSpreadAssignment(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p)
    ) {
      if (ts.isSpreadElement(p) && (ts.isCallExpression(p.parent) || ts.isNewExpression(p.parent))) {
        return ts.isCallExpression(p.parent) && this.isPureCall(p.parent) ? undefined : 'spread into a call';
      }
      let lit: ts.Node = ts.isArrayLiteralExpression(p) ? p : p.parent;
      for (;;) {
        const q = lit.parent;
        if (q && ((ts.isPropertyAssignment(q) && q.initializer === lit) || ts.isSpreadAssignment(q) || ts.isSpreadElement(q))) {
          lit = q.parent;
          continue;
        }
        if (q && ts.isArrayLiteralExpression(q)) {
          lit = q;
          continue;
        }
        if (q && (ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isSatisfiesExpression(q))) {
          lit = q;
          continue;
        }
        break;
      }
      if (!ts.isObjectLiteralExpression(lit) && !ts.isArrayLiteralExpression(lit) && !ts.isParenthesizedExpression(lit) && !ts.isAsExpression(lit) && !ts.isSatisfiesExpression(lit)) {
        return undefined;
      }
      // The literal itself is now the value carrier: a method call on it counts too (`[x].forEach(…)`).
      const q = lit.parent;
      if (q && ts.isPropertyAccessExpression(q) && q.expression === lit && ts.isCallExpression(q.parent) && q.parent.expression === q) {
        return PURE_METHODS.has(q.name.text) ? undefined : `literal holding it has '${q.name.text}' called on it`;
      }
      return this.escapeContext(lit as ts.Expression, false, false, depth, seen);
    }
    if (ts.isVariableDeclaration(p) && p.initializer === e) {
      for (const n of bindingNames(p.name)) {
        const why = this.aliasUnsafe(p, n, depth, seen);
        if (why) return why;
      }
      return undefined;
    }
    if (ts.isBinaryExpression(p) && p.right === e && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const left = skipParens(p.left);
      if (isModuleExports(left) || exportsMember(left)) return undefined;
      if (ts.isIdentifier(left)) {
        const d = this.findDeclaration(left.text, left);
        if (d?.kind === 'var') return this.aliasUnsafe(d.decl, left.text, depth, seen);
        return 'assigned to a binding it cannot follow';
      }
      return 'stored into another object';
    }
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === e)) {
      // Returned: every place the function's result lands must leave it alone too.
      let fn: ts.Node | undefined = ts.isArrowFunction(p) ? p : p.parent;
      while (fn && !isFunctionLike(fn)) fn = fn.parent;
      if (!fn || seen.has(fn)) return undefined;
      seen.add(fn);
      const { sites, escape } = this.resultSites(fn, depth);
      if (escape) return escape;
      for (const site of sites) {
        const why = this.escapeAt(site, false, depth + 1, seen, true);
        if (why) return `returned, then ${why}`;
      }
      return undefined;
    }
    if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.expression === e) return 'iterated';
    return undefined;
  }

  /**
   * Every expression a function's result lands in (its calls, the reads of a
   * getter), or why they can't all be found. Handing the function (or the object
   * holding it) to the module's exports is fine: importers are checked where they
   * use it (see {@link writesIntoModules}). An anonymous callback's caller is
   * library code (a Strapi factory): it is trusted unless this file writes into
   * some call result.
   */
  private resultSites(f: ts.Node, d: number, walk: SitesWalk = newSitesWalk()): { sites: ts.Expression[]; escape?: string } {
    const sites: ts.Expression[] = [];
    const done = (escape: string | undefined): { sites: ts.Expression[]; escape?: string } => (escape ? { sites, escape } : { sites });
    if (d > 6) return done('returned too deeply');
    // Each function / binding / object is walked once (aliases can form a DAG: exponential otherwise).
    if (walk.fns.has(f)) return done(undefined);
    walk.fns.add(f);
    this.steps++;
    if (this.overBudget()) return done('read budget exceeded');
    const parent = f.parent;
    // a getter / method / function-valued property of an object literal
    let member: { lit: ts.ObjectLiteralExpression; key: string | undefined; mode: 'get' | 'call' } | undefined;
    if ((ts.isGetAccessorDeclaration(f) || ts.isMethodDeclaration(f)) && parent && ts.isObjectLiteralExpression(parent)) {
      member = { lit: parent, key: propName(f.name), mode: ts.isGetAccessorDeclaration(f) ? 'get' : 'call' };
    } else if ((ts.isFunctionExpression(f) || ts.isArrowFunction(f)) && parent && ts.isPropertyAssignment(parent) && parent.initializer === f && ts.isObjectLiteralExpression(parent.parent)) {
      if (isExportGetterDescriptor(parent.parent)) return done(undefined); // Babel's `export *`: Object.defineProperty(exports, k, { get… })
      member = { lit: parent.parent, key: propName(parent.name), mode: 'call' };
    }
    if (member) {
      if (member.key === undefined) return done('returned from a computed member');
      return done(this.memberSites(member.lit, member.key, member.mode, d, sites, walk));
    }
    const b = this.functionBinding(f);
    if (!b) {
      if (this.flowsToExports(f as ts.Expression, d)) return done(undefined);
      if (parent && ts.isClassLike(parent)) return done('returned from a class member');
      return done(this.hasCallRootedWrites(f.getSourceFile()) ? 'returned from a function whose result is written' : undefined);
    }
    return done(this.functionValueSites(b, d, sites, walk));
  }

  /** The binding a function is known by: `function f`, `const f = …`, `f = …` (a var). */
  private functionBinding(fn: ts.Node): { name: string; decl: Declaration; at: ts.Identifier } | undefined {
    let id: ts.Identifier | undefined;
    if (ts.isFunctionDeclaration(fn) && fn.name) id = fn.name;
    else {
      let x: ts.Node = fn;
      while (x.parent && ts.isParenthesizedExpression(x.parent)) x = x.parent;
      const p = x.parent;
      if (p && ts.isVariableDeclaration(p) && p.initializer === x && ts.isIdentifier(p.name)) id = p.name;
      else if (p && ts.isBinaryExpression(p) && p.right === x && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(p.left)) id = p.left;
    }
    if (!id) return undefined;
    const decl = this.findDeclaration(id.text, id);
    if (!decl || decl.kind === 'opaque') return undefined;
    return { name: id.text, decl, at: id };
  }

  /** Where a function VALUE goes: called (a result site), aliased, exported, kept in an object… */
  private functionValueSites(b: { name: string; decl: Declaration; at: ts.Identifier }, d: number, sites: ts.Expression[], walk: SitesWalk): string | undefined {
    const key = declarationKey(b.decl);
    if (key) {
      let names = walk.bindings.get(key);
      if (!names) walk.bindings.set(key, (names = new Set()));
      if (names.has(b.name)) return undefined;
      names.add(b.name);
    }
    const sf = b.at.getSourceFile();
    const scope = b.decl.kind === 'var' ? b.decl.scopeNode : b.decl.kind === 'param' ? (b.decl.fn.body ?? sf) : sf;
    for (const r of this.refsIn(scope).get(b.name) ?? []) {
      if (r === b.at || !sameDeclaration(this.findDeclaration(b.name, r), b.decl)) continue;
      this.steps++;
      if (this.overBudget()) return 'read budget exceeded';
      let e: ts.Expression = r;
      while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isNonNullExpression(e.parent))) e = e.parent;
      const q = e.parent;
      if (!q) continue;
      if (ts.isCallExpression(q) && q.expression === e) {
        sites.push(q);
        continue;
      }
      if (ts.isBinaryExpression(q) && q.left === e && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) continue; // the binding itself (re)assigned
      if (ts.isExportAssignment(q) || ts.isExportSpecifier(q) || ts.isTypeOfExpression(q)) continue;
      if (ts.isBinaryExpression(q) && q.right === e && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = skipParens(q.left);
        if (isModuleExports(left) || exportsMember(left)) continue;
      }
      // an alias: `const g = f` / `g = f`
      const alias = ts.isVariableDeclaration(q) && q.initializer === e && ts.isIdentifier(q.name) ? q.name
        : ts.isBinaryExpression(q) && q.right === e && q.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(skipParens(q.left)) ? (skipParens(q.left) as ts.Identifier)
          : undefined;
      if (alias) {
        const ad = this.findDeclaration(alias.text, alias);
        if (!ad || ad.kind === 'opaque') return `'${b.name}' aliased where it can't be followed`;
        if (d > 6) return 'aliased too deeply';
        const why = this.functionValueSites({ name: alias.text, decl: ad, at: alias }, d + 1, sites, walk);
        if (why) return why;
        continue;
      }
      // kept in an object literal: `{ get }`, `{ a: get }`
      if ((ts.isShorthandPropertyAssignment(q) || (ts.isPropertyAssignment(q) && q.initializer === e)) && ts.isObjectLiteralExpression(q.parent)) {
        const key = ts.isShorthandPropertyAssignment(q) ? q.name.text : propName(q.name);
        if (key === undefined) return `'${b.name}' kept under a computed key`;
        const why = this.memberSites(q.parent, key, 'call', d, sites, walk);
        if (why) return why;
        continue;
      }
      // returned by another function G (rollup's `requireX()` hands back the server factory):
      // fine when G is exported (importers are checked), else wherever G's results are called
      if (ts.isReturnStatement(q) || (ts.isArrowFunction(q) && q.body === e)) {
        let g: ts.Node | undefined = ts.isArrowFunction(q) ? q : q.parent;
        while (g && !isFunctionLike(g)) g = g.parent;
        if (!g) return `'${b.name}' returned where it can't be followed`;
        if (this.flowsToExports(g as ts.Expression, d + 1)) continue;
        const outer = this.resultSites(g, d + 1, walk);
        if (outer.escape) return outer.escape;
        for (const site of outer.sites) {
          let c: ts.Node = site;
          while (c.parent && ts.isParenthesizedExpression(c.parent)) c = c.parent;
          if (c.parent && ts.isCallExpression(c.parent) && c.parent.expression === c) sites.push(c.parent);
          else return `'${b.name}' returned, then used where its results can't be followed`;
        }
        continue;
      }
      // handed to library code (a factory callback): same trust as an anonymous callback
      if ((ts.isCallExpression(q) || ts.isNewExpression(q)) && q.arguments?.includes(e)) {
        if (this.hasCallRootedWrites(sf)) return `'${b.name}' handed to a call in a file that writes into call results`;
        continue;
      }
      if (ts.isIfStatement(q) || (ts.isPrefixUnaryExpression(q) && q.operator === ts.SyntaxKind.ExclamationToken) || (ts.isBinaryExpression(q) && COMPARISONS.has(q.operatorToken.kind))) continue;
      return `'${b.name}' used where its results can't be followed`;
    }
    return undefined;
  }

  /** The reads of `lit.key` (a getter) / calls of `lit.key()` (a method), wherever `lit` is bound. */
  private memberSites(lit: ts.ObjectLiteralExpression, key: string, mode: 'get' | 'call', d: number, sites: ts.Expression[], walk: SitesWalk): string | undefined {
    const seenKeys = walk.members.get(lit) ?? new Set<string>();
    walk.members.set(lit, seenKeys);
    if (seenKeys.has(`${mode}:${key}`)) return undefined;
    seenKeys.add(`${mode}:${key}`);
    if (this.flowsToExports(lit, d)) return undefined;
    let x: ts.Node = lit;
    while (x.parent && (ts.isParenthesizedExpression(x.parent) || ts.isAsExpression(x.parent) || ts.isSatisfiesExpression(x.parent))) x = x.parent;
    const p = x.parent;
    if (!p || !ts.isVariableDeclaration(p) || p.initializer !== x || !ts.isIdentifier(p.name)) {
      // returned by a function: each of its results holds the member
      if (p && (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === x))) {
        let fn: ts.Node | undefined = ts.isArrowFunction(p) ? p : p.parent;
        while (fn && !isFunctionLike(fn)) fn = fn.parent;
        if (fn && this.flowsToExports(fn as ts.Expression, d + 1)) return undefined;
      }
      return `object holding '${key}' used where it can't be followed`;
    }
    const name = p.name.text;
    const decl = this.findDeclaration(name, p.name);
    if (!decl || decl.kind !== 'var') return `object holding '${key}' can't be followed`;
    for (const r of this.refsIn(decl.scopeNode).get(name) ?? []) {
      if (!sameDeclaration(this.findDeclaration(name, r), decl)) continue;
      let e: ts.Expression = r;
      while (e.parent && (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isNonNullExpression(e.parent))) e = e.parent;
      const q = e.parent;
      if (!q) continue;
      if ((ts.isPropertyAccessExpression(q) || ts.isElementAccessExpression(q)) && q.expression === e) {
        const k = ts.isPropertyAccessExpression(q) ? q.name.text : ts.isStringLiteralLike(q.argumentExpression) ? q.argumentExpression.text : undefined;
        if (k === undefined) return `'${name}' read with a computed key`;
        if (k !== key) continue;
        if (mode === 'get') {
          sites.push(q);
          continue;
        }
        let c: ts.Node = q;
        while (c.parent && ts.isParenthesizedExpression(c.parent)) c = c.parent;
        if (c.parent && ts.isCallExpression(c.parent) && c.parent.expression === c) {
          sites.push(c.parent);
          continue;
        }
        return `method '${key}' taken as a value`;
      }
      if (ts.isBinaryExpression(q) && q.left === e && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) continue;
      if (this.flowsToExports(e, d + 1)) continue;
      return `'${name}' (holding '${key}') used where it can't be followed`;
    }
    return undefined;
  }

  /** Does this value end up as (part of) the module's exports — directly, nested in them, or as an exported function's result? */
  private flowsToExports(e0: ts.Expression, d: number): boolean {
    if (d > 8) return false;
    let e: ts.Node = e0;
    for (;;) {
      const p = e.parent;
      if (!p) return false;
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
        e = p;
        continue;
      }
      if ((ts.isPropertyAssignment(p) && p.initializer === e) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p)) {
        e = p.parent;
        continue;
      }
      if (ts.isArrayLiteralExpression(p)) {
        e = p;
        continue;
      }
      if (ts.isExportAssignment(p)) return true;
      if (ts.isBinaryExpression(p) && p.right === e && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = skipParens(p.left);
        return isModuleExports(left) || !!exportsMember(left);
      }
      if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === e)) {
        let fn: ts.Node | undefined = ts.isArrowFunction(p) ? p : p.parent;
        while (fn && !isFunctionLike(fn)) fn = fn.parent;
        return !!fn && this.flowsToExports(fn as ts.Expression, d + 1);
      }
      if (ts.isVariableDeclaration(p) && p.initializer === e && ts.isIdentifier(p.name)) {
        const stmt = p.parent?.parent;
        if (stmt && ts.isVariableStatement(stmt) && hasExportModifier(stmt)) return true;
        return this.bindingExportedOnly(p.name, d);
      }
      if (ts.isFunctionDeclaration(e) && e.name) {
        if (hasExportModifier(e)) return true;
        return this.bindingExportedOnly(e.name, d);
      }
      return false;
    }
  }

  /** Is every use of this binding a hand-over to the module's exports? */
  private bindingExportedOnly(id: ts.Identifier, d: number): boolean {
    const decl = this.findDeclaration(id.text, id);
    if (!decl || decl.kind === 'opaque') return false;
    const sf = id.getSourceFile();
    const scope = decl.kind === 'var' ? decl.scopeNode : sf;
    let any = false;
    for (const r of this.refsIn(scope).get(id.text) ?? []) {
      if (r === id || !sameDeclaration(this.findDeclaration(id.text, r), decl)) continue;
      const q = r.parent;
      if (q && ts.isExportSpecifier(q)) {
        any = true;
        continue;
      }
      if (!this.flowsToExports(r, d + 1)) return false;
      any = true;
    }
    return any;
  }

  /**
   * Can this `this` reference change its receiver? Written through, handed to
   * code, aliased, a mutating method called on it — or (`strict`) any method
   * called on it (a sibling method may write).
   */
  private thisMutates(t: ts.Node, strict: boolean): boolean {
    let e: ts.Node = t;
    let depth = 0;
    while (e.parent && (((ts.isPropertyAccessExpression(e.parent) || ts.isElementAccessExpression(e.parent)) && e.parent.expression === e) || ts.isParenthesizedExpression(e.parent))) {
      if (!ts.isParenthesizedExpression(e.parent)) depth++;
      e = e.parent;
    }
    const p = e.parent;
    if (!p) return false;
    if (depth > 0 && isWriteTarget(e as ts.Expression)) return true;
    if (depth > 0 && ts.isCallExpression(p) && p.expression === e) {
      const m = ts.isPropertyAccessExpression(e) ? e.name.text : undefined;
      return strict ? !(m && PURE_METHODS.has(m)) : !!m && SELF_MUTATORS.has(m);
    }
    if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.arguments?.includes(e as ts.Expression)) return !(ts.isCallExpression(p) && this.isPureCall(p));
    if (depth === 0 && (ts.isVariableDeclaration(p) || (ts.isBinaryExpression(p) && p.right === e) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p))) return true;
    return false;
  }

  /** Can calling this function as a method change its receiver (through its own `this`)? */
  private receiverMayChange(fn: ts.Node): boolean {
    const hit = this.receiverCache.get(fn);
    if (hit !== undefined) return hit;
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      this.steps++;
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        if (this.thisMutates(n, true)) found = true;
        return;
      }
      if ((isFunctionLike(n) && !ts.isArrowFunction(n)) || ts.isClassLike(n)) return;
      ts.forEachChild(n, walk);
    };
    ts.forEachChild(fn, walk);
    this.receiverCache.set(fn, found);
    return found;
  }

  /**
   * Who runs a call: `external` code (Strapi's runtime, a library — reached
   * through a global, a parameter or a package import) doesn't write into what
   * it's handed, except the known `mutator` utilities (`Object.assign`,
   * `Reflect.set`, lodash's `merge`/`set`…, which write their first argument);
   * `internal` code (this plugin's own functions) is analysed.
   */
  private calleeKind(c0: ts.Expression): 'external' | 'mutator' | 'internal' {
    let c = skipParens(c0);
    if (ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.CommaToken) c = skipParens(c.right); // `(0, x.f)(…)`
    const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : ts.isElementAccessExpression(c) && ts.isStringLiteralLike(c.argumentExpression) ? c.argumentExpression.text : undefined;
    if (this.originOf(c, 0) === 'internal') return 'internal';
    if (name === undefined || !MUTATOR_NAMES.has(name)) return 'external';
    // a mutating utility: `Object.assign`, `Reflect.set`, lodash's `merge`… (not any API's `extend`/`set`)
    let root: ts.Expression = c;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isCallExpression(root)) root = skipParens(root.expression);
    if (ts.isIdentifier(root) && !this.findDeclaration(root.text, root)) return root.text === 'Object' || root.text === 'Reflect' ? 'mutator' : 'external';
    const pkg = ts.isIdentifier(root) ? this.packageOf(root, 0) : undefined;
    return pkg !== undefined && UTILITY_PACKAGES.test(pkg) ? 'mutator' : 'external';
  }

  /** The package a binding was imported/required from (`const { merge } = require('lodash')` → `lodash`). */
  private packageOf(id: ts.Identifier, depth: number): string | undefined {
    const d = this.findDeclaration(id.text, id);
    if (d?.kind === 'import') return ts.isStringLiteralLike(d.decl.moduleSpecifier) ? d.decl.moduleSpecifier.text : undefined;
    if ((d?.kind !== 'var' && d?.kind !== 'destructured') || !d.decl.initializer || depth > 6) return undefined;
    let init = skipParens(d.decl.initializer);
    if (ts.isCallExpression(init) && !(ts.isIdentifier(init.expression) && init.expression.text === 'require') && init.arguments[0]) init = skipParens(init.arguments[0]); // interop wrapper
    while (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) init = skipParens(init.expression);
    if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require') {
      const a0 = init.arguments[0];
      return a0 && ts.isStringLiteralLike(a0) ? a0.text : undefined;
    }
    return ts.isIdentifier(init) ? this.packageOf(init, depth + 1) : undefined;
  }

  /**
   * Where the value an expression starts from comes from: the runtime or a
   * library (`external`: a global, a parameter, a package import — or a local
   * variable initialized from one, `const s = strapi.plugin('x').service('y')`),
   * or this plugin's own code (`internal`).
   */
  private originOf(e0: ts.Expression, depth: number): 'external' | 'internal' {
    let root: ts.Expression = skipParens(e0);
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root) || ts.isCallExpression(root)) root = skipParens(root.expression);
    if (!ts.isIdentifier(root)) return 'internal';
    const d = this.findDeclaration(root.text, root);
    if (!d || d.kind === 'param') return 'external';
    if (d.kind === 'import') return ts.isStringLiteralLike(d.decl.moduleSpecifier) && !d.decl.moduleSpecifier.text.startsWith('.') ? 'external' : 'internal';
    if (this.isModuleBinding(d, false)) return this.isModuleBinding(d) ? 'internal' : 'external';
    // `_interopDefault(require$$0)`: what the interop helper wraps
    const wrapped = (d.kind === 'var' || d.kind === 'destructured') && d.decl.initializer ? skipParens(d.decl.initializer) : undefined;
    if (wrapped && ts.isCallExpression(wrapped) && wrapped.arguments.length === 1 && INTEROP_NAME.test(calleeText(wrapped.expression) ?? '') && depth < 6) return this.originOf(wrapped.arguments[0]!, depth + 1);
    if ((d.kind === 'var' || d.kind === 'destructured') && d.decl.initializer && depth < 6 && !(d.kind === 'var' && (d.redeclared || this.writesOf(d).some((w) => w.kind === 'assign')))) {
      const init = skipParens(d.decl.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init) || ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init) || ts.isClassExpression(init)) return 'internal';
      return this.originOf(init, depth + 1);
    }
    return 'internal';
  }

  /**
   * May what `fn` returns be (or reach) state that outlives the call — a
   * module-level binding, `this`, the module itself? Its parameters are the
   * caller's values (checked where they're passed); globals (`strapi`) and fresh
   * values aren't module state.
   */
  private mayReturnState(fn: ts.Node, freshThis = false): Promise<boolean> {
    const cache = freshThis ? this.stateReturnFreshCache : this.stateReturnCache;
    const running = freshThis ? this.stateRunningFresh : this.stateRunning;
    // A cycle (f → g → f): assume the worst instead of waiting on itself.
    if (running.has(fn)) return Promise.resolve(true);
    const hit = cache.get(fn);
    if (hit !== undefined) return hit;
    running.add(fn);
    const p = (async (): Promise<boolean> => {
      const exprs: ts.Expression[] = [];
      const f = fn as FunctionLike;
      if (ts.isArrowFunction(f) && !ts.isBlock(f.body)) exprs.push(f.body);
      else if (f.body) {
        forEachInScope(f.body, (n) => {
          if (ts.isReturnStatement(n) && n.expression) exprs.push(n.expression);
        });
      }
      for (const x of exprs) if (await this.mayBeState(x, 0, freshThis, new Set([fn]))) return true;
      return false;
    })().finally(() => running.delete(fn));
    cache.set(fn, p);
    return p;
  }

  /**
   * `freshThis`: `this` is a fresh object (a method of an object literal a
   * factory returns). `visiting`: functions being analysed (recursion → assume
   * the worst).
   */
  private async mayBeState(x0: ts.Expression, d: number, freshThis: boolean, visiting: Set<ts.Node>): Promise<boolean> {
    if (d > 8) return true;
    this.steps++;
    let x = skipParens(x0);
    while (ts.isAwaitExpression(x) || ts.isTypeAssertionExpression(x)) x = skipParens(x.expression);
    const again = (y: ts.Expression): Promise<boolean> => this.mayBeState(y, d + 1, freshThis, visiting);
    const some = async (ys: ts.Expression[]): Promise<boolean> => {
      for (const y of ys) if (await again(y)) return true;
      return false;
    };
    const fnState = (f: ts.Node, fresh: boolean): Promise<boolean> => (visiting.has(f) ? Promise.resolve(true) : this.mayReturnState(f, fresh));
    if (ts.isStringLiteralLike(x) || ts.isNumericLiteral(x) || ts.isBigIntLiteral(x) || ts.isTemplateExpression(x) || ts.isRegularExpressionLiteral(x)) return false;
    if (x.kind === ts.SyntaxKind.TrueKeyword || x.kind === ts.SyntaxKind.FalseKeyword || x.kind === ts.SyntaxKind.NullKeyword) return false;
    if (ts.isVoidExpression(x) || ts.isTypeOfExpression(x) || ts.isPrefixUnaryExpression(x) || ts.isPostfixUnaryExpression(x) || ts.isDeleteExpression(x)) return false;
    if (x.kind === ts.SyntaxKind.ThisKeyword) return !freshThis;
    if (ts.isConditionalExpression(x)) return some([x.whenTrue, x.whenFalse]);
    if (ts.isBinaryExpression(x)) {
      const op = x.operatorToken.kind;
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandToken) return some([x.left, x.right]);
      if (op === ts.SyntaxKind.CommaToken || (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment)) return again(x.right);
      return false; // arithmetic, comparison: a primitive
    }
    if (ts.isArrowFunction(x)) return fnState(x, freshThis);
    if (ts.isFunctionExpression(x)) return fnState(x, true);
    if (ts.isClassExpression(x)) return true;
    if (ts.isObjectLiteralExpression(x)) {
      for (const pr of x.properties) {
        if (ts.isPropertyAssignment(pr)) {
          if (await again(pr.initializer)) return true;
        } else if (ts.isShorthandPropertyAssignment(pr)) {
          if (await again(pr.name)) return true;
        } else if (ts.isSpreadAssignment(pr)) {
          if (await again(pr.expression)) return true;
        } else if (ts.isMethodDeclaration(pr) || ts.isGetAccessorDeclaration(pr)) {
          if (await fnState(pr, true)) return true;
        } else if (!ts.isSetAccessorDeclaration(pr)) return true;
      }
      return false;
    }
    if (ts.isArrayLiteralExpression(x)) return some(x.elements.map((el) => (ts.isSpreadElement(el) ? el.expression : el)));
    if (ts.isNewExpression(x)) return some([...(x.arguments ?? [])]);
    if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) return again(accessRoot(x).root);
    if (ts.isCallExpression(x)) {
      if (await some(x.arguments.map((a) => (ts.isSpreadElement(a) ? a.expression : a)))) return true;
      const c = skipParens(x.expression);
      if (ts.isIdentifier(c) && c.text === 'require') return true;
      // a call of one of this plugin's functions: what IT returns
      const kind = this.calleeKind(c);
      if (kind !== 'internal') return false; // the runtime / a library hands back its own values
      const callee = await this.ev(c, x.getSourceFile().fileName, undefined);
      if (callee.k === 'native') return false;
      if (callee.k === 'fn') return fnState(callee.node, false);
      return again(accessRoot(c).root);
    }
    if (ts.isTaggedTemplateExpression(x)) return again(accessRoot(x.tag).root);
    if (ts.isIdentifier(x)) {
      const dd = this.findDeclaration(x.text, x);
      if (!dd) return x.text === 'module' || x.text === 'exports'; // other globals (`strapi`, `process`) aren't module state
      if (dd.kind === 'param') return false; // the caller's value: checked where it is passed
      if (dd.kind === 'fn') return false; // a function value
      if (dd.kind === 'var' && !ts.isSourceFile(dd.scopeNode)) {
        // a function's local (fresh per call): what it was given — its initializer and reassignments
        if (dd.redeclared) return true;
        const assigns = this.writesOf(dd).filter((w) => w.kind === 'assign');
        return (dd.decl.initializer ? await again(dd.decl.initializer) : false) || (await some(assigns.map((w) => w.rhs!)));
      }
      if (dd.kind === 'destructured' && !ts.isSourceFile(this.varScopeOf(dd.decl)) && dd.decl.initializer) return again(dd.decl.initializer);
      // a module-level binding: state, unless it holds a function or a primitive
      if (dd.kind === 'var' || dd.kind === 'destructured' || dd.kind === 'import') {
        const v = await this.ev(x, x.getSourceFile().fileName, undefined);
        return !(v.k === 'fn' || v.k === 'native' || v.k === 'str' || v.k === 'num' || v.k === 'bool' || v.k === 'nil');
      }
      return true;
    }
    return true;
  }

  /**
   * Is the module-derived value at `start` (a module binding's reference, a
   * `require()`, a value reached from one, what a module function returns)
   * written to from here? Returns where, if so. Reports what the code shows —
   * a write through it, an alias, a returned value, a readable helper's
   * parameter, a mutating utility or method; a flow into code it can't read
   * (an unreadable function, another object) is not followed.
   */
  private async moduleUse(start: ts.Expression, ctx: ModuleUseCtx, depth: number, container = false): Promise<string | undefined> {
    if (depth > 24) return ctx.where(start, 'followed too deep to tell');
    const visited = container ? ctx.visitedContainer : ctx.visited;
    if (visited.has(start)) return undefined;
    visited.add(start);
    if (this.overBudget()) return undefined;
    this.steps++;
    let e: ts.Expression = start;
    let viaAccess = false;
    let accessDepth = 0;
    for (;;) {
      const p = e.parent;
      if (!p) return undefined;
      if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === e) {
        e = p;
        viaAccess = true;
        accessDepth++;
        continue;
      }
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p) || ts.isAwaitExpression(p)) {
        e = p;
        continue;
      }
      if (ts.isConditionalExpression(p) && p.condition !== e) {
        e = p;
        continue;
      }
      if (ts.isBinaryExpression(p)) {
        const op = p.operatorToken.kind;
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.QuestionQuestionToken || (op === ts.SyntaxKind.CommaToken && p.right === e)) {
          e = p;
          continue;
        }
      }
      break;
    }
    const p = e.parent!;
    const file = e.getSourceFile().fileName;
    // written through
    if (isWriteTarget(e)) {
      if (!viaAccess) return undefined; // rebinding a variable that held it
      if (container && accessDepth === 1) return undefined; // a fresh object holding it gets another key
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ctx.privateVirtual(e)) return undefined;
      return ctx.where(p, 'written');
    }
    // Container mode is for the fresh object itself: a member read out of it (`h.m`) is the module's value again.
    container = container && accessDepth === 0;
    // A primitive or a function can't be written into (and a module's functions are meant to be handed around).
    const bare = skipParens(e);
    if (!container && !ts.isCallExpression(bare) && !ts.isNewExpression(bare) && !(ts.isCallExpression(p) && p.expression === e)) {
      const v = await this.ev(e, file, undefined);
      if (v.k === 'fn' || v.k === 'native' || v.k === 'str' || v.k === 'num' || v.k === 'bool' || v.k === 'nil') return undefined;
    }
    // called: a method runs with its receiver as `this`; what a function returns may be its module's state
    if (ts.isCallExpression(p) && p.expression === e) {
      const callee = skipParens(e);
      let fnv: Value | undefined;
      if (viaAccess && (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee))) {
        const m = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
        const receiver = skipParens(callee.expression);
        const deep = ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver) || ts.isCallExpression(receiver);
        if (m === undefined || !PURE_METHODS.has(m)) {
          fnv = await this.ev(callee, file, undefined);
          // `mod.list.push(x)`, `mod.map.set(k, v)`: a built-in mutator on the module's own array/object
          if (fnv.k !== 'fn' && m !== undefined && SELF_MUTATORS.has(m) && deep) {
            const recv = await this.ev(receiver, file, undefined);
            if (recv.k === 'arr' || recv.k === 'obj') return ctx.where(p, `'${m}' called on it`);
          }
          // `Object.entries(mod).forEach((x) => …)`: an array's own iteration — the callback receives its members
          if (fnv.k !== 'fn' && m !== undefined && ARRAY_ITERATORS.has(m)) {
            const cb = p.arguments[0] && skipParens(p.arguments[0]);
            const cbv = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb) ? undefined : await this.ev(cb, file, undefined));
            const fnNode = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) ? cb : cbv?.k === 'fn' ? cbv.node : undefined;
            if (cb && !fnNode) return undefined; // a callback it can't read: no write seen
            const param = fnNode?.parameters[m === 'reduce' || m === 'reduceRight' ? 1 : 0];
            if (param) {
              const why = await this.followBinding(param.name, param, ctx, depth);
              if (why) return why;
            }
            return m === 'forEach' ? undefined : this.moduleUse(p, ctx, depth + 1);
          }
          // a method it can read that changes its receiver (one it can't read is not followed)
          if (fnv.k === 'fn' && this.receiverMayChange(fnv.node)) return ctx.where(p, `method '${m ?? '[computed]'}' changes it`);
        }
      }
      fnv ??= await this.ev(callee, file, undefined);
      if (fnv.k === 'native' || (fnv.k === 'fn' && !(await this.mayReturnState(fnv.node)))) return undefined;
      return this.moduleUse(p, ctx, depth + 1);
    }
    // handed to code: harmless when what's handed is a function or a primitive
    const argOf = (x: ts.Node): ts.CallExpression | ts.NewExpression | undefined => {
      const q = x.parent;
      return q && (ts.isCallExpression(q) || ts.isNewExpression(q)) && q.arguments?.includes(x as ts.Expression) ? q : undefined;
    };
    const call = argOf(e) ?? (ts.isSpreadElement(p) ? argOf(p) : undefined);
    if (call) {
      if (ctx.privateVirtualRoot(e)) return undefined; // rollup's wrapper hands its own module object to its factory
      if (call.arguments?.[0] === e && this.isExportStar(call)) return undefined; // re-exported: importers are checked where they use it
      if (ts.isCallExpression(call) && this.isPureCall(call)) {
        const t = calleeText(call.expression);
        if (t && READ_ONLY_GLOBALS.has(t)) return undefined;
        if (t && /^console\./.test(t)) return undefined;
        return this.moduleUse(call, ctx, depth + 1); // an interop helper / Object.freeze hands it back
      }
      const idx = call.arguments!.indexOf((argOf(e) ? e : p) as ts.Expression);
      let kind = this.calleeKind(call.expression);
      if (kind === 'internal' && (await this.externalThroughHelper(call.expression, 0))) kind = 'external';
      if (kind === 'external') return undefined;
      if (kind === 'mutator') {
        if (idx === 0) return ctx.where(call, 'written by a utility');
        return this.moduleUse(call, ctx, depth + 1); // copied/stored into the target, which the call returns
      }
      // this plugin's own function: follow the parameter that receives it
      const v = await this.ev(e, file, undefined);
      if (v.k === 'fn' || v.k === 'native' || v.k === 'str' || v.k === 'num' || v.k === 'bool' || v.k === 'nil') return undefined;
      if (ts.isNewExpression(call)) return undefined; // a constructor: not followed
      const fnv = await this.ev(call.expression, file, undefined);
      if (fnv.k === 'native') return undefined;
      if (fnv.k !== 'fn' || !fnv.node.body) return undefined; // a function it can't read: not followed
      if (call.arguments.slice(0, idx).some((a) => ts.isSpreadElement(a)) || ts.isSpreadElement(call.arguments[idx]!)) return undefined; // spread: not followed
      const param = fnv.node.parameters[idx] ?? fnv.node.parameters.find((pp) => pp.dotDotDotToken);
      if (!param) return undefined; // not a declared parameter (`arguments`): not followed
      return this.followBinding(param.name, param, ctx, depth, container);
    }
    // inside a literal: where the literal goes
    if ((ts.isPropertyAssignment(p) && p.initializer === e) || ts.isShorthandPropertyAssignment(p) || ts.isSpreadAssignment(p) || ts.isArrayLiteralExpression(p) || ts.isSpreadElement(p)) {
      const lit = (ts.isArrayLiteralExpression(p) ? p : p.parent) as ts.Expression;
      if (isDestructuringTarget(lit)) return viaAccess ? ctx.where(lit, 'destructuring target') : undefined;
      return this.moduleUse(lit, ctx, depth + 1, true); // a fresh object holding it: its own keys are its own
    }
    // aliased
    if (ts.isVariableDeclaration(p) && p.initializer === e) return this.followBinding(p.name, p, ctx, depth, container);
    if (ts.isBinaryExpression(p) && p.right === e) {
      const op = p.operatorToken.kind;
      if (op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken) {
        const left = skipParens(p.left);
        if (isModuleExports(left) || exportsMember(left)) return undefined; // re-exported: importers are checked where they use it
        if (ts.isIdentifier(left)) return this.followBinding(left, left, ctx, depth, container);
        // stored into a fresh object of this function (`const conf = {…}; conf.k = it`): follow that object
        const holder = skipParens(accessRoot(left).root);
        if (ts.isIdentifier(holder)) {
          const hd = this.findDeclaration(holder.text, holder);
          const init = hd?.kind === 'var' && !ts.isSourceFile(hd.scopeNode) && !hd.redeclared && hd.decl.initializer ? skipParens(hd.decl.initializer) : undefined;
          if (init && (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) && hd?.kind === 'var') return this.followBinding(hd.decl.name, hd.decl, ctx, depth, true);
        }
        return undefined; // kept in another object: not followed
      }
      return undefined;
    }
    if (ts.isParameter(p) && p.initializer === e) return this.followBinding(p.name, p, ctx, depth);
    if (ts.isBindingElement(p) && p.initializer === e) return this.followBinding(p.name, p, ctx, depth);
    // returned: wherever the function's result lands
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === e)) {
      let fn: ts.Node | undefined = ts.isArrowFunction(p) ? p : p.parent;
      while (fn && !isFunctionLike(fn)) fn = fn.parent;
      if (!fn || ctx.seen.has(fn)) return undefined;
      ctx.seen.add(fn);
      const { sites, escape } = this.resultSites(fn, 0);
      if (escape) return undefined; // its results land where they can't be followed
      for (const site of sites) {
        const why = await this.moduleUse(site, ctx, depth + 1, container);
        if (why) return why;
      }
      return undefined;
    }
    if (ts.isForOfStatement(p) && p.expression === e && ts.isVariableDeclarationList(p.initializer)) {
      // `for (const x of mod.list)`: x holds its members
      if (ctx.seen.has(p)) return undefined;
      ctx.seen.add(p);
      for (const d of p.initializer.declarations) {
        for (const id of identifiersOf(d.name)) {
          for (const r of this.refsIn(p.statement).get(id.text) ?? []) {
            const why = await this.moduleUse(r, ctx, depth + 1);
            if (why) return why;
          }
        }
      }
      return undefined;
    }
    return undefined; // read
  }

  /**
   * tsc's `__exportStar(m, exports)` (local helper or `tslib.__exportStar`): copies
   * `m`'s keys onto this module's exports, reading `m` only.
   */
  private isExportStar(call: ts.CallExpression | ts.NewExpression): boolean {
    if (!ts.isCallExpression(call)) return false;
    const target = call.arguments[1] && skipParens(call.arguments[1]);
    if (!target || !((ts.isIdentifier(target) && target.text === 'exports' && !this.findDeclaration('exports', target)) || isModuleExports(target))) return false;
    const c = skipParens(call.expression);
    if (ts.isIdentifier(c) && /^_*exportStar$/i.test(c.text)) {
      const d = this.findDeclaration(c.text, c);
      const text = d?.kind === 'fn' ? d.decl.getText() : d?.kind === 'var' ? d.decl.initializer?.getText() : undefined;
      return !!text && text.includes('hasOwnProperty') && !/\bm\s*\[[^\]]*\]\s*=(?!=)/.test(text);
    }
    if (ts.isPropertyAccessExpression(c) && c.name.text === '__exportStar' && ts.isIdentifier(c.expression)) {
      const d = this.findDeclaration(c.expression.text, c.expression);
      const init = d?.kind === 'var' && d.decl.initializer ? skipParens(d.decl.initializer) : undefined;
      const spec = init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require' ? init.arguments[0] : undefined;
      return !!spec && ts.isStringLiteralLike(spec) && spec.text === 'tslib';
    }
    return false;
  }

  /**
   * Is what a call chain ends in handed back by the runtime / a library through
   * one of this plugin's helpers (`getService(name)` → `strapi.plugin(…).service(name)`,
   * `const sm = getSessionManager()`)? Then calling into it is calling the runtime.
   */
  private async externalThroughHelper(e0: ts.Expression, depth: number): Promise<boolean> {
    if (depth > 4) return false;
    let call: ts.CallExpression | undefined;
    let r: ts.Expression = skipParens(e0);
    if (ts.isBinaryExpression(r) && r.operatorToken.kind === ts.SyntaxKind.CommaToken) r = skipParens(r.right);
    for (; ts.isPropertyAccessExpression(r) || ts.isElementAccessExpression(r) || ts.isCallExpression(r); r = skipParens(r.expression)) if (ts.isCallExpression(r)) call = r;
    if (!call) {
      if (!ts.isIdentifier(r)) return false;
      const d = this.findDeclaration(r.text, r);
      if (d?.kind !== 'var' || ts.isSourceFile(d.scopeNode) || d.redeclared || !d.decl.initializer || this.writesOf(d).some((w) => w.kind === 'assign')) return false;
      const init = skipParens(d.decl.initializer);
      return this.originOf(init, 0) === 'external' || this.externalThroughHelper(init, depth + 1);
    }
    const fnv = await this.ev(call.expression, call.getSourceFile().fileName, undefined);
    if (fnv.k !== 'fn' || !fnv.node.body) return false;
    const f = fnv.node as FunctionLike;
    const returns: ts.Expression[] = [];
    if (ts.isArrowFunction(f) && !ts.isBlock(f.body)) returns.push(f.body);
    else forEachInScope(f.body!, (n) => {
      if (ts.isReturnStatement(n) && n.expression) returns.push(n.expression);
    });
    for (const ret of returns) {
      const x = skipParens(ret);
      if (x.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(x) && x.text === 'undefined') || ts.isVoidExpression(x)) continue;
      if (this.originOf(x, 0) === 'external') continue;
      if (await this.externalThroughHelper(x, depth + 1)) continue;
      return false;
    }
    return true;
  }

  /** Follow every reference of the binding(s) a pattern declares (an alias of a module-derived value). */
  private async followBinding(name: ts.BindingName, key: ts.Node, ctx: ModuleUseCtx, depth: number, container = false): Promise<string | undefined> {
    if (ctx.seen.has(key)) return undefined;
    ctx.seen.add(key);
    for (const id of identifiersOf(name)) {
      const d = this.findDeclaration(id.text, id);
      if (!d || d.kind === 'opaque' || d.kind === 'import') continue; // a binding it can't follow
      const scope = d.kind === 'var' ? d.scopeNode : d.kind === 'param' ? (d.fn.body ?? d.fn) : d.kind === 'destructured' ? this.varScopeOf(d.decl) : id.getSourceFile();
      for (const r of this.refsIn(scope).get(id.text) ?? []) {
        if (r === id || !sameDeclaration(this.findDeclaration(id.text, r), d)) continue;
        const why = await this.moduleUse(r, ctx, depth + 1, container);
        if (why) return why;
      }
    }
    return undefined;
  }

  /** Can code in this file write into another (relative) module's exports? */
  private async moduleMutationIn(sf: ts.SourceFile, ctx: ModuleUseCtx): Promise<string | undefined> {
    const isRelRequire = (n: ts.Node): n is ts.CallExpression =>
      ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require' && !!n.arguments[0] && ts.isStringLiteralLike(n.arguments[0]) && n.arguments[0].text.startsWith('.');
    const starts: ts.Expression[] = [];
    const bindings: Array<{ id: ts.Identifier; d: Declaration }> = [];
    const walk = (n: ts.Node): void => {
      this.steps++;
      if (ts.isVariableDeclaration(n) && n.initializer) {
        for (const id of identifiersOf(n.name)) {
          const d = this.findDeclaration(id.text, id);
          if (this.isModuleBinding(d)) bindings.push({ id, d: d! });
        }
      } else if (ts.isImportDeclaration(n) && n.importClause && !n.importClause.isTypeOnly && ts.isStringLiteralLike(n.moduleSpecifier) && n.moduleSpecifier.text.startsWith('.')) {
        const ic = n.importClause;
        const ids: ts.Identifier[] = [];
        if (ic.name) ids.push(ic.name);
        if (ic.namedBindings && ts.isNamespaceImport(ic.namedBindings)) ids.push(ic.namedBindings.name);
        if (ic.namedBindings && ts.isNamedImports(ic.namedBindings)) for (const el of ic.namedBindings.elements) if (!el.isTypeOnly) ids.push(el.name);
        for (const id of ids) {
          const d = this.findDeclaration(id.text, id);
          if (d) bindings.push({ id, d });
        }
      } else if (isRelRequire(n)) {
        let x: ts.Node = n;
        while (x.parent && (ts.isParenthesizedExpression(x.parent) || ts.isAsExpression(x.parent))) x = x.parent;
        if (!(x.parent && ts.isVariableDeclaration(x.parent) && x.parent.initializer === x)) starts.push(n);
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    for (const { id, d } of bindings) {
      const scope = d.kind === 'var' ? d.scopeNode : d.kind === 'destructured' ? this.varScopeOf(d.decl) : sf;
      for (const r of this.refsIn(scope).get(id.text) ?? []) {
        if (r === id || !sameDeclaration(this.findDeclaration(id.text, r), d)) continue;
        const why = await this.moduleUse(r, ctx, 0);
        if (why) return why;
      }
    }
    for (const s0 of starts) {
      const why = await this.moduleUse(s0, ctx, 0);
      if (why) return why;
    }
    return undefined;
  }

  /** Why a variable's value can't be trusted (escapes into code that may mutate it), cached per declaration. */
  private varEscape(d: Extract<Declaration, { kind: 'var' }>): string | undefined {
    const hit = this.escapeCache.get(d.decl);
    if (hit !== undefined) return hit ?? undefined;
    const name = (d.decl.name as ts.Identifier).text;
    const same = (x: Declaration | undefined): boolean => x?.kind === 'var' && x.decl === d.decl;
    // Calling a module's functions (`utils.factory(…)`, `mod.__require()`) is how modules are used.
    const why = this.escapeOf(name, d.scopeNode, same, this.isModuleBinding(d, false), 0, new Set([d.decl]));
    this.escapeCache.set(d.decl, why ?? null);
    return why;
  }

  /** A parameter that is written, or escapes, inside its function can't be read as its argument. */
  private paramUnsafe(d: Extract<Declaration, { kind: 'param' }>, name: string): string | undefined {
    const body = d.fn.body;
    if (!body) return undefined;
    const key = d.fn.parameters[d.index]!;
    const hit = this.escapeCache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const why = this.paramUnsafeUncached(d, name, body);
    this.escapeCache.set(key, why ?? null);
    return why;
  }

  private paramUnsafeUncached(d: Extract<Declaration, { kind: 'param' }>, name: string, body: ts.Node): string | undefined {
    const same = (x: Declaration | undefined): boolean => sameDeclaration(x, d);
    for (const w of this.writesIn(body).get(name) ?? []) {
      if (!same(this.findDeclaration(name, w.root))) continue;
      if (w.kind === 'arg' && this.isPureCall(w.call!)) continue;
      return 'written';
    }
    return this.escapeOf(name, body, same, false, 0, new Set());
  }

  /**
   * Rollup's commonjs "virtual module" protocol: `var m = require('./_virtual/x.js')`
   * holds `{ exports: {} }` and the owning module writes `m.__module.exports = value`.
   * A read of `m.__module.exports` in that module is the value it writes there
   * (rollup keeps a virtual module private to its owner). Returns the written
   * expression, `'ambiguous'` if written more than once, or undefined when the
   * read isn't that protocol.
   */
  private rollupVirtualExports(
    node: ts.Expression,
  ): { value: ts.Expression; props: Array<{ key: string; rhs: ts.Expression }> } | 'ambiguous' | undefined {
    const target = virtualModuleTarget(node, this);
    if (!target || target.key !== undefined) return undefined;
    const sf = node.getSourceFile();
    const values: ts.Expression[] = [];
    const props: Array<{ key: string; rhs: ts.Expression }> = [];
    let unmodelled = false;
    const walk = (n: ts.Node): void => {
      this.steps++;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        const t = virtualModuleTarget(n.left, this);
        if (t && t.decl === target.decl) {
          if (n.operatorToken.kind !== ts.SyntaxKind.EqualsToken || t.key === null) unmodelled = true;
          else if (t.key === undefined) values.push(n.right);
          else props.push({ key: t.key, rhs: n.right });
        }
      } else if (ts.isCallExpression(n)) {
        // `v.__module.exports.push(…)`, `Object.assign(v.__module.exports, …)`: not modelled.
        const c = n.expression;
        if (ts.isPropertyAccessExpression(c) && virtualModuleTarget(c.expression, this)?.decl === target.decl) unmodelled = true;
        for (const a of n.arguments) if (virtualModuleTarget(a, this)?.decl === target.decl && !this.isPureCall(n)) unmodelled = true;
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
    if (values.length === 0) return undefined;
    if (values.length > 1 || unmodelled) return 'ambiguous';
    return { value: values[0]!, props };
  }

  /** Internal: declaration lookup for module-level helpers. */
  lookup(name: string, at: ts.Node): Declaration | undefined {
    return this.findDeclaration(name, at);
  }

  /** Is passing a variable to this call harmless (the callee cannot write into it)? */
  private isPureCall(call: ts.CallExpression): boolean {
    const c = call.expression;
    const text = calleeText(c);
    const rootName = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : undefined;
    const rootNode = ts.isIdentifier(c) ? c : ts.isPropertyAccessExpression(c) ? c.expression : undefined;
    const isGlobal = rootName !== undefined && rootNode !== undefined && this.findDeclaration(rootName, rootNode) === undefined;
    if (isGlobal && (text === 'require' || (text && PURE_GLOBAL_CALLS.has(text)) || (text && /^console\./.test(text)))) return true;
    if (ts.isIdentifier(c)) {
      const d = this.findDeclaration(c.text, c);
      if (d?.kind === 'fn' && INTEROP_NAME.test(c.text) && d.decl.body?.getText().includes('__esModule')) return true;
      if (d?.kind === 'var' && INTEROP_NAME.test(c.text) && d.decl.initializer?.getText().includes('__esModule')) return true;
      return false;
    }
    // `helpers.getDefaultExportFromCjs(x)` — only from rollup's own helper module.
    if (ts.isPropertyAccessExpression(c) && INTEROP_NAME.test(c.name.text) && ts.isIdentifier(c.expression)) {
      const d = this.findDeclaration(c.expression.text, c.expression);
      const init = d?.kind === 'var' && d.decl.initializer ? skipParens(d.decl.initializer) : undefined;
      const spec = init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require' ? init.arguments[0] : undefined;
      return !!spec && ts.isStringLiteralLike(spec) && /_commonjsHelpers|_interop/.test(spec.text);
    }
    return false;
  }

  /**
   * A variable's value: its initializer, or its single assignment when it has
   * none (rollup's `var x; … x = …`), plus top-level `x.key = …` writes. Any
   * other write makes it unknown.
   */
  private async evVariable(d: Extract<Declaration, { kind: 'var' }>, file: string, scope: Scope | undefined): Promise<Value> {
    const decl = d.decl;
    if (this.inProgress.has(decl)) return UNKNOWN('cyclic variable');
    const moduleLevel = ts.isSourceFile(d.scopeNode);
    if (moduleLevel) {
      const hit = this.moduleVarCache.get(decl);
      if (hit) return hit;
      const p = this.evVariableUncached(d, file, undefined);
      this.moduleVarCache.set(decl, p);
      return p;
    }
    return this.evVariableUncached(d, file, scope);
  }

  private async evVariableUncached(d: Extract<Declaration, { kind: 'var' }>, file: string, scope: Scope | undefined): Promise<Value> {
    const decl = d.decl;
    const name = (decl.name as ts.Identifier).text;
    if (d.redeclared) return UNKNOWN(`'${name}' redeclared`);
    const escape = this.varEscape(d);
    if (escape) return UNKNOWN(`'${name}' ${escape}`);
    this.inProgress.add(decl);
    try {
      const writes = this.writesOf(d);
      const assigns: ts.Expression[] = [];
      const props: WriteSite[] = [];
      for (const w of writes) {
        if (w.kind === 'unmodelled') return UNKNOWN(`'${name}' written in a way not modelled`);
        if (w.kind === 'arg') {
          if (!this.isPureCall(w.call!)) return UNKNOWN(`'${name}' passed to a function`);
          continue;
        }
        if (w.kind === 'assign') assigns.push(w.rhs!);
        else props.push(w);
      }
      const init = decl.initializer;
      const initIsEmpty = !init || init.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(init) || (ts.isIdentifier(init) && init.text === 'undefined');
      let v: Value;
      if (assigns.length > 1) return UNKNOWN(`'${name}' reassigned`);
      if (assigns.length === 1) {
        if (!initIsEmpty) return UNKNOWN(`'${name}' reassigned over its initializer`);
        v = await this.ev(assigns[0]!, file, scope);
      } else {
        v = init && !initIsEmpty ? await this.ev(init, file, scope) : NIL;
      }
      if (!props.length) return v;
      if (v.k !== 'obj') return UNKNOWN(`'${name}' property written on a ${v.k}`);
      // Adding a key is modelled; overriding one (or writing it twice) depends on control flow.
      const written = new Set<string>();
      for (const w of props) {
        if (v.props.has(w.key!) || written.has(w.key!)) return UNKNOWN(`'${name}.${w.key}' overridden`);
        written.add(w.key!);
      }
      const out: ObjValue = { ...v, props: new Map(v.props), keyLocs: new Map(v.keyLocs) };
      const sf = decl.getSourceFile();
      for (const w of props) {
        const rhs = w.rhs!;
        out.props.set(w.key!, memo(() => this.ev(rhs, file, scope)));
        out.keyLocs.set(w.key!, { file, pos: w.node.getStart(sf) });
      }
      return out;
    } finally {
      this.inProgress.delete(decl);
    }
  }

  /**
   * Does any parsed file write INTO another module's exports (a property write,
   * a mutating call or a deep write rooted at a `require(...)` / import binding,
   * or at `require(...)` itself)? Such a patch can add entries we never see when
   * reading that module — callers then treat what they read as incomplete.
   */
  async writesIntoModules(): Promise<string | undefined> {
    await this.parseReachable();
    const files = this.parsedFiles().filter((sf) => !sf.fileName.endsWith('.json'));
    // A rollup virtual module is private to the ONE file that requires it.
    const virtualOwners = new Map<string, number>();
    for (const sf of files) {
      for (const spec of relativeSpecifiers(sf)) {
        if (!/(^|\/)_virtual\//.test(spec)) continue;
        const key = resolveDots(join(dirname(sf.fileName), spec));
        virtualOwners.set(key, (virtualOwners.get(key) ?? 0) + 1);
      }
    }
    const privateVirtual = (t: ts.Expression): boolean => {
      const target = virtualModuleTarget(t, this);
      if (!target) return false;
      const init = target.decl.initializer && skipParens(target.decl.initializer);
      const spec = init && ts.isCallExpression(init) ? init.arguments[0] : undefined;
      if (!spec || !ts.isStringLiteralLike(spec)) return false;
      const key = resolveDots(join(dirname(target.decl.getSourceFile().fileName), spec.text));
      return (virtualOwners.get(key) ?? 0) === 1;
    };
    const virtualSpecOwned = (decl: ts.VariableDeclaration): boolean => {
      const init = decl.initializer && skipParens(decl.initializer);
      const spec = init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'require' ? init.arguments[0] : undefined;
      if (!spec || !ts.isStringLiteralLike(spec) || !/(^|\/)_virtual\//.test(spec.text)) return false;
      return (virtualOwners.get(resolveDots(join(dirname(decl.getSourceFile().fileName), spec.text))) ?? 0) === 1;
    };
    for (const sf of files) {
      const ctx: ModuleUseCtx = {
        sf,
        seen: new Set(),
        visited: new Set(),
        visitedContainer: new Set(),
        where: (n, why) => {
          const f = n.getSourceFile();
          return `${f.fileName}:${f.getLineAndCharacterOfPosition(n.getStart(f)).line + 1}${why ? `: ${why}` : ''}`;
        },
        privateVirtual,
        privateVirtualRoot: (e) => {
          const root = skipParens(accessRoot(e).root);
          if (!ts.isIdentifier(root)) return false;
          const d = this.findDeclaration(root.text, root);
          return d?.kind === 'var' && virtualSpecOwned(d.decl);
        },
      };
      const hit = await this.moduleMutationIn(sf, ctx);
      if (hit) return hit;
    }
    return undefined;
  }
}

/** A name → items index (a file's, or a scope's slice of it). */
interface ScopedIndex<T> {
  get(name: string): T[] | undefined;
}

/** What one result-site walk has already visited. */
interface SitesWalk {
  fns: Set<ts.Node>;
  bindings: Map<ts.Node, Set<string>>;
  members: Map<ts.Node, Set<string>>;
}

function newSitesWalk(): SitesWalk {
  return { fns: new Set(), bindings: new Map(), members: new Map() };
}

/** The node identifying a binding's declaration (lookups build fresh objects). */
function declarationKey(d: Declaration): ts.Node | undefined {
  switch (d.kind) {
    case 'var':
    case 'destructured':
    case 'fn':
    case 'import':
      return d.decl;
    case 'param':
      return d.fn.parameters[d.index];
    default:
      return undefined;
  }
}

interface ModuleUseCtx {
  sf: ts.SourceFile;
  seen: Set<ts.Node>;
  /** Start nodes already followed (each once). */
  visited: Set<ts.Node>;
  visitedContainer: Set<ts.Node>;
  where: (n: ts.Node, why?: string) => string;
  /** A plain `m.__module.exports(.k) = …` into rollup's private wrapper (modelled by the evaluator). */
  privateVirtual: (t: ts.Expression) => boolean;
  privateVirtualRoot: (e: ts.Expression) => boolean;
}

const COMPARISONS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

/** Packages whose `merge`/`set`/`assign`… write into their first argument. */
const UTILITY_PACKAGES = /^(lodash(\/.*)?|lodash-es(\/.*)?|lodash\.\w+|underscore|ramda|deepmerge|deep-extend|merge|merge-deep|object-assign|extend|defu|dot-prop|dset)$/;

/** Built-in array iteration: the callback receives the members (`reduce`: second parameter). */
const ARRAY_ITERATORS = new Set(['forEach', 'map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap', 'reduce', 'reduceRight']);

/** Library utilities that write into their first argument (by member name, on external code). */
const MUTATOR_NAMES = new Set([
  'assign',
  'assignIn',
  'assignWith',
  'assignInWith',
  'extend',
  'extendWith',
  'merge',
  'mergeWith',
  'defaults',
  'defaultsDeep',
  'set',
  'setWith',
  'unset',
  'update',
  'updateWith',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
  'deleteProperty',
  'remove',
  'pull',
  'pullAll',
  'pullAllBy',
  'pullAllWith',
  'pullAt',
]);

/** Calls whose result carries nothing of their arguments. */
const READ_ONLY_GLOBALS = new Set(['require', 'Object.keys', 'Object.isFrozen', 'Object.getOwnPropertyNames', 'JSON.stringify', 'Array.isArray']);

/** Is `e` assigned to, deleted, incremented, or a for-in/of target? */
function isWriteTarget(e: ts.Expression): boolean {
  const p = e.parent;
  if (!p) return false;
  if (ts.isBinaryExpression(p) && p.left === e && p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && p.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
  if (ts.isDeleteExpression(p)) return true;
  if ((ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) && (p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken)) return true;
  if ((ts.isForOfStatement(p) || ts.isForInStatement(p)) && p.initializer === e) return true;
  return false;
}

/** Is this literal (or one it is nested in) the target of a destructuring assignment? */
function isDestructuringTarget(lit: ts.Node): boolean {
  let x = lit;
  for (;;) {
    const q = x.parent;
    if (!q) return false;
    if (ts.isParenthesizedExpression(q) || ts.isPropertyAssignment(q) || ts.isShorthandPropertyAssignment(q) || ts.isSpreadAssignment(q) || ts.isSpreadElement(q) || ts.isArrayLiteralExpression(q) || ts.isObjectLiteralExpression(q)) {
      x = q;
      continue;
    }
    if (ts.isBinaryExpression(q) && q.left === x && q.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
    if ((ts.isForOfStatement(q) || ts.isForInStatement(q)) && q.initializer === x) return true;
    return false;
  }
}

/** `{ enumerable, get: function () { return m[k] } }` handed to `Object.defineProperty(exports, …)` (Babel's `export *`). */
function isExportGetterDescriptor(lit: ts.ObjectLiteralExpression): boolean {
  const call = lit.parent;
  if (!call || !ts.isCallExpression(call) || calleeText(call.expression) !== 'Object.defineProperty' || call.arguments[2] !== lit) return false;
  const target = call.arguments[0] && skipParens(call.arguments[0]);
  return !!target && ((ts.isIdentifier(target) && target.text === 'exports') || isModuleExports(target));
}

/** Every identifier a binding name declares. */
function identifiersOf(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) out.push(...identifiersOf(el.name));
  return out;
}

/**
 * `m.__module.exports` where `m` is bound to `require('…/_virtual/….js')` (rollup's
 * commonjs module wrapper) → the declaration of `m`; otherwise undefined.
 */
function virtualModuleTarget(
  e: ts.Expression,
  ev: StaticEvaluator,
): { decl: ts.VariableDeclaration; key: string | undefined | null } | undefined {
  let x = skipParens(e);
  // `m.__module.exports.k` → key k (null when computed); `m.__module.exports` → key undefined
  let key: string | undefined | null;
  if ((ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) && !isExportsAccess(x)) {
    key = ts.isPropertyAccessExpression(x) ? x.name.text : ts.isStringLiteralLike(x.argumentExpression) ? x.argumentExpression.text : null;
    x = skipParens(x.expression);
  }
  if (!ts.isPropertyAccessExpression(x) || x.name.text !== 'exports') return undefined;
  const mod = skipParens(x.expression);
  if (!ts.isPropertyAccessExpression(mod) || mod.name.text !== '__module') return undefined;
  const root = skipParens(mod.expression);
  if (!ts.isIdentifier(root)) return undefined;
  const d = ev.lookup(root.text, root);
  if (d?.kind !== 'var' || !d.decl.initializer) return undefined;
  const init = skipParens(d.decl.initializer);
  if (!ts.isCallExpression(init) || !ts.isIdentifier(init.expression) || init.expression.text !== 'require') return undefined;
  const spec = init.arguments[0];
  if (!spec || !ts.isStringLiteralLike(spec) || !/(^|\/)_virtual\//.test(spec.text)) return undefined;
  return { decl: d.decl, key };
}

/** `….__module.exports` itself (not a property of it). */
function isExportsAccess(x: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(x) && x.name.text === 'exports' && ts.isPropertyAccessExpression(skipParens(x.expression)) && (skipParens(x.expression) as ts.PropertyAccessExpression).name.text === '__module';
}

/** Do two lookups designate the same binding? (lookups build fresh objects, compare their nodes) */
function sameDeclaration(a: Declaration | undefined, b: Declaration | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'var':
    case 'destructured':
      return a.decl === (b as typeof a).decl;
    case 'fn':
      return a.decl === (b as typeof a).decl;
    case 'param':
      return a.fn === (b as typeof a).fn && a.index === (b as typeof a).index;
    case 'import':
      return a.decl === (b as typeof a).decl && a.imported === (b as typeof a).imported;
    default:
      return false;
  }
}

/** The name a function expression/arrow is bound to (`const x = () => …`), for helper recognition. */
function bindingNameOf(fn: ts.Node): string | undefined {
  let p = fn.parent;
  // `var x = (function () { …; return function (mod) {…} })()` — tsc ≥5.7's __importStar: the
  // function returned by an IIFE is known by the IIFE's binding.
  if (p && ts.isReturnStatement(p)) {
    let f: ts.Node | undefined = p.parent;
    while (f && !isFunctionLike(f)) f = f.parent;
    let call: ts.Node | undefined = f?.parent;
    while (call && ts.isParenthesizedExpression(call)) call = call.parent;
    if (!f || !call || !ts.isCallExpression(call) || skipParens(call.expression) !== f) return undefined;
    p = call.parent;
  }
  while (p && (ts.isParenthesizedExpression(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.BarBarToken))) p = p.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

/** The truthiness of a value, when knowable. */
function truthy(v: Value): boolean | undefined {
  switch (v.k) {
    case 'obj':
    case 'arr':
    case 'fn':
    case 'native':
      return true;
    case 'nil':
      return false;
    case 'bool':
      return v.v;
    case 'num':
      return v.v !== 0;
    case 'str':
      return v.v.length > 0;
    default:
      return undefined;
  }
}

/** Memoize a thunk (computed at most once); re-entry while it runs is a cycle → unknown. */
export function memo(thunk: Lazy): Lazy {
  let p: Promise<Value> | undefined;
  let running = false;
  return () => {
    if (running) return Promise.resolve(UNKNOWN('cycle'));
    if (p) return p;
    running = true;
    p = thunk()
      .catch(() => UNKNOWN('evaluation error'))
      .finally(() => {
        running = false;
      });
    return p;
  };
}

// ---------------------------------------------------------------------------
// Helpers to read evaluated values
// ---------------------------------------------------------------------------

/** Keys of an object value, or undefined if not an object. */
export function objKeys(v: Value): string[] | undefined {
  return v.k === 'obj' ? [...v.props.keys()] : undefined;
}

export async function asStr(_ev: StaticEvaluator, v: Value | Promise<Value>): Promise<string | undefined> {
  const x = await v;
  return x.k === 'str' ? x.v : undefined;
}

/** Fully materialize a value as plain JSON (strings/numbers/bools/arrays/objects); unknown parts become `undefined`. */
export async function toPlain(ev: StaticEvaluator, v: Value, depth = 0): Promise<unknown> {
  if (depth > 12) return undefined;
  switch (v.k) {
    case 'str':
    case 'num':
    case 'bool':
      return v.v;
    case 'nil':
      return null;
    case 'arr': {
      const out: unknown[] = [];
      for (const it of v.items) out.push(await toPlain(ev, await ev.force(it), depth + 1));
      return out;
    }
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const [k, t] of v.props) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        out[k] = await toPlain(ev, await ev.force(t), depth + 1);
      }
      return out;
    }
    default:
      return undefined;
  }
}
