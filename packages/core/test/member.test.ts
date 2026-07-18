import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('service/controller method navigation', () => {
  let engine: StrapiEngine;
  let root: string;
  let files: Record<string, string>;
  const base = (): string => `${root}/apps/cms-a`;
  const consumer = (): string => `${base()}/src/playground.ts`;

  beforeAll(async () => {
    const fx = loadFixture('monorepo-two-projects');
    root = fx.root;
    files = fx.files;
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);
  });

  it('jumps to a custom service method (what TypeScript cannot, due to `any`)', async () => {
    const code = `strapi.service('api::page.notifier').notify('hi')`;
    const offset = code.indexOf('notify(') + 1;
    const targets = await engine.getDefinitions(consumer(), offset, code);
    const notifier = `${base()}/src/api/page/services/notifier.ts`;
    expect(targets[0]?.filePath).toBe(notifier);
    expect(files[notifier]!.slice(targets[0]!.offset!)).toMatch(/^notify/);
  });

  it('jumps to a core-override service method', async () => {
    const code = `strapi.service('api::page.page').findPage('x')`;
    const offset = code.indexOf('findPage') + 1;
    const targets = await engine.getDefinitions(consumer(), offset, code);
    expect(targets[0]?.filePath).toBe(`${base()}/src/api/page/services/page.ts`);
    const src = files[`${base()}/src/api/page/services/page.ts`]!;
    expect(src.slice(targets[0]!.offset!)).toMatch(/^findPage/);
  });

  it('hovers a service method with its signature and owning ref', async () => {
    const code = `strapi.service('api::page.notifier').notify('hi')`;
    const offset = code.indexOf('notify(') + 1;
    const info = await engine.getHover(consumer(), offset, code);
    expect(info?.markdown).toContain('Service method');
    expect(info?.markdown).toContain('api::page.notifier');
    expect(info?.markdown).toContain('notify(message: string)');
    expect(info?.markdown).toContain('Promise');
  });

  it('falls back to the file when the method is unknown', async () => {
    const code = `strapi.service('api::page.notifier').doesNotExist()`;
    const offset = code.indexOf('doesNotExist') + 1;
    const targets = await engine.getDefinitions(consumer(), offset, code);
    expect(targets[0]?.filePath).toBe(`${base()}/src/api/page/services/notifier.ts`);
    expect(targets[0]?.offset).toBeUndefined();
  });
});
