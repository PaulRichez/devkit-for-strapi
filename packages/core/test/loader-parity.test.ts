import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { buildIndex, updateIndexForFile } from '../src/index/indexer';
import type { StrapiIndex, StrapiProject } from '../src/model/types';
import { projectInfo } from '../src/query/projectInfo';
import { listBrokenRefs, listUnused, referencesOf, validateRef } from '../src/query/refQuery';

// DevKit names artifacts the way Strapi's loaders do: an API's files kebab-cased
// and read flat, a local plugin's by the keys its server entry registers.
const R = 'c:/lp';
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
  [`${R}/src/components/shared/settings.json`]: '{"collectionName":"components_shared_settings","info":{"displayName":"Settings"},"attributes":{}}',
  [`${R}/src/api/foo/content-types/foo/schema.json`]: '{"kind":"collectionType","info":{"singularName":"foo","pluralName":"foos"},"attributes":{}}',
  // Registered as has-access, foo-pdf, foo-manager (normalizeName).
  [`${R}/src/api/foo/middlewares/hasAccess.js`]: 'module.exports = (config, { strapi }) => async (ctx, next) => next();\n',
  [`${R}/src/api/foo/services/foo-PDF.js`]: 'module.exports = ({ strapi }) => ({ run() { return 1; } });\n',
  [`${R}/src/api/foo/services/foo_manager.js`]: 'module.exports = ({ strapi }) => ({ list() { return []; } });\n',
  [`${R}/src/api/foo/policies/isAllowedToEditStuff.js`]: 'module.exports = (ctx) => true;\n',
  // Never loaded: Strapi reads an API's folders flat.
  [`${R}/src/api/foo/services/sub/bar.js`]: 'module.exports = ({ strapi }) => ({ run() { return 2; } });\n',
  [`${R}/src/api/foo/routes/01-foo.js`]:
    "module.exports = { routes: [{ method: 'GET', path: '/foo', handler: 'api::foo.foo.find', config: { middlewares: ['api::foo.has-access'] } }] };\n",
  [`${R}/src/api/foo/controllers/foo.js`]: [
    "module.exports = ({ strapi }) => ({",
    '  async find(ctx) {',
    "    await strapi.service('api::foo.foo-pdf').run();",
    "    await strapi.service('api::foo.foo-manager').list();",
    "    await strapi.entityService.create('shared.settings', { data: {} });",
    "    await strapi.db.query('shared.settings').findMany();",
    "    await strapi.service('api::foo.sub.bar').run();",
    "    await strapi.plugin('helper').service('error.catch').run();",
    "    await strapi.service('plugin::helper.error.log').write();",
    "    await strapi.service('plugin::opaque.x.thing').go();",
    "    await strapi.service('plugin::auto.thing').go();",
    "    await strapi.service('plugin::auto.nope').go();",
    '  },',
    '});',
    '',
  ].join('\n'),
  // Global: the base name as written, flat.
  [`${R}/src/policies/isOwner.js`]: 'module.exports = (ctx) => true;\n',
  [`${R}/src/policies/sub/inner.js`]: 'module.exports = (ctx) => true;\n',

  // A plugin registering keys that aren't its file names (a key, a spread sub-index).
  [`${R}/src/plugins/keys/strapi-server.js`]: "module.exports = require('./server');\n",
  [`${R}/src/plugins/keys/server/index.js`]:
    "module.exports = { controllers: require('./controllers'), services: require('./services'), routes: require('./routes') };\n",
  [`${R}/src/plugins/keys/server/controllers/index.js`]:
    "const myController = require('./my-controller');\nmodule.exports = { myController, ...require('./content-api') };\n",
  [`${R}/src/plugins/keys/server/controllers/my-controller.js`]:
    "module.exports = ({ strapi }) => ({ index(ctx) { return strapi.plugin('keys').service('myService').getWelcomeMessage(); } });\n",
  [`${R}/src/plugins/keys/server/controllers/content-api/index.js`]: "module.exports = { 'content-api-item': require('./item') };\n",
  [`${R}/src/plugins/keys/server/controllers/content-api/item.js`]: 'module.exports = ({ strapi }) => ({ findItems(ctx) { return []; } });\n',
  [`${R}/src/plugins/keys/server/services/index.js`]: "module.exports = { myService: require('./my-service') };\n",
  [`${R}/src/plugins/keys/server/services/my-service.js`]: "module.exports = ({ strapi }) => ({ getWelcomeMessage() { return 'hi'; } });\n",
  // Not in the index: not a service.
  [`${R}/src/plugins/keys/server/services/__tests__/my-service.test.js`]: "test('x', () => {});\n",
  [`${R}/src/plugins/keys/server/routes/index.js`]:
    "module.exports = [{ method: 'GET', path: '/', handler: 'myController.index' }, { method: 'GET', path: '/m', handler: 'content-api-item.findItems' }];\n",

  // A plugin whose services object spreads a helper that prefixes a sub-index's keys —
  // a pure local function DevKit evaluates: the collection stays closed.
  [`${R}/src/plugins/helper/strapi-server.js`]: "module.exports = require('./server');\n",
  [`${R}/src/plugins/helper/server/index.js`]: "module.exports = { services: require('./services') };\n",
  [`${R}/src/plugins/helper/server/services/index.js`]: [
    'const withPrefix = (prefix, services) => Object.keys(services).reduce((acc, key) => {',
    '  acc[`${prefix}.${key}`] = services[key];',
    '  return acc;',
    '}, {});',
    "module.exports = { email: require('./email'), ...withPrefix('error', require('./error')) };",
    '',
  ].join('\n'),
  [`${R}/src/plugins/helper/server/services/email.js`]: 'module.exports = ({ strapi }) => ({ send() {} });\n',
  [`${R}/src/plugins/helper/server/services/error/index.js`]: "module.exports = { catch: require('./catch') };\n",
  [`${R}/src/plugins/helper/server/services/error/catch.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',

  // A helper DevKit can't follow (a loop writing into an object): the collection is open.
  [`${R}/src/plugins/opaque/strapi-server.js`]: "module.exports = require('./server');\n",
  [`${R}/src/plugins/opaque/server/index.js`]: "module.exports = { services: require('./services') };\n",
  [`${R}/src/plugins/opaque/server/services/index.js`]: [
    'function load(prefix, services) {',
    '  const out = {};',
    "  for (const key in services) out[prefix + '.' + key] = services[key];",
    '  return out;',
    '}',
    "module.exports = { email: require('./email'), ...load('x', require('./x')) };",
    '',
  ].join('\n'),
  [`${R}/src/plugins/opaque/server/services/email.js`]: 'module.exports = ({ strapi }) => ({ send() {} });\n',
  [`${R}/src/plugins/opaque/server/services/x/index.js`]: "module.exports = { thing: require('./thing') };\n",
  [`${R}/src/plugins/opaque/server/services/x/thing.js`]: 'module.exports = ({ strapi }) => ({ go() {} });\n',

  // A folder auto-loader (the kind DevKit scaffolds): the folder convention holds.
  [`${R}/src/plugins/auto/strapi-server.js`]: [
    "const fs = require('fs');",
    "const path = require('path');",
    'function loadDir(dir) {',
    '  const out = {};',
    "  for (const f of fs.readdirSync(path.join(__dirname, 'server', dir))) out[f.replace(/\\.js$/, '')] = require(path.join(__dirname, 'server', dir, f));",
    '  return out;',
    '}',
    "module.exports = { services: loadDir('services') };",
    '',
  ].join('\n'),
  [`${R}/src/plugins/auto/server/services/thing.js`]: 'module.exports = ({ strapi }) => ({ go() {} });\n',
};

describe("names as Strapi's loaders register them (feedback v2: 1-4, 11, 14)", () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('V2-1: a component UID in a content-type call is never a broken ref, as validate_reference says', () => {
    expect(validateRef(project, 'shared.settings').status).toBe('valid');
    expect(listBrokenRefs(project).map((b) => b.ref)).not.toContain('shared.settings');
  });

  it('V2-2: API artifacts are registered under their kebab-case name', () => {
    for (const ref of ['api::foo.has-access', 'api::foo.foo-pdf', 'api::foo.foo-manager']) {
      expect(validateRef(project, ref).status, ref).toBe('valid');
      expect(referencesOf(project, ref).length, ref).toBeGreaterThan(0);
    }
    const unused = listUnused(project).map((u) => u.ref);
    expect(unused).not.toContain('api::foo.foo-pdf');
    expect(unused).not.toContain('api::foo.foo-manager');
    expect(unused).not.toContain('api::foo.has-access');
    expect(listBrokenRefs(project).map((b) => b.ref)).not.toContain('api::foo.has-access');
  });

  it('V2-2: the raw file names are unknown, and the suggestion is the registered name (never the reverse)', () => {
    expect(validateRef(project, 'api::foo.hasAccess')).toMatchObject({ status: 'unknown', didYouMean: 'api::foo.has-access' });
    expect(validateRef(project, 'api::foo.foo_manager')).toMatchObject({ status: 'unknown', didYouMean: 'api::foo.foo-manager' });
    expect(validateRef(project, 'api::foo.foo-PDF')).toMatchObject({ status: 'unknown', didYouMean: 'api::foo.foo-pdf' });
  });

  it('V2-2: the suggestion is exact even when the raw name is far from the registered one', async () => {
    expect(validateRef(project, 'api::foo.isAllowedToEditStuff')).toMatchObject({ status: 'unknown', didYouMean: 'api::foo.is-allowed-to-edit-stuff' });
    const code = "module.exports = { routes: [{ method: 'GET', path: '/x', handler: 'api::foo.foo.find', config: { policies: ['api::foo.isAllowedToEditStuff'] } }] };";
    const [d] = await engine.validateFile(`${R}/src/api/foo/routes/02-x.js`, code);
    expect(d?.quickFixes?.[0]?.replacement).toBe('api::foo.is-allowed-to-edit-stuff');
  });

  it('V2-2: no diagnostic on the route that mounts the kebab-case middleware', async () => {
    const f = `${R}/src/api/foo/routes/01-foo.js`;
    expect(await engine.validateFile(f, files[f]!)).toEqual([]);
  });

  it('V2-3: a file in an API subfolder is not a service (undefined at runtime): unknown and broken, not unused', () => {
    expect(validateRef(project, 'api::foo.sub.bar').status).toBe('unknown');
    expect(listUnused(project).map((u) => u.ref)).not.toContain('api::foo.sub.bar');
    expect(listBrokenRefs(project).find((b) => b.ref === 'api::foo.sub.bar')?.kind).toBe('service');
  });

  it('V2-3: global policies keep their name as written, flat', () => {
    expect([...project.index.policies.keys()].filter((k) => k.startsWith('global::'))).toEqual(['global::isOwner']);
  });

  it('V2-4: a plugin registers the keys of its index (a key, a spread sub-index), not its file names', () => {
    expect(validateRef(project, 'plugin::keys.myController')).toMatchObject({ status: 'valid', kinds: ['controller'] });
    expect(validateRef(project, 'plugin::keys.content-api-item').status).toBe('valid');
    expect(validateRef(project, 'plugin::keys.myService').status).toBe('valid');
    expect(validateRef(project, 'plugin::keys.my-controller').status).toBe('unknown');
    expect(validateRef(project, 'plugin::keys.my-service').status).toBe('unknown');
    expect(listBrokenRefs(project).filter((b) => b.ref.startsWith('plugin::keys.'))).toEqual([]);
    // The handlers resolve to the files behind the keys.
    expect(referencesOf(project, 'plugin::keys.myController.index').length).toBe(1);
    expect(referencesOf(project, 'plugin::keys.content-api-item.findItems').length).toBe(1);
    expect(project.index.controllers.get('plugin::keys.content-api-item')?.filePath).toBe(`${R}/src/plugins/keys/server/controllers/content-api/item.js`);
    const unused = listUnused(project).map((u) => u.ref);
    expect(unused).not.toContain('plugin::keys.myService');
    expect(unused).not.toContain('plugin::keys.my-service');
  });

  it('V2-18: a helper that prefixes a sub-index is evaluated — exact keys, the collection stays closed', () => {
    expect(validateRef(project, 'plugin::helper.email').status).toBe('valid');
    expect(validateRef(project, 'plugin::helper.error.catch')).toMatchObject({ status: 'valid', kinds: ['service'] });
    const errorCatch = project.index.services.get('plugin::helper.error.catch');
    expect(errorCatch?.unconfirmed).toBeUndefined();
    expect(errorCatch?.filePath).toBe(`${R}/src/plugins/helper/server/services/error/catch.js`);
    // A name it doesn't register is unknown again (a typo is caught), and broken where it is called.
    expect(validateRef(project, 'plugin::helper.error.log', 'service').status).toBe('unknown');
    expect(validateRef(project, 'plugin::helper.fooo', 'service').status).toBe('unknown');
    expect(listBrokenRefs(project).map((b) => b.ref)).toContain('plugin::helper.error.log');
    expect(project.index.openCollections?.get('helper')).toBeUndefined();
  });

  it('V2-18: a helper DevKit cannot follow leaves the collection open — and says so, with where', async () => {
    expect(validateRef(project, 'plugin::opaque.email').status).toBe('valid');
    const unseen = validateRef(project, 'plugin::opaque.nope', 'service');
    expect(unseen.status).toBe('external');
    expect(unseen.reason).toMatch(/^Plugin 'opaque' registers its services through code DevKit can't read \(src\/plugins\/opaque\/server\/services\/index\.js:6\)/);
    expect(listBrokenRefs(project).filter((b) => b.ref.startsWith('plugin::opaque.'))).toEqual([]);
    // Files no key accounts for keep their folder name, unconfirmed: never "unused".
    expect(project.index.services.get('plugin::opaque.x.thing')?.unconfirmed).toBe(true);
    expect(listUnused(project).map((u) => u.ref)).not.toContain('plugin::opaque.x.thing');
    // project_info: verified in part, why, and the refs it can't check counted.
    const info = await projectInfo(new MemoryFileSystem(files), project, engine.getProjects()[0]!);
    const opaque = info.plugins.find((p) => p.name === 'opaque')!;
    expect(opaque.verified).toBe('partial');
    expect(opaque.why?.[0]).toMatch(/its services are registered by code DevKit can't read \(src\/plugins\/opaque\/server\/services\/index\.js:6\)/);
    expect(info.health.unverifiedByPlugin?.opaque).toBe(2); // the service, and its method called
    expect(info.notes.join('\n')).toMatch(/Verified in part: opaque/);
    expect(info.plugins.find((p) => p.name === 'helper')?.verified).toBe(true);
  });

  it('V2-4: a folder auto-loader keeps the folder convention, verified', () => {
    expect(validateRef(project, 'plugin::auto.thing').status).toBe('valid');
    expect(listBrokenRefs(project).map((b) => b.ref)).toContain('plugin::auto.nope');
  });

  it('V2-11: a test file under services/ is not a service', () => {
    expect([...project.index.services.keys()].filter((k) => k.includes('__tests__'))).toEqual([]);
    expect(listUnused(project).filter((u) => u.filePath.includes('__tests__'))).toEqual([]);
  });

  it("V2-14: a broken service's method calls are grouped under it, not reported again as a controller", () => {
    const broken = listBrokenRefs(project);
    expect(broken.find((b) => b.ref === 'api::foo.sub.bar')?.methods?.map((m) => m.name)).toEqual(['run']);
    expect(broken.some((b) => b.ref === 'api::foo.sub.bar.run')).toBe(false);
    expect(broken.some((b) => b.kind === 'controller' && b.ref.startsWith('api::foo.sub.bar'))).toBe(false);
  });

  it('one verdict: every broken ref is unknown for validate_reference (same kind)', () => {
    const broken = listBrokenRefs(project);
    expect(broken.length).toBeGreaterThan(0);
    for (const b of broken) expect(validateRef(project, b.ref, b.kind).status, `${b.kind} ${b.ref}`).toBe('unknown');
  });

  it('the editor diagnostics agree: only the refs Strapi would not find are flagged', async () => {
    const f = `${R}/src/api/foo/controllers/foo.js`;
    const flagged = (await engine.validateFile(f, files[f]!)).map((d) => files[f]!.slice(d.start, d.end));
    expect(flagged.sort()).toEqual(['api::foo.sub.bar', 'plugin::auto.nope', 'plugin::helper.error.log']);
  });
});

/** Every definition key the index holds, with the flags that change a verdict. */
function snapshot(index: StrapiIndex): Record<string, string[]> {
  const flags = (m: Map<string, { unconfirmed?: boolean; filePath: string }>) =>
    [...m].map(([k, a]) => `${k}${a.unconfirmed ? ' (unconfirmed)' : ''} @ ${a.filePath}`).sort();
  return {
    contentTypes: [...index.contentTypes.keys()].sort(),
    components: [...index.components.keys()].sort(),
    services: flags(index.services),
    controllers: flags(index.controllers),
    policies: flags(index.policies),
    middlewares: flags(index.middlewares),
    plugins: [...index.pluginNames].sort(),
    open: [...(index.openCollections ?? [])].map(([p, k]) => `${p}:${[...k].sort().join(',')}`).sort(),
  };
}

describe('registry-based plugins: the incremental index keeps parity with buildIndex', () => {
  const SRC = `${R}/src`;

  it('file by file from an empty index → the same index', async () => {
    const A = snapshot(await buildIndex(new MemoryFileSystem(files), SRC));
    const fs = new MemoryFileSystem(files);
    const index = await buildIndex(new MemoryFileSystem({}), SRC);
    for (const f of Object.keys(files)) if (f.includes('/src/')) await updateIndexForFile(fs, { srcDir: SRC, index }, f);
    expect(snapshot(index)).toEqual(A);
  });

  it("an edit to a plugin's index renames what it registers", async () => {
    const fs = new MemoryFileSystem({ ...files });
    const index = await buildIndex(fs, SRC);
    const idx = `${SRC}/plugins/keys/server/services/index.js`;
    fs.writeFile(idx, "module.exports = { welcome: require('./my-service') };\n");
    await updateIndexForFile(fs, { srcDir: SRC, index }, idx);
    expect(index.services.has('plugin::keys.welcome')).toBe(true);
    expect(index.services.has('plugin::keys.myService')).toBe(false);
    expect(snapshot(index)).toEqual(snapshot(await buildIndex(fs, SRC)));
  });

  it("a plugin's deleted files leave none of its artifacts behind", async () => {
    const fs = new MemoryFileSystem({ ...files });
    const index = await buildIndex(fs, SRC);
    for (const f of Object.keys(files).filter((f) => f.includes('/plugins/keys/'))) fs.delete(f);
    await updateIndexForFile(fs, { srcDir: SRC, index }, `${SRC}/plugins/keys/server/services/index.js`);
    expect([...index.services.keys(), ...index.controllers.keys()].filter((k) => k.startsWith('plugin::keys.'))).toEqual([]);
    expect(snapshot(index)).toEqual(snapshot(await buildIndex(fs, SRC)));
  });
});
