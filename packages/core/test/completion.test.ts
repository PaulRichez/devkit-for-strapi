import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('completion (v5-shop)', () => {
  let engine: StrapiEngine;
  let root: string;
  const file = (rel: string): string => `${root}/src/api/product/${rel}`;
  const labels = async (path: string, code: string, marker: string): Promise<string[]> => {
    const offset = code.indexOf(marker) + marker.length;
    const result = await engine.getCompletions(path, offset, code);
    return result.items.map((i) => i.label);
  };

  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('suggests content-type UIDs inside documents()', async () => {
    const got = await labels(file('controllers/x.ts'), `strapi.documents('')`, `documents('`);
    expect(got).toContain('api::product.product');
    expect(got).toContain('api::category.category');
  });

  it('suggests service refs inside service()', async () => {
    const got = await labels(file('controllers/x.ts'), `strapi.service('')`, `service('`);
    expect(got).toContain('api::product.product');
  });

  it('suggests a known global policy in a route config', async () => {
    const code = `export default { config: { find: { policies: [''] } } };`;
    const got = await labels(file('routes/x.ts'), code, `policies: ['`);
    expect(got).toContain('global::is-authenticated');
  });

  it('suggests component UIDs inside a schema', async () => {
    const code = `{ "attributes": { "seo": { "type": "component", "component": "" } } }`;
    const got = await labels(file('content-types/x/schema.json'), code, `"component": "`);
    expect(got).toContain('shared.seo');
  });

  it('suggests controller actions for a partial handler', async () => {
    const code = `export default { routes: [{ handler: 'api::product.product.' }] };`;
    const got = await labels(file('routes/x.ts'), code, `'api::product.product.`);
    expect(got).toContain('api::product.product.featured');
    expect(got).toContain('api::product.product.find');
    expect(got).toContain('api::product.product.update');
  });

  it('reports a replace range covering the typed string content', async () => {
    const code = `strapi.documents('api::pro')`;
    const offset = code.indexOf('api::pro') + 3;
    const result = await engine.getCompletions(file('controllers/x.ts'), offset, code);
    expect(result.replace).toBeDefined();
    expect(code.slice(result.replace!.start, result.replace!.end)).toBe('api::pro');
  });

  it('returns no items for a file outside any Strapi project', async () => {
    const result = await engine.getCompletions('c:/elsewhere/x.ts', 18, `strapi.documents('')`);
    expect(result.items).toEqual([]);
  });
});

describe('completion: bare policy names in a plugin route (same scoping as the validator)', () => {
  it('suggests the short name of a same-plugin policy in a plugin route config', async () => {
    const ROOT = 'c:/pc';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${ROOT}/src/plugins/comms/server/policies/is-owner.ts`]: 'export default () => true;\n',
      }),
    );
    await engine.init([ROOT]);
    const code = `export default { routes: [{ handler: 'x.y', config: { policies: [''] } }] };`;
    const offset = code.indexOf(`policies: ['`) + `policies: ['`.length;
    const items = (await engine.getCompletions(`${ROOT}/src/plugins/comms/server/routes/x.ts`, offset, code)).items;
    const bare = items.find((i) => i.label === 'is-owner');
    expect(bare).toBeDefined();
    expect(bare?.detail).toBe('plugin::comms');
  });
});

describe('completion: schema-only content-type auto-CRUD actions', () => {
  it('suggests core actions for a schema-only content-type route handler', async () => {
    const ROOT = 'c:/cc';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${ROOT}/src/api/widget/content-types/widget/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"widget"},"attributes":{}}',
      }),
    );
    await engine.init([ROOT]);
    const code = `export default { routes: [{ handler: 'api::widget.widget.' }] };`;
    const offset = code.indexOf('api::widget.widget.') + 'api::widget.widget.'.length;
    const items = (await engine.getCompletions(`${ROOT}/src/api/widget/routes/widget.ts`, offset, code)).items.map((i) => i.label);
    expect(items).toContain('api::widget.widget.find');
    expect(items).toContain('api::widget.widget.findOne');
  });
});
