import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { relationUsagesOf } from '../src/query/refQuery';

const ROOT = 'c:/r';
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/src/api/blog/content-types/article/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{"title":{"type":"string"},"author":{"type":"relation","target":"api::blog.author"}}}',
  [`${ROOT}/src/api/blog/content-types/author/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"author"},"attributes":{}}',
  [`${ROOT}/src/use.ts`]:
    `async function go() {
       await strapi.entityService.findMany('api::blog.article', { populate: { author: true }, fields: ['title'] });
       await strapi.documents('api::blog.article').findMany({ populate: ['author'], filters: { title: 'x' } });
     }`,
};

describe('relation-field usages (J4)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('records populate usages of a real relation field (object key + array element)', () => {
    const [usage] = relationUsagesOf(project, 'api::blog.article', 'author');
    expect(usage!.field).toBe('author');
    expect(usage!.locations.length).toBe(2); // { author: true } + ['author']
    expect(usage!.locations.every((l) => l.via === 'relation-field')).toBe(true);
  });

  it('does not record scalar fields (guardrail: only known relations)', () => {
    const all = relationUsagesOf(project, 'api::blog.article');
    expect(all.map((u) => u.field)).toEqual(['author']);
    // `title` appears in fields/filters but is scalar → never recorded.
    expect(relationUsagesOf(project, 'api::blog.article', 'title')[0]!.locations).toHaveLength(0);
  });

  it('returns nothing for an unknown content-type (never guesses)', () => {
    expect(relationUsagesOf(project, 'api::nope.nope')).toEqual([]);
  });
});

describe('relation-field usages: service-arm gated to query methods (J4 hardening)', () => {
  const R2 = 'c:/r2';
  const f: Record<string, string> = {
    [`${R2}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${R2}/src/api/blog/content-types/article/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{"author":{"type":"relation","target":"api::blog.author"}}}',
    [`${R2}/src/api/blog/content-types/author/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"author"},"attributes":{}}',
    [`${R2}/src/use.ts`]:
      `async function go() {
         await strapi.service('api::blog.article').find({ populate: { author: true } });        // query method → recorded
         await strapi.service('api::blog.article').buildReport({ populate: { author: true } });  // custom method → NOT recorded
       }`,
  };
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(f));
    await engine.init([R2]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('records service(uid).find({populate}) but not a custom service(uid).method({populate})', () => {
    const usages = relationUsagesOf(project, 'api::blog.article', 'author');
    // Exactly the `.find(...)` query — the custom `.buildReport(...)` is not a query API.
    expect(usages[0]!.locations.length).toBe(1);
  });
});
