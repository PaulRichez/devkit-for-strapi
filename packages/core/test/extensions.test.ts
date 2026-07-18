import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { getSchema, resolveRef, validateRef } from '../src/query/refQuery';

// #15 — content-types extended under src/extensions/<plugin>/content-types/…
// (Strapi's standard plugin-extension mechanism; `users-permissions.user` is the
// canonical case, present in nearly every app).
const R = 'c:/ext';
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.2.0"}}',
  [`${R}/src/extensions/users-permissions/content-types/user/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"user","displayName":"User"},"attributes":{"customField":{"type":"string"},"company":{"type":"relation","target":"api::company.company"}}}',
  [`${R}/src/api/company/content-types/company/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"company"},"attributes":{"owner":{"type":"relation","target":"plugin::users-permissions.user"}}}',
};

describe('extensions: content-types extended under src/extensions are indexed (#15)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('get_schema finds the extended content-type, flagged extension (partial overlay)', () => {
    const schema = getSchema(project, 'plugin::users-permissions.user');
    expect(schema).toBeDefined();
    expect(schema!.extension).toBe(true);
    expect(schema!.attributes.map((a) => a.name)).toContain('customField');
  });

  it('resolve points at the extension schema.json', () => {
    const targets = resolveRef(project, 'plugin::users-permissions.user');
    expect(targets[0]?.filePath).toBe(`${R}/src/extensions/users-permissions/content-types/user/schema.json`);
  });

  it('validate_reference says valid (local resolution wins over external)', () => {
    expect(validateRef(project, 'plugin::users-permissions.user').status).toBe('valid');
  });

  it('does NOT make the extended plugin local — its other refs stay external (unverifiable)', () => {
    expect(project.index.pluginNames.has('users-permissions')).toBe(false);
    expect(validateRef(project, 'plugin::users-permissions.role').status).toBe('external');
  });

  it('a relation target pointing at the extended CT validates clean in a schema', async () => {
    const f = `${R}/src/api/company/content-types/company/schema.json`;
    expect(await engine.validateFile(f, files[f]!)).toEqual([]);
  });
});
