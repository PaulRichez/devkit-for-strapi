import ts from 'typescript';
import { isStrapi, pluginNameOf } from './patterns';
import { parseSource } from './parse';

/**
 * A method access on a resolved Strapi service/controller, e.g. the `notify` in
 * `strapi.service('api::page.notifier').notify()`. TypeScript can't navigate
 * this because `strapi.service(...)` is typed `any` — Strapi DevKit can.
 */
export interface MemberAccessRef {
  kind: 'service-member' | 'controller-member' | 'plugin-service-member';
  /** UID for service/controller; bare service name for a plugin chain. */
  ref: string;
  pluginName?: string;
  method: string;
  /** Range of the method identifier (for hover). */
  range: { start: number; end: number };
}

function literalArg0(call: ts.CallExpression): string | undefined {
  const a = call.arguments[0];
  return a && ts.isStringLiteralLike(a) ? a.text : undefined;
}

function classifyBaseCall(call: ts.CallExpression): Omit<MemberAccessRef, 'method' | 'range'> | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  const obj = callee.expression;
  const uid = literalArg0(call);
  if (!uid) return undefined;

  if (method === 'service') {
    const plugin = pluginNameOf(obj);
    if (plugin !== undefined) return { kind: 'plugin-service-member', ref: uid, pluginName: plugin };
    if (isStrapi(obj)) return { kind: 'service-member', ref: uid };
  }
  if (method === 'controller' && isStrapi(obj)) {
    return { kind: 'controller-member', ref: uid };
  }
  return undefined;
}

/** Detect a method access on a resolved service/controller at `offset`. */
export function analyzeMemberAt(filePath: string, text: string, offset: number): MemberAccessRef | undefined {
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
  if (!ts.isCallExpression(access.expression)) return undefined;

  const base = classifyBaseCall(access.expression);
  if (!base) return undefined;

  return { ...base, method: ident.text, range: { start: ident.getStart(sf), end: ident.getEnd() } };
}
