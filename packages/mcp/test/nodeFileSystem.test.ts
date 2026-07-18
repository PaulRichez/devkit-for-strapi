import { createEngine } from 'devkit-for-strapi-core';
import { fixturePath } from 'devkit-for-strapi-test-fixtures';
import { describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../src/nodeFileSystem';

describe('NodeFileSystem (real disk)', () => {
  it('drives the engine over node:fs and discovers both monorepo projects', async () => {
    const root = fixturePath('monorepo-two-projects');
    const engine = createEngine(new NodeFileSystem());
    await engine.init([root]);

    const roots = engine.getProjects().map((p) => p.root);
    expect(roots.some((r) => r.endsWith('apps/cms-a'))).toBe(true);
    expect(roots.some((r) => r.endsWith('apps/cms-b'))).toBe(true);
  });

  it('stat returns null for a missing path (never throws)', async () => {
    const fs = new NodeFileSystem();
    expect(await fs.stat(`${fixturePath('monorepo-two-projects')}/does-not-exist`)).toBeNull();
    expect(await fs.exists(`${fixturePath('monorepo-two-projects')}/nope`)).toBe(false);
  });
});
