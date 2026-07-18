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

function classifyCall(call: ts.CallExpression, lit: ts.StringLiteralLike): ClassifiedRef | undefined {
  const argIndex = call.arguments.indexOf(lit);
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

/** Classify a string literal inside a `.ts/.js` file. */
export function classifyCodeLiteral(lit: ts.StringLiteralLike): ClassifiedRef | undefined {
  const parent = lit.parent;
  if (ts.isCallExpression(parent)) return classifyCall(parent, lit);

  if (ts.isPropertyAssignment(parent) && parent.initializer === lit) {
    if (propNameText(parent.name) === 'handler') return { kind: 'controller-action', apiStyle: 'route' };
  }

  if (ts.isArrayLiteralExpression(parent) && ts.isPropertyAssignment(parent.parent)) {
    const key = propNameText(parent.parent.name);
    if (key === 'policies') return { kind: 'policy-ref', apiStyle: 'route' };
    if (key === 'middlewares') return { kind: 'middleware-ref', apiStyle: 'route' };
  }

  // Registry map access: strapi.services['api::x.x'], strapi.contentTypes['…'], …
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === lit) {
    const obj = parent.expression;
    if (ts.isPropertyAccessExpression(obj) && isStrapi(obj.expression)) {
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
      }
    }
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
