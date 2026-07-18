import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('strapi.contentType / strapi.getModel', () => {
  let engine: StrapiEngine;
  let root: string;
  const consumer = (): string => `${root}/src/api/product/controllers/x.ts`;

  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('resolves contentType() to schema.json', async () => {
    const code = `strapi.contentType('api::product.product')`;
    const targets = await engine.getDefinitions(consumer(), code.indexOf('product.product'), code);
    expect(targets[0]?.filePath).toBe(`${root}/src/api/product/content-types/product/schema.json`);
  });

  it('resolves getModel() to schema.json', async () => {
    const code = `strapi.getModel('api::product.product')`;
    const targets = await engine.getDefinitions(consumer(), code.indexOf('product.product'), code);
    expect(targets[0]?.filePath).toBe(`${root}/src/api/product/content-types/product/schema.json`);
  });

  it('does not warn about contentType() in a v5 project (it is not entityService)', async () => {
    const code = `strapi.contentType('api::product.product')`;
    expect(await engine.validateFile(consumer(), code)).toEqual([]);
  });
});

describe('plugin sub-accessor: strapi.plugin(a).controller(b)', () => {
  const root = 'c:/proj';
  const consumer = `${root}/src/api/x/controllers/x.ts`;
  let engine: StrapiEngine;

  beforeAll(async () => {
    const files: Record<string, string> = {
      [`${root}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${root}/src/plugins/reviews/server/controllers/review.ts`]: 'export default { async list(ctx){} };',
    };
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);
  });

  it('resolves the plugin controller to its file', async () => {
    const code = `strapi.plugin('reviews').controller('review')`;
    const offset = code.indexOf(`'review'`) + 2;
    const targets = await engine.getDefinitions(consumer, offset, code);
    expect(targets[0]?.filePath).toBe(`${root}/src/plugins/reviews/server/controllers/review.ts`);
  });

  it('does not raise a false positive on a valid plugin controller', async () => {
    const code = `strapi.plugin('reviews').controller('review')`;
    expect(await engine.validateFile(consumer, code)).toEqual([]);
  });

  it('flags an unknown method on a local plugin controller', async () => {
    const code = `strapi.plugin('reviews').controller('nope')`;
    const [d] = await engine.validateFile(consumer, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-controller');
  });
});
