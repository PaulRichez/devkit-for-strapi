import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { listRoutes } from '../src/index/routes';
import { relationUsagesOf } from '../src/query/refQuery';

// Regression pins for the coverage-audit backlog (all probed correct — these lock
// the behaviour so a future refactor can't silently break these untested paths).

describe('hover: policy / middleware / plugin-name branches', () => {
  const R = 'c:/hov';
  const route = `${R}/src/api/blog/routes/blog.ts`;
  const files: Record<string, string> = {
    [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${R}/src/api/blog/content-types/blog/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
    [`${R}/src/policies/is-auth.ts`]: 'export default () => true;\n',
    [`${R}/src/middlewares/audit.ts`]: 'export default () => async () => {};\n',
    [`${R}/src/plugins/shop/server/services/cart.ts`]: 'export default { checkout() {} };\n',
    [route]:
      `export default { routes: [{ handler: 'api::blog.blog.find', config: { policies: ['global::is-auth'], middlewares: ['global::audit'] } }] };`,
  };
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
  });
  const hover = (code: string, needle: string) => engine.getHover(route, code.indexOf(needle) + 2, code);

  it('describes a known policy and middleware', async () => {
    const code = files[route]!;
    expect((await hover(code, 'global::is-auth'))?.markdown).toContain('Policy');
    expect((await hover(code, 'global::audit'))?.markdown).toContain('Middleware');
  });

  it('marks an unknown policy', async () => {
    const code = `export default { routes: [{ handler: 'api::blog.blog.find', config: { policies: ['global::ghost'] } }] };`;
    expect((await hover(code, 'global::ghost'))?.markdown).toContain('Unknown');
  });

  it('distinguishes a local plugin from an unrecognized one', async () => {
    const local = `strapi.plugin('shop')`;
    expect((await engine.getHover(`${R}/src/x.ts`, local.indexOf('shop') + 1, local))?.markdown).toContain('Local plugin');
    const ext = `strapi.plugin('users-permissions')`;
    expect((await engine.getHover(`${R}/src/x.ts`, ext.indexOf('users-permissions') + 1, ext))?.markdown).toContain('Plugin');
  });
});

describe('member completion: controller and plugin-service targets', () => {
  const R = 'c:/mc';
  const files: Record<string, string> = {
    [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${R}/src/api/page/content-types/page/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"page"},"attributes":{}}',
    [`${R}/src/api/page/controllers/page.ts`]:
      `export default { async ping(ctx: any) {}, async pong(ctx: any) {} };`,
    [`${R}/src/plugins/shop/server/services/cart.ts`]: 'export default { checkout() {}, addItem() {} };\n',
  };
  let engine: StrapiEngine;
  const F = `${R}/src/x.ts`;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
  });
  const after = async (code: string) => (await engine.getCompletions(F, code.length, code)).items.map((i) => i.label);

  it('suggests a controller method after strapi.controller(x).', async () => {
    const got = await after(`strapi.controller('api::page.page').`);
    expect(got).toContain('ping');
    expect(got).toContain('pong');
  });

  it('suggests a plugin-service method after strapi.plugin(a).service(b).', async () => {
    const got = await after(`strapi.plugin('shop').service('cart').`);
    expect(got).toContain('checkout');
    expect(got).toContain('addItem');
  });
});

describe('completion: plugin-name argument (strapi.plugin("|"))', () => {
  const R = 'c:/pn';
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${R}/src/plugins/shop/server/services/cart.ts`]: 'export default {};\n',
      }),
    );
    await engine.init([R]);
  });

  it('suggests local plugin names inside strapi.plugin()', async () => {
    const code = `strapi.plugin('')`;
    const items = (await engine.getCompletions(`${R}/src/x.ts`, code.indexOf(`('`) + 2, code)).items.map((i) => i.label);
    expect(items).toContain('shop');
  });
});

describe('go-to-definition: route handler for a non-overridden core action', () => {
  it('navigates to the controller file (no offset) when the action is a default CRUD, not an override', async () => {
    const R = 'c:/cf';
    const ctrl = `${R}/src/api/widget/controllers/widget.ts`;
    const route = `${R}/src/api/widget/routes/widget.ts`;
    const code = `export default { routes: [{ handler: 'api::widget.widget.find' }] };`;
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${R}/src/api/widget/content-types/widget/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"widget"},"attributes":{}}',
        // Controller file exists but only overrides `featured` — `find` is the inherited core action.
        [ctrl]: `import { factories } from '@strapi/strapi';\nexport default factories.createCoreController('api::widget.widget', () => ({ async featured(ctx: any) {} }));`,
        [route]: code,
      }),
    );
    await engine.init([R]);
    const targets = await engine.getDefinitions(route, code.indexOf('api::widget.widget.find') + 2, code);
    expect(targets[0]?.filePath).toBe(ctrl);
    expect(targets[0]?.offset).toBeUndefined(); // lands in the file, not on a specific method
  });
});

