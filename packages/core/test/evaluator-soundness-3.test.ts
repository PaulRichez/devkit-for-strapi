/**
 * Third-round soundness regressions (adversarial re-verification). Same contract:
 * never hang; never `complete` while the code registers something DevKit missed;
 * the project's own code rewriting a plugin makes it unverifiable — with or
 * without node_modules — and mainstream tsc output stays complete and exact.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { readInstalledPlugins, type InstalledPlugin } from '../src/plugins/installed';
import { pluginWriteTargets } from '../src/plugins/rewrites';
import { validateRef } from '../src/query/refQuery';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
function app(pluginFiles: Record<string, string>, extra: Record<string, string> = {}): MemoryFileSystem {
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0', 'my-plugin': '1.0.0' } }),
    [`${NM}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
    [`${NM}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
    [`${NM}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${NM}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' } }),
    ...extra,
  };
  for (const [k, v] of Object.entries(pluginFiles)) files[`${NM}/my-plugin/${k}`] = v;
  return new MemoryFileSystem(files);
}
const TIMEOUT = 'TIMEOUT' as const;
async function read(fs: MemoryFileSystem): Promise<InstalledPlugin> {
  const r = await Promise.race([readInstalledPlugins(fs, ROOT), new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), 8000))]);
  expect(r, 'must not hang').not.toBe(TIMEOUT);
  if (r === TIMEOUT) throw new Error('hang');
  return r!.plugins.find((x) => x.name === 'my-plugin')!;
}
/** Through the engine: is plugin::my-plugin.extra reported unknown (a false positive)? */
async function engineSaysUnknown(fs: MemoryFileSystem): Promise<boolean> {
  const engine = createEngine(fs);
  await engine.init([ROOT]);
  return validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status === 'unknown';
}
const C = `({ strapi }) => ({ async a(ctx) {} })`;
const SRV = { 'strapi-server.js': `module.exports = { controllers: { main: ${C} } };` };
type Case = Record<string, string> | [Record<string, string>, Record<string, string>];
const cases: Record<string, Case> = {
  P50_param_default_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction f(o = controllers) { o.extra = ${C}; }\nf();\nmodule.exports = { controllers };` },
  P51_binding_default_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nconst { a = controllers } = {};\na.extra = ${C};\nmodule.exports = { controllers };` },
  P52_cross_file_call_result_alias: {
    'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c').getControllers() };`,
    'c.js': `const controllers = { main: ${C} };\nexports.getControllers = () => controllers;`,
    'patch.js': `const c = require('./c');\nconst ctrls = c.getControllers();\nctrls.extra = ${C};\nmodule.exports = {};`,
  },
  P53_same_file_call_result_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction get() { return controllers; }\nconst r = get();\nr.extra = ${C};\nmodule.exports = { controllers };` },
  P54_renamed_fn_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction get() { return controllers; }\nconst g = get;\ng().extra = ${C};\nmodule.exports = { controllers };` },
  P55_getter_return_written: { 'strapi-server.js': `const controllers = { main: ${C} };\nconst s = { get c() { return controllers; } };\ns.c.extra = ${C};\nmodule.exports = { controllers };` },
  P56_module_this_method: {
    'strapi-server.js': `const reg = require('./registry');\nreg.register('extra', ${C});\nmodule.exports = { controllers: reg.items };`,
    'registry.js': `module.exports = { items: { main: ${C} }, register(k, v) { this.items[k] = v; } };`,
  },
  P57a_lodash_named_assign: {
    'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c') };`,
    'c.js': `module.exports = { main: ${C} };`,
    'patch.js': `const lodash = require('lodash');\nconst c = require('./c');\nlodash.assign(c, { extra: ${C} });\nmodule.exports = {};`,
  },
  P57b_destructured_merge: {
    'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c') };`,
    'c.js': `module.exports = { main: ${C} };`,
    'patch.js': `const { merge } = require('lodash');\nconst c = require('./c');\nmerge(c, { extra: ${C} });\nmodule.exports = {};`,
  },
  P57c_reflect_set: {
    'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c') };`,
    'c.js': `module.exports = { main: ${C} };`,
    'patch.js': `const c = require('./c');\nReflect.set(c, 'extra', ${C});\nmodule.exports = {};`,
  },
  P58a_module_alias: {
    'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c') };`,
    'c.js': `module.exports = { main: ${C} };`,
    'patch.js': `const c = require('./c');\nconst d = c;\nd.extra = ${C};\nmodule.exports = {};`,
  },
  P58b_module_default_alias: {
    'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c').default };`,
    'c.js': `exports.default = { main: ${C} };`,
    'patch.js': `const m = require('./c');\nconst d = m.default;\nd.extra = ${C};\nmodule.exports = {};`,
  },
  P59_module_via_param: {
    'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c') };`,
    'c.js': `module.exports = { main: ${C} };`,
    'patch.js': `function patch(m) { m.extra = ${C}; }\npatch(require('./c'));\nmodule.exports = {};`,
  },
  P60_destructured_plugin_fn: [SRV, { [`${ROOT}/src/index.ts`]: `export default { register({ strapi: { plugin } }) { plugin('my-plugin').controllers.extra = ${C}; } };` }],
  P60b_bracket_access: [SRV, { [`${ROOT}/src/index.ts`]: `export default { register({ strapi }) { strapi['plugin']('my-plugin')['controllers'].extra = ${C}; } };` }],
  P61_alias_by_assignment: [SRV, { [`${ROOT}/src/index.ts`]: `let p;\nexport default { register({ strapi }) { p = strapi.plugin('my-plugin'); p.controllers.extra = ${C}; } };` }],
  P62_alias_via_param: [SRV, { [`${ROOT}/src/index.ts`]: `function extend(plugin) { plugin.controllers.extra = ${C}; }\nexport default { register({ strapi }) { extend(strapi.plugin('my-plugin')); } };` }],
  P62b_collection_via_param: [SRV, { [`${ROOT}/src/index.ts`]: `function add(controllers) { controllers.extra = ${C}; }\nexport default { register({ strapi }) { add(strapi.plugin('my-plugin').controllers); } };` }],
  P64_local_plugin_outside_src: [SRV, {
    [`${ROOT}/config/plugins.js`]: `module.exports = { local: { enabled: true, resolve: './plugins/local' } };`,
    [`${ROOT}/plugins/local/strapi-server.js`]: `module.exports = { register({ strapi }) { strapi.plugin('my-plugin').controllers.extra = ${C}; } };`,
  }],
};


Object.assign(cases, {
  P60_destructured_plugin_fn: [SRV, { [`${ROOT}/src/index.ts`]: `export default { register({ strapi: { plugin } }) { plugin('my-plugin').controllers.extra = ${C}; } };` }],
  P60b_bracket_access: [SRV, { [`${ROOT}/src/index.ts`]: `export default { register({ strapi }) { strapi['plugin']('my-plugin')['controllers'].extra = ${C}; } };` }],
  P61_alias_by_assignment: [SRV, { [`${ROOT}/src/index.ts`]: `let p;\nexport default { register({ strapi }) { p = strapi.plugin('my-plugin'); p.controllers.extra = ${C}; } };` }],
  P62_alias_via_param: [SRV, { [`${ROOT}/src/index.ts`]: `function extend(plugin) { plugin.controllers.extra = ${C}; }\nexport default { register({ strapi }) { extend(strapi.plugin('my-plugin')); } };` }],
  P62b_collection_via_param: [SRV, { [`${ROOT}/src/index.ts`]: `function add(controllers) { controllers.extra = ${C}; }\nexport default { register({ strapi }) { add(strapi.plugin('my-plugin').controllers); } };` }],
  P50_param_default_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction f(o = controllers) { o.extra = ${C}; }\nf();\nmodule.exports = { controllers };` },
  P51_binding_default_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nconst { a = controllers } = {};\na.extra = ${C};\nmodule.exports = { controllers };` },
  P53_same_file_call_result_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction get() { return controllers; }\nconst r = get();\nr.extra = ${C};\nmodule.exports = { controllers };` },
  P54_renamed_fn_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction get() { return controllers; }\nconst g = get;\ng().extra = ${C};\nmodule.exports = { controllers };` },
  P55_getter_return_written: { 'strapi-server.js': `const controllers = { main: ${C} };\nconst s = { get c() { return controllers; } };\ns.c.extra = ${C};\nmodule.exports = { controllers };` },
} as Record<string, Case>);

const TSC_INDEX = `"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const controllers = __importStar(require("./controllers"));
exports.default = { controllers };
`;
const TSC_CTRL = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = void 0;
const main = ({ strapi }) => ({ async a(ctx) { } });
exports.main = main;
`;

