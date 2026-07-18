import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

const ROOT = 'c:/p';
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/src/api/page/services/notifier.ts`]:
    `import { x } from 'y';\nexport default () => ({ async notify(m: string) {}, async ping() {} });`,
  [`${ROOT}/src/policies/is-auth.ts`]: `import { y } from 'z';\nexport default () => true;`,
  [`${ROOT}/src/x.ts`]:
    `strapi.service('api::page.notifier').notify('a');
     strapi.service('api::page.notifier').notify('b');
     strapi.service('api::page.notifier').ping();`,
};

describe('function-level references (method calls)', () => {
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('shows a per-method CodeLens on a service method', async () => {
    const svc = `${ROOT}/src/api/page/services/notifier.ts`;
    const lenses = await engine.getCodeLenses(svc, files[svc]!);
    const byKey = (m: string) => lenses.find((l) => files[svc]!.slice(l.offset).startsWith(m));
    expect(byKey('notify')!.count).toBe(2);
    expect(byKey('ping')!.count).toBe(1);
  });

  it('finds references from a method call site', async () => {
    const x = `${ROOT}/src/x.ts`;
    const code = files[x]!;
    const refs = await engine.getReferences(x, code.indexOf('.notify') + 2, code);
    expect(refs.length).toBe(2);
  });

  it('finds references from the method definition (nearest anchor)', async () => {
    const svc = `${ROOT}/src/api/page/services/notifier.ts`;
    const code = files[svc]!;
    const refs = await engine.getReferences(svc, code.indexOf('notify('), code);
    expect(refs.length).toBe(2);
  });

  it('anchors a policy CodeLens on the export line, not line 1', async () => {
    const pol = `${ROOT}/src/policies/is-auth.ts`;
    const [lens] = await engine.getCodeLenses(pol, files[pol]!);
    expect(lens!.offset).toBe(files[pol]!.indexOf('export default'));
    expect(lens!.offset).toBeGreaterThan(0);
  });
});
