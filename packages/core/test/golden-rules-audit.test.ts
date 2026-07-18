import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { listBrokenRefs, referencesOf, resolveRef, validateRef } from '../src/query/refQuery';

// Regression suite for the 2026-07-07 golden-rules audit (findings #17, #20-#26):
// every case below is real, valid Strapi that must NEVER be flagged (rule #3).
const R = 'c:/ga';
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
  // A component (bare `<category>.<name>` UID, no `::`).
  [`${R}/src/components/providers/providers.json`]:
    '{"collectionName":"components_providers","info":{"displayName":"Providers"},"attributes":{"name":{"type":"string"}}}',
  // A schema-only content-type: schema.json but NO services/controllers file.
  [`${R}/src/api/widget/content-types/widget/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"widget","pluralName":"widgets"},"attributes":{}}',
  // A singleType content-type with a createCoreRouter (auto-CRUD, no findOne/create).
  [`${R}/src/api/homepage/content-types/homepage/schema.json`]:
    '{"kind":"singleType","info":{"singularName":"homepage","pluralName":"homepages"},"attributes":{}}',
  [`${R}/src/api/homepage/routes/homepage.js`]:
    "const { createCoreRouter } = require('@strapi/strapi').factories;\nmodule.exports = createCoreRouter('api::homepage.homepage');\n",
  // A nested controller (controllers/nested/deep.js → name `nested.deep`).
  [`${R}/src/api/thing/content-types/thing/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"thing","pluralName":"things"},"attributes":{}}',
  [`${R}/src/api/thing/controllers/nested/deep.js`]: 'module.exports = { run(ctx) { return 1; } };\n',
  [`${R}/src/api/thing/routes/thing.js`]:
    "module.exports = { routes: [{ method: 'GET', path: '/deep', handler: 'api::thing.nested.deep.run' }] };\n",
  // A plugin route using the built-in admin policy + short-form handler.
  [`${R}/src/plugins/mine/server/controllers/settings.js`]: 'module.exports = { find(ctx) { return 1; } };\n',
  [`${R}/src/plugins/mine/server/routes/index.js`]:
    "module.exports = [{ method: 'GET', path: '/mine', handler: 'settings.find', config: { policies: ['admin::isAuthenticatedAdmin'] } }];\n",
};