const STATIC_ONLY = new Set(['P64_local_plugin_outside_src', 'P60_destructured_plugin_fn', 'P60b_bracket_access', 'P61_alias_by_assignment', 'P62_alias_via_param', 'P62b_collection_via_param']);

describe('round 3: never complete with something missing', () => {
  for (const [name, c] of Object.entries(cases)) {
    it(name, async () => {
      const [pf, ex] = Array.isArray(c) ? c : [c, {}];
      const fs = app(pf, ex);
      const p = await read(fs);
      if (p.complete) {
        const refs = p.artifacts.map((a) => a.ref);
        expect(refs.includes('plugin::my-plugin.extra'), `${name}: complete but missing plugin::my-plugin.extra: ${JSON.stringify(refs)}`).toBe(true);
      }
      // and end to end, the engine never reports the runtime-added controller as unknown
      expect(await engineSaysUnknown(app(pf, ex))).toBe(false);
    }, 20000);
  }
  // cases built inline below, reused by name above where relevant
  void STATIC_ONLY;
});

describe('round 3: project-code rewrites, independent of node_modules', () => {
  it('more files than the scan limit never hide src/index (the plugin becomes unverifiable)', async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 2100; i++) extra[`${ROOT}/src/admin/extensions/f${i}.js`] = `export const x${i} = ${i};`;
    extra[`${ROOT}/src/index.ts`] = `export default { register({ strapi }) { strapi.plugin('my-plugin').controllers.extra = ${C}; } };`;
    expect(await engineSaysUnknown(app(SRV, extra))).toBe(false);
  }, 60000);

  for (const withModules of [false, true]) {
    it(`a local plugin rewritten from src/index is not verified (${withModules ? 'with' : 'without'} node_modules)`, async () => {
      const files: Record<string, string> = {
        [`${ROOT}/src/plugins/local/server/controllers/main.js`]: `module.exports = ({ strapi }) => ({ async a(ctx) {} });`,
        [`${ROOT}/src/index.ts`]: `export default { register({ strapi }) { strapi.plugin('local').controllers.extra = ({ strapi }) => ({ async b(ctx) {} }); } };`,
        [`${ROOT}/src/api/x/routes/x.js`]: `module.exports = { routes: [{ method: 'GET', path: '/x', handler: 'plugin::local.extra.b' }] };`,
      };
      const fs = withModules
        ? app(SRV, files)
        : new MemoryFileSystem({ [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0' } }), ...files });
      const engine = createEngine(fs);
      await engine.init([ROOT]);
      const f = `${ROOT}/src/api/x/routes/x.js`;
      expect(await engine.validateFile(f, await fs.readFile(f))).toEqual([]);
    });
  }

  it('editing any src file that rewrites a plugin is picked up', async () => {
    const fs = app(SRV, { [`${ROOT}/src/index.ts`]: `import register from './register';\nexport default { register };`, [`${ROOT}/src/register.ts`]: `export default () => {};` });
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const project = engine.allProjects()[0]!;
    expect(validateRef(project, 'plugin::my-plugin.extra').status).toBe('unknown');
    const f = `${ROOT}/src/register.ts`;
    fs.writeFile(f, `export default ({ strapi }) => { strapi.plugin('my-plugin').controllers.extra = ${C}; };`);
    await engine.onFilesChanged([f], []);
    expect(validateRef(project, 'plugin::my-plugin.extra').status).not.toBe('unknown');
  });

  it('reads of a plugin (services, config, provider) keep it verifiable', async () => {
    const fs = app(SRV, {
      [`${ROOT}/src/index.ts`]: `export default { async bootstrap({ strapi }) {
  const p = strapi.plugin('my-plugin');
  await p.service('x').find();
  const cfg = strapi.plugin('my-plugin').config('k');
  strapi.plugin('my-plugin').provider = {};
  console.log(cfg, p.controllers.main);
} };`,
    });
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status).toBe('unknown');
  });
});

