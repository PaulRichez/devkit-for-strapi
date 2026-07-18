import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('hover (v5-shop)', () => {
  let engine: StrapiEngine;
  let root: string;
  const ctrl = (): string => `${root}/src/api/product/controllers/x.ts`;
  const hoverAt = (code: string, needle: string): Promise<{ markdown: string } | undefined> =>
    engine.getHover(ctrl(), code.indexOf(needle) + 2, code);

  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('describes a content-type with attribute count', async () => {
    const info = await hoverAt(`strapi.documents('api::product.product')`, 'product.product');
    expect(info?.markdown).toContain('Content type');
    expect(info?.markdown).toContain('api::product.product');
    expect(info?.markdown).toMatch(/attribute/);
  });

  it('describes a service and its file', async () => {
    const info = await hoverAt(`strapi.service('api::product.product')`, 'product.product');
    expect(info?.markdown).toContain('Service');
    expect(info?.markdown).toContain('services/product.ts');
  });

  it('marks an unknown reference', async () => {
    const info = await hoverAt(`strapi.service('api::nope.nope')`, 'nope.nope');
    expect(info?.markdown).toContain('Unknown');
  });

  it('warns about entityService usage in a v5 project', async () => {
    const info = await hoverAt(`strapi.entityService.findMany('api::product.product', {})`, 'product.product');
    expect(info?.markdown).toContain('v5');
  });

  it('returns nothing when not on a magic string', async () => {
    const code = `const x = 1;`;
    expect(await engine.getHover(ctrl(), 6, code)).toBeUndefined();
  });
});

describe('hover usage breakdown (insights)', () => {
  const ROOT = 'c:/p';
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${ROOT}/src/api/blog/content-types/article/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"article","displayName":"Article"},"attributes":{"seo":{"type":"component","component":"shared.seo"}}}',
    [`${ROOT}/src/api/blog/content-types/comment/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"comment"},"attributes":{"article":{"type":"relation","target":"api::blog.article"}}}',
    [`${ROOT}/src/components/shared/seo.json`]: '{"collectionName":"c","info":{"displayName":"Seo"},"attributes":{}}',
    [`${ROOT}/src/x.ts`]: `strapi.documents('api::blog.article').findMany({});`,
  };
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('adds the usage breakdown to a content-type hover', async () => {
    const x = `${ROOT}/src/x.ts`;
    const code = files[x]!;
    const info = await engine.getHover(x, code.indexOf('api::blog.article') + 2, code);
    expect(info?.markdown).toContain('Used:');
    expect(info?.markdown).toContain('incoming relation'); // comment → article
  });

  it('adds the usage count to a component hover (in schema.json)', async () => {
    const schema = `${ROOT}/src/api/blog/content-types/article/schema.json`;
    const code = files[schema]!;
    const info = await engine.getHover(schema, code.indexOf('shared.seo') + 2, code);
    expect(info?.markdown).toContain('Used in 1 content type');
  });
});

describe('hover: schema-only content-type auto-CRUD handler', () => {
  it('describes a core route handler on a schema-only content-type (not "Unknown")', async () => {
    const ROOT = 'c:/hh';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${ROOT}/src/api/widget/content-types/widget/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"widget"},"attributes":{}}',
      }),
    );
    await engine.init([ROOT]);
    const code = `export default { routes: [{ handler: 'api::widget.widget.find' }] };`;
    const info = await engine.getHover(`${ROOT}/src/api/widget/routes/widget.ts`, code.indexOf('api::widget.widget.find') + 2, code);
    expect(info?.markdown).toContain('Controller action');
    expect(info?.markdown).not.toContain('Unknown');
  });
});
