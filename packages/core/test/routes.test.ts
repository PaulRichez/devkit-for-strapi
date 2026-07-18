import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { listRoutes } from '../src/index/routes';

const ROOT = 'c:/p';

const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/src/api/product/content-types/product/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"product","pluralName":"products"},"attributes":{}}',
  [`${ROOT}/src/api/product/routes/product.ts`]:
    "export default factories.createCoreRouter('api::product.product', { except: ['delete'], config: { find: { policies: ['global::is-auth'] } } });\n",
  [`${ROOT}/src/api/product/routes/custom.ts`]:
    "export default { routes: [{ method: 'POST', path: '/products/import', handler: 'api::product.product.import', config: { middlewares: ['global::audit'] } }] };\n",
};

describe('listRoutes (static route table)', () => {
  it('synthesizes auto-CRUD from createCoreRouter and parses custom routes', async () => {
    const fs = new MemoryFileSystem(files);
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const project = engine.allProjects()[0]!;
    const routes = await listRoutes(fs, project);

    // auto-CRUD on /products (pluralName), `delete` excepted, per-action policy on find.
    const find = routes.find((r) => r.handler === 'api::product.product.find');
    expect(find).toMatchObject({ method: 'GET', path: '/products', source: 'core-router' });
    expect(find?.policies).toEqual(['global::is-auth']);
    expect(routes.some((r) => r.handler === 'api::product.product.findOne' && r.path === '/products/:id')).toBe(true);
    expect(routes.some((r) => r.handler === 'api::product.product.delete')).toBe(false);

    // custom route from a routes-file array.
    const custom = routes.find((r) => r.handler === 'api::product.product.import');
    expect(custom).toMatchObject({ method: 'POST', path: '/products/import', source: 'router-file' });
    expect(custom?.middlewares).toEqual(['global::audit']);
  });

  it('includes .mts/.cts route files (aligned with the reference walk)', async () => {
    const fs = new MemoryFileSystem({
      [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${ROOT}/src/api/widget/content-types/widget/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"widget","pluralName":"widgets"},"attributes":{}}',
      [`${ROOT}/src/api/widget/routes/widget.mts`]: "export default factories.createCoreRouter('api::widget.widget');\n",
    });
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const project = engine.allProjects()[0]!;
    const routes = await listRoutes(fs, project);
    expect(routes.some((r) => r.handler === 'api::widget.widget.find')).toBe(true);
  });

  it('synthesizes singleType auto-CRUD as find/update/delete on the singular path (no findOne/create, no :id)', async () => {
    const fs = new MemoryFileSystem({
      [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${ROOT}/src/api/homepage/content-types/homepage/schema.json`]:
        '{"kind":"singleType","info":{"singularName":"homepage","pluralName":"homepages"},"attributes":{}}',
      [`${ROOT}/src/api/homepage/routes/homepage.ts`]: "export default factories.createCoreRouter('api::homepage.homepage');\n",
    });
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const project = engine.allProjects()[0]!;
    const routes = await listRoutes(fs, project);

    const actions = routes.filter((r) => r.handler.startsWith('api::homepage.homepage.')).map((r) => r.handler.split('.').pop());
    expect(actions.sort()).toEqual(['delete', 'find', 'update']); // no findOne/create
    expect(routes.find((r) => r.handler.endsWith('.find'))?.path).toBe('/homepage'); // singular, no plural
    expect(routes.some((r) => r.path.includes(':id'))).toBe(false); // no :id resource
  });
});