describe('round 3: tsc 5.9 import * as (IIFE __importStar) stays complete and exact', () => {
  it('reads the controllers namespace', async () => {
    const p = await read(app({
      'strapi-server.js': `module.exports = require('./dist/index.js');`,
      'dist/index.js': TSC_INDEX,
      'dist/controllers.js': TSC_CTRL,
    }));
    expect(p.gaps).toEqual([]);
    expect(p.complete).toBe(true);
    expect(p.artifacts.map((a) => a.ref)).toEqual(['plugin::my-plugin.main']);
  });
});

describe('round 3: the rewrite scan stays precise on real plugin code', () => {
  const targets = (code: string): string[] => {
    const r = pluginWriteTargets(ts.createSourceFile('/x.js', code, ts.ScriptTarget.Latest, true));
    return [...[...r.plugins].map((x) => `plugin:${x}`), ...[...r.artifacts].map((x) => `artifact:${x}`)].sort();
  };
  it('reads through library calls are not rewrites', () => {
    expect(targets(`const _ = require('lodash');\nmodule.exports = () => ({ list() { return _.keys(strapi.plugin('users-permissions').policies); } });`)).toEqual([]);
    expect(targets(`var require$$0 = require('lodash');\nfunction _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }\nvar d = _interopDefault(require$$0);\nconst _ = d.default;\n_.flatMap(strapi.plugins, (plugin) => _.flatMap(plugin.controllers, (c) => _.keys(c)));`)).toEqual([]);
  });
  it('iterating plugins and writing into them is a rewrite', () => {
    expect(targets(`Object.values(strapi.plugins).forEach((p) => { p.controllers.extra = {}; });`)).toEqual(['plugin:*']);
    expect(targets(`for (const p of Object.values(strapi.plugins)) p.controllers.extra = {};`)).toEqual(['plugin:*']);
  });
  it('a plugin handle handed to another module or a mutating utility is a rewrite; to the runtime it is not', () => {
    expect(targets(`const { patch } = require('./patch');\npatch(strapi.plugin('x'));`)).toEqual(['plugin:x']);
    expect(targets(`Object.assign(strapi.plugin('x').controllers, { y: {} });`)).toEqual(['plugin:x']);
    expect(targets(`strapi.get('auth').register('content-api', strapi.plugin('x'));`)).toEqual([]);
  });
  it('only `strapi` (and its aliases) has plugin getters; names are scoped', () => {
    expect(targets(`const p = nexus.plugin({ name: 'x' });\nmodule.exports = { plugins: [p] };`)).toEqual([]);
    expect(targets(`const { plugin } = contentType;\nfoo({ plugin });`)).toEqual([]);
    expect(targets(`function a() { const route = strapi.plugin('x').routes; return route.length; }\nfunction b(route) { return { ...route }; }`)).toEqual([]);
    expect(targets(`const s = strapi;\ns.plugin('x').controllers.y = {};`)).toEqual(['plugin:x']);
  });
  it('members read while iterating are copies, not the collection', () => {
    expect(targets(`_.forEach(strapi.plugins, (plugin) => { const routes = _.flatMap(plugin.routes, (r) => r.routes ?? r); out.push(...routes.map((r) => ({ ...r }))); });`)).toEqual([]);
  });
});
