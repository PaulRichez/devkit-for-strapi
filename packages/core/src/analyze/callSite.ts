import ts from 'typescript';
import type { ReferenceContext } from '../model/types';
import { classifyConfigMiddlewareLiteral, isConfigMiddlewares } from './config';
import { parseSource } from './parse';
import { type ClassifiedRef, classifyCodeLiteral, classifyJsonLiteral } from './patterns';

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
  return c ? buildContext(sf, lit, c) : undefined;
}

/** Every recognized Strapi reference in a file (used by the validator, F2). */
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
  return out;
}
