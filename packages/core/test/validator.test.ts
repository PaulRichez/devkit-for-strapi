import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('diagnostics (v5-shop)', () => {
  let engine: StrapiEngine;
  let root: string;
  const file = (rel: string): string => `${root}/src/api/product/${rel}`;

  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('reports nothing for a valid file', async () => {
    const code = `await strapi.documents('api::product.product').findMany({});`;
    expect(await engine.validateFile(file('controllers/x.ts'), code)).toEqual([]);
  });

  it('flags an unknown content-type and suggests the closest one', async () => {
    const code = `strapi.documents('api::product.prodcut').findMany({});`;
    const [d] = await engine.validateFile(file('controllers/x.ts'), code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-content-type');
    expect(d?.severity).toBe('error');
    expect(d?.quickFixes?.[0]?.replacement).toBe('api::product.product');
  });

  it('flags an unknown service', async () => {
    const code = `strapi.service('api::product.produc');`;
    const [d] = await engine.validateFile(file('controllers/x.ts'), code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-service');
    expect(d?.quickFixes?.[0]?.replacement).toBe('api::product.product');
  });

  it('warns about a v4 entityService pattern in a v5 project', async () => {
    const code = `strapi.entityService.findMany('api::product.product', {});`;
    const [d] = await engine.validateFile(file('controllers/x.ts'), code);
    expect(d?.code).toBe('devkit-for-strapi.v4-in-v5');
    expect(d?.severity).toBe('warning');
  });

  it('flags a malformed handler and an unknown action', async () => {
    const malformed = `export default { routes: [{ handler: 'api::product.product' }] };`;
    expect((await engine.validateFile(file('routes/x.ts'), malformed))[0]?.code).toBe(
      'devkit-for-strapi.malformed-ref',
    );

    const unknownAction = `export default { routes: [{ handler: 'api::product.product.feature' }] };`;
    const [d] = await engine.validateFile(file('routes/x.ts'), unknownAction);
    expect(d?.code).toBe('devkit-for-strapi.unknown-action');
    expect(d?.quickFixes?.[0]?.replacement).toBe('api::product.product.featured');
  });

  it('accepts a non-overridden core action', async () => {
    const code = `export default { routes: [{ handler: 'api::product.product.update' }] };`;
    expect(await engine.validateFile(file('routes/x.ts'), code)).toEqual([]);
  });

  it('does not flag references to external (installed) plugins', async () => {
    const code = `strapi.service('plugin::users-permissions.user');`;
    expect(await engine.validateFile(file('controllers/x.ts'), code)).toEqual([]);
  });

  it('flags an unknown bare policy but accepts a known global one', async () => {
    const unknown = `export default { config: { find: { policies: ['nope'] } } };`;
    expect((await engine.validateFile(file('routes/x.ts'), unknown))[0]?.code).toBe(
      'devkit-for-strapi.unknown-policy',
    );
    const known = `export default { config: { find: { policies: ['global::is-authenticated'] } } };`;
    expect(await engine.validateFile(file('routes/x.ts'), known)).toEqual([]);
  });

  it('flags an unknown component reference inside a schema', async () => {
    const json = `{ "attributes": { "seo": { "type": "component", "component": "shared.so" } } }`;
    const [d] = await engine.validateFile(file('content-types/x/schema.json'), json);
    expect(d?.code).toBe('devkit-for-strapi.unknown-component');
    expect(d?.quickFixes?.[0]?.replacement).toBe('shared.seo');
  });
});

describe('diagnostics (v4-blog)', () => {
  let engine: StrapiEngine;
  let root: string;

  beforeAll(async () => {
    const fx = loadFixture('v4-blog');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('does not warn about entityService in a v4 project', async () => {
    const code = `strapi.entityService.findMany('api::article.article', {});`;
    expect(await engine.validateFile(`${root}/src/api/article/controllers/x.js`, code)).toEqual([]);
  });

  it('accepts an api-scoped bare policy resolved within its owning api', async () => {
    const code = `module.exports = { config: { find: { policies: ['is-published'] } } };`;
    expect(await engine.validateFile(`${root}/src/api/article/routes/x.js`, code)).toEqual([]);
  });
});

describe('diagnostics: auto-CRUD on schema-only content-types + spread actions', () => {
  const ROOT = 'c:/dd';
  // `widget` is SCHEMA-ONLY (no controller file → Strapi auto-generates the controller).
  // `gadget` has a controller whose actions are merged via spread (`...shared`).
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${ROOT}/src/api/widget/content-types/widget/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"widget"},"attributes":{}}',
    [`${ROOT}/src/api/gadget/content-types/gadget/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"gadget"},"attributes":{}}',
    [`${ROOT}/src/api/gadget/controllers/gadget.ts`]:
      "export default factories.createCoreController('api::gadget.gadget', () => ({ ...shared, async ping() {} }));",
    // `homepage` is a schema-only SINGLE type (auto-CRUD serves find/update/delete only).
    [`${ROOT}/src/api/homepage/content-types/homepage/schema.json`]:
      '{"kind":"singleType","info":{"singularName":"homepage"},"attributes":{}}',
    // a local PLUGIN content-type with no controller (Strapi doesn't auto-CRUD plugin CTs).
    [`${ROOT}/src/plugins/shop/server/content-types/thing/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"thing"},"attributes":{}}',
  };
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
  });

  it('accepts a core auto-CRUD handler on a schema-only content-type (no false "Unknown controller")', async () => {
    const code = `export default { routes: [{ handler: 'api::widget.widget.find' }] };`;
    expect(await engine.validateFile(`${ROOT}/src/api/widget/routes/widget.ts`, code)).toEqual([]);
  });

  it('still flags a non-core action on a schema-only content-type (it genuinely does not exist)', async () => {
    const code = `export default { routes: [{ handler: 'api::widget.widget.customExport' }] };`;
    const [d] = await engine.validateFile(`${ROOT}/src/api/widget/routes/widget.ts`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-action');
  });

  it('suppresses "Unknown action" when the controller factory spreads (...shared)', async () => {
    const code = `export default { routes: [{ handler: 'api::gadget.gadget.exportCsv' }] };`;
    expect(await engine.validateFile(`${ROOT}/src/api/gadget/routes/gadget.ts`, code)).toEqual([]);
  });

  it('still validates a known explicit action on a spread controller', async () => {
    const code = `export default { routes: [{ handler: 'api::gadget.gadget.ping' }] };`;
    expect(await engine.validateFile(`${ROOT}/src/api/gadget/routes/gadget.ts`, code)).toEqual([]);
  });

  it('on a schema-only singleType, accepts find/update/delete but flags findOne/create (kind-aware)', async () => {
    const rf = `${ROOT}/src/api/homepage/routes/homepage.ts`;
    for (const action of ['find', 'update', 'delete']) {
      const code = `export default { routes: [{ handler: 'api::homepage.homepage.${action}' }] };`;
      expect(await engine.validateFile(rf, code)).toEqual([]);
    }
    for (const action of ['findOne', 'create']) {
      const code = `export default { routes: [{ handler: 'api::homepage.homepage.${action}' }] };`;
      expect((await engine.validateFile(rf, code))[0]?.code).toBe('devkit-for-strapi.unknown-action');
    }
  });

  it('does not assert validity for a local-plugin schema-only content-type handler (no-op, no false positive)', async () => {
    // Strapi doesn't auto-CRUD plugin CTs; registration can't be verified statically → no diagnostic.
    const code = `export default { routes: [{ handler: 'plugin::shop.thing.find' }] };`;
    expect(await engine.validateFile(`${ROOT}/src/plugins/shop/server/routes/thing.ts`, code)).toEqual([]);
  });
});

