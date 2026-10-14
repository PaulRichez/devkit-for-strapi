import ts from 'typescript';
import type { ApiStyle, ReferenceKind } from '../model/types';

export interface ClassifiedRef {
  kind: ReferenceKind;
  apiStyle?: ApiStyle;
  pluginName?: string;
}

/** `strapi` global, destructured `strapi`, or `*.strapi`. */
export function isStrapi(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'strapi';
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'strapi';
  return false;
}

/** `strapi.db` */
export function isStrapiDb(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'db' && isStrapi(node.expression);
}

/** When `base` is `strapi.plugin('a')`, return `'a'` (only for literal names). */
export function pluginNameOf(base: ts.Expression): string | undefined {
  if (
    ts.isCallExpression(base) &&
    ts.isPropertyAccessExpression(base.expression) &&
    base.expression.name.text === 'plugin' &&
    isStrapi(base.expression.expression)
  ) {
    const arg = base.arguments[0];
    if (arg && ts.isStringLiteralLike(arg)) return arg.text;
  }
  return undefined;
}

function getCalleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

export function propNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function classifyCall(call: ts.CallExpression, arg: ts.Expression): ClassifiedRef | undefined {
  const argIndex = call.arguments.indexOf(arg);
  if (argIndex < 0) return undefined;

  const callee = call.expression;
  const calleeName = getCalleeName(callee);

  if (
    argIndex === 0 &&
    (calleeName === 'createCoreService' ||
      calleeName === 'createCoreController' ||
      calleeName === 'createCoreRouter')
  ) {
    return { kind: 'content-type-uid', apiStyle: 'factory' };
  }

  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  const base = callee.expression;

  // strapi.entityService.<method>(uid, ...)
  if (
    argIndex === 0 &&
    ts.isPropertyAccessExpression(base) &&
    base.name.text === 'entityService' &&
    isStrapi(base.expression)
  ) {
    return { kind: 'content-type-uid', apiStyle: 'entityService' };
  }

  if (argIndex !== 0) return undefined;

  switch (method) {
    case 'service': {
      const plugin = pluginNameOf(base);
      if (plugin !== undefined) return { kind: 'plugin-service-ref', apiStyle: 'plugin', pluginName: plugin };
      return isStrapi(base) ? { kind: 'service-ref', apiStyle: 'service' } : undefined;
    }
    case 'controller': {
      const plugin = pluginNameOf(base);
      if (plugin !== undefined) return { kind: 'controller-ref', apiStyle: 'plugin', pluginName: plugin };
      return isStrapi(base) ? { kind: 'controller-ref', apiStyle: 'controller' } : undefined;
    }
    case 'policy': {
      const plugin = pluginNameOf(base);
      if (plugin !== undefined) return { kind: 'policy-ref', apiStyle: 'plugin', pluginName: plugin };
      return isStrapi(base) ? { kind: 'policy-ref', apiStyle: 'service' } : undefined;
    }
    case 'middleware': {
      const plugin = pluginNameOf(base);
      if (plugin !== undefined) return { kind: 'middleware-ref', apiStyle: 'plugin', pluginName: plugin };
      return isStrapi(base) ? { kind: 'middleware-ref', apiStyle: 'service' } : undefined;
    }
    case 'documents':
      return isStrapi(base) ? { kind: 'content-type-uid', apiStyle: 'documents' } : undefined;
    case 'query':
      // `strapi.db.query('uid')` (v4/v5) and the bare `strapi.query('uid')` (v4)
      // both reference a content-type; only the API style differs.
      if (isStrapiDb(base)) return { kind: 'content-type-uid', apiStyle: 'db.query' };
      return isStrapi(base) ? { kind: 'content-type-uid', apiStyle: 'query' } : undefined;
    // strapi.contentType('api::x.x') / strapi.plugin('a').contentType('b') → the schema.
    case 'contentType': {
      const plugin = pluginNameOf(base);
      if (plugin !== undefined) return { kind: 'content-type-uid', apiStyle: 'plugin', pluginName: plugin };
      return isStrapi(base) ? { kind: 'content-type-uid', apiStyle: 'contentType' } : undefined;
    }
    case 'getModel':
      return isStrapi(base) ? { kind: 'content-type-uid', apiStyle: 'getModel' } : undefined;
    case 'plugin':
      return isStrapi(base) ? { kind: 'plugin-name', apiStyle: 'plugin' } : undefined;
    default:
      return undefined;
  }
}

