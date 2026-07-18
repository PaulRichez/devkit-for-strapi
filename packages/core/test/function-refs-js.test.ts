import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

// The TypeScript twin of these assertions lives in function-refs.test.ts. This
// file proves the exact same behaviour for a v4-style CommonJS (.js) project:
// `module.exports = () => ({ ... })`, `createCoreController(...)`, `require(...)`.
const ROOT = 'c:/p';
const NOTIFIER = `${ROOT}/src/api/page/services/notifier.js`;
const PAGE_CTRL = `${ROOT}/src/api/page/controllers/page.js`;
const POLICY = `${ROOT}/src/policies/is-auth.js`;
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
  [NOTIFIER]: `module.exports = () => ({ async notify(m) {}, async ping() {} });`,
  [PAGE_CTRL]:
    `const { createCoreController } = require('@strapi/strapi').factories;
     module.exports = createCoreController('api::page.page', () => ({
       async feature(ctx) { ctx.body = 'ok'; },
     }));`,
  [`${ROOT}/src/api/page/routes/page.js`]:
    `module.exports = { routes: [{ handler: 'api::page.page.feature' }] };`,
  [POLICY]: `const x = require('y');\nmodule.exports = () => true;`,
  [`${ROOT}/src/x.js`]:
    `strapi.service('api::page.notifier').notify('a');
     strapi.service('api::page.notifier').notify('b');
     strapi.service('api::page.notifier').ping();`,
};

describe('function-level references (CommonJS .js)', () => {
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('shows a per-method CodeLens on a module.exports service method', async () => {
    const lenses = await engine.getCodeLenses(NOTIFIER, files[NOTIFIER]!);
    const byKey = (m: string) => lenses.find((l) => files[NOTIFIER]!.slice(l.offset).startsWith(m));
    expect(byKey('notify')!.count).toBe(2);
    expect(byKey('ping')!.count).toBe(1);
  });

  it('finds references from a .js method call site', async () => {
    const x = `${ROOT}/src/x.js`;
    const code = files[x]!;
    const refs = await engine.getReferences(x, code.indexOf('.notify') + 2, code);
    expect(refs.length).toBe(2);
  });

  it('finds references from the .js method definition (nearest anchor)', async () => {
    const code = files[NOTIFIER]!;
    const refs = await engine.getReferences(NOTIFIER, code.indexOf('notify('), code);
    expect(refs.length).toBe(2);
  });

  it('counts a controller method’s route-handler usage (createCoreController in .js)', async () => {
    const lenses = await engine.getCodeLenses(PAGE_CTRL, files[PAGE_CTRL]!);
    const feature = lenses.find((l) => files[PAGE_CTRL]!.slice(l.offset).startsWith('feature'));
    // The `api::page.page.feature` route handler shares the method's key.
    expect(feature!.count).toBe(1);
  });

  it('anchors a .js policy CodeLens on module.exports, not line 1', async () => {
    const [lens] = await engine.getCodeLenses(POLICY, files[POLICY]!);
    expect(lens!.offset).toBe(files[POLICY]!.indexOf('module.exports'));
    expect(lens!.offset).toBeGreaterThan(0);
  });
});
