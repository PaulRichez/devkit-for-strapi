/**
 * Find where a content-type's **relation field** is used by name inside a query —
 * `populate`/`filters` on `entityService` / `documents` / `db.query` / `query` /
 * `service` calls. This is object-key analysis (not a magic string), so it's the
 * one place we look past string literals. *Garantir, ne pas deviner*: we only
 * record a key when it is a **known relation field** of the call's content-type
 * (resolved from its real schema) — an unknown key is ignored, never guessed.
 *
 * Known gap (surfaced via `coverage`): only top-level `populate`/`filters` are
 * scanned, not arbitrarily nested populate trees.
 */

import ts from 'typescript';
import { MAX_PARSE_CHARS, parseSource } from './parse';
import { isStrapi, isStrapiDb } from './patterns';

export interface RelationUsage {
  uid: string;
  field: string;
  /** Char offsets of the field token (identifier key, or string content). */
  start: number;
  end: number;
}

/** A data-access call carrying a content-type UID and an options object. */
interface DataCall {
  uid: string;
  options: ts.ObjectLiteralExpression;
}

/**
 * Core service methods that actually accept `{ populate }`/`{ filters }`. Unlike
 * `documents`/`db.query` (whose receiver is itself a query API), `service('uid')`
 * returns a *custom* service — so we only treat its known query methods as queries,
 * never a custom `service('uid').buildReport({ populate })` (which would over-count).
 */
const QUERY_METHODS = new Set(['find', 'findOne', 'findMany', 'findPage', 'count', 'create', 'update', 'delete']);

function stringArg(node: ts.Expression | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function objectArg(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  return node && ts.isObjectLiteralExpression(node) ? node : undefined;
}

/** Recognize `strapi.entityService.m('uid', {…})` and `strapi.x('uid').m({…})`. */
function dataCallOf(call: ts.CallExpression): DataCall | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const base = callee.expression;

  // strapi.entityService.<method>('uid', { options })
  if (
    ts.isPropertyAccessExpression(base) &&
    base.name.text === 'entityService' &&
    isStrapi(base.expression)
  ) {
    const uid = stringArg(call.arguments[0]);
    const options = objectArg(call.arguments[1]);
    return uid && options ? { uid, options } : undefined;
  }

  // strapi.documents('uid').<method>({ options }) — and db.query / query / service.
  if (ts.isCallExpression(base)) {
    const inner = base.expression;
    if (!ts.isPropertyAccessExpression(inner)) return undefined;
    const method = inner.name.text;
    const recv = inner.expression;
    const outer = callee.name.text; // the method called on the receiver (find / buildReport / …)
    const isReceiver =
      (method === 'documents' && isStrapi(recv)) ||
      (method === 'query' && (isStrapiDb(recv) || isStrapi(recv))) ||
      (method === 'service' && isStrapi(recv) && QUERY_METHODS.has(outer));
    if (!isReceiver) return undefined;
    const uid = stringArg(base.arguments[0]);
    const options = objectArg(call.arguments[0]);
    return uid && options ? { uid, options } : undefined;
  }
  return undefined;
}

/** The relevant option object on a query, by key (`populate`, `filters`). */
function optionValue(options: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
  for (const p of options.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === key) return p.initializer;
    if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.name) && p.name.text === key) return p.initializer;
  }
  return undefined;
}

/** Field name + token range from a key node (identifier or string literal). */
function keyToken(name: ts.PropertyName, sf: ts.SourceFile): { field: string; start: number; end: number } | undefined {
  if (ts.isIdentifier(name)) return { field: name.text, start: name.getStart(sf), end: name.getEnd() };
  if (ts.isStringLiteralLike(name)) return { field: name.text, start: name.getStart(sf) + 1, end: name.getEnd() - 1 };
  return undefined;
}

/**
 * Collect relation-field usages in a source file. `relationFieldsOf(uid)` returns
 * the real relation field names of a content-type (or undefined if unknown) — the
 * guardrail that keeps us from guessing.
 */
export function collectRelationFieldUsages(
  filePath: string,
  text: string,
  relationFieldsOf: (uid: string) => Set<string> | undefined,
): RelationUsage[] {
  if (filePath.endsWith('.json') || text.length > MAX_PARSE_CHARS) return [];
  const sf = parseSource(filePath, text); // shares the pass's cached AST (parse-once) + correct ScriptKind
  const out: RelationUsage[] = [];

  const record = (uid: string, fields: Set<string>, field: string, start: number, end: number): void => {
    if (fields.has(field)) out.push({ uid, field, start, end });
  };

  const scanPopulate = (uid: string, fields: Set<string>, value: ts.Expression): void => {
    if (ts.isStringLiteralLike(value)) {
      record(uid, fields, value.text, value.getStart(sf) + 1, value.getEnd() - 1);
    } else if (ts.isArrayLiteralExpression(value)) {
      for (const el of value.elements) {
        if (ts.isStringLiteralLike(el)) record(uid, fields, el.text, el.getStart(sf) + 1, el.getEnd() - 1);
      }
    } else if (ts.isObjectLiteralExpression(value)) {
      for (const p of value.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
        const tok = keyToken(p.name, sf);
        if (tok) record(uid, fields, tok.field, tok.start, tok.end);
      }
    }
  };

  const scanFilters = (uid: string, fields: Set<string>, value: ts.Expression): void => {
    if (!ts.isObjectLiteralExpression(value)) return;
    for (const p of value.properties) {
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
      const tok = keyToken(p.name, sf);
      if (tok) record(uid, fields, tok.field, tok.start, tok.end);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const dc = dataCallOf(node);
      if (dc) {
        const fields = relationFieldsOf(dc.uid);
        if (fields && fields.size) {
          const populate = optionValue(dc.options, 'populate');
          if (populate) scanPopulate(dc.uid, fields, populate);
          const filters = optionValue(dc.options, 'filters');
          if (filters) scanFilters(dc.uid, fields, filters);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
