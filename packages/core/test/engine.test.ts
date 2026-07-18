import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('engine (multi-project workspace)', () => {
  it('discovers projects, counts the index, and resolves ownership per file', async () => {
    const { root, files } = loadFixture('monorepo-two-projects');
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([root]);

    const projects = engine.getProjects();
    expect(projects.length).toBe(2);

    const a = engine.projectForFile(`${root}/apps/cms-a/src/api/page/controllers/page.ts`);
    expect(a?.version).toBe(5);
    expect(a?.index.contentTypes.has('api::page.page')).toBe(true);

    const b = engine.projectForFile(`${root}/apps/cms-b/src/api/post/content-types/post/schema.json`);
    expect(b?.version).toBe(4);

    // A file outside any Strapi project has no owner → features no-op.
    expect(engine.projectForFile(`${root}/README.md`)).toBeUndefined();
  });

  it('addRoot locates a project on demand from a file path (walk-up), no startup config', async () => {
    const { root, files } = loadFixture('monorepo-two-projects');
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([]); // no folders → nothing discovered
    expect(engine.getProjects().length).toBe(0);

    // Point at a file deep inside cms-a → the engine walks up to its project root.
    const projects = await engine.addRoot(`${root}/apps/cms-a/src/api/page/controllers/page.ts`);
    expect(projects.some((p) => p.root.endsWith('apps/cms-a'))).toBe(true);
    expect(engine.projectForFile(`${root}/apps/cms-a/src/api/page/controllers/page.ts`)?.index.contentTypes.has('api::page.page')).toBe(true);
  });

  it('addRoot scans down from a directory (monorepo) and is idempotent', async () => {
    const { root, files } = loadFixture('monorepo-two-projects');
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([]);
    const first = await engine.addRoot(root); // the workspace dir → both apps
    expect(first.length).toBe(2);
    const again = await engine.addRoot(`${root}/apps/cms-a`); // already covered → no change
    expect(again.length).toBe(2);
  });

  it('exposes the exact installed Strapi version + the declared range (#19)', async () => {
    const R = 'c:/ver';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.2.0"}}',
        [`${R}/node_modules/@strapi/strapi/package.json`]: '{"name":"@strapi/strapi","version":"4.25.1"}',
        [`${R}/src/api/blog/content-types/blog/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
      }),
    );
    await engine.init([R]);
    const [p] = engine.getProjects();
    expect(p?.version).toBe(4); // major, drives internal logic — unchanged
    expect(p?.strapiVersion).toBe('4.25.1'); // exact installed
    expect(p?.declaredVersion).toBe('^4.2.0'); // the package.json range
  });

  it('omits strapiVersion when node_modules is absent (never guesses an exact version)', async () => {
    const R = 'c:/nov';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${R}/src/api/blog/content-types/blog/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
      }),
    );
    await engine.init([R]);
    const [p] = engine.getProjects();
    expect(p?.strapiVersion).toBeUndefined();
    expect(p?.declaredVersion).toBe('^5.0.0');
  });

  it('rescans when a package.json changes', async () => {
    const { root, files } = loadFixture('nested-not-at-root');
    const fs = new MemoryFileSystem(files);
    const engine = createEngine(fs);
    await engine.init([root]);
    expect(engine.getProjects().length).toBe(1);

    // Turn the frontend into a Strapi project and notify the engine.
    fs.writeFile(
      `${root}/frontend/package.json`,
      '{"name":"frontend","dependencies":{"@strapi/strapi":"^5.0.0"}}',
    );
    await engine.onFilesChanged([`${root}/frontend/package.json`], []);
    expect(engine.getProjects().length).toBe(2);
  });
});
