/**
 * The application middleware stack of `config/middlewares`, in order — what every
 * request goes through before the router (Strapi 4.13.5 / 5.48
 * `registerApplicationMiddlewares`: `strapi.server.use()` for each entry, the router
 * mounted after them). Read statically from the file's literal array; a stack built
 * at runtime is reported `not-literal`, never guessed.
 */

import ts from 'typescript';
import { literalText, parseSource } from '../analyze/parse';
import { propNameText } from '../analyze/patterns';
import { type FileSystem, FileType } from '../fs/FileSystem';
import { join } from '../fs/paths';
import { envConfigFiles, findConfigFile } from '../plugins/config';

export interface GlobalMiddlewareEntry {
  /** As written: a name (`strapi::cors`, `global::x`), the `resolve` path, or `<inline>` / `<unread>`. */
  name: string;
  /** `name` (a registered middleware), `resolve` (a package or path), `inline` (a function), `unread`. */
  form: 'name' | 'resolve' | 'inline' | 'unread';
  /** Char offset of the entry in {@link GlobalMiddlewares.file} (inside the quotes for a string). */
  offset: number;
  /** `{ name, config }`: the entry is configured. */
  hasConfig: boolean;
}

export interface GlobalMiddlewares {
  /**
   * `read`: the entries are the literal stack; `not-literal`: not read statically (built
   * at runtime, a JSON config…), entries unknown; `missing`: no file — Strapi uses its default stack.
   */
  status: 'read' | 'not-literal' | 'missing';
  file?: string;
  entries: GlobalMiddlewareEntry[];
  /** `config/env/<env>/middlewares.*`: they replace the stack for that NODE_ENV (not merged here). */
  envFiles: string[];
}

/** Read the project's `config/middlewares` stack. */
export async function readGlobalMiddlewares(fs: FileSystem, root: string): Promise<GlobalMiddlewares> {
  const envFiles = await envConfigFiles(fs, root, 'middlewares');
  const file = await findConfigFile(fs, root, 'middlewares');
  if (!file) {
    // Strapi also loads a JSON config: not read here, but never reported as missing.
    const json = join(root, 'config', 'middlewares.json');
    if ((await fs.stat(json))?.type === FileType.File) return { status: 'not-literal', file: json, entries: [], envFiles };
    return { status: 'missing', entries: [], envFiles };
  }
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch {
    return { status: 'not-literal', file, entries: [], envFiles };
  }
  const sf = parseSource(file, text);
  const arr = stackArray(sf);
  if (!arr) return { status: 'not-literal', file, entries: [], envFiles };
  const entries: GlobalMiddlewareEntry[] = [];
  for (const el of arr.elements) {
    const offset = el.getStart(sf);
    if (ts.isSpreadElement(el)) return { status: 'not-literal', file, entries: [], envFiles };
    const s = literalText(el);
    if (s !== undefined) {
      entries.push({ name: s, form: 'name', offset: offset + 1, hasConfig: false });
    } else if (ts.isObjectLiteralExpression(el)) {
      const name = prop(sf, el, 'name');
      const resolve = prop(sf, el, 'resolve');
      const hasConfig = el.properties.some((p) => p.name !== undefined && propNameText(p.name) === 'config');
      if (name) entries.push({ name: name.text ?? '<unread>', form: name.text ? 'name' : 'unread', offset: name.offset ?? offset, hasConfig });
      else if (resolve) entries.push({ name: resolve.text ?? '<unread>', form: resolve.text ? 'resolve' : 'unread', offset: resolve.offset ?? offset, hasConfig });
      else entries.push({ name: '<unread>', form: 'unread', offset, hasConfig });
    } else if (ts.isArrowFunction(el) || ts.isFunctionExpression(el)) {
      entries.push({ name: '<inline>', form: 'inline', offset, hasConfig: false });
    } else {
      entries.push({ name: '<unread>', form: 'unread', offset, hasConfig: false });
    }
  }
  return { status: 'read', file, entries, envFiles };
}

/** A property's literal value and its offset (`text` undefined: present but not a literal). */
function prop(sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, key: string): { text?: string; offset?: number } | undefined {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p) || propNameText(p.name) !== key) continue;
    const text = literalText(p.initializer);
    return text !== undefined ? { text, offset: p.initializer.getStart(sf) + 1 } : {};
  }
  return undefined;
}

/**
 * The exported stack: `export default [...]`, `module.exports = [...]`, an exported
 * top-level const, or a config function (`({ env }) => [...]`, `return [...]`) whose
 * result is that literal array.
 */
function stackArray(sf: ts.SourceFile): ts.ArrayLiteralExpression | undefined {
  let expr: ts.Expression | undefined;
  for (const stmt of sf.statements) {
    if (ts.isExportAssignment(stmt)) expr = stmt.expression;
    else if (
      ts.isExpressionStatement(stmt) &&
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(stmt.expression.left) &&
      stmt.expression.left.name.text === 'exports' &&
      ts.isIdentifier(stmt.expression.left.expression) &&
      stmt.expression.left.expression.text === 'module'
    ) {
      expr = stmt.expression.right;
    }
  }
  expr = unwrap(expr);
  if (expr && ts.isIdentifier(expr)) expr = unwrap(topLevelConst(sf, expr.text));
  if (expr && (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr))) expr = unwrap(functionResult(expr));
  return expr && ts.isArrayLiteralExpression(expr) ? expr : undefined;
}

function unwrap(e: ts.Expression | undefined): ts.Expression | undefined {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
  return e;
}

/** The expression a config function returns, when it is its only statement. */
function functionResult(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression | undefined {
  if (!ts.isBlock(fn.body)) return fn.body;
  const stmts = fn.body.statements;
  return stmts.length === 1 && ts.isReturnStatement(stmts[0]!) ? stmts[0].expression : undefined;
}

function topLevelConst(sf: ts.SourceFile, name: string): ts.Expression | undefined {
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
  return count === 1 ? found : undefined;
}
