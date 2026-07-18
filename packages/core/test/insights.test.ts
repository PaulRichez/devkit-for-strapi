import { beforeAll, describe, expect, it } from 'vitest';
import { buildModelMaps, componentInsights, contentTypeInsights } from '../src/reference/insights';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';

const ROOT = 'c:/p';
const ARTICLE = `${ROOT}/src/api/blog/content-types/article/schema.json`;
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  // article: used by a relation (comment), a data call (x.ts), routes; uses a component.
  [ARTICLE]:
    '{"kind":"collectionType","info":{"singularName":"article","displayName":"Article"},"attributes":{"title":{"type":"string"},"seo":{"type":"component","component":"shared.seo"}}}',
  // comment: a relation pointing AT article → an incoming relation for article.
  [`${ROOT}/src/api/blog/content-types/comment/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"comment","displayName":"Comment"},"attributes":{"article":{"type":"relation","relation":"manyToOne","target":"api::blog.article"}}}',
  [`${ROOT}/src/api/blog/routes/article.ts`]:
    `export default { routes: [{ handler: 'api::blog.article.find' }] };`,
  [`${ROOT}/src/x.ts`]: `strapi.documents('api::blog.article').findMany({});`,
  [`${ROOT}/src/components/shared/seo.json`]: '{"collectionName":"c","info":{"displayName":"Seo"},"attributes":{}}',
  // an unused content-type and an orphan component → issues.
  [`${ROOT}/src/api/blog/content-types/tag/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"tag"},"attributes":{}}',
  [`${ROOT}/src/components/shared/unused.json`]: '{"info":{"displayName":"Unused"},"attributes":{}}',
};

describe('content-type & component insights', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    project = engine.projectForFile(ARTICLE)!;
  });

  it('breaks the content-type reference count down by category', () => {
    const ins = contentTypeInsights(project, 'api::blog.article', buildModelMaps(project));
    expect(ins.total).toBe(2); // the comment relation + the documents() call
    expect(ins.dataUsages).toBe(1); // documents()
    expect(ins.routeHandlers).toBe(1); // the route handler (not a member call)
    expect(ins.incomingRelations).toHaveLength(1);
    expect(ins.incomingRelations[0]!.fromUid).toBe('api::blog.comment');
  });

  it('lists which content-types use a component', () => {
    const ins = componentInsights(project, 'shared.seo', buildModelMaps(project));
    expect(ins.usedByCount).toBe(1);
    expect(ins.usedInContentTypes).toEqual(['api::blog.article']);
  });

  it('tags references with their `via` category', () => {
    const refs = project.references.get('ct:api::blog.article') ?? [];
    expect(refs.some((r) => r.via === 'schema')).toBe(true); // the incoming relation
    expect(refs.some((r) => r.via === 'documents')).toBe(true); // the data call
  });

  it('emits an incoming-relations CodeLens after the references lens', async () => {
    const lenses = await engine.getCodeLenses(ARTICLE, files[ARTICLE]!);
    expect(lenses[0]!.kind).toBe('references'); // references entry stays index 0
    const incoming = lenses.find((l) => l.kind === 'incoming-relations');
    expect(incoming?.count).toBe(1);
  });
});

describe('getModel (Model Explorer data)', () => {
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('builds one project with content-types, relations, components and issues', () => {
    const [model] = engine.getModel();
    expect(model!.root).toBe(ROOT);

    const article = model!.contentTypes.find((c) => c.uid === 'api::blog.article')!;
    expect(article.displayName).toBe('Article');
    expect(article.components.map((c) => c.uid)).toEqual(['shared.seo']);
    expect(article.incomingRelations).toHaveLength(1);

    const comment = model!.contentTypes.find((c) => c.uid === 'api::blog.comment')!;
    expect(comment.relations).toEqual([
      { attr: 'article', targetUid: 'api::blog.article', offset: expect.any(Number) },
    ]);

    // unused content-type + orphan component surface as issues.
    expect(model!.issues).toContainEqual({ kind: 'unused-content-type', uid: 'api::blog.tag', label: 'tag' });
    expect(model!.issues).toContainEqual({ kind: 'orphan-component', uid: 'shared.unused', label: 'shared.unused' });
  });
});

describe('insights parity in CommonJS (.js)', () => {
  const jsFiles: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
    [`${ROOT}/src/api/blog/content-types/article/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{}}',
    [`${ROOT}/src/api/blog/routes/article.js`]:
      `module.exports = { routes: [{ handler: 'api::blog.article.find' }] };`,
    [`${ROOT}/src/x.js`]: `strapi.documents('api::blog.article').findMany({});`,
  };

  it('counts route handlers and data usages from .js files', async () => {
    const engine = createEngine(new MemoryFileSystem(jsFiles));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    const project = engine.projectForFile(`${ROOT}/src/x.js`)!;
    const ins = contentTypeInsights(project, 'api::blog.article', buildModelMaps(project));
    expect(ins.routeHandlers).toBe(1);
    expect(ins.dataUsages).toBe(1);
  });
});
