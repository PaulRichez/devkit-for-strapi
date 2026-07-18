import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { listUnused, referencesOf } from '../src/query/refQuery';

const ROOT = 'c:/p';
const CONTROLLER = `${ROOT}/src/api/product/controllers/product.ts`;

const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/src/api/product/content-types/product/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"product","pluralName":"products"},"attributes":{}}',
  // `find` overrides the core action (served by auto-CRUD); `helper` is custom (no route).
  [CONTROLLER]: 'export default { async find() {}, async helper() {} };\n',
  [`${ROOT}/src/api/product/routes/product.ts`]: "export default factories.createCoreRouter('api::product.product');\n",
};

describe('auto-CRUD handler refs (createCoreRouter)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;

  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('counts an overridden core action as referenced via its auto-CRUD route', () => {
    expect(referencesOf(project, 'api::product.product.find').some((r) => r.via === 'route')).toBe(true);
  });

  it('does not flag the auto-CRUD-served `find` as unused, but does flag the custom `helper`', () => {
    const unused = listUnused(project, { kinds: ['method'] }).map((u) => u.ref);
    expect(unused).not.toContain('api::product.product.find');
    expect(unused).toContain('api::product.product.helper');
  });

  it('gives `find` a non-zero CodeLens count (helper stays 0)', async () => {
    const methods = (await engine.getCodeLenses(CONTROLLER, files[CONTROLLER]!)).filter((l) => l.method);
    expect(methods.some((l) => l.count >= 1)).toBe(true); // find, via the route
    expect(methods.some((l) => l.count === 0)).toBe(true); // helper
  });
});
