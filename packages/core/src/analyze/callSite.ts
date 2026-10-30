import ts from 'typescript';
import type { ReferenceContext } from '../model/types';
import { classifyConfigMiddlewareLiteral, isConfigMiddlewares } from './config';
import { constantResolver, mayDeclareStringConstants } from './constants';
import { parseSource } from './parse';
import { type ClassifiedRef, classifyArgument, classifyCodeLiteral, classifyJsonLiteral } from './patterns';

/** Cheap gate: skip files that cannot contain a Strapi magic-string call site. */
const CODE_PREFILTER = /strapi|factories|createCore|handler|policies|middlewares/;
const JSON_PREFILTER = /"(component|components|target)"/;

function isJson(filePath: string): boolean {
  return filePath.endsWith('.json');
}

/**
 * True only for JSON files Strapi treats as schema/component definitions — a
 * content-type `schema.json`, or a component at `.../components/<cat>/<name>.json`.
 * Every other `.json` (tsconfig.json, i18n, seed data, package.json) must be
 * ignored: without this gate, any file with a `target`/`component` key was parsed
 * as a schema — e.g. tsconfig's `compilerOptions.target` flagged as a bad UID.
 */
function isSchemaOrComponentJson(filePath: string): boolean {
  const path = filePath.replace(/\\/g, '/');
  if (path.endsWith('/schema.json') || path === 'schema.json') return true;
  return /\/components\/[^/]+\/[^/]+\.json$/.test(path);
}

/** Innermost string literal whose span contains `offset`. */
function findStringAt(sf: ts.SourceFile, offset: number): ts.StringLiteralLike | undefined {
  let found: ts.StringLiteralLike | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getFullStart() || offset > node.getEnd()) return;
    if (ts.isStringLiteralLike(node) && offset >= node.getStart(sf) && offset <= node.getEnd()) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return found;
}

function buildContext(sf: ts.SourceFile, lit: ts.StringLiteralLike, c: ClassifiedRef): ReferenceContext {
  const ctx: ReferenceContext = {
    kind: c.kind,
    text: lit.text,
    range: { start: lit.getStart(sf) + 1, end: lit.getEnd() - 1 },
    isLiteral: true,
  };
  if (c.apiStyle) ctx.apiStyle = c.apiStyle;
  if (c.pluginName !== undefined) ctx.pluginName = c.pluginName;
  return ctx;
}

function classify(filePath: string, lit: ts.StringLiteralLike): ClassifiedRef | undefined {
  if (isConfigMiddlewares(filePath)) return classifyConfigMiddlewareLiteral(lit);
  if (isJson(filePath)) return isSchemaOrComponentJson(filePath) ? classifyJsonLiteral(lit) : undefined;
  return classifyCodeLiteral(lit);
}

/** A use of a string constant as a Strapi call argument (see `constants.ts`). */
interface ConstantUse {
  /** The literal the `const` is initialised with. */
  declaration: ts.StringLiteralLike;
  /** The identifier passed to the call. */
  site: ts.Identifier;
  classified: ClassifiedRef;
}

