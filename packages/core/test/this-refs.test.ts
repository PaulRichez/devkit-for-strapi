import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { listUnused, referencesOf } from '../src/query/refQuery';

const R = 'c:/t';
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${R}/src/api/blog/content-types/blog/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
  [`${R}/src/api/blog/services/blog.ts`]:
    `export default factories.createCoreService('api::blog.blog', () => ({
       async helper() { return 1; },
       async main() { return this.helper(); },
     }));`,
};

describe('this.method() self-calls are referenced (no false dead code)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('counts a `this.helper()` call as a reference to the method', () => {
    const refs = referencesOf(project, 'api::blog.blog#helper');
    expect(refs.length).toBeGreaterThanOrEqual(1);
    expect(refs.some((r) => r.via === 'this')).toBe(true);
  });

  it('does not list a this-called method as unused (helper), but still flags a truly uncalled one (main)', () => {
    const unusedMethods = listUnused(project, { kinds: ['method'] }).map((u) => u.ref);
    expect(unusedMethods).not.toContain('api::blog.blog.helper');
    expect(unusedMethods).toContain('api::blog.blog.main');
  });
});

describe('member-var call-sites (const e = strapi.service(...); e.method())', () => {
  const R2 = 'c:/tv';
  const tree: Record<string, string> = {
    [`${R2}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${R2}/src/api/blog/content-types/blog/schema.json`]:
      '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
    [`${R2}/src/api/blog/services/blog.ts`]:
      `export default factories.createCoreService('api::blog.blog', () => ({ async chat() { return 1; } }));`,
    [`${R2}/src/api/other/controllers/other.ts`]:
      `const engine = strapi.service('api::blog.blog');\nexport default { async go() { return engine.chat(); } };`,
  };
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(tree));
    await engine.init([R2]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('counts a binding member-call as a reference, tagged via:member-var', () => {
    const refs = referencesOf(project, 'api::blog.blog#chat');
    expect(refs.some((r) => r.via === 'member-var')).toBe(true);
  });

  it('no longer reports the method as unused (the list_unused / rename incoherence)', () => {
    expect(listUnused(project, { kinds: ['method'] }).map((u) => u.ref)).not.toContain('api::blog.blog.chat');
  });
});
