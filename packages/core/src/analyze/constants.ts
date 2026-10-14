/**
 * String constants, resolved lexically: an identifier that names a
 * `const X = '<literal>'` in scope (`const THREAD = 'plugin::x.thread';
 * strapi.db.query(THREAD)`) stands for that literal — a value Strapi
 * receives exactly. *Garantir, ne pas deviner*: only `const` bindings initialised
 * with a plain string literal count; a `let`/`var`, a parameter, an import, a
 * destructured or any other binding of the same name shadows it, and nothing
 * is followed across files.
 */

import ts from 'typescript';

/** Nodes that hold block-scoped declarations. */
function isBlockScope(node: ts.Node): boolean {
  return ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node) || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) || ts.isCatchClause(node);
}

/** Nodes that start a function scope (parameters, `var`, a function expression's own name). */
function isFunctionScope(node: ts.Node): node is ts.SignatureDeclaration {
  return ts.isFunctionLike(node);
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

/** Every identifier a binding name introduces (`a`, `{ a, b: [c] }`). */
function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) out.push(name.text);
  else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(el.name, out);
}

/** Bindings a scope node declares: name → its literal (a string `const`), or `null` (anything else). */
type Bindings = Map<string, ts.StringLiteralLike | null>;

function declare(map: Bindings, name: string, value: ts.StringLiteralLike | null): void {
  // Two declarations of one name in a scope (a redeclared var, a function and a var…): never a constant.
  map.set(name, map.has(name) ? null : value);
}

function addVariableList(map: Bindings, list: ts.VariableDeclarationList): void {
  const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
  for (const d of list.declarations) {
    if (ts.isIdentifier(d.name) && isConst && d.initializer) {
      const init = unwrap(d.initializer);
      declare(map, d.name.text, ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init) ? init : null);
      continue;
    }
    const names: string[] = [];
    bindingNames(d.name, names);
    for (const n of names) declare(map, n, null);
  }
}

/** `var` declarations anywhere in a function body (hoisted to the function), not entering nested functions. */
function collectVars(node: ts.Node, map: Bindings): void {
  node.forEachChild((child) => {
    if (ts.isFunctionLike(child) || ts.isClassLike(child)) return;
    if (ts.isVariableDeclarationList(child) && (child.flags & ts.NodeFlags.BlockScoped) === 0) {
      const names: string[] = [];
      for (const d of child.declarations) bindingNames(d.name, names);
      for (const n of names) declare(map, n, null);
    }
    collectVars(child, map);
  });
}

function scopeBindings(node: ts.Node): Bindings {
  const map: Bindings = new Map();
  if (isFunctionScope(node)) {
    for (const p of node.parameters) {
      const names: string[] = [];
      bindingNames(p.name, names);
      for (const n of names) declare(map, n, null);
    }
    if (ts.isFunctionExpression(node) && node.name) declare(map, node.name.text, null);
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body) collectVars(body, map);
    return map;
  }
  if (ts.isSourceFile(node)) collectVars(node, map);
  if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) {
    if (node.initializer && ts.isVariableDeclarationList(node.initializer) && node.initializer.flags & ts.NodeFlags.BlockScoped) {
      addVariableList(map, node.initializer);
    }
    return map;
  }
  if (ts.isCatchClause(node)) {
    if (node.variableDeclaration) {
      const names: string[] = [];
      bindingNames(node.variableDeclaration.name, names);
      for (const n of names) declare(map, n, null);
    }
    return map;
  }
  const statements: readonly ts.Node[] = ts.isCaseBlock(node) ? node.clauses.flatMap((c) => [...c.statements]) : 'statements' in node ? [...(node as ts.Block).statements] : [];
  for (const st of statements) {
    if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.BlockScoped) addVariableList(map, st.declarationList);
    else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) declare(map, st.name.text, null);
    else if (ts.isImportDeclaration(st) && st.importClause) {
      const c = st.importClause;
      if (c.name) declare(map, c.name.text, null);
      if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) declare(map, c.namedBindings.name.text, null);
      else if (c.namedBindings) for (const el of c.namedBindings.elements) declare(map, el.name.text, null);
    } else if (ts.isImportEqualsDeclaration(st)) declare(map, st.name.text, null);
  }
  return map;
}

/** Resolves identifiers of one source file to the string constant they name, if any. */
export interface ConstantResolver {
  /** The `const` string literal `id` names in its scope, or `undefined`. */
  resolve(id: ts.Identifier): ts.StringLiteralLike | undefined;
}

/** A resolver for `sf` (scope tables are built lazily, once per scope). */
export function constantResolver(sf: ts.SourceFile): ConstantResolver {
  const cache = new Map<ts.Node, Bindings>();
  const bindingsOf = (node: ts.Node): Bindings => {
    let b = cache.get(node);
    if (!b) cache.set(node, (b = scopeBindings(node)));
    return b;
  };
  return {
    resolve(id) {
      for (let cur: ts.Node | undefined = id.parent; cur; cur = cur.parent) {
        if (!isBlockScope(cur) && !isFunctionScope(cur)) continue;
        const b = bindingsOf(cur);
        if (b.has(id.text)) return b.get(id.text) ?? undefined;
        if (cur === sf) break;
      }
      return undefined;
    },
  };
}

/** Cheap gate: a file without a `const X = '…'` (or `"…"`, `` `…` ``) has no string constant. */
export function mayDeclareStringConstants(text: string): boolean {
  return /\bconst\s+[\w$]+\s*=\s*['"`]/.test(text);
}
