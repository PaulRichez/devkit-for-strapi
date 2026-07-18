import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('member completion after a dot', () => {
  let engine: StrapiEngine;
  let root: string;
  const file = (): string => `${root}/apps/cms-a/src/playground.ts`;
  const labelsAfter = async (code: string): Promise<string[]> => {
    const result = await engine.getCompletions(file(), code.length, code);
    return result.items.map((i) => i.label);
  };

  beforeAll(async () => {
    const fx = loadFixture('monorepo-two-projects');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('suggests a custom service method after `.`', async () => {
    expect(await labelsAfter(`strapi.service('api::page.notifier').`)).toContain('notify');
  });

  it('suggests a core-override service method after `.`', async () => {
    expect(await labelsAfter(`strapi.service('api::page.page').`)).toContain('findPage');
  });

  it('suggests Document Service methods after `.`', async () => {
    const got = await labelsAfter(`strapi.documents('api::page.page').`);
    expect(got).toContain('findMany');
    expect(got).toContain('publish');
  });

  it('suggests Entity Service methods after `.`', async () => {
    expect(await labelsAfter(`strapi.entityService.`)).toContain('findOne');
  });

  it('filters by a partial member and reports a replace range', async () => {
    const code = `strapi.service('api::page.notifier').not`;
    const result = await engine.getCompletions(file(), code.length, code);
    expect(result.items.map((i) => i.label)).toContain('notify');
    expect(code.slice(result.replace!.start, result.replace!.end)).toBe('not');
  });
});
