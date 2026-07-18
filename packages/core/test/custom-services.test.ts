import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('custom (non-factory) services and controllers', () => {
  let engine: StrapiEngine;
  let root: string;
  const base = (): string => `${root}/apps/cms-a`;
  const consumer = (): string => `${base()}/src/api/page/controllers/x.ts`;

  beforeAll(async () => {
    const fx = loadFixture('monorepo-two-projects');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('indexes a plain custom service registered by file name', () => {
    const project = engine.projectForFile(consumer())!;
    expect(project.index.services.has('api::page.notifier')).toBe(true);
  });

  it('resolves a custom service ref to its file', async () => {
    const code = `strapi.service('api::page.notifier')`;
    const targets = await engine.getDefinitions(consumer(), 18, code);
    expect(targets[0]?.filePath).toBe(`${base()}/src/api/page/services/notifier.ts`);
  });

  it('extracts actions from a plain custom controller and resolves the handler', async () => {
    const project = engine.projectForFile(consumer())!;
    const webhook = project.index.controllers.get('api::page.webhook')!;
    expect(webhook.actions?.map((a) => a.name)).toContain('receive');

    const code = `export default { routes: [{ handler: 'api::page.webhook.receive' }] };`;
    const offset = code.indexOf('webhook.receive');
    const targets = await engine.getDefinitions(consumer(), offset, code);
    expect(targets[0]?.filePath).toBe(`${base()}/src/api/page/controllers/webhook.ts`);
    const src = (await loadFixtureSrc(base()))['controllers/webhook.ts'];
    expect(src.slice(targets[0]!.offset!)).toMatch(/^receive/);
  });
});

async function loadFixtureSrc(base: string): Promise<Record<string, string>> {
  const { files } = loadFixture('monorepo-two-projects');
  const out: Record<string, string> = {};
  const prefix = `${base}/src/api/page/`;
  for (const [path, content] of Object.entries(files)) {
    if (path.startsWith(prefix)) out[path.slice(prefix.length)] = content;
  }
  return out;
}
