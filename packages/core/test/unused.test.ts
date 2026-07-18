import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { listUnused } from '../src/query/refQuery';

const ROOT = 'c:/p';
const SERVICE = `${ROOT}/src/api/blog/services/blog.ts`;

const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/src/api/post/content-types/post/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"post"},"attributes":{}}',
  [`${ROOT}/src/api/tag/content-types/tag/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"tag"},"attributes":{}}',
  [SERVICE]: 'export default { async used() {}, async unused() {} };\n',
  [`${ROOT}/src/api/post/services/post.ts`]: 'export default { async helper() {} };\n', // resource service (post has a CT)
  [`${ROOT}/src/api/mailer/services/mailer.ts`]: 'export default { async send() {} };\n', // standalone service (no CT)
  [`${ROOT}/src/policies/is-auth.ts`]: 'export default () => true;\n', // global policy, referenced below
  [`${ROOT}/src/policies/orphan-policy.ts`]: 'export default () => true;\n', // never referenced → dead
  [`${ROOT}/src/middlewares/orphan-mw.ts`]: 'export default () => async () => {};\n', // never referenced → dead
  [`${ROOT}/src/api/blog/routes/blog.ts`]:
    "export default { routes: [{ handler: 'api::blog.blog.used', config: { policies: ['global::is-auth'] } }] };\n",
  [`${ROOT}/src/use.ts`]: "strapi.service('api::blog.blog').used();\nstrapi.documents('api::post.post').findMany();\n",
};

describe('listUnused (dead Strapi code)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;

  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('reports the uncalled method and the orphan content-type, not the used ones', () => {
    const items = listUnused(project);
    expect(items.some((i) => i.kind === 'method' && i.ref === 'api::blog.blog.unused')).toBe(true);
    expect(items.some((i) => i.kind === 'content-type' && i.ref === 'api::tag.tag')).toBe(true);
    expect(items.some((i) => i.ref === 'api::blog.blog.used')).toBe(false); // called
    expect(items.some((i) => i.ref === 'api::post.post')).toBe(false); // referenced via documents()
  });

  it('restricts to one file with `file`, and to one kind with `kinds`', () => {
    const inFile = listUnused(project, { file: SERVICE });
    expect(inFile.length).toBeGreaterThan(0);
    expect(inFile.every((i) => i.filePath === SERVICE && i.kind === 'method')).toBe(true);

    const onlyMethods = listUnused(project, { kinds: ['method'] });
    expect(onlyMethods.every((i) => i.kind === 'method')).toBe(true);
  });

  it('flags a standalone custom service, not a resource one (framework-wired)', () => {
    const services = listUnused(project, { kinds: ['service'] }).map((i) => i.ref);
    expect(services).toContain('api::mailer.mailer'); // standalone, dead
    expect(services).not.toContain('api::post.post'); // resource service → used by auto-CRUD
  });

  it('flags an orphan policy / middleware, not one referenced by a route', () => {
    const policies = listUnused(project, { kinds: ['policy'] }).map((i) => i.ref);
    expect(policies).toContain('global::orphan-policy'); // never referenced → dead
    expect(policies).not.toContain('global::is-auth'); // referenced by blog's route config
    const middlewares = listUnused(project, { kinds: ['middleware'] }).map((i) => i.ref);
    expect(middlewares).toContain('global::orphan-mw');
  });
});