/** Every identifier passed to a Strapi call that names a string `const` in scope. */
function constantUses(filePath: string, text: string, sf: ts.SourceFile): ConstantUse[] {
  if (isJson(filePath) || isConfigMiddlewares(filePath) || !mayDeclareStringConstants(text)) return [];
  const resolver = constantResolver(sf);
  const out: ConstantUse[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const classified = classifyArgument(node);
      const declaration = classified && resolver.resolve(node);
      if (classified && declaration) out.push({ declaration, site: node, classified });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** The constant declarations a file passes to Strapi calls, each with its first call's classification. */
function constantDeclarations(filePath: string, text: string, sf: ts.SourceFile): Map<ts.StringLiteralLike, ClassifiedRef> {
  const out = new Map<ts.StringLiteralLike, ClassifiedRef>();
  for (const u of constantUses(filePath, text, sf)) if (!out.has(u.declaration)) out.set(u.declaration, u.classified);
  return out;
}

function constantContext(sf: ts.SourceFile, lit: ts.StringLiteralLike, c: ClassifiedRef): ReferenceContext {
  const ctx = buildContext(sf, lit, c);
  ctx.constant = true;
  return ctx;
}

/**
 * Map a cursor offset inside a file to a Strapi reference context, or
 * `undefined` when the cursor is not inside a recognized magic string.
 */
export function analyzeAt(filePath: string, text: string, offset: number): ReferenceContext | undefined {
  // Config files are detected by path, so they bypass the substring prefilter
  // (a stack of only `global::` entries has no prefilter-matching substring).
  const prefilter = isJson(filePath) ? JSON_PREFILTER : CODE_PREFILTER;
  if (!isConfigMiddlewares(filePath) && !prefilter.test(text)) return undefined;

  const sf = parseSource(filePath, text);
  const lit = findStringAt(sf, offset);
  if (!lit) return undefined;

  const c = classify(filePath, lit);
  if (c) return buildContext(sf, lit, c);
  // The literal a `const` passed to a Strapi call is initialised with.
  const asConstant = ts.isVariableDeclaration(lit.parent) ? constantDeclarations(filePath, text, sf).get(lit) : undefined;
  return asConstant ? constantContext(sf, lit, asConstant) : undefined;
}

/**
 * Every recognized Strapi reference in a file (used by the validator, F2) —
 * the literals in Strapi calls, and the `const` literals passed to them
 * (`constant: true`).
 */
export function collectReferences(filePath: string, text: string): ReferenceContext[] {
  const prefilter = isJson(filePath) ? JSON_PREFILTER : CODE_PREFILTER;
  if (!isConfigMiddlewares(filePath) && !prefilter.test(text)) return [];

  const sf = parseSource(filePath, text);
  const out: ReferenceContext[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      const c = classify(filePath, node);
      if (c) out.push(buildContext(sf, node, c));
    }
    node.forEachChild(visit);
  };
  visit(sf);
  for (const [lit, c] of constantDeclarations(filePath, text, sf)) out.push(constantContext(sf, lit, c));
  return out;
}

/**
 * The call sites of string constants (`strapi.db.query(THREAD)`), each as
 * a context on the identifier with the constant's value as text — what the
 * reference index counts (the declaration itself is not a use).
 */
export function collectConstantCallSites(filePath: string, text: string): ReferenceContext[] {
  if (!CODE_PREFILTER.test(text)) return [];
  const sf = parseSource(filePath, text);
  return constantUses(filePath, text, sf).map((u) => {
    const ctx: ReferenceContext = {
      kind: u.classified.kind,
      text: u.declaration.text,
      range: { start: u.site.getStart(sf), end: u.site.getEnd() },
      isLiteral: true,
    };
    if (u.classified.apiStyle) ctx.apiStyle = u.classified.apiStyle;
    if (u.classified.pluginName !== undefined) ctx.pluginName = u.classified.pluginName;
    return ctx;
  });
}

/**
 * Strapi calls whose UID argument DevKit can't read — a parameter, a `let`, a
 * template, a value from another module, an index into a map
 * (`strapi.service(uid)`, `strapi.services[TARGETS[type]]`): they may reach
 * anything of their kind, so they are what can complete a find-references or
 * an unused list. Context text is the part of the UID DevKit can read — every
 * UID the call may reach starts with it (`plugin::y.` for
 * `strapi.plugin('y').service(name)`, `api::foo.` for `'api::foo.' + kind`),
 * '' when none is; the range is the argument.
 */
export function collectUnresolvedCalls(filePath: string, text: string): ReferenceContext[] {
  if (isJson(filePath) || isConfigMiddlewares(filePath) || !CODE_PREFILTER.test(text)) return [];
  const sf = parseSource(filePath, text);
  const constants = mayDeclareStringConstants(text) ? constantResolver(sf) : undefined;
  const out: ReferenceContext[] = [];
  const consider = (arg: ts.Expression): void => {
    if (ts.isStringLiteralLike(arg) || (ts.isIdentifier(arg) && constants?.resolve(arg))) return;
    const c = classifyArgument(arg);
    if (!c || c.kind === 'plugin-name') return;
    const head = staticHead(arg, constants);
    // A head without `::` proves nothing about the UID: a bare name (`'is-' + kind`) is
    // qualified by its file (api, global, plugin), so the call may reach anything.
    const scope = c.pluginName !== undefined ? `plugin::${c.pluginName}.${head}` : head.includes('::') ? head : '';
    const ctx: ReferenceContext = { kind: c.kind, text: scope, range: { start: arg.getStart(sf), end: arg.getEnd() }, isLiteral: false };
    if (c.apiStyle) ctx.apiStyle = c.apiStyle;
    out.push(ctx);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments[0]) consider(node.arguments[0]);
    else if (ts.isElementAccessExpression(node)) consider(node.argumentExpression);
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

const RELATIVE_IMPORT_PREFILTER = /(require|import)\s*\(\s*['"`]\.|from\s*['"]\./;

/**
 * The relative module paths a code file loads (`require('../services/x')`,
 * `import x from './x'`, `import('./x')`), as written: what keeps a file's module
 * used even when nothing calls its Strapi name. The range is the path's.
 */
export function collectRelativeImports(filePath: string, text: string): Array<{ spec: string; start: number; end: number }> {
  if (isJson(filePath) || !RELATIVE_IMPORT_PREFILTER.test(text)) return [];
  const sf = parseSource(filePath, text);
  const out: Array<{ spec: string; start: number; end: number }> = [];
  const add = (s: ts.Expression | undefined): void => {
    if (s && ts.isStringLiteralLike(s) && /^\.\.?(\/|$)/.test(s.text)) out.push({ spec: s.text, start: s.getStart(sf) + 1, end: s.getEnd() - 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const callee = node.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
    } else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      // Types only (`import type`, `export type`, every binding `type`): erased, never loaded.
      if (!isTypeOnlyModuleUse(node)) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && !node.isTypeOnly) {
      add(node.moduleReference.expression);
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** An import or export that TypeScript erases: it names types only, so the module is never loaded. */
function isTypeOnlyModuleUse(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return !!clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
  }
  const clause = node.importClause;
  if (!clause) return false; // `import './x'`: a side-effect import loads it
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const named = clause.namedBindings;
  return !!named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly);
}

/**
 * The start every value of `e` has, read statically: the literal (or string
 * constant) leftmost in a `+` chain, a template's head — a string `+` anything
 * is a string that starts with it. '' otherwise.
 */
function staticHead(e: ts.Expression, constants: ReturnType<typeof constantResolver> | undefined): string {
  while (ts.isParenthesizedExpression(e) || (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
    e = ts.isParenthesizedExpression(e) ? e.expression : e.left;
  }
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isTemplateExpression(e)) return e.head.text;
  if (ts.isIdentifier(e)) return constants?.resolve(e)?.text ?? '';
  return '';
}

/**
 * The string literals of a code file that aren't a Strapi reference (neither a
 * call argument DevKit recognises nor a constant passed to one) and look like a
 * namespaced UID (`::`) — candidates for a plain value reference (a registry
 * map, a config value), matched against the index by the caller.
 */
export function collectUnclassifiedUidLiterals(filePath: string, text: string): Array<{ text: string; start: number; end: number }> {
  if (isJson(filePath) || !text.includes('::')) return [];
  const sf = parseSource(filePath, text);
  const constants = constantDeclarations(filePath, text, sf);
  const out: Array<{ text: string; start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.includes('::') && !classify(filePath, node) && !constants.has(node)) {
      out.push({ text: node.text, start: node.getStart(sf) + 1, end: node.getEnd() - 1 });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}
