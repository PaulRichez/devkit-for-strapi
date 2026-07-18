import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { buildIndex, updateIndexForFile } from '../src/index/indexer';
import type { StrapiIndex } from '../src/model/types';

describe('indexer (v5-shop)', () => {
  it('indexes content-types, components, services, controllers, policies, middlewares', async () => {
    const { root, files } = loadFixture('v5-shop');
    const index = await buildIndex(new MemoryFileSystem(files), `${root}/src`);

    expect([...index.contentTypes.keys()].sort()).toEqual([
      'api::category.category',
      'api::product.product',
    ]);

    const product = index.contentTypes.get('api::product.product')!;
    expect(product.kind).toBe('collectionType');
    expect(product.info.singularName).toBe('product');
    expect(product.attributes.category!.target).toBe('api::category.category');
    expect(product.attributes.seo!.component).toBe('shared.seo');
    expect(product.schemaPath).toBe(`${root}/src/api/product/content-types/product/schema.json`);

    expect([...index.components.keys()]).toEqual(['shared.seo']);
    expect(index.services.has('api::product.product')).toBe(true);

    const controller = index.controllers.get('api::product.product')!;
    expect(controller.actions?.map((a) => a.name).sort()).toEqual(['featured', 'find']);

    expect(index.policies.has('global::is-authenticated')).toBe(true);
    expect(index.middlewares.has('global::logger')).toBe(true);
  });
});

