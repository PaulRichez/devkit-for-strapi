import ts from 'typescript';
import { basename, dirname, stripExt } from '../fs/paths';
import { type ClassifiedRef, propNameText } from './patterns';

/**
 * True for a project's root `config/middlewares.{ts,js,…}` — the middleware
 * *stack*. Detected by name + immediate parent dir, so per-env configs
 * (`config/env/<env>/middlewares.ts`, parent dir = the env) are excluded.
 */
export function isConfigMiddlewares(filePath: string): boolean {
  return stripExt(basename(filePath)) === 'middlewares' && basename(dirname(filePath)) === 'config';
}

/** `module.exports` property-access (the CommonJS export target). */
function isModuleExports(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'exports' &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'module'
  );
}

/** True if `arr` is the array exported by `export default [...]` / `module.exports = [...]`. */
function isTopLevelConfigArray(arr: ts.ArrayLiteralExpression): boolean {
  const parent = arr.parent;
  if (ts.isExportAssignment(parent)) return parent.expression === arr;
  return (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === arr &&
    isModuleExports(parent.left)
  );
}

/**
 * Classify a string literal inside `config/middlewares.{ts,js}`. The middleware
 * stack is the top-level exported array; its elements are either a ref string
 * (`'global::x'`) or an object `{ name: 'global::x', config }`. Built-in
 * `strapi::*` entries are skipped (framework code, no workspace file — and
 * `parseRef` rejects the `strapi` namespace), and `{ resolve: './path' }`
 * entries are paths, not refs.
 */
export function classifyConfigMiddlewareLiteral(lit: ts.StringLiteralLike): ClassifiedRef | undefined {
  if (lit.text.startsWith('strapi::')) return undefined; // framework built-in — never flag
  const parent = lit.parent;

  // (a) a direct string element of the top-level stack array.
  if (ts.isArrayLiteralExpression(parent) && isTopLevelConfigArray(parent)) {
    return { kind: 'middleware-ref', apiStyle: 'config' };
  }

  // (b) the `name:` value of an object element of that array.
  if (
    ts.isPropertyAssignment(parent) &&
    parent.initializer === lit &&
    propNameText(parent.name) === 'name' &&
    ts.isObjectLiteralExpression(parent.parent) &&
    ts.isArrayLiteralExpression(parent.parent.parent) &&
    isTopLevelConfigArray(parent.parent.parent)
  ) {
    return { kind: 'middleware-ref', apiStyle: 'config' };
  }

  return undefined;
}