/** A route's `policies: [...]` / `middlewares: [...]` list → what its entries reference. */
function scopedListKind(list: ts.ArrayLiteralExpression): ClassifiedRef | undefined {
  if (!ts.isPropertyAssignment(list.parent)) return undefined;
  const key = propNameText(list.parent.name);
  if (key === 'policies') return { kind: 'policy-ref', apiStyle: 'route' };
  if (key === 'middlewares') return { kind: 'middleware-ref', apiStyle: 'route' };
  return undefined;
}

/** Registry map access: `strapi.services['api::x.x']`, `strapi.contentTypes[…]`, … */
function classifyRegistryAccess(access: ts.ElementAccessExpression): ClassifiedRef | undefined {
  const obj = access.expression;
  if (!ts.isPropertyAccessExpression(obj) || !isStrapi(obj.expression)) return undefined;
  switch (obj.name.text) {
    case 'services':
      return { kind: 'service-ref', apiStyle: 'service' };
    case 'controllers':
      return { kind: 'controller-ref', apiStyle: 'controller' };
    case 'contentTypes':
      return { kind: 'content-type-uid' };
    case 'policies':
      return { kind: 'policy-ref', apiStyle: 'service' };
    case 'middlewares':
      return { kind: 'middleware-ref', apiStyle: 'service' };
    case 'components':
      return { kind: 'component-uid' };
    default:
      return undefined;
  }
}

/**
 * What a call argument or a registry index references, by the Strapi call or
 * access it sits in (`strapi.db.query(x)`, `strapi.services[x]`) — whatever the
 * expression: a literal, or an identifier naming a string constant.
 */
export function classifyArgument(node: ts.Expression): ClassifiedRef | undefined {
  const parent = node.parent;
  if (ts.isCallExpression(parent)) return classifyCall(parent, node);
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return classifyRegistryAccess(parent);
  return undefined;
}

/** Classify a string literal inside a `.ts/.js` file. */
export function classifyCodeLiteral(lit: ts.StringLiteralLike): ClassifiedRef | undefined {
  const parent = lit.parent;
  const asArgument = classifyArgument(lit);
  if (asArgument) return asArgument;

  if (ts.isPropertyAssignment(parent) && parent.initializer === lit) {
    const key = propNameText(parent.name);
    if (key === 'handler') return { kind: 'controller-action', apiStyle: 'route' };
    // The object form of a route's policy/middleware: `{ name: 'api::x.y', config: {…} }`.
    if (key === 'name') {
      const entry = parent.parent;
      if (ts.isArrayLiteralExpression(entry.parent)) {
        const list = scopedListKind(entry.parent);
        if (list) return list;
      }
    }
  }

  if (ts.isArrayLiteralExpression(parent)) {
    const list = scopedListKind(parent);
    if (list) return list;
  }

  return undefined;
}

/** Classify a string literal inside a `schema.json` / component JSON value. */
export function classifyJsonLiteral(lit: ts.StringLiteralLike): ClassifiedRef | undefined {
  const parent = lit.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === lit) {
    const key = propNameText(parent.name);
    if (key === 'target') return { kind: 'content-type-uid', apiStyle: 'schema' };
    if (key === 'component') return { kind: 'component-uid', apiStyle: 'schema' };
  }
  if (ts.isArrayLiteralExpression(parent) && ts.isPropertyAssignment(parent.parent)) {
    if (propNameText(parent.parent.name) === 'components') {
      return { kind: 'component-uid', apiStyle: 'schema' };
    }
  }
  return undefined;
}
