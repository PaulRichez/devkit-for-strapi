import { describe, expect, it } from 'vitest';
import { analyzeAt, collectReferences } from '../src/analyze/callSite';

/** Offset landing inside the first occurrence of `needle`. */
function inside(text: string, needle: string): number {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`needle not found: ${needle}`);
  return i + Math.floor(needle.length / 2);
}

describe('call-site analyzer (code)', () => {
  const cases: Array<[string, string, string, string | undefined]> = [
    [`strapi.service('api::product.product')`, 'product.product', 'service-ref', 'service'],
    [`strapi.controller('api::product.product')`, 'product.product', 'controller-ref', 'controller'],
    [`strapi.documents('api::product.product').findMany({})`, 'product.product', 'content-type-uid', 'documents'],
    [`strapi.entityService.findMany('api::article.article', {})`, 'article.article', 'content-type-uid', 'entityService'],
    [`strapi.db.query('api::article.article').findOne({})`, 'article.article', 'content-type-uid', 'db.query'],
    [`strapi.query('api::article.article').findOne({})`, 'article.article', 'content-type-uid', 'query'],
    [`strapi.plugin('users-permissions')`, 'users-permissions', 'plugin-name', 'plugin'],
    [`export default factories.createCoreController('api::x.x', () => ({}))`, 'x.x', 'content-type-uid', 'factory'],
    [`strapi.contentType('api::product.product')`, 'product.product', 'content-type-uid', 'contentType'],
    [`strapi.getModel('api::product.product')`, 'product.product', 'content-type-uid', 'getModel'],
  ];

  it.each(cases)('classifies %s', (code, needle, kind, apiStyle) => {
    const ctx = analyzeAt('file.ts', code, inside(code, needle));
    expect(ctx?.kind).toBe(kind);
    expect(ctx?.apiStyle).toBe(apiStyle);
    expect(ctx?.isLiteral).toBe(true);
  });

  it('classifies a route handler as a controller action', () => {
    const code = `export default { routes: [{ handler: 'api::product.product.featured' }] };`;
    const ctx = analyzeAt('routes.ts', code, inside(code, 'featured'));
    expect(ctx?.kind).toBe('controller-action');
    expect(ctx?.text).toBe('api::product.product.featured');
  });

  it('classifies policies and middlewares array elements', () => {
    const code = `export default { config: { find: { policies: ['global::is-auth'], middlewares: ['api::x.mw'] } } };`;
    expect(analyzeAt('r.ts', code, inside(code, 'is-auth'))?.kind).toBe('policy-ref');
    expect(analyzeAt('r.ts', code, inside(code, 'x.mw'))?.kind).toBe('middleware-ref');
  });

  it('extracts the plugin name for a chained plugin service', () => {
    const code = `strapi.plugin('users-permissions').service('user')`;
    const ctx = analyzeAt('s.ts', code, inside(code, `'user'`) + 1);
    expect(ctx?.kind).toBe('plugin-service-ref');
    expect(ctx?.pluginName).toBe('users-permissions');
    expect(ctx?.text).toBe('user');
  });

  it('never guesses: variables and template strings yield no context', () => {
    expect(analyzeAt('s.ts', `strapi.service(uid)`, 16)).toBeUndefined();
    const tpl = 'strapi.service(`api::${x}.y`)';
    expect(analyzeAt('s.ts', tpl, inside(tpl, 'api::'))).toBeUndefined();
  });

  it('reports the string content range without quotes', () => {
    const code = `strapi.service('api::product.product')`;
    const ctx = analyzeAt('s.ts', code, inside(code, 'product.product'))!;
    expect(code.slice(ctx.range.start, ctx.range.end)).toBe('api::product.product');
  });
});

describe('call-site analyzer (json)', () => {
  it('classifies component and target values in a schema', () => {
    const json = `{ "attributes": { "cat": { "type": "relation", "target": "api::category.category" }, "seo": { "type": "component", "component": "shared.seo" } } }`;
    expect(analyzeAt('schema.json', json, inside(json, 'category.category'))?.kind).toBe('content-type-uid');
    expect(analyzeAt('schema.json', json, inside(json, 'shared.seo'))?.kind).toBe('component-uid');
  });

  it('does not classify the property key itself', () => {
    const json = `{ "attributes": { "target": { "type": "string" } } }`;
    expect(analyzeAt('schema.json', json, inside(json, '"target"') + 2)).toBeUndefined();
  });
});

describe('collectReferences', () => {
  it('finds every content-type ref in a v4 controller', () => {
    const code = `const { createCoreController } = require('@strapi/strapi').factories;
module.exports = createCoreController('api::article.article', ({ strapi }) => ({
  async find() { return strapi.entityService.findMany('api::article.article', {}); },
  async other() { return strapi.db.query('api::article.article').findMany({}); },
}));`;
    const refs = collectReferences('c.js', code);
    const ctUids = refs.filter((r) => r.kind === 'content-type-uid');
    expect(ctUids.length).toBe(3);
  });
});
