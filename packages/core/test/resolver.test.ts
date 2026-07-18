import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('go-to-definition (v5-shop)', () => {
  let engine: StrapiEngine;
  let root: string;
  let files: Record<string, string>;

  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    files = fx.files;
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);
  });

  const at = (src: string, anchor: string, uid: string): number => {
    const from = src.indexOf(anchor);
    const u = src.indexOf(uid, from);
    return u + 2;
  };

  it('resolves documents() and the factory UID to schema.json', async () => {
    const path = `${root}/src/api/product/controllers/product.ts`;
    const src = files[path]!;
    const schema = `${root}/src/api/product/content-types/product/schema.json`;

    const viaDocuments = await engine.getDefinitions(path, at(src, 'documents(', 'api::product.product'), src);
    expect(viaDocuments[0]?.filePath).toBe(schema);

    const viaFactory = await engine.getDefinitions(path, at(src, 'createCoreController(', 'api::product.product'), src);
    expect(viaFactory[0]?.filePath).toBe(schema);
  });

  it('resolves a service ref to the service file', async () => {
    const path = `${root}/src/api/product/controllers/product.ts`;
    const src = files[path]!;
    const targets = await engine.getDefinitions(path, at(src, 'service(', 'api::product.product'), src);
    expect(targets[0]?.filePath).toBe(`${root}/src/api/product/services/product.ts`);
  });

  it('resolves a route handler to the controller action method', async () => {
    const path = `${root}/src/api/product/routes/custom.ts`;
    const src = files[path]!;
    const offset = at(src, 'handler:', 'api::product.product.featured');
    const targets = await engine.getDefinitions(path, offset, src);
    const controller = `${root}/src/api/product/controllers/product.ts`;
    expect(targets[0]?.filePath).toBe(controller);
    const controllerSrc = files[controller]!;
    expect(controllerSrc.slice(targets[0]!.offset!)).toMatch(/^featured/);
  });

  it('resolves a global policy ref to its file', async () => {
    const path = `${root}/src/api/product/routes/product.ts`;
    const src = files[path]!;
    const targets = await engine.getDefinitions(path, at(src, 'policies:', 'global::is-authenticated'), src);
    expect(targets[0]?.filePath).toBe(`${root}/src/policies/is-authenticated.ts`);
  });

  it('resolves relation target and component refs inside a schema', async () => {
    const path = `${root}/src/api/product/content-types/product/schema.json`;
    const src = files[path]!;
    const target = await engine.getDefinitions(path, at(src, '"target"', 'api::category.category'), src);
    expect(target[0]?.filePath).toBe(`${root}/src/api/category/content-types/category/schema.json`);
    const comp = await engine.getDefinitions(path, at(src, '"component"', 'shared.seo'), src);
    expect(comp[0]?.filePath).toBe(`${root}/src/components/shared/seo.json`);
  });

  it('returns nothing for an unknown reference or a file outside any project', async () => {
    const path = `${root}/src/api/product/controllers/product.ts`;
    const bad = `strapi.service('api::nope.nope')`;
    expect(await engine.getDefinitions(path, bad.indexOf('nope'), bad)).toEqual([]);
    expect(await engine.getDefinitions('c:/elsewhere/x.ts', 16, `strapi.service('api::product.product')`)).toEqual([]);
  });
});

describe('go-to-definition: bare policy resolves local-shadows-global (api > global precedence)', () => {
  it('a bare policy name in an api route lands on the api-local file, not the same-named global one', async () => {
    // Strapi resolves an unqualified policy within the owning api before falling
    // back to global. This precedence (api::<owner>.<name> before global::<name>)
    // is encoded only in resolveScoped's candidate order — pin it so a reorder
    // can't silently send go-to-def to the wrong file.
    const root = 'c:/prec';
    const files: Record<string, string> = {
      [`${root}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${root}/src/api/product/content-types/product/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"product"},"attributes":{}}',
      [`${root}/src/policies/is-owner.ts`]: 'export default () => true;\n', // global
      [`${root}/src/api/product/policies/is-owner.ts`]: 'export default () => true;\n', // api-local (shadows)
      [`${root}/src/api/product/routes/product.ts`]:
        `export default { routes: [{ method: 'GET', path: '/p', handler: 'api::product.product.find', config: { policies: ['is-owner'] } }] };`,
    };
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);
    const path = `${root}/src/api/product/routes/product.ts`;
    const src = files[path]!;
    const targets = await engine.getDefinitions(path, src.indexOf("'is-owner'") + 2, src);
    expect(targets[0]?.filePath).toBe(`${root}/src/api/product/policies/is-owner.ts`);
  });
});

describe('go-to-definition (plugin chains)', () => {
  it('resolves strapi.plugin(a).service(b) to the local plugin service', async () => {
    const root = 'c:/proj';
    const files: Record<string, string> = {
      [`${root}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${root}/src/plugins/reviews/server/services/review.ts`]: 'export default {};',
    };
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);

    const code = `strapi.plugin('reviews').service('review')`;
    const offset = code.indexOf(`'review'`) + 2;
    const consumer = `${root}/src/api/x/controllers/x.ts`;
    const targets = await engine.getDefinitions(consumer, offset, code);
    expect(targets[0]?.filePath).toBe(`${root}/src/plugins/reviews/server/services/review.ts`);
  });
});

describe('go-to-definition: short-form route handler + nested plugin service', () => {
  it('resolves a short-form ("controller.action") handler in a plugin route to the controller action', async () => {
    const ROOT = 'c:/sf';
    const route = `${ROOT}/src/plugins/comms/server/routes/x.ts`;
    const controller = `${ROOT}/src/plugins/comms/server/controllers/conversation.ts`;
    const src = `export default { routes: [{ handler: 'conversation.thread' }] };`;
    const engine = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [controller]: 'export default { thread() { return 1; } };\n',
        [route]: src,
      }),
    );
    await engine.init([ROOT]);
    const targets = await engine.getDefinitions(route, src.indexOf('conversation.thread') + 2, src);
    expect(targets[0]?.filePath).toBe(controller);
  });

  it('resolves a full-UID reference to a nested (dotted-name) plugin service', async () => {
    const ROOT = 'c:/nsv';
    const svc = `${ROOT}/src/plugins/comms/server/services/error/catch.js`;
    const engine = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [svc]: 'export default { run() { return 1; } };\n',
      }),
    );
    await engine.init([ROOT]);
    const code = `strapi.service('plugin::comms.error.catch').run();`;
    const targets = await engine.getDefinitions(`${ROOT}/src/x.ts`, code.indexOf('error.catch') + 2, code);
    expect(targets[0]?.filePath).toBe(svc);
  });
});

describe('go-to-definition: schema-only content-type auto-CRUD handler', () => {
  it('resolves a core route handler on a schema-only content-type to its schema (editor↔MCP consistency)', async () => {
    const ROOT = 'c:/scr';
    const route = `${ROOT}/src/api/widget/routes/widget.ts`;
    const schema = `${ROOT}/src/api/widget/content-types/widget/schema.json`;
    const src = `export default { routes: [{ handler: 'api::widget.widget.find' }] };`;
    const engine = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [schema]: '{"kind":"collectionType","info":{"singularName":"widget"},"attributes":{}}',
        [route]: src,
      }),
    );
    await engine.init([ROOT]);
    const targets = await engine.getDefinitions(route, src.indexOf('api::widget.widget.find') + 2, src);
    expect(targets[0]?.filePath).toBe(schema);
  });
});