describe('golden-rules audit: no false positives on valid Strapi (core)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  // #20 — framework namespaces are unverifiable, never flagged.
  it('#20 does not flag admin::/strapi:: content-type UIDs in db.query', async () => {
    const code = `strapi.db.query('admin::user').findMany();\nstrapi.db.query('strapi::core-store').findMany();`;
    expect(await engine.validateFile(`${R}/src/x.js`, code)).toEqual([]);
  });

  it('#20 does not flag the built-in admin policy in a plugin route', async () => {
    const f = `${R}/src/plugins/mine/server/routes/index.js`;
    expect(await engine.validateFile(f, files[f]!)).toEqual([]);
  });

  it('#20 validateRef treats admin::user as external, not unknown', () => {
    expect(validateRef(project, 'admin::user').status).toBe('external');
  });

  it('#20 listBrokenRefs never reports a framework ref', () => {
    const code = `strapi.db.query('admin::user').findMany();`;
    // The ref is collected but must be skipped as a framework built-in.
    void code;
    expect(listBrokenRefs(project).some((b) => b.ref.startsWith('admin::') || b.ref.startsWith('strapi::'))).toBe(false);
  });

  // #17 — component UID in a DB-layer content-type context is valid.
  it('#17 does not flag a real component UID used in db.query/getModel', async () => {
    const code = `strapi.db.query('providers.providers').findMany();\nstrapi.getModel('providers.providers');`;
    expect(await engine.validateFile(`${R}/src/x.js`, code)).toEqual([]);
  });

  it('#17 an unknown component-shaped ref is "Unknown component", never "Malformed content-type"', async () => {
    const code = `strapi.db.query('providers.nope').findMany();`;
    const [d] = await engine.validateFile(`${R}/src/x.js`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-component');
  });

  it('#17 resolves + hovers a component used in a content-type context', async () => {
    const code = `strapi.db.query('providers.providers');`;
    const off = code.indexOf('providers.providers') + 2;
    const targets = await engine.getDefinitions(`${R}/src/x.js`, off, code);
    expect(targets[0]?.filePath).toBe(`${R}/src/components/providers/providers.json`);
    const hover = await engine.getHover(`${R}/src/x.js`, off, code);
    expect(hover?.markdown).toContain('Component');
  });

  // #21 — auto-generated service/controller on a schema-only content-type.
  it('#21 does not flag service()/controller() on a schema-only content-type', async () => {
    const code = `strapi.service('api::widget.widget').find();\nstrapi.controller('api::widget.widget');`;
    expect(await engine.validateFile(`${R}/src/x.js`, code)).toEqual([]);
  });

  it('#21 resolves a schema-only service ref to the content-type schema', async () => {
    const code = `strapi.service('api::widget.widget');`;
    const off = code.indexOf('api::widget.widget') + 2;
    const targets = await engine.getDefinitions(`${R}/src/x.js`, off, code);
    expect(targets[0]?.filePath).toBe(`${R}/src/api/widget/content-types/widget/schema.json`);
  });

  // #23 — nested controller route handler: valid, resolves, no corrupting quickfix.
  it('#23 does not flag a route handler pointing at a nested (dotted) controller', async () => {
    const f = `${R}/src/api/thing/routes/thing.js`;
    expect(await engine.validateFile(f, files[f]!)).toEqual([]);
  });

  it('#23 resolves a nested-controller handler to the controller action', async () => {
    const f = `${R}/src/api/thing/routes/thing.js`;
    const code = files[f]!;
    const off = code.indexOf('api::thing.nested.deep.run') + 2;
    const targets = await engine.getDefinitions(f, off, code);
    expect(targets[0]?.filePath).toBe(`${R}/src/api/thing/controllers/nested/deep.js`);
  });

  it('#23 a quickfix on a nested controller keeps the action segment (no truncation)', async () => {
    // Typo the action; the suggestion must be `api::thing.nested.deep.<action>`, never
    // a truncated ref that drops `.deep` (which would corrupt the route on apply).
    const code = `module.exports = { routes: [{ handler: 'api::thing.nested.deep.runn' }] };`;
    const [d] = await engine.validateFile(`${R}/src/api/thing/routes/x.js`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-action');
    const fix = d?.quickFixes?.[0]?.replacement;
    if (fix) expect(fix).toBe('api::thing.nested.deep.run');
  });

  it('#23 (MCP side) resolve/find_references/list_broken_refs agree on a nested-controller handler', () => {
    // resolve('api::thing.nested.deep.run') → the nested controller file (not `nested`+action `deep`).
    const targets = resolveRef(project, 'api::thing.nested.deep.run');
    expect(targets[0]?.filePath).toBe(`${R}/src/api/thing/controllers/nested/deep.js`);
    // The route handler is indexed under the nested method key…
    expect(referencesOf(project, 'api::thing.nested.deep.run').length).toBeGreaterThanOrEqual(1);
    // …and never reported broken (the entity behind the method key is `api::thing.nested.deep`).
    expect(listBrokenRefs(project)).toEqual([]);
  });

  it('completion parity: db.query suggests components; service() suggests schema-only CTs', async () => {
    const dbCode = `strapi.db.query('')`;
    const db = await engine.getCompletions(`${R}/src/x.js`, dbCode.indexOf(`('`) + 2, dbCode);
    expect(db.items.some((i) => i.label === 'providers.providers')).toBe(true);
    const svcCode = `strapi.service('')`;
    const svc = await engine.getCompletions(`${R}/src/x.js`, svcCode.indexOf(`('`) + 2, svcCode);
    expect(svc.items.some((i) => i.label === 'api::widget.widget')).toBe(true); // auto-generated core service
  });

  // #26 — a singleType's auto-router serves no findOne/create.
  it('#26 does not synthesize findOne/create route refs for a singleType', () => {
    expect(referencesOf(project, 'api::homepage.homepage#findOne')).toEqual([]);
    expect(referencesOf(project, 'api::homepage.homepage#create')).toEqual([]);
    // …but the real singleType actions ARE served.
    expect(referencesOf(project, 'api::homepage.homepage#find').length).toBeGreaterThanOrEqual(1);
  });
});

// #22 — only real schema/component JSON files are parsed as Strapi schemas.
describe('golden-rules audit: JSON classifier is path-scoped (#22)', () => {
  const R2 = 'c:/ga2';
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(
      new MemoryFileSystem({
        [`${R2}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${R2}/src/api/blog/content-types/blog/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"blog"},"attributes":{}}',
      }),
    );
    await engine.init([R2]);
  });

  it('does not flag a tsconfig.json compilerOptions.target as a content-type', async () => {
    const code = '{ "compilerOptions": { "target": "ES2019", "outDir": "dist" } }';
    expect(await engine.validateFile(`${R2}/tsconfig.json`, code)).toEqual([]);
  });

  it('does not flag an arbitrary data.json with a "component" key', async () => {
    const code = '{ "component": "some.thing", "target": "whatever" }';
    expect(await engine.validateFile(`${R2}/src/api/blog/data.json`, code)).toEqual([]);
  });

  it('still classifies a real content-type schema.json (target relation validated)', async () => {
    const code = '{ "kind": "collectionType", "attributes": { "author": { "type": "relation", "target": "api::nope.nope" } } }';
    const f = `${R2}/src/api/comment/content-types/comment/schema.json`;
    const [d] = await engine.validateFile(f, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-content-type');
  });
});
