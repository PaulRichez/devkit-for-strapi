import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

const ROOT = 'c:/p';
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/src/api/blog/content-types/article/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{}}',
  [`${ROOT}/src/api/blog/controllers/article.ts`]:
    `export default factories.createCoreController('api::blog.article', () => ({
       async find() { return strapi.documents('api::blog.article').findMany({}); },
     }));`,
  [`${ROOT}/src/api/blog/services/article.ts`]:
    `import { factories } from '@strapi/strapi';\nexport default factories.createCoreService('api::blog.article');`,
  [`${ROOT}/src/api/blog/routes/article.ts`]:
    `export default { routes: [{ handler: 'api::blog.article.find', config: { policies: ['global::is-auth'] } }] };`,
  [`${ROOT}/src/policies/is-auth.ts`]: 'export default () => true;',
  [`${ROOT}/src/extra.ts`]:
    `strapi.documents('api::blog.article'); strapi.service('api::blog.article');`,
};

describe('reference index', () => {
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  const lensCount = async (path: string): Promise<number> => {
    const [lens] = await engine.getCodeLenses(path, files[path] ?? '');
    return lens?.count ?? -1;
  };

  it('counts content-type references across the project (CodeLens)', async () => {
    // factory(controller) + documents(controller) + factory(service) + documents(extra) = 4
    expect(await lensCount(`${ROOT}/src/api/blog/content-types/article/schema.json`)).toBe(4);
  });

  it('counts service references separately from content-type ones', async () => {
    expect(await lensCount(`${ROOT}/src/api/blog/services/article.ts`)).toBe(1);
  });

  it('counts policy references resolved from a route config', async () => {
    expect(await lensCount(`${ROOT}/src/policies/is-auth.ts`)).toBe(1);
  });

  it('getReferences from a UID call-site lists every call-site', async () => {
    const path = `${ROOT}/src/extra.ts`;
    const code = files[path]!;
    const offset = code.indexOf('api::blog.article') + 2; // inside the documents() UID
    const refs = await engine.getReferences(path, offset, code);
    expect(refs.length).toBe(4);
    expect(refs.some((r) => r.filePath.endsWith('extra.ts'))).toBe(true);
    expect(refs.some((r) => r.filePath.endsWith('controllers/article.ts'))).toBe(true);
  });

  it('getReferences from the definition file (no magic string under cursor)', async () => {
    const path = `${ROOT}/src/api/blog/content-types/article/schema.json`;
    const refs = await engine.getReferences(path, 0, files[path]!);
    expect(refs.length).toBe(4);
  });

  it('updates the reference index incrementally on file change', async () => {
    const fs = new MemoryFileSystem(files);
    const e = createEngine(fs);
    await e.init([ROOT]);
    await e.whenReferencesReady();
    const schema = `${ROOT}/src/api/blog/content-types/article/schema.json`;
    expect((await e.getCodeLenses(schema, files[schema]!))[0]!.count).toBe(4);

    // extra.ts drops its documents() ref → count must fall to 3 without a full rescan.
    const extra = `${ROOT}/src/extra.ts`;
    fs.writeFile(extra, `strapi.service('api::blog.article');`);
    await e.onFilesChanged([extra], []);
    expect((await e.getCodeLenses(schema, files[schema]!))[0]!.count).toBe(3);
  });

  it('anchors the CodeLens on the definition line, not at offset 0', async () => {
    const service = `${ROOT}/src/api/blog/services/article.ts`;
    const [lens] = await engine.getCodeLenses(service, files[service]!);
    // Anchors at `export default …`, skipping the import line above it.
    expect(lens!.offset).toBe(files[service]!.indexOf('export default'));
    expect(lens!.offset).toBeGreaterThan(0);
  });

  it('builds references in the background and notifies when ready', async () => {
    const e = createEngine(new MemoryFileSystem(files));
    let fired = 0;
    e.onReferencesChanged(() => fired++);
    await e.init([ROOT]); // returns once the definition index is ready…
    await e.whenReferencesReady(); // …references land shortly after, in the background
    expect(fired).toBeGreaterThan(0);
    expect((await e.getCodeLenses(`${ROOT}/src/api/blog/services/article.ts`, ''))[0]!.count).toBe(1);
  });
});

describe('reference index — bare strapi.query + snippet (J1)', () => {
  const R = 'c:/q';
  const tree: Record<string, string> = {
    [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
    [`${R}/src/api/blog/content-types/article/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{}}',
    [`${R}/src/api/blog/services/article.ts`]:
      `import { factories } from '@strapi/strapi';\nexport default factories.createCoreService('api::blog.article');`,
    // The bare v4 form `strapi.query('uid')` (no `.db`) — the J1 coverage gap.
    [`${R}/src/use.ts`]: `async function go() {\n  return strapi.query('api::blog.article').findOne({});\n}`,
  };

  it('indexes the bare strapi.query(uid) call as a content-type reference', async () => {
    const engine = createEngine(new MemoryFileSystem(tree));
    await engine.init([R]);
    await engine.whenReferencesReady();
    const path = `${R}/src/use.ts`;
    const code = tree[path]!;
    const offset = code.indexOf('api::blog.article') + 2;
    const refs = await engine.getReferences(path, offset, code);
    expect(refs.some((r) => r.filePath.endsWith('use.ts'))).toBe(true);
    // factory(service) + bare query(use) both reference the content-type.
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it('attaches a trimmed source-line snippet to each reference', async () => {
    const engine = createEngine(new MemoryFileSystem(tree));
    await engine.init([R]);
    await engine.whenReferencesReady();
    const path = `${R}/src/use.ts`;
    const code = tree[path]!;
    const offset = code.indexOf('api::blog.article') + 2;
    const refs = await engine.getReferences(path, offset, code);
    const here = refs.find((r) => r.filePath.endsWith('use.ts'))!;
    expect(here.snippet).toBe(`return strapi.query('api::blog.article').findOne({});`);
  });
});

describe('reference index (fixture)', () => {
  it('finds content-type references in multiple files', async () => {
    const { root, files: fx } = loadFixture('monorepo-two-projects');
    const engine = createEngine(new MemoryFileSystem(fx));
    await engine.init([root]);
    await engine.whenReferencesReady();
    const schema = `${root}/apps/cms-a/src/api/page/content-types/page/schema.json`;
    const [lens] = await engine.getCodeLenses(schema, fx[schema] ?? '');
    expect(lens!.count).toBeGreaterThan(2);
    const filesReferencing = new Set(lens!.references.map((r) => r.filePath));
    expect(filesReferencing.size).toBeGreaterThan(1);
  });
});
