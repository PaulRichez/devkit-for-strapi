/**
 * Soundness regressions for the installed-plugin reader (from an adversarial audit).
 * The contract: the reader never hangs, and a plugin it reports `complete` holds
 * EVERYTHING the code registers — otherwise DevKit would report a real ref as unknown.
 * Shapes it can model exactly (Babel/tsc output, chained exports…) must stay complete.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { type InstalledPlugin, readInstalledPlugins } from '../src/plugins/installed';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
const CTRL = `({ strapi }) => ({ async a(ctx) {} })`;
const MAIN = 'controller:plugin::my-plugin.main';
const EXTRA = 'controller:plugin::my-plugin.extra';

function app(pluginFiles: Record<string, string>, extra: Record<string, string> = {}, pkg: Record<string, unknown> = {}): MemoryFileSystem {
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0', 'my-plugin': '1.0.0' } }),
    [`${NM}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
    [`${NM}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
    [`${NM}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${NM}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' }, ...pkg }),
    ...extra,
  };
  for (const [k, v] of Object.entries(pluginFiles)) files[`${NM}/my-plugin/${k}`] = v;
  return new MemoryFileSystem(files);
}

const TIMEOUT = 'TIMEOUT' as const;
function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), ms))]);
}

async function read(fs: MemoryFileSystem): Promise<InstalledPlugin> {
  const res = await withTimeout(readInstalledPlugins(fs, ROOT));
  expect(res, 'the reader must not hang').not.toBe(TIMEOUT);
  if (res === TIMEOUT) throw new Error('hang');
  return res!.plugins.find((x) => x.name === 'my-plugin')!;
}

const arts = (p: InstalledPlugin): string[] => p.artifacts.map((a) => `${a.kind}:${a.ref}`).sort();

/** Never report complete with less than what the code registers. */
function expectSound(p: InstalledPlugin, registered: string[]): void {
  if (p.complete) expect(arts(p)).toEqual([...registered].sort());
}

/** Shapes DevKit models exactly: complete, and exact. */
function expectExact(p: InstalledPlugin, registered: string[]): void {
  expect(p.gaps).toEqual([]);
  expect(p.complete).toBe(true);
  expect(arts(p)).toEqual([...registered].sort());
}

