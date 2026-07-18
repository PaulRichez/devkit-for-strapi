import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { buildIndex } from '../src/index/indexer';

describe('multiple content-types under one api', () => {
  it('indexes every content-type folder of an api', async () => {
    const { root, files } = loadFixture('monorepo-two-projects');
    const index = await buildIndex(new MemoryFileSystem(files), `${root}/apps/cms-a/src`);
    expect(index.contentTypes.has('api::page.page')).toBe(true);
    expect(index.contentTypes.has('api::page.section')).toBe(true);
    expect(index.services.has('api::page.page')).toBe(true);
  });

  it('resolves each content-type of the same api independently', async () => {
    const { root, files } = loadFixture('monorepo-two-projects');
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);
    const consumer = `${root}/apps/cms-a/src/api/page/controllers/x.ts`;

    const toPage = await engine.getDefinitions(consumer, 18, `strapi.documents('api::page.page')`);
    expect(toPage[0]?.filePath).toBe(`${root}/apps/cms-a/src/api/page/content-types/page/schema.json`);

    const toSection = await engine.getDefinitions(consumer, 18, `strapi.documents('api::page.section')`);
    expect(toSection[0]?.filePath).toBe(`${root}/apps/cms-a/src/api/page/content-types/section/schema.json`);
  });
});