describe('index: a component carries its own relation/component attributes', () => {
  it('parses target / component / components on a component definition', async () => {
    const R = 'c:/comp';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${R}/src/api/blog/content-types/author/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"author"},"attributes":{}}',
        [`${R}/src/components/box/panel.json`]:
          '{"collectionName":"c","info":{"displayName":"Panel"},"attributes":{' +
          '"owner":{"type":"relation","relation":"oneToOne","target":"api::blog.author"},' +
          '"seo":{"type":"component","component":"box.inner"},' +
          '"blocks":{"type":"dynamiczone","components":["box.inner","box.other"]}}}',
        [`${R}/src/components/box/inner.json`]: '{"collectionName":"i","info":{"displayName":"Inner"},"attributes":{}}',
      }),
    );
    await engine.init([R]);
    const comp = engine.allProjects()[0]!.index.components.get('box.panel')!;
    expect(comp.attributes.owner?.target).toBe('api::blog.author');
    expect(comp.attributes.seo?.component).toBe('box.inner');
    expect(comp.attributes.blocks?.components).toEqual(['box.inner', 'box.other']);
  });
});

describe('index: a malformed schema.json is silently skipped (no crash, siblings still indexed)', () => {
  it('does not throw and indexes the valid sibling content-type', async () => {
    const R = 'c:/bad';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        // Corrupt (half-written) JSON — must be skipped, not crash the index build.
        [`${R}/src/api/broken/content-types/broken/schema.json`]: '{ "kind": "collectionType", "attributes": { ',
        [`${R}/src/api/ok/content-types/ok/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"ok"},"attributes":{}}',
      }),
    );
    await engine.init([R]);
    const idx = engine.allProjects()[0]!.index;
    expect(idx.contentTypes.has('api::ok.ok')).toBe(true);
    expect(idx.contentTypes.has('api::broken.broken')).toBe(false);
  });
});

describe('relation-field usage: bare-string populate form', () => {
  it("records populate: 'author' (single relation as a bare string)", async () => {
    const R = 'c:/pop';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${R}/src/api/blog/content-types/article/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{"author":{"type":"relation","target":"api::blog.author"}}}',
        [`${R}/src/api/blog/content-types/author/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"author"},"attributes":{}}',
        [`${R}/src/use.ts`]: "strapi.documents('api::blog.article').findMany({ populate: 'author' });",
      }),
    );
    await engine.init([R]);
    await engine.whenReferencesReady();
    const usages = relationUsagesOf(engine.allProjects()[0]!, 'api::blog.article', 'author');
    expect(usages[0]!.locations.length).toBe(1);
  });
});

describe('routes: createCoreRouter only + prefix options', () => {
  it('restricts to the `only` actions and applies `prefix` to the path', async () => {
    const R = 'c:/rt';
    const fs = new MemoryFileSystem({
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${R}/src/api/widget/content-types/widget/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"widget","pluralName":"widgets"},"attributes":{}}',
      [`${R}/src/api/widget/routes/widget.ts`]:
        "import { factories } from '@strapi/strapi';\nexport default factories.createCoreRouter('api::widget.widget', { only: ['find'], prefix: '/v1' });",
    });
    const engine = createEngine(fs);
    await engine.init([R]);
    const routes = await listRoutes(fs, engine.allProjects()[0]!);
    const actions = routes.map((r) => r.handler.split('.').pop());
    expect(actions).toContain('find');
    expect(actions).not.toContain('create'); // excluded by `only`
    expect(routes.every((r) => r.path.startsWith('/v1'))).toBe(true);
  });
});

describe('validator: external plugin sub-accessor is a silent no-op', () => {
  it('does not flag strapi.plugin(external).service(x) (unverifiable)', async () => {
    const R = 'c:/ext-noop';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${R}/src/api/blog/content-types/blog/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
      }),
    );
    await engine.init([R]);
    const code = `strapi.plugin('users-permissions').service('user').fetchAuthenticatedUser();`;
    expect(await engine.validateFile(`${R}/src/x.ts`, code)).toEqual([]);
  });
});