describe('reader never hangs', () => {
  it('cyclic module.exports = require', async () => {
    await read(app({ 'strapi-server.js': `module.exports = require('./a');`, 'a.js': `module.exports = require('./b');`, 'b.js': `module.exports = require('./a');` }));
  });
  it('self-referential object', async () => {
    await read(app({ 'strapi-server.js': `const o = { controllers: o.controllers }; module.exports = o;` }));
  });
  it('export-star cycle', async () => {
    const p = await read(app({
      'strapi-server.js': `module.exports = { controllers: require('./c') };`,
      'c.js': `export * from './d'; export const main = ${CTRL};`,
      'd.js': `export * from './c';`,
    }));
    expectSound(p, [MAIN]);
  });
  it('engine init with a cyclic local-plugin content-types aggregator', async () => {
    const fs = new MemoryFileSystem({
      '/app/package.json': JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0' } }),
      '/app/src/plugins/p/server/content-types/index.ts': `export * from './a';`,
      '/app/src/plugins/p/server/content-types/a.ts': `export * from './index';\nexport const foo = { schema: { kind: 'collectionType', attributes: {} } };`,
    });
    const engine = createEngine(fs);
    expect(await withTimeout(engine.init(['/app']).then(() => 'ok'))).toBe('ok');
    expect(await withTimeout(engine.validateFile('/app/src/x.ts', 'x').then(() => 'ok'))).toBe('ok');
  });
  it('a long module chain stays bounded', async () => {
    const files: Record<string, string> = { 'strapi-server.js': `module.exports = { controllers: require('./m0') };` };
    for (let i = 0; i < 1400; i++) files[`m${i}.js`] = i < 1399 ? `module.exports = { ...require('./m${i + 1}'), k${i}: ${CTRL} };` : `module.exports = {};`;
    const t = Date.now();
    await read(app(files));
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('never complete with something missing', () => {
  it('early return depending on a runtime condition (EE plugins)', async () => {
    const p = await read(app({
      'strapi-server.js': `module.exports = ({ env }) => { if (env('X')) return { controllers: { main: ${CTRL}, extra: ${CTRL} } }; return { controllers: { main: ${CTRL} } }; };`,
    }));
    expectSound(p, [MAIN, EXTRA]);
    expect(p.complete).toBe(false);
  });
  it('nested write through a path', async () => {
    expectSound(await read(app({
      'strapi-server.js': `const server = require('./server'); server.controllers.extra = ${CTRL}; module.exports = server;`,
      'server.js': `module.exports = { controllers: { main: ${CTRL} } };`,
    })), [MAIN, EXTRA]);
  });
  it('mutation through a helper function', async () => {
    expectSound(await read(app({
      'strapi-server.js': `const controllers = { main: ${CTRL} };\nfunction addExtra(target) { target.extra = ${CTRL}; }\naddExtra(controllers);\nmodule.exports = { controllers };`,
    })), [MAIN, EXTRA]);
  });
  it('for-of / while loops writing exports', async () => {
    for (const loop of [`for (const k of ['extra']) exports[k] = ${CTRL};`, `let i = 0; while (i++ < 1) exports['extra'] = ${CTRL};`]) {
      expectSound(await read(app({
        'strapi-server.js': `module.exports = { controllers: require('./controllers') };`,
        'controllers.js': `exports.main = ${CTRL};\n${loop}`,
      })), [MAIN, EXTRA]);
    }
  });
  it('a function declaration writing exports (old tsc __export)', async () => {
    expectSound(await read(app({
      'strapi-server.js': `module.exports = { controllers: require('./controllers') };`,
      'controllers.js': `"use strict";\nfunction __export(m) { for (var p in m) if (!exports.hasOwnProperty(p)) exports[p] = m[p]; }\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.main = ${CTRL};\n__export(require("./more"));`,
      'more.js': `exports.extra = ${CTRL};`,
    })), [MAIN, EXTRA]);
  });
  it('an alias of module.exports', async () => {
    expectSound(await read(app({
      'strapi-server.js': `module.exports = { controllers: require('./controllers') };`,
      'controllers.js': `module.exports = { main: ${CTRL} };\nconst e = module.exports;\ne.extra = ${CTRL};`,
    })), [MAIN, EXTRA]);
  });
  it("module['exports'] assignment", async () => {
    expectSound(await read(app({
      'strapi-server.js': `module.exports = { controllers: require('./controllers') };`,
      'controllers.js': `exports.main = ${CTRL};\nmodule['exports'] = { main: ${CTRL}, extra: ${CTRL} };`,
    })), [MAIN, EXTRA]);
  });
  it('an IIFE writing into the server object', async () => {
    expectSound(await read(app({
      'strapi-server.js': `const s = { controllers: { main: ${CTRL} } };\n(function () { s.controllers.extra = ${CTRL}; })();\nmodule.exports = s;`,
    })), [MAIN, EXTRA]);
  });
  it('esbuild __export(target, { … })', async () => {
    expectSound(await read(app({
      'strapi-server.js': `var __defProp = Object.defineProperty;\nvar __export = (target, all) => { for (var name in all) __defProp(target, name, { get: all[name], enumerable: true }); };\nvar controllers = {};\n__export(controllers, { main: () => main, extra: () => extra });\nconst main = ${CTRL};\nconst extra = ${CTRL};\nmodule.exports = { controllers };`,
    })), [MAIN, EXTRA]);
  });
  it('initializer plus a conditional reassignment', async () => {
    expectSound(await read(app({
      'strapi-server.js': `let controllers = { main: ${CTRL}, extra: ${CTRL} };\nif (process.env.LITE) controllers = { main: ${CTRL} };\nmodule.exports = { controllers };`,
    })), [MAIN, EXTRA]);
  });
  it('parameter default value', async () => {
    expectSound(await read(app({
      'strapi-server.js': `const make = (extra = { extra: ${CTRL} }) => ({ main: ${CTRL}, ...extra });\nmodule.exports = { controllers: make() };`,
    })), [MAIN, EXTRA]);
  });
  it('duplicate var declaration', async () => {
    expectSound(await read(app({
      'strapi-server.js': `var controllers = { main: ${CTRL} };\nvar controllers = { main: ${CTRL}, extra: ${CTRL} };\nmodule.exports = { controllers };`,
    })), [MAIN, EXTRA]);
  });
  it('logical-assignment property write', async () => {
    expectSound(await read(app({
      'strapi-server.js': `const controllers = { main: ${CTRL} };\ncontrollers.extra ??= ${CTRL};\nmodule.exports = { controllers };`,
    })), [MAIN, EXTRA]);
  });
  it('a user function whose name looks like an interop helper', async () => {
    expectSound(await read(app({
      'strapi-server.js': `function interopControllers(base) { return { ...base, extra: ${CTRL} }; }\nmodule.exports = { controllers: interopControllers({ main: ${CTRL} }) };`,
    })), [MAIN, EXTRA]);
  });
  it('an array index write on routes', async () => {
    const p = await read(app({
      'strapi-server.js': `const routes = [{ method: 'GET', path: '/a', handler: 'main.a' }];\nroutes[1] = { method: 'GET', path: '/b', handler: 'main.a' };\nmodule.exports = { controllers: { main: ${CTRL} }, routes };`,
    }));
    if (p.complete) expect(p.routes.map((r) => r.path).sort()).toEqual(['/a', '/b']);
  });
  it('a collection key present but nil is a gap, not an empty collection', async () => {
    const p = await read(app({ 'strapi-server.js': `const c = require('./missing-at-runtime-only');\nmodule.exports = { controllers: c.nope };` }));
    expect(p.complete).toBe(false);
  });
});

describe('modelled shapes stay exact', () => {
  it('Babel 7.23+: var _default = exports.default = {…}', async () => {
    expectExact(await read(app({
      'strapi-server.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = void 0;\nvar _default = exports.default = { controllers: { main: ${CTRL} } };`,
    })), [MAIN]);
  });
  it('Babel loose mode: exports.__esModule = true', async () => {
    expectExact(await read(app({
      'strapi-server.js': `"use strict";\nexports.__esModule = true;\nexports.default = void 0;\nvar _default = { controllers: { main: ${CTRL} } };\nexports.default = _default;`,
    })), [MAIN]);
  });
  it('chained export assignment', async () => {
    expectExact(await read(app({
      'strapi-server.js': `module.exports = { controllers: require('./controllers') };`,
      'controllers.js': `exports.main = exports.extra = ${CTRL};`,
    })), [MAIN, EXTRA]);
  });
  it('rollup cached-require pattern (same identifier on every return)', async () => {
    expectExact(await read(app({
      'strapi-server.js': `var i = require('./i');\nmodule.exports = i.__require();`,
      'i.js': `var server;\nvar has;\nfunction req() {\n  if (has) return server;\n  has = 1;\n  server = { controllers: { main: ${CTRL} } };\n  return server;\n}\nexports.__require = req;`,
    })), [MAIN]);
  });
  it('exports map: conditions in object order (node before require)', async () => {
    const p = await read(app(
      {
        'dist/node.js': `module.exports = { controllers: { main: ${CTRL}, extra: ${CTRL} } };`,
        'dist/cjs.js': `module.exports = { controllers: { main: ${CTRL} } };`,
      },
      {},
      { exports: { './strapi-server': { node: './dist/node.js', require: './dist/cjs.js' } } },
    ));
    expectExact(p, [MAIN, EXTRA]);
  });
});

describe('project-side plugin rewrites', () => {
  it('src/index register() writing into a plugin makes it incomplete', async () => {
    const p = await read(app(
      { 'strapi-server.js': `module.exports = { controllers: { main: ${CTRL} } };` },
      { [`${ROOT}/src/index.ts`]: `export default { register({ strapi }) { strapi.plugin('my-plugin').controllers.extra = { a() {} }; } };` },
    ));
    expect(p.complete).toBe(false);
  });
  it('a mere read of a plugin in src/index keeps it complete', async () => {
    const p = await read(app(
      { 'strapi-server.js': `module.exports = { controllers: { main: ${CTRL} } };` },
      { [`${ROOT}/src/index.ts`]: `export default { async bootstrap({ strapi }) { await strapi.plugin('my-plugin').service('x'); } };` },
    ));
    expect(p.complete).toBe(true);
  });
});

describe('performance', () => {
  it('a 400 KB scope-hoisted bundle reads in well under a few seconds', async () => {
    const lines = [`'use strict';`];
    for (let i = 0; i < 5000; i++) lines.push(`const helper${i} = (x) => { const y = x + ${i}; return { y, z: [y, y, y] }; };`);
    for (let i = 0; i < 500; i++) lines.push(`const c${i} = ({ strapi }) => ({ async a${i}(ctx) { return helper0(ctx); }, async b${i}(ctx) {} });`);
    lines.push(`const controllers = { ${Array.from({ length: 500 }, (_, i) => `c${i}`).join(', ')} };`);
    lines.push(`module.exports = { controllers };`);
    const t = Date.now();
    const p = await read(app({ 'strapi-server.js': lines.join('\n') }));
    const ms = Date.now() - t;
    expect(ms).toBeLessThan(4000);
    expectSound(p, Array.from({ length: 500 }, (_, i) => `controller:plugin::my-plugin.c${i}`));
  }, 30_000);
});

describe('runtime rewrites inside a plugin', () => {
  it("a plugin's own register() pushing routes makes it incomplete", async () => {
    const p = await read(app({
      'strapi-server.js': `module.exports = { register: require('./register'), controllers: { main: ${CTRL} } };`,
      'register.js': `module.exports = ({ strapi }) => { strapi.plugin('my-plugin').routes['content-api'].routes.push({ method: 'GET', path: '/x', handler: 'main.a' }); };`,
    }));
    expect(p.complete).toBe(false);
  });
});
