/**
 * Second-round soundness regressions (adversarial re-verification). Contract:
 * never hang; never `complete` while the code registers something DevKit missed;
 * and the mainstream compiler outputs (plain v4 JS, tsc CJS, Babel, the Strapi 5
 * SDK bundle) stay complete and exact.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { readInstalledPlugins, type InstalledPlugin } from '../src/plugins/installed';
import { installedStamp } from '../src/plugins/merge';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
function app(pluginFiles: Record<string, string>, extra: Record<string, string> = {}, major = 5): MemoryFileSystem {
  const v = major === 5 ? '5.10.0' : '4.25.0';
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': v, 'my-plugin': '1.0.0' } }),
    [`${NM}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: v }),
    [`${NM}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: v }),
    [`${NM}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${NM}/@strapi/strapi/dist/core/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${NM}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' } }),
    ...extra,
  };
  for (const [k, val] of Object.entries(pluginFiles)) files[`${NM}/my-plugin/${k}`] = val;
  return new MemoryFileSystem(files);
}
const TIMEOUT = 'TIMEOUT' as const;
async function read(fs: MemoryFileSystem): Promise<InstalledPlugin> {
  const r = await Promise.race([readInstalledPlugins(fs, ROOT), new Promise<typeof TIMEOUT>((res) => setTimeout(() => res(TIMEOUT), 8000))]);
  expect(r, 'must not hang').not.toBe(TIMEOUT);
  if (r === TIMEOUT) throw new Error('hang');
  return r!.plugins.find((x) => x.name === 'my-plugin')!;
}
const C = `({ strapi }) => ({ async a(ctx) {} })`;
type Case = Record<string, string> | [Record<string, string>, Record<string, string>];
const cases: Record<string, Case> = {
  P46_param_reassigned: { 'strapi-server.js': `function build(c) { c = { ...c, extra: ${C} }; return c; }\nmodule.exports = { controllers: build({ main: ${C} }) };` },
  P47_param_mutated: { 'strapi-server.js': `function build(c) { c.extra = ${C}; return c; }\nmodule.exports = { controllers: build({ main: ${C} }) };` },
  P34d_virtual_written_elsewhere_parsed: {
    'strapi-server.js': `var v = require('./_virtual/c.js');\nv.__module.exports = { main: ${C} };\nmodule.exports = { ...require('./other'), controllers: v.__module.exports };`,
    'other.js': `var w = require('./_virtual/c.js');\nw.__module.exports.extra = ${C};\nexports.x = 1;`,
    '_virtual/c.js': `var c = { exports: {} };\nexports.__module = c;`,
  },
  P27_mixed_shadow: { 'strapi-server.js': `module.exports = { controllers: require('./c') };`, 'c.js': `module.exports = { main: ${C} };\nfunction patch(exports) { module.exports.extra = ${C}; }\npatch({});` },
  P28_unused_require_patch: { 'strapi-server.js': `const unused = require('./patch');\nmodule.exports = { controllers: require('./c') };`, 'c.js': `module.exports = { main: ${C} };`, 'patch.js': `require('./c').extra = ${C};` },
  P29_top_this: { 'strapi-server.js': `module.exports = { controllers: require('./c') };`, 'c.js': `exports.main = ${C};\nthis.extra = ${C};` },
  P30a_conditional_override: { 'strapi-server.js': `const server = { controllers: { main: ${C}, extra: ${C} } };\nif (process.env.LITE) server.controllers = { main: ${C} };\nmodule.exports = server;` },
  P30b_write_after_capture: { 'strapi-server.js': `const s = { c: { main: ${C}, extra: ${C} } };\nmodule.exports = { controllers: s.c };\ns.c = { main: ${C} };` },
  P30c_override_in_uncalled_fn: { 'strapi-server.js': `const server = { controllers: { main: ${C}, extra: ${C} } };\nfunction lite() { server.controllers = { main: ${C} }; }\nmodule.exports = server;` },
  P31a_obj_literal_arg: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction addTo(o) { o.c.extra = ${C}; }\naddTo({ c: controllers });\nmodule.exports = { controllers };` },
  P31b_array_forEach: { 'strapi-server.js': `const controllers = { main: ${C} };\n[controllers].forEach((c) => { c.extra = ${C}; });\nmodule.exports = { controllers };` },
  P31c_alias_var: { 'strapi-server.js': `const server = { controllers: { main: ${C} } };\nconst c = server.controllers;\nc.extra = ${C};\nmodule.exports = server;` },
  P31d_destructured_alias: { 'strapi-server.js': `const server = { controllers: { main: ${C} } };\nconst { controllers } = server;\ncontrollers.extra = ${C};\nmodule.exports = server;` },
  P31e_new_arg: { 'strapi-server.js': `const controllers = { main: ${C} };\nclass R { constructor(o) { o.extra = ${C}; } }\nnew R(controllers);\nmodule.exports = { controllers };` },
  P31f_holder_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nconst holder = {};\nholder.c = controllers;\nholder.c.extra = ${C};\nmodule.exports = { controllers };` },
  P31g_return_alias: { 'strapi-server.js': `const controllers = { main: ${C} };\nfunction get() { return controllers; }\nget().extra = ${C};\nmodule.exports = { controllers };` },
  P32_patch_via_default_alias: { 'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c').default };`, 'c.js': `exports.default = { main: ${C} };`, 'patch.js': `const c = require('./c').default;\nc.extra = ${C};\nmodule.exports = {};` },
  P33_patch_object_assign: { 'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c') };`, 'c.js': `module.exports = { main: ${C} };`, 'patch.js': `const c = require('./c');\nObject.assign(c, { extra: ${C} });\nmodule.exports = {};` },
  P34_virtual_object_assign: {
    'strapi-server.js': `var v = require('./_virtual/c.js');\nv.__module.exports = { main: ${C} };\nObject.assign(v.__module.exports, { extra: ${C} });\nmodule.exports = { controllers: v.__module.exports };`,
    '_virtual/c.js': `var c = { exports: {} };\nexports.__module = c;`,
  },
  P34b_virtual_push: {
    'strapi-server.js': `var v = require('./_virtual/r.js');\nv.__module.exports = [{ method: 'GET', path: '/a', handler: 'main.a' }];\nv.__module.exports.push({ method: 'GET', path: '/b', handler: 'main.b' });\nmodule.exports = { controllers: { main: ${C} }, routes: v.__module.exports };`,
    '_virtual/r.js': `var r = { exports: {} };\nexports.__module = r;`,
  },
  P34c_virtual_written_elsewhere: {
    'strapi-server.js': `const o = require('./other');\nvar v = require('./_virtual/c.js');\nv.__module.exports = { main: ${C} };\nmodule.exports = { controllers: v.__module.exports, x: o.x };`,
    'other.js': `var w = require('./_virtual/c.js');\nw.__module.exports.extra = ${C};\nexports.x = 1;`,
    '_virtual/c.js': `var c = { exports: {} };\nexports.__module = c;`,
  },
  P35_shim_self_reference: { 'strapi-server.js': `const { createContentApiRoutesFactory } = require('@strapi/utils');\nconst factory = createContentApiRoutesFactory(() => [...factory().routes]);\nmodule.exports = { controllers: { main: ${C} }, routes: { 'content-api': factory } };` },
  P36_module_alias: { 'strapi-server.js': `module.exports = { controllers: require('./c') };`, 'c.js': `exports.main = ${C};\nconst m = module;\nm.exports.extra = ${C};` },
  P37_module_passed: { 'strapi-server.js': `module.exports = { controllers: require('./c') };`, 'c.js': `exports.main = ${C};\nfunction reg(mod) { mod.exports.extra = ${C}; }\nreg(module);` },
  P38_this_method_mutation: { 'strapi-server.js': `const registry = { items: { main: ${C} }, register(k, v) { this.items[k] = v; } };\nregistry.register('extra', ${C});\nmodule.exports = { controllers: registry.items };` },
  P39_shadowed_console: { 'strapi-server.js': `const console = { log: (o) => { o.extra = ${C}; } };\nconst controllers = { main: ${C} };\nconsole.log(controllers);\nmodule.exports = { controllers };` },
  P39b_interop_named_method: { 'strapi-server.js': `const u = { interopPatch: (o) => { o.extra = ${C}; } };\nconst controllers = { main: ${C} };\nu.interopPatch(controllers);\nmodule.exports = { controllers };` },
  P40_project_register_file: [
    { 'strapi-server.js': `module.exports = { controllers: { main: ${C} } };` },
    { [`${ROOT}/src/index.ts`]: `import register from './register';\nexport default { register };`, [`${ROOT}/src/register.ts`]: `export default ({ strapi }) => { strapi.plugin('my-plugin').controllers.extra = ${C}; };` },
  ],
  P41_project_alias: [
    { 'strapi-server.js': `module.exports = { controllers: { main: ${C} } };` },
    { [`${ROOT}/src/index.ts`]: `export default { register({ strapi }) { const p = strapi.plugin('my-plugin'); p.controllers.extra = ${C}; } };` },
  ],
  P41b_project_destructure: [
    { 'strapi-server.js': `module.exports = { controllers: { main: ${C} } };` },
    { [`${ROOT}/src/index.ts`]: `export default { register({ strapi }) { const { controllers } = strapi.plugin('my-plugin'); controllers.extra = ${C}; } };` },
  ],
  P41c_strapi_controller_getter: [
    { 'strapi-server.js': `module.exports = { controllers: { main: ${C} } };` },
    { [`${ROOT}/src/index.ts`]: `export default { register({ strapi }) { strapi.controller('plugin::my-plugin.main').b = async () => {}; } };` },
  ],
  P43_local_plugin_register: [
    { 'strapi-server.js': `module.exports = { controllers: { main: ${C} } };` },
    { [`${ROOT}/src/plugins/local/server/register.js`]: `module.exports = ({ strapi }) => { strapi.plugin('my-plugin').controllers.extra = ${C}; };` },
  ],
  P44_plugin_helper_file: {
    'strapi-server.js': `module.exports = { register: require('./register'), controllers: { main: ${C} } };`,
    'register.js': `const patch = require('./patch');\nmodule.exports = ({ strapi }) => patch(strapi);`,
    'patch.js': `module.exports = (strapi) => { strapi.plugin('my-plugin').controllers.extra = ${C}; };`,
  },
};


describe('round 2: never complete with something missing', () => {
  for (const [name, c] of Object.entries(cases)) {
    it(name, async () => {
      const [pf, ex] = Array.isArray(c) ? c : [c, {}];
      const p = await read(app(pf, ex));
      if (!p.complete) return;
      const refs = p.artifacts.map((a) => a.ref);
      const routes = p.routes.map((r) => r.path);
      // every case registers an `extra` controller (or a `/b` route, or a `b` action) at runtime
      const actions = p.artifacts.flatMap((a) => (a.actions ?? []).map((x) => x.name));
      // an artifact extended in place (strapi.controller('plugin::x.main').b = …) may instead keep its name but lose its exhaustive method list
      const mainPartial = p.artifacts.some((a) => a.ref === 'plugin::my-plugin.main' && a.hasSpread);
      const ok = refs.includes('plugin::my-plugin.extra') || routes.includes('/b') || actions.includes('b') || (name.includes('controller_getter') && mainPartial);
      expect(ok, `${name}: complete but missing what it registers: ${JSON.stringify({ refs, routes })}`).toBe(true);
    }, 15000);
  }
});

describe('round 2: freshness', () => {
  it('editing a non-entry file of a plugin changes the full fingerprint', async () => {
    const fs = app({
      'strapi-server.js': `module.exports = require('./server');`,
      'server/index.js': `module.exports = { controllers: require('./controllers') };`,
      'server/controllers/index.js': `module.exports = { main: ${C} };`,
    });
    const r = await readInstalledPlugins(fs, ROOT);
    const s1 = await installedStamp(fs, ROOT, r!.strapiDir, r, true);
    fs.writeFile(`${NM}/my-plugin/server/controllers/index.js`, `module.exports = { main: ${C}, extra: ${C} };`);
    const s2 = await installedStamp(fs, ROOT, r!.strapiDir, r, true);
    expect(s1).not.toBe(s2);
  });
});

const TSC_HELPERS = `var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};`;
const TSC_STAR = `var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};`;

const shapes: Record<string, [Record<string, string>, number?]> = {
  v4_plain_js: [{
    'strapi-server.js': `'use strict';\nmodule.exports = require('./server');`,
    'server/index.js': `'use strict';\nconst register = require('./register');\nconst bootstrap = require('./bootstrap');\nconst controllers = require('./controllers');\nconst routes = require('./routes');\nconst services = require('./services');\nconst contentTypes = require('./content-types');\nmodule.exports = { register, bootstrap, controllers, routes, services, contentTypes, config: { default: {}, validator() {} }, policies: {}, middlewares: {} };`,
    'server/register.js': `'use strict';\nmodule.exports = ({ strapi }) => {\n  // register phase\n};`,
    'server/bootstrap.js': `'use strict';\nmodule.exports = ({ strapi }) => {\n  strapi.log.info(strapi.plugin('my-plugin').service('myService').getWelcomeMessage());\n};`,
    'server/controllers/index.js': `'use strict';\nconst myController = require('./my-controller');\nmodule.exports = { myController };`,
    'server/controllers/my-controller.js': `'use strict';\nmodule.exports = ({ strapi }) => ({\n  index(ctx) {\n    ctx.body = strapi.plugin('my-plugin').service('myService').getWelcomeMessage();\n  },\n});`,
    'server/services/index.js': `'use strict';\nconst myService = require('./my-service');\nmodule.exports = { myService };`,
    'server/services/my-service.js': `'use strict';\nmodule.exports = ({ strapi }) => ({\n  getWelcomeMessage() { return 'Welcome'; },\n});`,
    'server/routes/index.js': `module.exports = [\n  { method: 'GET', path: '/', handler: 'myController.index', config: { policies: [] } },\n];`,
    'server/content-types/index.js': `'use strict';\nconst item = require('./item');\nmodule.exports = { item };`,
    'server/content-types/item/index.js': `'use strict';\nconst schema = require('./schema.json');\nmodule.exports = { schema };`,
    'server/content-types/item/schema.json': JSON.stringify({ kind: 'collectionType', info: { singularName: 'item', pluralName: 'items' }, attributes: { title: { type: 'string' } } }),
  }, 4],
  tsc_cjs: [{
    'strapi-server.js': `'use strict';\nmodule.exports = require('./dist/server');`,
    'dist/server/index.js': `"use strict";\n${TSC_HELPERS}\nObject.defineProperty(exports, "__esModule", { value: true });\nconst register_1 = __importDefault(require("./register"));\nconst controllers_1 = __importDefault(require("./controllers"));\nconst services_1 = __importDefault(require("./services"));\nconst routes_1 = __importDefault(require("./routes"));\nexports.default = {\n    register: register_1.default,\n    controllers: controllers_1.default,\n    services: services_1.default,\n    routes: routes_1.default,\n};`,
    'dist/server/register.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = ({ strapi }) => {\n    // register phase\n};`,
    'dist/server/controllers/index.js': `"use strict";\n${TSC_HELPERS}\nObject.defineProperty(exports, "__esModule", { value: true });\nconst controller_1 = __importDefault(require("./controller"));\nexports.default = {\n    controller: controller_1.default,\n};`,
    'dist/server/controllers/controller.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nconst controller = ({ strapi }) => ({\n    index(ctx) {\n        ctx.body = strapi.plugin('my-plugin').service('service').getWelcomeMessage();\n    },\n});\nexports.default = controller;`,
    'dist/server/services/index.js': `"use strict";\n${TSC_HELPERS}\nObject.defineProperty(exports, "__esModule", { value: true });\nconst service_1 = __importDefault(require("./service"));\nexports.default = {\n    service: service_1.default,\n};`,
    'dist/server/services/service.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = ({ strapi }) => ({\n    getWelcomeMessage() {\n        return 'Welcome';\n    },\n});`,
    'dist/server/routes/index.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = [\n    { method: 'GET', path: '/', handler: 'controller.index', config: { policies: [] } },\n];`,
  }, 4],
  tsc_cjs_named_reexports: [{
    'strapi-server.js': `module.exports = require('./dist/server');`,
    'dist/server/index.js': `"use strict";\n${TSC_HELPERS}\nObject.defineProperty(exports, "__esModule", { value: true });\nconst controllers_1 = require("./controllers");\nexports.default = { controllers: controllers_1.controllers };`,
    'dist/server/controllers/index.js': `"use strict";\n${TSC_HELPERS}\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.controllers = void 0;\nconst a_1 = __importDefault(require("./a"));\nexports.controllers = { a: a_1.default };`,
    'dist/server/controllers/a.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = ({ strapi }) => ({ find() {} });`,
  }],
  tsc_export_star: [{
    'strapi-server.js': `module.exports = { controllers: require('./dist/controllers') };`,
    'dist/controllers/index.js': `"use strict";\n${TSC_STAR}\nObject.defineProperty(exports, "__esModule", { value: true });\n__exportStar(require("./a"), exports);\n__exportStar(require("./b"), exports);`,
    'dist/controllers/a.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.a = void 0;\nconst a = ({ strapi }) => ({ find() {} });\nexports.a = a;`,
    'dist/controllers/b.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.b = void 0;\nconst b = ({ strapi }) => ({ find() {} });\nexports.b = b;`,
  }],
  tsc_export_default_as: [{
    'strapi-server.js': `module.exports = { controllers: require('./dist/controllers') };`,
    'dist/controllers/index.js': `"use strict";\n${TSC_HELPERS}\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.b = exports.a = void 0;\nvar a_1 = require("./a");\nObject.defineProperty(exports, "a", { enumerable: true, get: function () { return __importDefault(a_1).default; } });\nvar b_1 = require("./b");\nObject.defineProperty(exports, "b", { enumerable: true, get: function () { return __importDefault(b_1).default; } });`,
    'dist/controllers/a.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = ({ strapi }) => ({ find() {} });`,
    'dist/controllers/b.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = ({ strapi }) => ({ find() {} });`,
  }],
  babel: [{
    'strapi-server.js': `module.exports = require('./lib/server').default;`,
    'lib/server/index.js': `"use strict";\nObject.defineProperty(exports, "__esModule", {\n  value: true\n});\nexports.default = void 0;\nvar _controllers = _interopRequireDefault(require("./controllers"));\nvar _register = _interopRequireDefault(require("./register"));\nfunction _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }\nvar _default = exports.default = {\n  register: _register.default,\n  controllers: _controllers.default\n};`,
    'lib/server/register.js': `"use strict";\nObject.defineProperty(exports, "__esModule", {\n  value: true\n});\nexports.default = void 0;\nvar _default = ({\n  strapi\n}) => {};\nexports.default = _default;`,
    'lib/server/controllers/index.js': `"use strict";\nObject.defineProperty(exports, "__esModule", {\n  value: true\n});\nexports.default = void 0;\nvar _main = _interopRequireDefault(require("./main"));\nfunction _interopRequireDefault(e) { return e && e.__esModule ? e : { default: e }; }\nvar _default = exports.default = {\n  main: _main.default\n};`,
    'lib/server/controllers/main.js': `"use strict";\nObject.defineProperty(exports, "__esModule", {\n  value: true\n});\nexports.default = void 0;\nvar _default = ({\n  strapi\n}) => ({\n  async find(ctx) {}\n});\nexports.default = _default;`,
  }],
  tsup_esbuild_cjs: [{
    'strapi-server.js': `module.exports = require('./dist/server/index.js');`,
    'dist/server/index.js': `"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var server_exports = {};
__export(server_exports, {
  default: () => server_default
});
module.exports = __toCommonJS(server_exports);
var main = ({ strapi }) => ({ async find(ctx) {} });
var controllers = { main };
var server_default = { controllers };`,
  }],
  sdk_single_bundle: [{
    'strapi-server.js': `module.exports = require('./dist/server/index.js');`,
    'dist/server/index.js': `"use strict";
const bootstrap = ({ strapi }) => {};
const register = ({ strapi }) => {};
const config = { default: {}, validator() {} };
const contentTypes = {};
const controller = ({ strapi }) => ({
  index(ctx) {
    ctx.body = strapi.plugin("my-plugin").service("service").getWelcomeMessage();
  }
});
const controllers = { controller };
const middlewares = {};
const policies = {};
const contentAPIRoutes = [{ method: "GET", path: "/", handler: "controller.index", config: { policies: [] } }];
const routes = { "content-api": { type: "content-api", routes: contentAPIRoutes } };
const service = ({ strapi }) => ({ getWelcomeMessage() { return "Welcome"; } });
const services = { service };
const index = { register, bootstrap, config, controllers, routes, services, contentTypes, policies, middlewares };
module.exports = index;`,
  }],
  sdk_single_bundle_with_utils: [{
    'strapi-server.js': `module.exports = require('./dist/server/index.js');`,
    'dist/server/index.js': `"use strict";
const utils = require("@strapi/utils");
const bootstrap = ({ strapi }) => {
  strapi.log.info("ok");
};
const controller = ({ strapi }) => ({
  async find(ctx) {
    const { query } = ctx;
    ctx.body = await strapi.plugin("my-plugin").service("service").find(query);
  }
});
const controllers = { controller };
const service = ({ strapi }) => ({
  async find(params) { return utils.sanitize ? params : params; }
});
const services = { service };
const routes = { "content-api": { type: "content-api", routes: [{ method: "GET", path: "/x", handler: "controller.find" }] } };
const index = { bootstrap, controllers, routes, services };
module.exports = index;`,
  }],
};


const EXPECTED: Record<string, string[]> = {
  v4_plain_js: ['content-type:plugin::my-plugin.item', 'controller:plugin::my-plugin.myController', 'service:plugin::my-plugin.myService'],
  tsc_cjs: ['controller:plugin::my-plugin.controller', 'service:plugin::my-plugin.service'],
  tsc_cjs_named_reexports: ['controller:plugin::my-plugin.a'],
  tsc_export_star: ['controller:plugin::my-plugin.a', 'controller:plugin::my-plugin.b'],
  tsc_export_default_as: ['controller:plugin::my-plugin.a', 'controller:plugin::my-plugin.b'],
  babel: ['controller:plugin::my-plugin.main'],
  sdk_single_bundle: ['controller:plugin::my-plugin.controller', 'service:plugin::my-plugin.service'],
  sdk_single_bundle_with_utils: ['controller:plugin::my-plugin.controller', 'service:plugin::my-plugin.service'],
};

describe('round 2: mainstream compiler outputs stay complete and exact', () => {
  for (const [name, [files, major]] of Object.entries(shapes)) {
    it(name, async () => {
      const p = await read(app(files, {}, major ?? 5));
      const got = [...p.contentTypes.map((c) => `content-type:${c.uid}`), ...p.artifacts.map((a) => `${a.kind}:${a.ref}`)].sort();
      if (!EXPECTED[name]) {
        // esbuild/tsup: incomplete is acceptable, never complete-and-wrong
        if (p.complete) expect(got).toEqual(['controller:plugin::my-plugin.main']);
        return;
      }
      expect(p.gaps).toEqual([]);
      expect(p.complete).toBe(true);
      expect(got).toEqual([...EXPECTED[name]!].sort());
    });
  }
});

describe('round 2: no false positive on tsc getter re-exports (end to end)', () => {
  it('a tsc `export { default as a }` controller action is valid', async () => {
    const fs = app(
      {
        'strapi-server.js': `module.exports = { controllers: require('./dist/controllers') };`,
        'dist/controllers/index.js': `"use strict";\n${TSC_HELPERS}\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.a = void 0;\nvar a_1 = require("./a");\nObject.defineProperty(exports, "a", { enumerable: true, get: function () { return __importDefault(a_1).default; } });`,
        'dist/controllers/a.js': `"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\nexports.default = ({ strapi }) => ({ async customAction(ctx) {} });`,
      },
      { [`${ROOT}/src/api/x/routes/x.js`]: `module.exports = { routes: [{ method: 'GET', path: '/x', handler: 'plugin::my-plugin.a.customAction' }] };` },
    );
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const f = `${ROOT}/src/api/x/routes/x.js`;
    expect(await engine.validateFile(f, await fs.readFile(f))).toEqual([]);
  });
});
