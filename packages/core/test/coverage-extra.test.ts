import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('registry map bracket access (strapi.services[...])', () => {
  let engine: StrapiEngine;
  let root: string;
  const consumer = (): string => `${root}/src/api/product/controllers/x.ts`;
  const defAt = (code: string, needle: string) =>
    engine.getDefinitions(consumer(), code.indexOf(needle), code);

  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('resolves strapi.services[uid] to the service file', async () => {
    const t = await defAt(`strapi.services['api::product.product']`, 'product.product');
    expect(t[0]?.filePath).toBe(`${root}/src/api/product/services/product.ts`);
  });

  it('resolves strapi.contentTypes[uid] to schema.json', async () => {
    const t = await defAt(`strapi.contentTypes['api::product.product']`, 'product.product');
    expect(t[0]?.filePath).toBe(`${root}/src/api/product/content-types/product/schema.json`);
  });

  it('resolves strapi.controllers[uid] to the controller file', async () => {
    const t = await defAt(`strapi.controllers['api::product.product']`, 'product.product');
    expect(t[0]?.filePath).toBe(`${root}/src/api/product/controllers/product.ts`);
  });

  it('resolves strapi.components[uid] to the component json', async () => {
    const t = await defAt(`strapi.components['shared.seo']`, 'shared.seo');
    expect(t[0]?.filePath).toBe(`${root}/src/components/shared/seo.json`);
  });
});

describe('plugin sub-accessors: contentType / policy / middleware', () => {
  const root = 'c:/proj';
  const consumer = `${root}/src/api/x/controllers/x.ts`;
  const base = `${root}/src/plugins/reviews/server`;
  let engine: StrapiEngine;

  beforeAll(async () => {
    const files: Record<string, string> = {
      [`${root}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${base}/content-types/review/schema.json`]:
        '{"kind":"collectionType","info":{"singularName":"review"},"attributes":{}}',
      [`${base}/policies/can-review.ts`]: 'export default () => true;',
      [`${base}/middlewares/track.ts`]: 'export default () => async (c: any, n: any) => n();',
    };
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);
  });

  const defAt = (code: string, needle: string) =>
    engine.getDefinitions(consumer, code.indexOf(needle) + 2, code);

  it('resolves plugin().contentType(b) to the plugin schema', async () => {
    const t = await defAt(`strapi.plugin('reviews').contentType('review')`, `'review'`);
    expect(t[0]?.filePath).toBe(`${base}/content-types/review/schema.json`);
  });

  it('resolves plugin().policy(b) to the plugin policy file', async () => {
    const t = await defAt(`strapi.plugin('reviews').policy('can-review')`, `'can-review'`);
    expect(t[0]?.filePath).toBe(`${base}/policies/can-review.ts`);
  });

  it('resolves plugin().middleware(b) to the plugin middleware file', async () => {
    const t = await defAt(`strapi.plugin('reviews').middleware('track')`, `'track'`);
    expect(t[0]?.filePath).toBe(`${base}/middlewares/track.ts`);
  });

  it('does not raise false positives on valid plugin sub-accessors', async () => {
    expect(await engine.validateFile(consumer, `strapi.plugin('reviews').policy('can-review')`)).toEqual([]);
    expect(await engine.validateFile(consumer, `strapi.plugin('reviews').contentType('review')`)).toEqual([]);
  });

  it('flags an unknown plugin policy', async () => {
    const [d] = await engine.validateFile(consumer, `strapi.plugin('reviews').policy('nope')`);
    expect(d?.code).toBe('devkit-for-strapi.unknown-policy');
  });

  it('completes bare names of the plugin', async () => {
    const code = `strapi.plugin('reviews').contentType('')`;
    const offset = code.indexOf(`('')`) + 2;
    const result = await engine.getCompletions(consumer, offset, code);
    expect(result.items.map((i) => i.label)).toContain('review');
  });
});
