import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

const ROOT = 'c:/p';
const MODERATION = `${ROOT}/src/plugins/reviews/server/services/moderation.ts`;
const ADMIN = `${ROOT}/src/plugins/reviews/server/controllers/admin.ts`;
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [MODERATION]: `export default () => ({ async approve(id: string) { return true; } });`,
  [ADMIN]: `export default { async list(ctx: any) { ctx.body = []; } };`,
  [`${ROOT}/src/use.ts`]:
    `strapi.plugin('reviews').service('moderation').approve('1');
     strapi.controller('plugin::reviews.admin').list();`,
};

describe('plugin service/controller navigation', () => {
  let engine: StrapiEngine;
  const use = `${ROOT}/src/use.ts`;
  const code = files[use]!;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
  });

  it('jumps to a plugin service file from a plugin().service() chain', async () => {
    const targets = await engine.getDefinitions(use, code.indexOf('moderation') + 2, code);
    expect(targets[0]?.filePath).toBe(MODERATION);
  });

  it('jumps to a plugin service method', async () => {
    const targets = await engine.getDefinitions(use, code.indexOf('approve') + 1, code);
    expect(targets[0]?.filePath).toBe(MODERATION);
    expect(files[MODERATION]!.slice(targets[0]!.offset!)).toMatch(/^approve/);
  });

  it('jumps to a plugin controller method via strapi.controller()', async () => {
    const targets = await engine.getDefinitions(use, code.indexOf('.list') + 2, code);
    expect(targets[0]?.filePath).toBe(ADMIN);
    expect(files[ADMIN]!.slice(targets[0]!.offset!)).toMatch(/^list/);
  });

  it('hovers a plugin service method with its owning ref', async () => {
    const info = await engine.getHover(use, code.indexOf('approve') + 1, code);
    expect(info?.markdown).toContain('moderation');
    expect(info?.markdown).toContain('approve');
  });
});
