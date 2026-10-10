/**
 * A small, **sound-or-silent** static evaluator for the module graph of a Strapi
 * plugin (or a project config file). It answers questions like "what are the keys
 * of the object this plugin registers as `controllers`?" by following the code the
 * way Node would — `require`/`import`, `module.exports`, bundler wrappers
 * (rollup's `x.__require()`, `getDefaultExportFromCjs`, tsc's `__importDefault`),
 * identifiers, property access and simple function calls — **without executing
 * anything**.
 *
 * The contract that makes it safe to build diagnostics on: every step it cannot
 * prove yields `unknown` (or marks an object `open`: "it may have keys I could not
 * see"). Callers only treat a result as exhaustive when nothing on the path was
 * unknown/open. *Garantir, ne pas deviner.*
 *
 * Evaluation is lazy: object properties and array items are thunks, forced only
 * when a caller reads them, so reading the key list of an aggregator never
 * evaluates the (possibly large) values behind it.
 */

import ts from 'typescript';
import { MAX_PARSE_CHARS, scriptKindFor } from '../analyze/parse';
import { type FileSystem, FileType } from '../fs/FileSystem';
import { dirname, join, normalize } from '../fs/paths';

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
const INDEX_FILES = ['index.js', 'index.cjs', 'index.mjs', 'index.ts', 'index.json'];

export interface EvaluatorLimits {
  /** Max nested evaluation depth (guards pathological recursion). */
  maxDepth: number;
  /** Max evaluation steps for the evaluator's lifetime (guards blow-ups). */
  maxSteps: number;
  /** Max distinct files parsed. */
  maxFiles: number;
}

const DEFAULT_LIMITS: EvaluatorLimits = { maxDepth: 60, maxSteps: 400_000, maxFiles: 1_500 };

/** Models of bare-specifier modules (e.g. `@strapi/utils` helpers), by specifier. */
export type ExternalModules = (spec: string, ev: StaticEvaluator) => Value | undefined;

/** True for a value that can be called. */
export function isCallable(v: Value): v is FnValue | NativeValue {
  return v.k === 'fn' || v.k === 'native';
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n) ||
    ts.isConstructorDeclaration(n)
  );
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

/** `module.exports` */
function isModuleExports(n: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(n) &&
    n.name.text === 'exports' &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === 'module'
  );
}

/** `exports.X` / `module.exports.X` / `exports['X']` → X */
function exportsMember(n: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(n)) {
    const base = n.expression;
    if ((ts.isIdentifier(base) && base.text === 'exports') || isModuleExports(base)) return n.name.text;
  }
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
    const base = n.expression;
    if ((ts.isIdentifier(base) && base.text === 'exports') || isModuleExports(base)) return n.argumentExpression.text;
  }
  return undefined;
}

/** True if `n` mentions `exports` / `module.exports` anywhere (an export write we may not understand). */
function touchesExports(n: ts.Node): boolean {
  let hit = false;
  const walk = (x: ts.Node): void => {
    if (hit) return;
    if (ts.isIdentifier(x) && x.text === 'exports') {
      const parent = x.parent;
      // `foo.exports` (not `module.exports`) is someone else's property.
      if (!(ts.isPropertyAccessExpression(parent) && parent.name === x && !(ts.isIdentifier(parent.expression) && parent.expression.text === 'module'))) {
        hit = true;
        return;
      }
    }
    ts.forEachChild(x, walk);
  };
  walk(n);
  return hit;
}