describe('diagnostics: nested (dotted-name) plugin artifacts + short-form route handlers', () => {
  const ROOT = 'c:/nd';
  let engine: StrapiEngine;

  beforeAll(async () => {
    engine = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        // A nested service (dotted name `error.catch`) — the reported false positive.
        [`${ROOT}/src/plugins/comms/server/services/error/catch.js`]: 'export default { run() { return 1; } };\n',
        [`${ROOT}/src/plugins/comms/server/policies/is-owner.ts`]: 'export default () => true;\n',
        [`${ROOT}/src/plugins/comms/server/controllers/conversation.ts`]:
          'export default { thread() { return 1; } };\n',
      }),
    );
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('does not flag a full-UID reference to a nested (dotted-name) service as malformed', async () => {
    const code = `strapi.service('plugin::comms.error.catch').run();`;
    expect(await engine.validateFile(`${ROOT}/src/plugins/comms/server/controllers/x.ts`, code)).toEqual([]);
  });

  it('still flags a genuinely unknown nested service (not silently accepted)', async () => {
    const code = `strapi.service('plugin::comms.error.missing').run();`;
    const [d] = await engine.validateFile(`${ROOT}/src/plugins/comms/server/controllers/x.ts`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-service');
  });

  it('accepts a bare policy name in a plugin route (owning plugin, not just owning api)', async () => {
    const code = `export default { routes: [{ handler: 'conversation.thread', config: { policies: ['is-owner'] } }] };`;
    expect(await engine.validateFile(`${ROOT}/src/plugins/comms/server/routes/x.ts`, code)).toEqual([]);
  });

  it('accepts Strapi\'s documented short-form route handler ("controller.action") in a plugin route', async () => {
    const code = `export default { routes: [{ handler: 'conversation.thread' }] };`;
    expect(await engine.validateFile(`${ROOT}/src/plugins/comms/server/routes/x.ts`, code)).toEqual([]);
  });

  it('still flags a short-form handler naming an unknown action', async () => {
    const code = `export default { routes: [{ handler: 'conversation.missing' }] };`;
    const [d] = await engine.validateFile(`${ROOT}/src/plugins/comms/server/routes/x.ts`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-action');
  });
});
