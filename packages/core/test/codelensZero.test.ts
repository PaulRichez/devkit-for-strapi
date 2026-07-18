import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

const ROOT = 'c:/p';

/**
 * The engine emits a CodeLens entry for *every* service/controller method,
 * including uncalled ones (`count: 0`) — so the client can surface a
 * "0 references" lens to flag a likely-unused method.
 */
describe('getCodeLenses: uncalled method gets a count:0 entry', () => {
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${ROOT}/src/api/blog/services/blog.ts`]: 'export default { async used() {}, async unused() {} };\n',
    [`${ROOT}/src/use.ts`]: "strapi.service('api::blog.blog').used();\n",
  };

  it('returns a method lens with count 0 for the uncalled method', async () => {
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();

    const svc = `${ROOT}/src/api/blog/services/blog.ts`;
    const methods = (await engine.getCodeLenses(svc, files[svc]!)).filter((l) => l.method);
    expect(methods.some((l) => l.count === 0)).toBe(true); // unused()
    expect(methods.some((l) => l.count === 1)).toBe(true); // used()
  });
});
