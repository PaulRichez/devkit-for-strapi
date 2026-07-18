import ts from 'typescript';
import type { StrapiApiId } from '../model/strapiApi';
import { isStrapi, isStrapiDb } from './patterns';
import { parseSource } from './parse';

/**
 * A call to a built-in Strapi data API method, e.g. the `findMany` in
 * `strapi.documents('api::page.page').findMany()`. There is no file to navigate
 * to (it lives in the framework), but we can enrich hover where TS shows `any`.
 */
export interface ApiMemberRef {
  api: StrapiApiId;
  method: string;
  /** Target content-type UID, when present as a literal. */
  uid?: string;
  range: { start: number; end: number };
}

function literalArg0(call: ts.CallExpression): string | undefined {
  const a = call.arguments[0];
  return a && ts.isStringLiteralLike(a) ? a.text : undefined;
}

export function analyzeApiMemberAt(filePath: string, text: string, offset: number): ApiMemberRef | undefined {
  if (filePath.endsWith('.json') || !/strapi/.test(text)) return undefined;

  const sf = parseSource(filePath, text);
  let ident: ts.Identifier | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getFullStart() || offset > node.getEnd()) return;
    if (ts.isIdentifier(node) && offset >= node.getStart(sf) && offset <= node.getEnd()) ident = node;
    node.forEachChild(visit);
  };
  visit(sf);
  if (!ident) return undefined;

  const access = ident.parent;
  if (!ts.isPropertyAccessExpression(access) || access.name !== ident) return undefined;
  const base = access.expression;
  const range = { start: ident.getStart(sf), end: ident.getEnd() };

  // strapi.documents('uid').<method>  /  strapi.db.query('uid').<method>
  if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) {
    const callee = base.expression;
    if (callee.name.text === 'documents' && isStrapi(callee.expression)) {
      return mk('document-service', ident.text, literalArg0(base), range);
    }
    if (callee.name.text === 'query' && isStrapiDb(callee.expression)) {
      return mk('query-engine', ident.text, literalArg0(base), range);
    }
  }

  // strapi.entityService.<method>('uid', …)
  if (ts.isPropertyAccessExpression(base) && base.name.text === 'entityService' && isStrapi(base.expression)) {
    const enclosing = access.parent;
    const uid = ts.isCallExpression(enclosing) ? literalArg0(enclosing) : undefined;
    return mk('entity-service', ident.text, uid, range);
  }

  return undefined;
}

function mk(api: StrapiApiId, method: string, uid: string | undefined, range: ApiMemberRef['range']): ApiMemberRef {
  return uid ? { api, method, uid, range } : { api, method, range };
}
