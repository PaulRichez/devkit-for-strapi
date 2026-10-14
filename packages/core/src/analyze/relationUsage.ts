/**
 * Find where a content-type's **relation field** is used by name inside a query —
 * `populate`/`filters` on `entityService` / `documents` / `db.query` / `query` /
 * `service` calls. This is object-key analysis (not a magic string), so it's the
 * one place we look past string literals. *Garantir, ne pas deviner*: we only
 * record a key when it is a **known relation field** of the call's content-type
 * (resolved from its real schema) — an unknown key is ignored, never guessed.
 *
 * Nested trees are followed through each relation's real `target` (see
 * {@link collectRelationFieldUsages}).
 */

import ts from 'typescript';
import { type ConstantResolver, constantResolver, mayDeclareStringConstants } from './constants';
import { MAX_PARSE_CHARS, parseSource } from './parse';
import { isStrapi, isStrapiDb } from './patterns';

export interface RelationUsage {
  uid: string;
  field: string;
  /** Char offsets of the field token (identifier key, or string content). */
  start: number;
  end: number;
  /** A shorthand property (`{ user }`): the token is also the value's name — a rename writes `owner: user`. */
  shorthand?: boolean;
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

/** The UID a call receives: a literal, or a string constant in scope. */
function stringArg(node: ts.Expression | undefined, constants: ConstantResolver | undefined): string | undefined {
  if (node && ts.isStringLiteralLike(node)) return node.text;
  return node && ts.isIdentifier(node) ? constants?.resolve(node)?.text : undefined;
}

function objectArg(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  return node && ts.isObjectLiteralExpression(node) ? node : undefined;
}

/** Recognize `strapi.entityService.m('uid', {…})` and `strapi.x('uid').m({…})`. */
function dataCallOf(call: ts.CallExpression, constants: ConstantResolver | undefined): DataCall | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const base = callee.expression;

  // strapi.entityService.<method>('uid', { options })
  if (
    ts.isPropertyAccessExpression(base) &&
    base.name.text === 'entityService' &&
    isStrapi(base.expression)
  ) {
    const uid = stringArg(call.arguments[0], constants);
    // `findMany(uid, params)`, but `findOne` / `update` / `delete(uid, id, params)`.
    const options = objectArg(call.arguments[1]) ?? objectArg(call.arguments[2]);
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
    const uid = stringArg(base.arguments[0], constants);
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

/** A content-type's relation fields: name → the content-type it targets (when known). */
export type RelationsOf = (uid: string) => ReadonlyMap<string, string | undefined> | undefined;

/** How deep a populate/filters tree is followed (each level resolves a relation's target). */
const MAX_DEPTH = 8;

/**
 * Collect relation-field usages in a source file, nested ones included: a
 * `populate: { a: { populate: { b } } }` tree, a `populate: ['a.b']` path,
 * `filters: { a: { b: … } }`, `$and`/`$or` lists — each level resolved against
 * the real `target` of the relation above it. `relationsOf(uid)` returns a
 * content-type's relation fields (or undefined if unknown) — the guardrail that
 * keeps us from guessing: a key that isn't a relation of the content-type at its
 * level is never recorded, and nothing below it is followed.
 */
export function collectRelationFieldUsages(filePath: string, text: string, relationsOf: RelationsOf): RelationUsage[] {
  if (filePath.endsWith('.json') || text.length > MAX_PARSE_CHARS) return [];
  const sf = parseSource(filePath, text); // shares the pass's cached AST (parse-once) + correct ScriptKind
  const constants = mayDeclareStringConstants(text) ? constantResolver(sf) : undefined;
  const out: RelationUsage[] = [];

  /** Record `field` when it is a relation of `uid`; its target (to descend into), if any. */
  const record = (uid: string, field: string, start: number, end: number, shorthand = false): string | undefined => {
    const relations = relationsOf(uid);
    if (!relations?.has(field)) return undefined;
    out.push(shorthand ? { uid, field, start, end, shorthand } : { uid, field, start, end });
    return relations.get(field);
  };

  /** A `'a.b.c'` populate path: each segment against the target of the one before. */
  const scanPath = (uid: string, lit: ts.StringLiteralLike): void => {
    let current: string | undefined = uid;
    let offset = lit.getStart(sf) + 1;
    for (const seg of lit.text.split('.')) {
      if (!current) return;
      current = record(current, seg, offset, offset + seg.length);
      offset += seg.length + 1;
    }
  };

  const scanPopulate = (uid: string, value: ts.Expression, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (ts.isStringLiteralLike(value)) {
      scanPath(uid, value);
    } else if (ts.isArrayLiteralExpression(value)) {
      for (const el of value.elements) if (ts.isStringLiteralLike(el)) scanPath(uid, el);
    } else if (ts.isObjectLiteralExpression(value)) {
      for (const p of value.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
        const tok = keyToken(p.name, sf);
        if (!tok) continue;
        const target = record(uid, tok.field, tok.start, tok.end, ts.isShorthandPropertyAssignment(p));
        // `a: { populate: … , filters: … }` → the same options on the relation's target.
        if (target && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)) {
          const nested = optionValue(p.initializer, 'populate');
          if (nested) scanPopulate(target, nested, depth + 1);
          const filters = optionValue(p.initializer, 'filters');
          if (filters) scanFilters(target, filters, depth + 1);
        }
      }
    }
  };

  const scanFilters = (uid: string, value: ts.Expression, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (ts.isArrayLiteralExpression(value)) {
      for (const el of value.elements) scanFilters(uid, el, depth);
      return;
    }
    if (!ts.isObjectLiteralExpression(value)) return;
    for (const p of value.properties) {
      if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
      const tok = keyToken(p.name, sf);
      if (!tok) continue;
      // `$and` / `$or` / `$not`: the same content-type, one level down.
      if (tok.field.startsWith('$')) {
        if (ts.isPropertyAssignment(p)) scanFilters(uid, p.initializer, depth + 1);
        continue;
      }
      const target = record(uid, tok.field, tok.start, tok.end, ts.isShorthandPropertyAssignment(p));
      if (target && ts.isPropertyAssignment(p)) scanFilters(target, p.initializer, depth + 1);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const dc = dataCallOf(node, constants);
      if (dc && relationsOf(dc.uid)?.size) {
        const populate = optionValue(dc.options, 'populate');
        if (populate) scanPopulate(dc.uid, populate, 0);
        const filters = optionValue(dc.options, 'filters');
        if (filters) scanFilters(dc.uid, filters, 0);
        // The Query Engine's (`db.query`) name for filters.
        const where = optionValue(dc.options, 'where');
        if (where) scanFilters(dc.uid, where, 0);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
