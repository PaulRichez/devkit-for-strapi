import ts from 'typescript';
import type { ControllerAction } from '../model/types';
import { isCalleeNamed, parseSource } from '../analyze/parse';

const DEFAULT_FACTORIES = ['createCoreController', 'createCoreService'];

/** Unwrap an arrow/function/parenthesized expression down to an object literal. */
function unwrapToObject(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  if (!node) return undefined;
  if (ts.isParenthesizedExpression(node)) return unwrapToObject(node.expression);
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const body = node.body;
    if (ts.isBlock(body)) {
      for (const stmt of body.statements) {
        if (ts.isReturnStatement(stmt) && stmt.expression) return unwrapToObject(stmt.expression);
      }
      return undefined;
    }
    return unwrapToObject(body);
  }
  return undefined;
}

/** The method header as written (params + return annotation), without the body. */
function signatureOf(prop: ts.ObjectLiteralElementLike, sf: ts.SourceFile): string | undefined {
  let body: ts.Node | undefined;
  if (ts.isMethodDeclaration(prop)) {
    body = prop.body;
  } else if (
    ts.isPropertyAssignment(prop) &&
    (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))
  ) {
    body = prop.initializer.body;
  }
  if (!body) return undefined;
  const header = sf.text
    .slice(prop.getStart(sf), body.getStart(sf))
    .replace(/\s*=>\s*$/, '')
    .replace(/\s*\{?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return header || undefined;
}

function collectActions(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile, out: Map<string, ControllerAction>): void {
  for (const prop of obj.properties) {
    let nameNode: ts.Identifier | undefined;
    if (ts.isMethodDeclaration(prop) && prop.name && ts.isIdentifier(prop.name)) {
      nameNode = prop.name;
    } else if (
      (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) &&
      ts.isIdentifier(prop.name)
    ) {
      nameNode = prop.name;
    }
    // Anchor on the action NAME so go-to-definition lands precisely on it.
    if (nameNode && !out.has(nameNode.text)) {
      const signature = signatureOf(prop, sf);
      const action: ControllerAction = { name: nameNode.text, offset: nameNode.getStart(sf) };
      if (signature) action.signature = signature;
      out.set(nameNode.text, action);
    }
  }
}

function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'exports' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module'
  );
}

const FACTORY_ANCHOR_NAMES = ['createCoreService', 'createCoreController', 'createCoreRouter'];

/** Collect the methods from a parsed service/controller source. */
function collectMethods(sf: ts.SourceFile, factories: readonly string[]): ControllerAction[] {
  const out = new Map<string, ControllerAction>();

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && factories.some((f) => isCalleeNamed(node, f))) {
      const obj = unwrapToObject(node.arguments[1]);
      if (obj) collectActions(obj, sf, out);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt)) {
      const obj = unwrapToObject(stmt.expression);
      if (obj) collectActions(obj, sf, out);
    } else if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(stmt.expression.left)
    ) {
      const obj = unwrapToObject(stmt.expression.right);
      if (obj) collectActions(obj, sf, out);
    }
  }

  return [...out.values()];
}

/** Offset of the `export default` / `export =` / `module.exports =` statement. */
function exportAnchor(sf: ts.SourceFile): number | undefined {
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt)) return stmt.getStart(sf);
    if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isModuleExports(stmt.expression.left)
    ) {
      return stmt.getStart(sf);
    }
  }
  return undefined;
}