function hasExportModifier(n: ts.Node): boolean {
  return (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ?? false;
}

function hasDefaultModifier(n: ts.Node): boolean {
  return (ts.canHaveModifiers(n) && ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) ?? false;
}

/** Visit `node`'s descendants without entering nested function-likes. */
function forEachInScope(node: ts.Node, visit: (n: ts.Node) => void): void {
  const walk = (n: ts.Node): void => {
    visit(n);
    if (n !== node && isFunctionLike(n)) return;
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(node, walk);
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
  | { kind: 'var'; decl: ts.VariableDeclaration; container: ts.Node }
  | { kind: 'destructured'; decl: ts.VariableDeclaration; path: BindingStep[] }
  | { kind: 'fn'; decl: ts.FunctionDeclaration }
  | { kind: 'param'; fn: ts.Node; index: number; destructured: boolean }
  | { kind: 'import'; decl: ts.ImportDeclaration; imported: 'default' | 'namespace' | string }
  | { kind: 'opaque'; why: string };

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

interface VariableWrites {
  assigns: ts.Expression[];
  propWrites: Array<{ key: string | undefined; rhs: ts.Expression; node: ts.Node }>;
  mutated: boolean;
}

/** Functions that write into their first argument. */
const MUTATORS = new Set(['assign', 'merge', 'mergeWith', 'set', 'setWith', 'defaults', 'defaultsDeep', 'extend', 'defineProperty', 'defineProperties', 'unset']);
/** Methods that mutate their receiver. */
const SELF_MUTATORS = new Set(['push', 'unshift', 'splice', 'set', 'delete', 'pop', 'shift']);

export class StaticEvaluator {
  private readonly sources = new Map<string, ts.SourceFile | null>();
  private readonly modules = new Map<string, Promise<Value>>();
  private readonly writesCache = new Map<ts.VariableDeclaration, VariableWrites>();
  private readonly moduleVarCache = new Map<ts.VariableDeclaration, Promise<Value>>();
  private readonly inProgress = new Set<ts.Node>();
  private steps = 0;
  private depth = 0;
  private readonly limits: EvaluatorLimits;

  constructor(
    private readonly fs: FileSystem,
    limits: Partial<EvaluatorLimits> = {},
    private readonly externals?: ExternalModules,
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /** Number of files parsed so far (diagnostics/tests). */
  get filesParsed(): number {
    return this.sources.size;
  }

  // -------------------------------------------------------------------------
  // Files & modules
  // -------------------------------------------------------------------------

  private async source(file: string): Promise<ts.SourceFile | null> {
    if (this.sources.has(file)) return this.sources.get(file)!;
    if (this.sources.size >= this.limits.maxFiles) return null;
    let sf: ts.SourceFile | null = null;
    try {
      const text = await this.fs.readFile(file);
      if (text.length <= MAX_PARSE_CHARS) {
        sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
      }
    } catch {
      sf = null;
    }
    this.sources.set(file, sf);
    return sf;
  }

  /** Resolve a relative module specifier from `fromFile` to an existing file. */
  async resolveRelative(fromFile: string, spec: string): Promise<string | undefined> {
    const base = join(dirname(fromFile), spec);
    for (const ext of RESOLVE_EXT) {
      const p = normalize(base + ext);
      const st = await this.fs.stat(p);
      if (st?.type === FileType.File) return p;
    }
    const st = await this.fs.stat(base);
    if (st?.type === FileType.Directory) {
      for (const idx of INDEX_FILES) {
        const p = join(base, idx);
        if ((await this.fs.stat(p))?.type === FileType.File) return p;
      }
    }
    return undefined;
  }

  private async requireModule(fromFile: string, spec: string): Promise<Value> {
    if (!spec.startsWith('.')) return this.externals?.(spec, this) ?? UNKNOWN(`external module '${spec}'`);
    const file = await this.resolveRelative(fromFile, spec);
    if (!file) return UNKNOWN(`unresolved '${spec}'`);
    return this.moduleExports(file);
  }

  /** The value of `module.exports` (CJS) or the module namespace (ESM) of `file`. */
  moduleExports(file: string): Promise<Value> {
    const key = normalize(file);
    let p = this.modules.get(key);
    if (!p) {
      p = this.computeModuleExports(key);
      this.modules.set(key, p);
    }
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

    let base: ts.Expression | undefined;
    let baseCount = 0;
    const props = new Map<string, Lazy>();
    const keyLocs = new Map<string, Loc>();
    let esModule = false;
    let open = false;
    const starFrom: Array<{ spec: string; node: ts.Node }> = [];

    const setProp = (name: string, node: ts.Node, thunk: Lazy): void => {
      props.set(name, memo(thunk));
      keyLocs.set(name, { file, pos: node.getStart(sf) });
    };

    for (const stmt of sf.statements) {
      // ---- CommonJS -------------------------------------------------------
      if (ts.isExpressionStatement(stmt)) {
        const e = stmt.expression;
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          if (isModuleExports(e.left)) {
            base = e.right;
            baseCount++;
            continue;
          }
          const member = exportsMember(e.left);
          if (member !== undefined) {
            const rhs = e.right;
            setProp(member, e.left, () => this.ev(rhs, file, undefined));
            continue;
          }
        }
        if (ts.isCallExpression(e)) {
          const callee = e.expression;
          // Object.defineProperty(exports, '__esModule' | 'x', { … })
          if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'Object' &&
            callee.name.text === 'defineProperty' &&
            e.arguments.length >= 3
          ) {
            const [target, nameArg, descArg] = e.arguments;
            const isExportsTarget = (ts.isIdentifier(target!) && target.text === 'exports') || isModuleExports(target!);
            if (isExportsTarget && nameArg && ts.isStringLiteralLike(nameArg)) {
              if (nameArg.text === '__esModule') {
                esModule = true;
              } else if (descArg && ts.isObjectLiteralExpression(descArg)) {
                const name = nameArg.text;
                const getter = descArg.properties.find(
                  (p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && propName(p.name) === 'get',
                );
                const valueProp = descArg.properties.find(
                  (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && propName(p.name) === 'value',
                );
                if (valueProp) {
                  setProp(name, nameArg, () => this.ev(valueProp.initializer, file, undefined));
                } else if (getter) {
                  setProp(name, nameArg, async () => {
                    const fnNode = ts.isPropertyAssignment(getter) ? getter.initializer : getter;
                    const fn = await this.ev(fnNode as ts.Expression, file, undefined);
                    return fn.k === 'fn' ? this.call(fn, []) : UNKNOWN('getter');
                  });
                } else {
                  open = true;
                }
              }
              continue;
            }
          }
          // Object.defineProperties(exports, { __esModule: { value: true }, x: { get() {…} } })
          if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.expression) &&
            callee.expression.text === 'Object' &&
            callee.name.text === 'defineProperties' &&
            e.arguments.length >= 2
          ) {
            const [target, descs] = e.arguments;
            const isExportsTarget = (ts.isIdentifier(target!) && target.text === 'exports') || isModuleExports(target!);
            if (isExportsTarget) {
              if (descs && ts.isObjectLiteralExpression(descs)) {
                for (const p of descs.properties) {
                  const pname = ts.isPropertyAssignment(p) ? propName(p.name) : undefined;
                  if (pname === undefined) {
                    // `[Symbol.toStringTag]` is harmless; any other computed key may hide an export.
                    const isSymbolKey =
                      ts.isPropertyAssignment(p) && ts.isComputedPropertyName(p.name) && /^Symbol\./.test(p.name.expression.getText(sf));
                    if (!isSymbolKey) open = true;
                    continue;
                  }
                  if (pname === '__esModule') {
                    esModule = true;
                    continue;
                  }
                  const desc = (p as ts.PropertyAssignment).initializer;
                  if (!ts.isObjectLiteralExpression(desc)) {
                    open = true;
                    continue;
                  }
                  const valueProp = desc.properties.find(
                    (q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && propName(q.name) === 'value',
                  );
                  const getter = desc.properties.find(
                    (q) => (ts.isPropertyAssignment(q) || ts.isMethodDeclaration(q)) && q.name !== undefined && propName(q.name) === 'get',
                  );
                  if (valueProp) setProp(pname, p, () => this.ev(valueProp.initializer, file, undefined));
                  else if (getter) {
                    setProp(pname, p, async () => {
                      const fnNode = ts.isPropertyAssignment(getter) ? getter.initializer : getter;
                      const fn = await this.ev(fnNode as ts.Expression, file, undefined);
                      return fn.k === 'fn' ? this.call(fn, []) : UNKNOWN('getter');
                    });
                  } else open = true;
                }
              } else {
                open = true;
              }
              continue;
            }
          }
          // tsc: __exportStar(require('./x'), exports)
          if (ts.isIdentifier(callee) && /exportStar/i.test(callee.text) && e.arguments[0]) {
            const a0 = e.arguments[0];
            if (ts.isCallExpression(a0) && ts.isIdentifier(a0.expression) && a0.expression.text === 'require') {
              const spec = a0.arguments[0];
              if (spec && ts.isStringLiteralLike(spec)) starFrom.push({ spec: spec.text, node: a0 });
              else open = true;
            } else {
              open = true;
            }
            continue;
          }
        }
        if (touchesExports(stmt)) open = true;
        continue;
      }

      // ---- ES modules -----------------------------------------------------
      if (ts.isExportAssignment(stmt)) {
        esModule = true;
        const expr = stmt.expression;
        if (stmt.isExportEquals) {
          base = expr;
          baseCount++;
        } else {
          setProp('default', stmt, () => this.ev(expr, file, undefined));
        }
        continue;
      }
      if (ts.isExportDeclaration(stmt)) {
        esModule = true;
        if (stmt.isTypeOnly) continue;
        const spec = stmt.moduleSpecifier && ts.isStringLiteralLike(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : undefined;
        if (!stmt.exportClause) {
          if (spec) starFrom.push({ spec, node: stmt });
          else open = true;
          continue;
        }
        if (ts.isNamedExports(stmt.exportClause)) {
          for (const el of stmt.exportClause.elements) {
            if (el.isTypeOnly) continue;
            const exported = el.name.text;
            const local = (el.propertyName ?? el.name).text;
            if (spec) {
              setProp(exported, el, async () => this.getProp(await this.requireModule(file, spec), local));
            } else {
              const id = el.propertyName ?? el.name;
              setProp(exported, el, () => this.resolveIdentifierByName(local, id as ts.Identifier, file, undefined));
            }
          }
        } else {
          // export * as ns from './x'
          const exported = stmt.exportClause.name.text;
          if (spec) setProp(exported, stmt, () => this.requireModule(file, spec));
        }
        continue;
      }
      // Conditional/blocked CJS export writes (`if (x) exports.y = …`) can't be followed.
      if (ts.isIfStatement(stmt) || ts.isBlock(stmt) || ts.isTryStatement(stmt) || ts.isForStatement(stmt) || ts.isSwitchStatement(stmt)) {
        if (touchesExports(stmt)) open = true;
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
            const init = d.initializer;
            const id = d.name;
            setProp(id.text, id, () => (init ? this.ev(init, file, undefined) : Promise.resolve(NIL)));
          }
        } else if (ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) {
          const name = hasDefaultModifier(stmt) ? 'default' : stmt.name?.text;
          if (!name) continue;
          if (ts.isFunctionDeclaration(stmt)) {
            const node = stmt;
            setProp(name, stmt, () => Promise.resolve(this.fnValue(node, file, undefined, node.name?.text)));
          } else {
            setProp(name, stmt, () => Promise.resolve(UNKNOWN('class')));
          }
        }
        continue;
      }
    }

    // Merge `export * from` sources (best-effort; their own openness propagates).
    for (const { spec } of starFrom) {
      const mod = await this.requireModule(file, spec);
      if (mod.k !== 'obj') {
        open = true;
        continue;
      }
      if (mod.open) open = true;
      for (const [k, thunk] of mod.props) {
        if (k === 'default' || props.has(k)) continue;
        props.set(k, thunk);
        const kl = mod.keyLocs.get(k);
        if (kl) keyLocs.set(k, kl);
      }
    }

    if (base) {
      if (baseCount > 1) return UNKNOWN('module.exports reassigned');
      const v = await this.ev(base, file, undefined);
      if (props.size === 0 && !esModule) return v;
      if (v.k === 'obj') {
        const merged: ObjValue = {
          k: 'obj',
          props: new Map(v.props),
          keyLocs: new Map(v.keyLocs),
          open: v.open || open,
          esModule: v.esModule || esModule,
          ...(v.loc ? { loc: v.loc } : {}),
        };
        for (const [k, t] of props) merged.props.set(k, t);
        for (const [k, l] of keyLocs) merged.keyLocs.set(k, l);
        return merged;
      }
      if (props.size === 0) return v;
      return { k: 'obj', props, keyLocs, open: true, esModule };
    }
    return { k: 'obj', props, keyLocs, open, esModule, loc: { file, pos: 0 } };
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

  /** Call a function value with already-evaluated arguments. */
  async call(fn: Value, args: Value[]): Promise<Value> {
    if (fn.k === 'native') return fn.impl(args);
    if (fn.k !== 'fn') return fn.k === 'unknown' ? fn : UNKNOWN(`call of ${fn.k}`);
    if (this.depth >= this.limits.maxDepth) return UNKNOWN('max depth');
    if (this.inProgress.has(fn.node)) return UNKNOWN('recursive call');
    const node = fn.node;
    const bindings = new Map<string, Value>();
    node.parameters.forEach((p, i) => {
      if (ts.isIdentifier(p.name)) bindings.set(p.name.text, args[i] ?? NIL);
    });
    const scope: Scope = { fn: node, bindings, parent: fn.scope };
    const body = node.body;
    if (!body) return UNKNOWN('no body');
    this.inProgress.add(node);
    this.depth++;
    try {
      if (!ts.isBlock(body)) return await this.ev(body, fn.file, scope);
      // The *last* top-level `return` is the function's result (rollup's
      // `if (cached) return x; …; x = …; return x;` and plain factories alike).
      let last: ts.ReturnStatement | undefined;
      for (const s of body.statements) if (ts.isReturnStatement(s)) last = s;
      if (!last) {
        const all: ts.ReturnStatement[] = [];
        forEachInScope(body, (n) => {
          if (ts.isReturnStatement(n)) all.push(n);
        });
        if (all.length !== 1) return all.length === 0 ? NIL : UNKNOWN('several nested returns');
        last = all[0];
      }
      return last!.expression ? await this.ev(last!.expression, fn.file, scope) : NIL;
    } finally {
      this.depth--;
      this.inProgress.delete(node);
    }
  }

  /** Evaluate an expression. */
  async ev(node: ts.Expression, file: string, scope: Scope | undefined): Promise<Value> {
    if (++this.steps > this.limits.maxSteps) return UNKNOWN('step budget');
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
      return this.fnValue(node, file, scope, ts.isFunctionExpression(node) ? node.name?.text : undefined);
    }
    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return NIL;
      return this.resolveIdentifierByName(node.text, node, file, scope);
    }
    if (ts.isPropertyAccessExpression(node)) {
      if (isModuleExports(node)) return UNKNOWN('self module.exports');
      const base = await this.ev(node.expression, file, scope);
      return this.getProp(base, node.name.text);
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      if (!ts.isStringLiteralLike(arg) && !ts.isNumericLiteral(arg)) return UNKNOWN('computed access');
      const base = await this.ev(node.expression, file, scope);
      if (base.k === 'arr' && ts.isNumericLiteral(arg)) return this.force(base.items[Number(arg.text)]);
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
      if (op === ts.SyntaxKind.CommaToken || op === ts.SyntaxKind.EqualsToken) return this.ev(node.right, file, scope);
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
        const left = await this.ev(node.left, file, scope);
        if (op === ts.SyntaxKind.QuestionQuestionToken) {
          return left.k === 'nil' ? this.ev(node.right, file, scope) : left;
        }
        const t = truthy(left);
        if (t === undefined) return UNKNOWN('|| on unknown');
        return t ? left : this.ev(node.right, file, scope);
      }
      return UNKNOWN(`binary ${ts.SyntaxKind[op]}`);
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
        // setter only — not a readable value
        continue;
      }
      out.keyLocs.set(name, keyLoc);
    }
    return out;
  }

  private async evArray(node: ts.ArrayLiteralExpression, file: string, scope: Scope | undefined): Promise<ArrValue> {
    const sf = node.getSourceFile();
    const out: ArrValue = { k: 'arr', items: [], open: false, loc: { file, pos: node.getStart(sf) } };
    for (const el of node.elements) {
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
    // require('…')
    if (ts.isIdentifier(callee) && callee.text === 'require' && !this.isLocallyDeclared(callee, 'require')) {
      const spec = node.arguments[0];
      if (spec && ts.isStringLiteralLike(spec)) return this.requireModule(file, spec.text);
      return UNKNOWN('dynamic require');
    }
    // Object.freeze / Object.seal / Object.assign
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
    if (fn.name && /getDefaultExport/i.test(fn.name)) {
      const a = node.arguments[0] ? await this.ev(node.arguments[0], file, scope) : NIL;
      return this.unwrapDefault(a);
    }
    if (fn.name && /interop|importDefault|importStar|__toESM|toCommonJS/i.test(fn.name)) {
      const a = node.arguments[0] ? await this.ev(node.arguments[0], file, scope) : NIL;
      return this.interopNamespace(a);
    }
    const args: Value[] = [];
    for (const a of node.arguments) {
      if (ts.isSpreadElement(a)) {
        args.push(UNKNOWN('spread arg'));
        continue;
      }
      // Arguments are rarely needed (factories ignore `{ strapi }`) — keep them lazy-cheap.
      args.push(ts.isIdentifier(a) || ts.isObjectLiteralExpression(a) || ts.isStringLiteralLike(a) ? await this.ev(a, file, scope) : UNKNOWN('arg'));
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

  /** Find the declaration `name` refers to at `at`, walking lexical scopes outward. */
  private findDeclaration(name: string, at: ts.Node): Declaration | undefined {
    let n: ts.Node | undefined = at.parent;
    let child: ts.Node = at;
    while (n) {
      if (isFunctionLike(n)) {
        const idx = n.parameters.findIndex((p) => bindingNames(p.name).includes(name));
        if (idx >= 0) {
          const p = n.parameters[idx]!;
          return { kind: 'param', fn: n, index: idx, destructured: !ts.isIdentifier(p.name) };
        }
        if ((ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) && n.name?.text === name && child !== n.name) {
          if (ts.isFunctionDeclaration(n)) return { kind: 'fn', decl: n };
        }
        // `var` declarations hoist to the function body.
        if (n.body) {
          const v = this.findVarIn(n.body, name, true);
          if (v) return v;
        }
      }
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
        const stmts = (n as ts.Block | ts.SourceFile).statements;
        for (const s of stmts) {
          if (ts.isVariableStatement(s)) {
            for (const d of s.declarationList.declarations) {
              if (bindingNames(d.name).includes(name)) {
                if (!ts.isIdentifier(d.name)) return destructured(d, name);
                return { kind: 'var', decl: d, container: this.containerOf(n) };
              }
            }
          } else if (ts.isFunctionDeclaration(s) && s.name?.text === name) {
            return { kind: 'fn', decl: s };
          } else if (ts.isClassDeclaration(s) && s.name?.text === name) {
            return { kind: 'opaque', why: 'class' };
          } else if (ts.isEnumDeclaration(s) && s.name.text === name) {
            return { kind: 'opaque', why: 'enum' };
          } else if (ts.isImportDeclaration(s) && s.importClause && !s.importClause.isTypeOnly) {
            const ic = s.importClause;
            if (ic.name?.text === name) return { kind: 'import', decl: s, imported: 'default' };
            const nb = ic.namedBindings;
            if (nb && ts.isNamespaceImport(nb) && nb.name.text === name) return { kind: 'import', decl: s, imported: 'namespace' };
            if (nb && ts.isNamedImports(nb)) {
              for (const el of nb.elements) {
                if (el.name.text === name) return { kind: 'import', decl: s, imported: (el.propertyName ?? el.name).text };
              }
            }
          }
        }
        if (ts.isSourceFile(n)) {
          const v = this.findVarIn(n, name, true);
          if (v) return v;
        }
      }
      if ((ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
        if (n.initializer.declarations.some((d) => bindingNames(d.name).includes(name))) return { kind: 'opaque', why: 'loop variable' };
      }
      if (ts.isCatchClause(n) && n.variableDeclaration && bindingNames(n.variableDeclaration.name).includes(name)) {
        return { kind: 'opaque', why: 'catch variable' };
      }
      child = n;
      n = n.parent;
    }
    return undefined;
  }

  /** A `var name` declared anywhere in `body` (not inside nested functions). */
  private findVarIn(body: ts.Node, name: string, varOnly: boolean): Declaration | undefined {
    let found: Declaration | undefined;
    forEachInScope(body, (n) => {
      if (found) return;
      if (ts.isVariableDeclaration(n) && bindingNames(n.name).includes(name)) {
        const list = n.parent;
        const isVar = ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
        if (varOnly && !isVar) return;
        found = ts.isIdentifier(n.name) ? { kind: 'var', decl: n, container: body } : destructured(n, name);
      }
    });
    return found;
  }

  /** The function body / source file that owns a block's declarations (for assignment search). */
  private containerOf(n: ts.Node): ts.Node {
    let c: ts.Node | undefined = n;
    while (c && !isFunctionLike(c) && !ts.isSourceFile(c)) c = c.parent;
    if (c && isFunctionLike(c) && c.body) return c.body;
    return c ?? n;
  }

  private async resolveIdentifierByName(name: string, at: ts.Identifier, file: string, scope: Scope | undefined): Promise<Value> {
    const d = this.findDeclaration(name, at);
    if (!d) return UNKNOWN(`global '${name}'`);
    switch (d.kind) {
      case 'opaque':
        return UNKNOWN(d.why);
      case 'param': {
        if (d.destructured) return UNKNOWN('destructured param');
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
          return mod; // CJS module imported by default → its module.exports
        }
        return this.getProp(mod, d.imported);
      }
      case 'var':
        return this.evVariable(d.decl, d.container, file, scope);
      case 'destructured': {
        if (!d.decl.initializer) return UNKNOWN('destructured without initializer');
        let v = await this.ev(d.decl.initializer, file, scope);
        for (const step of d.path) {
          if (typeof step.key === 'number') v = v.k === 'arr' ? await this.force(v.items[step.key]) : UNKNOWN('array pattern');
          else v = await this.getProp(v, step.key);
          if (v.k === 'nil' && step.dflt) v = await this.ev(step.dflt, file, scope);
        }
        return v;
      }
    }
  }

  /**
   * A variable's value: its initializer and/or its (single) later assignment
   * `name = …` in the same function scope, plus `name.key = …` property writes.
   */
  /** Writes to a variable inside its scope (computed once per declaration). */
  private scanWrites(decl: ts.VariableDeclaration, container: ts.Node): VariableWrites {
    const cached = this.writesCache.get(decl);
    if (cached) return cached;
    const name = (decl.name as ts.Identifier).text;
    const out: VariableWrites = { assigns: [], propWrites: [], mutated: false };
    const isSelf = (e: ts.Expression): boolean => {
      if (!ts.isIdentifier(e) || e.text !== name) return false;
      const d = this.findDeclaration(name, e);
      return d?.kind === 'var' && d.decl === decl;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (isSelf(n.left)) out.assigns.push(n.right);
        else if (ts.isPropertyAccessExpression(n.left) && isSelf(n.left.expression)) {
          out.propWrites.push({ key: n.left.name.text, rhs: n.right, node: n.left.name });
        } else if (ts.isElementAccessExpression(n.left) && isSelf(n.left.expression)) {
          const a = n.left.argumentExpression;
          out.propWrites.push({ key: ts.isStringLiteralLike(a) ? a.text : undefined, rhs: n.right, node: n.left });
        }
      } else if (ts.isDeleteExpression(n)) {
        const t = n.expression;
        if ((ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) && isSelf(t.expression)) out.mutated = true;
      } else if (ts.isCallExpression(n)) {
        const c = n.expression;
        const callee = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : undefined;
        // A known mutator writing into the variable: Object.assign(x, …), _.merge(x, …), x.push(…)…
        // (merely *passing* the variable to a function is not a write).
        if (callee && MUTATORS.has(callee) && n.arguments[0] && isSelf(n.arguments[0])) out.mutated = true;
        if (ts.isPropertyAccessExpression(c) && SELF_MUTATORS.has(c.name.text) && isSelf(c.expression)) out.mutated = true;
      }
    };
    const walk = (n: ts.Node): void => {
      visit(n);
      ts.forEachChild(n, walk);
    };
    walk(container);
    this.writesCache.set(decl, out);
    return out;
  }

  private async evVariable(decl: ts.VariableDeclaration, container: ts.Node, file: string, scope: Scope | undefined): Promise<Value> {
    if (this.inProgress.has(decl)) return UNKNOWN('cyclic variable');
    // Module-level variables don't depend on any call's parameters → cache them.
    const moduleLevel = ts.isSourceFile(container);
    if (moduleLevel) {
      const hit = this.moduleVarCache.get(decl);
      if (hit) return hit;
      const p = this.evVariableUncached(decl, container, file, undefined);
      this.moduleVarCache.set(decl, p);
      return p;
    }
    return this.evVariableUncached(decl, container, file, scope);
  }

  private async evVariableUncached(decl: ts.VariableDeclaration, container: ts.Node, file: string, scope: Scope | undefined): Promise<Value> {
    const name = (decl.name as ts.Identifier).text;
    const { assigns, propWrites, mutated } = this.scanWrites(decl, container);
    this.inProgress.add(decl);
    try {
      let v: Value;
      const init = decl.initializer;
      const initIsEmpty = !init;
      if (assigns.length > 1) return UNKNOWN(`'${name}' reassigned`);
      if (assigns.length === 1) {
        v = await this.ev(assigns[0]!, file, scope);
      } else if (!initIsEmpty) {
        v = await this.ev(init!, file, scope);
      } else {
        v = NIL;
      }
      if (propWrites.length || mutated) {
        if (v.k !== 'obj') return mutated ? UNKNOWN(`'${name}' mutated`) : v;
        const out: ObjValue = { ...v, props: new Map(v.props), keyLocs: new Map(v.keyLocs) };
        if (mutated) out.open = true;
        const sf = decl.getSourceFile();
        for (const w of propWrites) {
          if (w.key === undefined) {
            out.open = true;
            continue;
          }
          const rhs = w.rhs;
          out.props.set(w.key, memo(() => this.ev(rhs, file, scope)));
          out.keyLocs.set(w.key, { file, pos: w.node.getStart(sf) });
        }
        return out;
      }
      return v;
    } finally {
      this.inProgress.delete(decl);
    }
  }
}

function destructured(decl: ts.VariableDeclaration, name: string): Declaration {
  const path = bindingPath(decl.name, name);
  if (!path || path === 'rest') return { kind: 'opaque', why: 'rest/complex destructuring' };
  return { kind: 'destructured', decl, path };
}

/** Memoize a thunk (each lazy value is computed at most once). */
function memo(thunk: Lazy): Lazy {
  let p: Promise<Value> | undefined;
  return () => (p ??= thunk());
}

// ---------------------------------------------------------------------------
// Helpers to read evaluated values
// ---------------------------------------------------------------------------

/** Keys of an object value, or undefined if not an object. */
export function objKeys(v: Value): string[] | undefined {
  return v.k === 'obj' ? [...v.props.keys()] : undefined;
}

export async function asStr(ev: StaticEvaluator, v: Value | Promise<Value>): Promise<string | undefined> {
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