describe('indexer (v4-blog)', () => {
  it('indexes v4 structure including api-scoped policy', async () => {
    const { root, files } = loadFixture('v4-blog');
    const index = await buildIndex(new MemoryFileSystem(files), `${root}/src`);

    expect(index.contentTypes.has('api::article.article')).toBe(true);
    expect(index.contentTypes.has('api::category.category')).toBe(true);

    const controller = index.controllers.get('api::article.article')!;
    expect(controller.actions?.map((a) => a.name).sort()).toEqual(['byCategory', 'find']);

    expect(index.policies.has('global::is-owner')).toBe(true);
    expect(index.policies.has('api::article.is-published')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Incremental definition index — updateIndexForFile
// ---------------------------------------------------------------------------

const R = 'c:/inc';
const BASE_FILES: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
  [`${R}/src/api/blog/content-types/blog/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"blog","pluralName":"blogs"},"attributes":{"title":{"type":"string"}}}',
  [`${R}/src/api/blog/services/blog.js`]:
    "const { createCoreService } = require('@strapi/strapi').factories;\nmodule.exports = createCoreService('api::blog.blog', () => ({ async notify(msg) { return msg; } }));\n",
  [`${R}/src/api/blog/controllers/blog.js`]:
    "const { createCoreController } = require('@strapi/strapi').factories;\nmodule.exports = createCoreController('api::blog.blog', () => ({ async find(ctx) { return ctx; } }));\n",
  [`${R}/src/api/blog/policies/is-published.js`]: "module.exports = () => true;\n",
  [`${R}/src/components/shared/seo.json`]:
    '{"collectionName":"components_shared_seo","info":{"displayName":"SEO"},"attributes":{"title":{"type":"string"}}}',
  [`${R}/src/policies/is-authenticated.js`]: "module.exports = () => true;\n",
};

/** Snapshot the index keys for parity comparison. */
function snapshot(index: StrapiIndex): Record<string, string[]> {
  return {
    contentTypes: [...index.contentTypes.keys()].sort(),
    components: [...index.components.keys()].sort(),
    services: [...index.services.keys()].sort(),
    controllers: [...index.controllers.keys()].sort(),
    policies: [...index.policies.keys()].sort(),
    middlewares: [...index.middlewares.keys()].sort(),
    pluginNames: [...index.pluginNames].sort(),
  };
}

describe('updateIndexForFile — incremental definition index', () => {
  it('parity: buildIndex then updateIndexForFile on each file → same index', async () => {
    const { root, files } = loadFixture('v5-shop');
    const full = await buildIndex(new MemoryFileSystem(files), `${root}/src`);
    const snapFull = snapshot(full);

    // Build incrementally: empty index, then updateIndexForFile for every file.
    const fs = new MemoryFileSystem(files);
    const inc: StrapiIndex = {
      contentTypes: new Map(),
      components: new Map(),
      services: new Map(),
      controllers: new Map(),
      policies: new Map(),
      middlewares: new Map(),
      pluginNames: new Set(),
      fileDefs: new Map(),
    };
    for (const filePath of Object.keys(files)) {
      if (filePath.includes('/src/')) {
        await updateIndexForFile(fs, { srcDir: `${root}/src`, index: inc }, filePath);
      }
    }
    expect(snapshot(inc)).toEqual(snapFull);
  });

  it('add: a new content-type schema appears in the index', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.contentTypes.has('api::blog.blog')).toBe(true);
    expect(index.contentTypes.has('api::news.news')).toBe(false);

    // Add a new content-type.
    const newsSchema = `${R}/src/api/news/content-types/news/schema.json`;
    const newsContent = '{"kind":"collectionType","info":{"singularName":"news","pluralName":"news"},"attributes":{"title":{"type":"string"}}}';
    fs.writeFile(newsSchema, newsContent);

    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, newsSchema);
    expect(index.contentTypes.has('api::news.news')).toBe(true);
    expect(index.contentTypes.get('api::news.news')!.kind).toBe('collectionType');
  });

  it('modify: a service with new methods updates the actions', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    const svc = index.services.get('api::blog.blog')!;
    expect(svc.actions?.map((a) => a.name)).toEqual(['notify']);

    // Modify the service to add a method.
    const svcPath = `${R}/src/api/blog/services/blog.js`;
    fs.writeFile(
      svcPath,
      "const { createCoreService } = require('@strapi/strapi').factories;\nmodule.exports = createCoreService('api::blog.blog', () => ({ async notify(msg) { return msg; }, async ping() { return 'pong'; } }));\n",
    );
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, svcPath);

    const updated = index.services.get('api::blog.blog')!;
    expect(updated.actions?.map((a) => a.name).sort()).toEqual(['notify', 'ping']);
  });

  it('delete: a removed controller is removed from the index + fileDefs', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    const ctrlPath = `${R}/src/api/blog/controllers/blog.js`;
    expect(index.controllers.has('api::blog.blog')).toBe(true);
    expect(index.fileDefs.has(ctrlPath)).toBe(true);

    // Delete the controller.
    fs.delete(ctrlPath);
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, ctrlPath);

    expect(index.controllers.has('api::blog.blog')).toBe(false);
    expect(index.fileDefs.has(ctrlPath)).toBe(false);
  });

  it('delete: a removed component is removed from the index', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    const compPath = `${R}/src/components/shared/seo.json`;
    expect(index.components.has('shared.seo')).toBe(true);

    fs.delete(compPath);
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, compPath);

    expect(index.components.has('shared.seo')).toBe(false);
    expect(index.fileDefs.has(compPath)).toBe(false);
  });

  it('non-definition file: a route file is a no-op (no entries added or removed)', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    const before = snapshot(index);

    // A route file — not a definition.
    const routePath = `${R}/src/api/blog/routes/blog.js`;
    fs.writeFile(routePath, "module.exports = { routes: [{ method: 'GET', path: '/', handler: 'blog.find' }] };\n");
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, routePath);

    expect(snapshot(index)).toEqual(before);
  });

  it('pluginNames: a file under a new plugin registers the plugin name', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.pluginNames.has('billing')).toBe(false);

    // Add a plugin service.
    const svcPath = `${R}/src/plugins/billing/server/services/invoice.js`;
    fs.writeFile(svcPath, "module.exports = { async create() { return 1; } };\n");
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, svcPath);

    expect(index.pluginNames.has('billing')).toBe(true);
    expect(index.services.has('plugin::billing.invoice')).toBe(true);
  });

  it('remove-then-readd: idempotent (same index as buildIndex)', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    const snapBefore = snapshot(index);

    // Remove + re-add every definition file.
    for (const filePath of Object.keys(BASE_FILES)) {
      if (!filePath.includes('/src/')) continue;
      const content = BASE_FILES[filePath]!;
      fs.delete(filePath);
      await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, filePath);
      fs.writeFile(filePath, content);
      await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, filePath);
    }
    expect(snapshot(index)).toEqual(snapBefore);
  });

  it('parity (v4-blog): buildIndex vs updateIndexForFile → same index', async () => {
    const { root, files } = loadFixture('v4-blog');
    const full = await buildIndex(new MemoryFileSystem(files), `${root}/src`);
    const snapFull = snapshot(full);

    const fs = new MemoryFileSystem(files);
    const inc: StrapiIndex = {
      contentTypes: new Map(),
      components: new Map(),
      services: new Map(),
      controllers: new Map(),
      policies: new Map(),
      middlewares: new Map(),
      pluginNames: new Set(),
      fileDefs: new Map(),
    };
    for (const filePath of Object.keys(files)) {
      if (filePath.includes('/src/')) {
        await updateIndexForFile(fs, { srcDir: `${root}/src`, index: inc }, filePath);
      }
    }
    expect(snapshot(inc)).toEqual(snapFull);
  });

  it('extension: src/extensions schema is indexed with extension: true', async () => {
    const extFiles: Record<string, string> = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${R}/src/extensions/users-permissions/content-types/user/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"user","pluralName":"users"},"attributes":{"username":{"type":"string"}}}',
    };
    const fs = new MemoryFileSystem(extFiles);
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.contentTypes.has('plugin::users-permissions.user')).toBe(true);
    expect(index.contentTypes.get('plugin::users-permissions.user')!.extension).toBe(true);

    // Modify the extension schema.
    const extPath = `${R}/src/extensions/users-permissions/content-types/user/schema.json`;
    fs.writeFile(extPath, '{"kind":"collectionType","info":{"singularName":"user","pluralName":"users"},"attributes":{"username":{"type":"string"},"email":{"type":"email"}}}');
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, extPath);
    expect(index.contentTypes.get('plugin::users-permissions.user')!.attributes.email).toBeDefined();
    expect(index.contentTypes.get('plugin::users-permissions.user')!.extension).toBe(true);
  });

  it('plugin content-type: src/plugins/<name>/server/content-types is indexed', async () => {
    const pluginFiles: Record<string, string> = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${R}/src/plugins/billing/server/content-types/invoice/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"invoice","pluralName":"invoices"},"attributes":{"total":{"type":"decimal"}}}',
    };
    const fs = new MemoryFileSystem(pluginFiles);
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.contentTypes.has('plugin::billing.invoice')).toBe(true);
    expect(index.pluginNames.has('billing')).toBe(true);

    // Delete the plugin CT.
    const ctPath = `${R}/src/plugins/billing/server/content-types/invoice/schema.json`;
    fs.delete(ctPath);
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, ctPath);
    expect(index.contentTypes.has('plugin::billing.invoice')).toBe(false);
  });

  it('global policy: src/policies/<file> is indexed as global::', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.policies.has('global::is-authenticated')).toBe(true);

    // Delete the global policy.
    const polPath = `${R}/src/policies/is-authenticated.js`;
    fs.delete(polPath);
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, polPath);
    expect(index.policies.has('global::is-authenticated')).toBe(false);
    expect(index.fileDefs.has(polPath)).toBe(false);
  });

  it('nested artifact: services/error/catch.js → service error.catch', async () => {
    const nestedFiles: Record<string, string> = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${R}/src/api/blog/content-types/blog/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
      [`${R}/src/api/blog/services/error/catch.js`]: 'module.exports = { async run() { return 1; } };\n',
    };
    const fs = new MemoryFileSystem(nestedFiles);
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.services.has('api::blog.error.catch')).toBe(true);

    // Modify the nested service.
    const svcPath = `${R}/src/api/blog/services/error/catch.js`;
    fs.writeFile(svcPath, 'module.exports = { async run() { return 1; }, async stop() { return 0; } };\n');
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, svcPath);
    const updated = index.services.get('api::blog.error.catch')!;
    expect(updated.actions?.map((a) => a.name).sort()).toEqual(['run', 'stop']);
  });

  it('malformed schema: a corrupted schema.json is skipped (old entry removed, no crash)', async () => {
    const fs = new MemoryFileSystem({ ...BASE_FILES });
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.contentTypes.has('api::blog.blog')).toBe(true);

    // Corrupt the schema.
    const schemaPath = `${R}/src/api/blog/content-types/blog/schema.json`;
    fs.writeFile(schemaPath, '{ broken json');
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, schemaPath);
    // The old CT is removed, the malformed one is not added → the CT is gone.
    expect(index.contentTypes.has('api::blog.blog')).toBe(false);
  });

  it('delete plugin service: removed from services + fileDefs', async () => {
    const pluginFiles: Record<string, string> = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${R}/src/plugins/billing/server/services/invoice.js`]: 'module.exports = { async create() { return 1; } };\n',
    };
    const fs = new MemoryFileSystem(pluginFiles);
    const index = await buildIndex(fs, `${R}/src`);
    expect(index.services.has('plugin::billing.invoice')).toBe(true);

    const svcPath = `${R}/src/plugins/billing/server/services/invoice.js`;
    fs.delete(svcPath);
    await updateIndexForFile(fs, { srcDir: `${R}/src`, index }, svcPath);
    expect(index.services.has('plugin::billing.invoice')).toBe(false);
    expect(index.fileDefs.has(svcPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Incremental-index audit regressions (parity with buildIndex on tricky layouts)
// ---------------------------------------------------------------------------

describe('updateIndexForFile — audit regressions (no divergence from buildIndex)', () => {
  const SRC = `${R}/src`;
  /** Build A = fresh buildIndex; B = incremental over every /src/ file; assert key-parity. */
  const parity = async (files: Record<string, string>) => {
    const A = snapshot(await buildIndex(new MemoryFileSystem(files), SRC));
    const fs = new MemoryFileSystem(files);
    const index = (await buildIndex(new MemoryFileSystem({}), SRC)); // empty base
    for (const f of Object.keys(files)) {
      if (f.includes('/src/')) await updateIndexForFile(fs, { srcDir: SRC, index }, f);
    }
    return { A, B: snapshot(index), index };
  };

  it('A: a subfolder named like the kind dir keeps its dotted ref (no lastIndexOf overlap)', async () => {
    const bar = `${SRC}/api/foo/services/services/bar.js`;
    const files = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${SRC}/api/foo/content-types/foo/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"foo"},"attributes":{}}',
      [bar]: 'module.exports = { run() { return 1; } };\n',
    };
    // Modify path: buildIndex, then re-index the file incrementally.
    const fs = new MemoryFileSystem(files);
    const index = await buildIndex(fs, SRC);
    expect(index.services.has('api::foo.services.bar')).toBe(true);
    fs.writeFile(bar, 'module.exports = { run() { return 2; } };\n');
    await updateIndexForFile(fs, { srcDir: SRC, index }, bar);
    expect(index.services.has('api::foo.services.bar')).toBe(true); // real ref preserved
    expect(index.services.has('api::foo.bar')).toBe(false); // no phantom
  });

  it('B: a stray top-level plugin dir is ignored when server/ exists (precedence)', async () => {
    const stray = `${SRC}/plugins/billing/services/legacy.js`;
    const files = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${SRC}/plugins/billing/server/services/invoice.js`]: 'module.exports = { create() {} };\n',
      [stray]: 'module.exports = { legacy() {} };\n',
    };
    const { A, B, index } = await parity(files);
    expect(B).toEqual(A); // buildIndex ignores the shadowed dir → so must the incremental path
    expect(index.services.has('plugin::billing.legacy')).toBe(false); // no phantom
    expect(index.services.has('plugin::billing.invoice')).toBe(true);
  });

  it('C: a non-code file under services/ is not indexed (.d.ts / .md gate)', async () => {
    const files = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${SRC}/api/foo/content-types/foo/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"foo"},"attributes":{}}',
      [`${SRC}/api/foo/services/foo.js`]: 'module.exports = { run() {} };\n',
      [`${SRC}/api/foo/services/foo.d.ts`]: 'export declare const x: number;\n',
      [`${SRC}/api/foo/services/README.md`]: '# notes\n',
    };
    const { A, B } = await parity(files);
    expect(B).toEqual(A);
    expect(B.services).toEqual(['api::foo.foo']); // no api::foo.foo.d, no README phantom
  });

  it('D: deleting one of two files sharing a ref keeps the surviving definition', async () => {
    // `blog.js` and `blog.ts` both resolve to `api::x.blog` (a JS→TS migration mid-flight).
    const js = `${SRC}/api/x/services/blog.js`;
    const ts = `${SRC}/api/x/services/blog.ts`;
    const files = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${SRC}/api/x/content-types/x/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"x"},"attributes":{}}',
      [js]: 'module.exports = { run() {} };\n',
      [ts]: 'export default { run() {} };\n',
    };
    const fs = new MemoryFileSystem(files);
    const index = await buildIndex(fs, SRC);
    expect(index.services.has('api::x.blog')).toBe(true);
    // Delete the file that does NOT own the current map entry — the ref must survive.
    const owner = index.services.get('api::x.blog')!.filePath;
    const victim = owner === js ? ts : js;
    fs.delete(victim);
    await updateIndexForFile(fs, { srcDir: SRC, index }, victim);
    expect(index.services.has('api::x.blog')).toBe(true); // still owned by the surviving file
    expect(index.services.get('api::x.blog')!.filePath).toBe(owner);
  });

  it('E: pluginNames drops a plugin whose directory no longer exists (delete direction)', async () => {
    const svc = `${SRC}/plugins/foo/server/services/bar.js`;
    // Build the index while the plugin exists…
    const fsBefore = new MemoryFileSystem({
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [svc]: 'module.exports = { bar() {} };\n',
    });
    const index = await buildIndex(fsBefore, SRC);
    expect(index.pluginNames.has('foo')).toBe(true);

    // …then the plugin dir is gone on disk (fs no longer has plugins/foo at all).
    const fsAfter = new MemoryFileSystem({ [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}' });
    await updateIndexForFile(fsAfter, { srcDir: SRC, index }, svc);
    // Matches a fresh buildIndex of the now-empty tree: 'foo' dropped → no stale
    // "local" classification that would wrongly validate/flag plugin::foo.* refs.
    expect(index.pluginNames.has('foo')).toBe(false);
    expect(snapshot(index).pluginNames).toEqual(snapshot(await buildIndex(fsAfter, SRC)).pluginNames);
  });
});
