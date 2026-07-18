import ts from 'typescript';
import type { StrapiApiId } from '../model/strapiApi';
import { isStrapi, isStrapiDb, pluginNameOf } from './patterns';
import { parseSource } from './parse';

/** What to suggest after a `.` on a resolved Strapi service/controller/API. */
export type MemberCompletion =
  | { target: 'service' | 'controller'; ref: string; replace: { start: number; end: number } }
  | { target: 'plugin-service'; ref: string; pluginName: string; replace: { start: number; end: number } }
  | { target: 'api'; api: StrapiApiId; replace: { start: number; end: number } };

function literalArg0(call: ts.CallExpression): string | undefined {
  const a = call.arguments[0];
  return a && ts.isStringLiteralLike(a) ? a.text : undefined;
}

/** Detect `<recognized base>.<partial>` at the cursor for member completion. */
export function analyzeMemberCompletionAt(
  filePath: string,
  text: string,
  offset: number,
): MemberCompletion | undefined {
  if (filePath.endsWith('.json') || !/strapi/.test(text)) return undefined;

  const sf = parseSource(filePath, text);
  // Property access whose dot sits just before the cursor (name may be partial/missing).
  let pa: ts.PropertyAccessExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (offset < node.getFullStart() || offset > node.getEnd()) return;
    if (ts.isPropertyAccessExpression(node) && offset > node.expression.getEnd() && offset <= node.getEnd()) {
      pa = node;
    }
    node.forEachChild(visit);
  };
  visit(sf);
  if (!pa) return undefined;

  const nameStart = pa.name.getStart(sf);
  const replace = { start: nameStart <= offset ? nameStart : offset, end: offset };
  const base = pa.expression;

  // strapi.entityService.<partial>
  if (ts.isPropertyAccessExpression(base) && base.name.text === 'entityService' && isStrapi(base.expression)) {
    return { target: 'api', api: 'entity-service', replace };
  }
  if (ts.isCallExpression(base) && ts.isPropertyAccessExpression(base.expression)) {
    const method = base.expression.name.text;
    const obj = base.expression.expression;
    const uid = literalArg0(base);
    if (method === 'service') {
      const plugin = pluginNameOf(obj);
      if (plugin !== undefined && uid) return { target: 'plugin-service', ref: uid, pluginName: plugin, replace };
      if (isStrapi(obj) && uid) return { target: 'service', ref: uid, replace };
    }
    if (method === 'controller' && isStrapi(obj) && uid) return { target: 'controller', ref: uid, replace };
    if (method === 'documents' && isStrapi(obj)) return { target: 'api', api: 'document-service', replace };
    if (method === 'query' && isStrapiDb(obj)) return { target: 'api', api: 'query-engine', replace };
  }
  return undefined;
}