/** Offset of the first `createCoreService/Controller/Router(...)` call. */
function factoryAnchor(sf: ts.SourceFile): number | undefined {
  let offset: number | undefined;
  const visit = (node: ts.Node): void => {
    if (offset !== undefined) return;
    if (ts.isCallExpression(node) && FACTORY_ANCHOR_NAMES.some((f) => isCalleeNamed(node, f))) {
      offset = node.getStart(sf);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return offset;
}

/** A service/controller file's UI anchor plus its methods, from one parse. */
export interface ArtifactInfo {
  /** Char offset to anchor a CodeLens on — the export/factory definition line. */
  anchorOffset: number;
  methods: ControllerAction[];
  /** True when the factory/export object spreads (`...shared`) → `methods` is partial. */
  hasSpread: boolean;
}

/** Does any factory/export object literal spread (`...x`)? → its action list is incomplete. */
function factoryHasSpread(sf: ts.SourceFile): boolean {
  let spread = false;
  const check = (obj: ts.ObjectLiteralExpression): void => {
    if (obj.properties.some((p) => ts.isSpreadAssignment(p))) spread = true;
  };
  const visit = (node: ts.Node): void => {
    if (spread) return;
    if (ts.isCallExpression(node) && DEFAULT_FACTORIES.some((f) => isCalleeNamed(node, f))) {
      const obj = unwrapToObject(node.arguments[1]);
      if (obj) check(obj);
    }
    if (!spread) ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!spread) {
    for (const stmt of sf.statements) {
      if (ts.isExportAssignment(stmt)) {
        const o = unwrapToObject(stmt.expression);
        if (o) check(o);
      } else if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExports(stmt.expression.left)
      ) {
        const o = unwrapToObject(stmt.expression.right);
        if (o) check(o);
      }
      if (spread) break;
    }
  }
  return spread;
}

/**
 * Parse a service/controller file once and return its UI anchor and methods.
 * The anchor is the AST node of the export statement (or, failing that, the
 * factory call) — never a text regex, so a `module.exports` mention in a comment
 * or string can't fool it, and the CJS destructure
 * `const { createCoreController } = require(...)` is ignored for the real export.
 */
export function analyzeArtifact(filePath: string, text: string): ArtifactInfo {
  const sf = parseSource(filePath, text);
  return {
    anchorOffset: exportAnchor(sf) ?? factoryAnchor(sf) ?? 0,
    methods: collectMethods(sf, DEFAULT_FACTORIES),
    hasSpread: factoryHasSpread(sf),
  };
}

/** AST offset to anchor UI on for any artifact (export statement, else factory). */
export function definitionAnchorOffset(filePath: string, text: string): number {
  const sf = parseSource(filePath, text);
  return exportAnchor(sf) ?? factoryAnchor(sf) ?? 0;
}

/**
 * Extract the methods exposed by a service or controller file. Handles
 * `factories.createCoreService/Controller('uid', () => ({ ... }))`, a bare
 * `export default { ... }` / `export default () => ({ ... })`, and the v4 CJS
 * `module.exports = { ... }` / `module.exports = createCoreX(...)` forms.
 */
export function extractMethods(
  filePath: string,
  text: string,
  factories: readonly string[] = DEFAULT_FACTORIES,
): ControllerAction[] {
  return collectMethods(parseSource(filePath, text), factories);
}

/** Controller action methods (used by the indexer for route-handler navigation). */
export function extractControllerActions(filePath: string, text: string): ControllerAction[] {
  return extractMethods(filePath, text, ['createCoreController']);
}

/**
 * Char range of the object literal that defines a service/controller's methods —
 * the factory's `() => ({ … })` argument, or a bare `export default { … }` /
 * `module.exports = { … }`. Lets a method rename scope its `this.method()` rewrites
 * to the artifact's own object, never an unrelated same-named method elsewhere in
 * the file (e.g. a helper `class` alongside the factory). Undefined if none found.
 */
export function factoryObjectRange(filePath: string, text: string): { start: number; end: number } | undefined {
  const sf = parseSource(filePath, text);
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(node) && DEFAULT_FACTORIES.some((f) => isCalleeNamed(node, f))) {
      const obj = unwrapToObject(node.arguments[1]);
      if (obj) found = obj;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!found) {
    for (const stmt of sf.statements) {
      if (ts.isExportAssignment(stmt)) {
        found = unwrapToObject(stmt.expression);
      } else if (
        ts.isExpressionStatement(stmt) &&
        ts.isBinaryExpression(stmt.expression) &&
        stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        isModuleExports(stmt.expression.left)
      ) {
        found = unwrapToObject(stmt.expression.right);
      }
      if (found) break;
    }
  }
  return found ? { start: found.getStart(sf), end: found.getEnd() } : undefined;
}
