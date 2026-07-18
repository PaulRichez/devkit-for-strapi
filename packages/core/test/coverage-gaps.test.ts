import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

const ROOT = 'c:/p';

describe('reference index: deleting the sole referrer drops the count to 0', () => {
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${ROOT}/src/api/blog/content-types/article/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{}}',
    [`${ROOT}/src/api/blog/routes/article.ts`]:
      `export default { routes: [{ handler: 'api::blog.article.find', config: { policies: ['global::guard'] } }] };`,
    [`${ROOT}/src/policies/guard.ts`]: 'export default () => true;',
  };

  it('removes a file’s references on deletion (1 → 0)', async () => {
    const fs = new MemoryFileSystem(files);
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    const policy = `${ROOT}/src/policies/guard.ts`;
    expect((await engine.getCodeLenses(policy, files[policy]!))[0]!.count).toBe(1);

    await engine.onFilesChanged([], [`${ROOT}/src/api/blog/routes/article.ts`]);
    expect((await engine.getCodeLenses(policy, files[policy]!))[0]!.count).toBe(0);
  });
});

describe('diagnostics: controller + middleware unknown codes', () => {
  let engine: StrapiEngine;
  let root: string;
  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('flags an unknown controller reference', async () => {
    const code = `strapi.controller('api::product.prod');`;
    const [d] = await engine.validateFile(`${root}/src/api/product/controllers/x.ts`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-controller');
    expect(d?.quickFixes?.[0]?.replacement).toBe('api::product.product');
  });

  it('flags an unknown middleware reference and suggests the closest', async () => {
    const code = `export default { routes: [{ config: { middlewares: ['global::logr'] } }] };`;
    const [d] = await engine.validateFile(`${root}/src/api/product/routes/x.ts`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-middleware');
    expect(d?.quickFixes?.[0]?.replacement).toBe('global::logger');
  });
});
