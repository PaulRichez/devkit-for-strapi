import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { dependencies, dependents, listRefs } from '../src/query/graph';

const ROOT = 'c:/g';
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  // article → relation to author, and its controller calls the author service.
  [`${ROOT}/src/api/blog/content-types/article/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{"author":{"type":"relation","target":"api::blog.author"}}}',
  [`${ROOT}/src/api/blog/content-types/author/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"author"},"attributes":{}}',
  [`${ROOT}/src/api/blog/controllers/article.ts`]:
    `export default factories.createCoreController('api::blog.article', () => ({
       async find() {
         await strapi.documents('api::blog.article').findMany({ populate: { author: true } });
         return strapi.service('api::blog.author').list();
       },
     }));`,
  [`${ROOT}/src/api/blog/services/article.ts`]:
    `import { factories } from '@strapi/strapi';\nexport default factories.createCoreService('api::blog.article');`,
  [`${ROOT}/src/api/blog/services/author.ts`]:
    `import { factories } from '@strapi/strapi';\nexport default factories.createCoreService('api::blog.author');`,
};

describe('graph queries (listRefs / dependencies / dependents)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('lists refs by glob', () => {
    const refs = listRefs(project, 'api::blog.*').map((r) => r.ref);
    expect(refs).toContain('api::blog.article');
    expect(refs).toContain('api::blog.author');
    // a narrower glob excludes the other
    expect(listRefs(project, 'api::blog.author').map((r) => r.ref)).toEqual(['api::blog.author']);
  });

  it('finds what a ref uses (dependencies: relation + service call)', () => {
    const deps = dependencies(project, 'api::blog.article');
    expect(deps).toContain('api::blog.author');
    expect(deps).not.toContain('api::blog.article'); // never itself
  });

  it('does not inject a phantom ref for relation-field usages (keyToRef strips the field segment)', () => {
    const deps = dependencies(project, 'api::blog.article');
    expect(deps).not.toContain('api::blog.article.author'); // the phantom non-entity ref
    expect(deps).toContain('api::blog.author'); // the real relation edge still present
  });

  it('finds what uses a ref (dependents: the inverse edge)', () => {
    const dep = dependents(project, 'api::blog.author');
    expect(dep).toContain('api::blog.article');
  });

  it('an entity nothing points to has no dependents', () => {
    expect(dependents(project, 'api::blog.article')).not.toContain('api::blog.author');
  });

  it('glob matches by prefix/suffix/exact and resists ReDoS (linear, no greedy regex)', () => {
    const refs = (p: string): string[] => listRefs(project, p).map((r) => r.ref);
    expect(refs('*')).toEqual(expect.arrayContaining(['api::blog.article', 'api::blog.author']));
    expect(refs('api::blog.a*')).toEqual(expect.arrayContaining(['api::blog.article', 'api::blog.author']));
    expect(refs('*.author')).toEqual(['api::blog.author']); // suffix
    expect(refs('api::blog.article')).toEqual(['api::blog.article']); // exact, no wildcard
    // prefix+suffix overlap must NOT match (would over-match a naive impl)
    expect(refs('api::blog.article*api::blog.article')).toEqual([]);
    // pathological pattern: a greedy `.*`-regex would backtrack catastrophically; this returns instantly.
    expect(refs('a*a*a*a*a*a*a*a*a*a*a*a*Z')).toEqual([]);
  });
});
