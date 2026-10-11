import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { pathsOutsideRoots } from '../src/edit/plan';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { listUnused, validateRef } from '../src/query/refQuery';
import { readInstalledPlugins } from '../src/plugins/installed';

const ROOT = '/app';

/** A Strapi 5 app whose plugins are compiled the way rollup ships @strapi/* (per-file CJS + `__require` wrappers). */
function v5Files(extra: Record<string, string> = {}): Record<string, string> {
  const nm = `${ROOT}/node_modules`;
  return {
    [`${ROOT}/package.json`]: JSON.stringify({
      name: 'app',
      dependencies: { '@strapi/strapi': '5.10.0', '@strapi/plugin-users-permissions': '5.10.0', 'left-pad': '1.0.0' },
    }),
    [`${ROOT}/src/api/article/content-types/article/schema.json`]: JSON.stringify({
      kind: 'collectionType',
      info: { singularName: 'article', pluralName: 'articles' },
      attributes: { title: { type: 'string' }, author: { type: 'relation', relation: 'manyToOne', target: 'plugin::users-permissions.user' } },
    }),
    [`${nm}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
    [`${nm}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
    [`${nm}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [\n  '@strapi/upload'\n];`,
    // --- internal plugin: upload (rollup per-file output)
    [`${nm}/@strapi/upload/package.json`]: JSON.stringify({
      name: '@strapi/upload',
      version: '5.10.0',
      strapi: { name: 'upload', kind: 'plugin' },
      exports: { './strapi-server': { require: './dist/server/index.js', import: './dist/server/index.mjs' } },
    }),
    [`${nm}/@strapi/upload/dist/server/index.js`]: `'use strict';
var _commonjsHelpers = require('./_virtual/_commonjsHelpers.js');
var index$1 = require('./index2.js');
var serverExports = index$1.__require();
var index = /*@__PURE__*/ _commonjsHelpers.getDefaultExportFromCjs(serverExports);
module.exports = index;`,
    [`${nm}/@strapi/upload/dist/server/_virtual/_commonjsHelpers.js`]: `'use strict';
function getDefaultExportFromCjs (x) {
	return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, 'default') ? x['default'] : x;
}
exports.getDefaultExportFromCjs = getDefaultExportFromCjs;`,
    [`${nm}/@strapi/upload/dist/server/index2.js`]: `'use strict';
var services = require('./services/index.js');
var contentTypes = require('./content-types/index.js');
var utils = require('@strapi/utils');
var server;
var hasRequiredServer;
function requireServer() {
    if (hasRequiredServer) return server;
    hasRequiredServer = 1;
    const services$1 = services.__require();
    const { createContentApiRoutesFactory } = utils;
    const contentApi = createContentApiRoutesFactory(() => [
      { method: 'POST', path: '/', handler: 'content-api.upload' },
      { method: 'GET', path: '/files', handler: 'content-api.find', config: { auth: false } },
    ]);
    server = ()=>({
        services: services$1,
        contentTypes: contentTypes.default,
        controllers: { 'content-api': ({ strapi }) => ({ async upload(ctx) {}, async find(ctx) {} }) },
        routes: { 'content-api': contentApi, admin: { type: 'admin', routes: [{ method: 'GET', path: '/settings', handler: 'admin.getSettings' }] } },
    });
    return server;
}
exports.__require = requireServer;`,
    [`${nm}/@strapi/upload/dist/server/services/index.js`]: `'use strict';
var upload = require('./upload.js');
var services;
var hasRequiredServices;
function requireServices() {
    if (hasRequiredServices) return services;
    hasRequiredServices = 1;
    services = { upload: upload.default };
    return services;
}
exports.__require = requireServices;`,
    [`${nm}/@strapi/upload/dist/server/services/upload.js`]: `'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
var upload = ({ strapi }) => ({
  async uploadFiles() {},
  formatFileInfo() {},
});
exports.default = upload;`,
    [`${nm}/@strapi/upload/dist/server/content-types/index.js`]: `'use strict';
Object.defineProperty(exports, '__esModule', { value: true });
var schema = require('./file/schema.json');
exports.default = { file: { schema } };`,
    [`${nm}/@strapi/upload/dist/server/content-types/file/schema.json`]: JSON.stringify({
      collectionName: 'files',
      info: { singularName: 'file', pluralName: 'files' },
      attributes: { name: { type: 'string' }, url: { type: 'string' } },
    }),
    // --- dependency plugin: users-permissions (v4-style plain source)
    [`${nm}/@strapi/plugin-users-permissions/package.json`]: JSON.stringify({
      name: '@strapi/plugin-users-permissions',
      version: '5.10.0',
      strapi: { name: 'users-permissions', kind: 'plugin' },
    }),
    [`${nm}/@strapi/plugin-users-permissions/strapi-server.js`]: `module.exports = require('./server');`,
    [`${nm}/@strapi/plugin-users-permissions/server/index.js`]: `'use strict';
const services = require('./services');
module.exports = () => ({
  contentTypes: { user: { schema: require('./content-types/user/schema.json') } },
  services,
  policies: { rateLimit: () => {} },
});`,
    [`${nm}/@strapi/plugin-users-permissions/server/services/index.js`]: `'use strict';
const jwt = require('./jwt');
module.exports = { jwt, user: ({ strapi }) => ({ fetch() {}, add() {} }) };`,
    [`${nm}/@strapi/plugin-users-permissions/server/services/jwt.js`]: `'use strict';
module.exports = ({ strapi }) => ({ issue() {}, verify() {} });`,
    [`${nm}/@strapi/plugin-users-permissions/server/content-types/user/schema.json`]: JSON.stringify({
      kind: 'collectionType',
      info: { singularName: 'user', pluralName: 'users' },
      attributes: { username: { type: 'string' }, email: { type: 'email' } },
    }),
    // a non-plugin dependency
    [`${nm}/left-pad/package.json`]: JSON.stringify({ name: 'left-pad', version: '1.0.0' }),
    ...extra,
  };
}

function v5App(extra: Record<string, string> = {}): MemoryFileSystem {
  return new MemoryFileSystem(v5Files(extra));
}

/** Links resolved like the disk does (pnpm's node_modules/<dep> → node_modules/.pnpm/…/<dep>). */
class LinkedFs extends MemoryFileSystem {
  constructor(
    files: Record<string, string>,
    private readonly links: Record<string, string>,
  ) {
    super(files);
  }
  private real(p: string): string {
    for (const [link, target] of Object.entries(this.links)) if (p === link || p.startsWith(`${link}/`)) return target + p.slice(link.length);
    return p;
  }
  override readFile(p: string) {
    return super.readFile(this.real(p));
  }
  override readDirectory(p: string) {
    return super.readDirectory(this.real(p));
  }
  override stat(p: string) {
    return super.stat(this.real(p));
  }
  override exists(p: string) {
    return super.exists(this.real(p));
  }
  async realpath(p: string): Promise<string> {
    return this.real(p);
  }
}

/** The same app installed by pnpm (isolated layout): only the direct dependencies are linked at the root. */
function v5PnpmApp(): LinkedFs {
  const nm = `${ROOT}/node_modules`;
  const store = `${nm}/.pnpm/@strapi+strapi@5.10.0/node_modules`;
  const up = `${nm}/.pnpm/@strapi+plugin-users-permissions@5.10.0/node_modules`;
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(v5Files())) {
    if (path.startsWith(`${nm}/@strapi/plugin-users-permissions/`)) files[up + path.slice(nm.length)] = text;
    else if (path.startsWith(`${nm}/@strapi/`)) files[store + path.slice(nm.length)] = text; // strapi, core and the built-ins side by side
    else files[path] = text;
  }
  return new LinkedFs(files, {
    [`${nm}/@strapi/strapi`]: `${store}/@strapi/strapi`,
    [`${nm}/@strapi/plugin-users-permissions`]: `${up}/@strapi/plugin-users-permissions`,
  });
}

async function engineFor(fs: MemoryFileSystem) {
  const engine = createEngine(fs);
  await engine.init([ROOT]);
  const project = engine.allProjects()[0]!;
  return { engine, project };
}

describe('installed plugins — static reading', () => {
  it("pnpm's isolated layout: Strapi's built-in plugins are found next to its real folder", async () => {
    const res = await readInstalledPlugins(v5PnpmApp(), ROOT);
    expect(res?.strapiVersion).toBe('5.10.0');
    const names = res!.plugins.map((p) => p.name).sort();
    expect(names).toEqual(['upload', 'users-permissions']);
    expect(res!.plugins.find((p) => p.name === 'upload')).toMatchObject({ origin: 'internal', complete: true });
  });

  it('reads internal (rollup) and dependency (source) plugins exhaustively', async () => {
    const res = await readInstalledPlugins(v5App(), ROOT);
    expect(res?.strapiVersion).toBe('5.10.0');
    const upload = res!.plugins.find((p) => p.name === 'upload')!;
    expect(upload.origin).toBe('internal');
    expect(upload.gaps).toEqual([]);
    expect(upload.complete).toBe(true);
    expect(upload.contentTypes.map((c) => c.uid)).toEqual(['plugin::upload.file']);
    expect(upload.contentTypes[0]!.attributes.url?.type).toBe('string');
    const svc = upload.artifacts.find((a) => a.ref === 'plugin::upload.upload')!;
    expect(svc.actions?.map((a) => a.name)).toEqual(['uploadFiles', 'formatFileInfo']);
    expect(svc.hasSpread).toBeUndefined();
    expect(upload.routes.map((r) => `${r.type} ${r.method} ${r.fullPath} ${r.handler} ${r.public}`)).toEqual([
      'content-api POST /api/upload plugin::upload.content-api.upload false',
      'content-api GET /api/upload/files plugin::upload.content-api.find true',
      'admin GET /upload/settings plugin::upload.admin.getSettings false',
    ]);

    const up = res!.plugins.find((p) => p.name === 'users-permissions')!;
    expect(up.complete).toBe(true);
    expect(up.artifacts.map((a) => a.ref).sort()).toEqual([
      'plugin::users-permissions.jwt',
      'plugin::users-permissions.rateLimit',
      'plugin::users-permissions.user',
    ]);
    expect(up.artifacts.find((a) => a.name === 'jwt')!.actions?.map((a) => a.name)).toEqual(['issue', 'verify']);
    expect(res!.plugins.some((p) => p.name === 'left-pad')).toBe(false);
  });

  it('honours config/plugins: a literal `enabled: false` removes the plugin, a computed one makes it uncertain', async () => {
    const off = await readInstalledPlugins(
      v5App({ [`${ROOT}/config/plugins.ts`]: `export default () => ({ 'users-permissions': { enabled: false } });` }),
      ROOT,
    );
    expect(off!.plugins.some((p) => p.name === 'users-permissions')).toBe(false);

    const unsure = await readInstalledPlugins(
      v5App({ [`${ROOT}/config/plugins.ts`]: `export default ({ env }) => ({ 'users-permissions': { enabled: env.bool('UP', true) } });` }),
      ROOT,
    );
    const up = unsure!.plugins.find((p) => p.name === 'users-permissions')!;
    expect(up.enabled).toBe('uncertain');
    expect(up.complete).toBe(false);
  });

  it('marks a plugin incomplete when src/extensions/<plugin>/strapi-server rewrites it', async () => {
    const res = await readInstalledPlugins(
      v5App({ [`${ROOT}/src/extensions/users-permissions/strapi-server.js`]: `module.exports = (plugin) => plugin;` }),
      ROOT,
    );
    const up = res!.plugins.find((p) => p.name === 'users-permissions')!;
    expect(up.complete).toBe(false);
    expect(up.gaps.join()).toMatch(/extensions/);
  });

  it('never claims completeness through an export write it does not understand', async () => {
    const res = await readInstalledPlugins(
      v5App({
        [`${ROOT}/node_modules/@strapi/plugin-users-permissions/server/services/index.js`]: `'use strict';
const jwt = require('./jwt');
if (process.env.X) exports.extra = jwt;
module.exports = { jwt };`,
      }),
      ROOT,
    );
    const up = res!.plugins.find((p) => p.name === 'users-permissions')!;
    expect(up.complete).toBe(false);
  });

  it('returns undefined without node_modules (behaviour unchanged)', async () => {
    const fs = new MemoryFileSystem({ [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { '@strapi/strapi': '5.0.0' } }) });
    expect(await readInstalledPlugins(fs, ROOT)).toBeUndefined();
  });
});

describe('installed plugins — engine integration', () => {
  it('validates refs into complete installed plugins instead of skipping them', async () => {
    const { project } = await engineFor(v5App());
    expect(validateRef(project, 'plugin::users-permissions.user').status).toBe('valid');
    expect(validateRef(project, 'plugin::users-permissions.jwt#issue').status).toBe('valid');
    const typo = validateRef(project, 'plugin::users-permissions.usr');
    expect(typo.status).toBe('unknown');
    // a plugin that is not installed stays unverifiable
    expect(validateRef(project, 'plugin::nope.thing').status).toBe('external');
    // framework namespaces are untouched
    expect(validateRef(project, 'admin::user').status).toBe('external');
  });

  it('reports an unknown plugin service in code, with a suggestion', async () => {
    const { engine } = await engineFor(v5App());
    const file = `${ROOT}/src/api/article/services/article.ts`;
    const src = `export default ({ strapi }) => ({ a() { return strapi.service('plugin::users-permissions.jwtt'); } });`;
    const diags = await engine.validateFile(file, src);
    expect(diags.map((d) => d.message).join('\n')).toMatch(/jwtt/);
    const ok = await engine.validateFile(file, src.replace('jwtt', 'jwt'));
    expect(ok).toEqual([]);
  });

  it('keeps installed entries out of dead-code results and the model outline', async () => {
    const { engine, project } = await engineFor(v5App());
    await engine.whenReferencesReady();
    const unused = listUnused(project);
    expect(unused.some((u) => u.filePath.includes('/node_modules/'))).toBe(false);
    const model = engine.getModel()[0]!;
    expect(model.contentTypes.map((c) => c.uid)).toEqual(['api::article.article']);
  });

  it('a project-level extension schema still wins over the installed one', async () => {
    const { project } = await engineFor(
      v5App({
        [`${ROOT}/src/extensions/users-permissions/content-types/user/schema.json`]: JSON.stringify({
          kind: 'collectionType',
          info: { singularName: 'user' },
          attributes: { username: { type: 'string' }, isPro: { type: 'boolean' } },
        }),
      }),
    );
    const ct = project.index.contentTypes.get('plugin::users-permissions.user')!;
    expect(ct.installed).toBeUndefined();
    expect(Object.keys(ct.attributes)).toContain('isPro');
  });

  it('picks up a plugin installed after startup (install markers), without a watcher', async () => {
    const fs = v5App();
    const { engine, project } = await engineFor(fs);
    expect(validateRef(project, 'plugin::seo.seo').status).toBe('external');
    const nm = `${ROOT}/node_modules`;
    fs.writeFile(`${ROOT}/package.json`, JSON.stringify({
      name: 'app',
      dependencies: { '@strapi/strapi': '5.10.0', '@strapi/plugin-users-permissions': '5.10.0', '@strapi/plugin-seo': '1.0.0' },
    }));
    fs.writeFile(`${nm}/@strapi/plugin-seo/package.json`, JSON.stringify({ name: '@strapi/plugin-seo', version: '1.0.0', strapi: { name: 'seo', kind: 'plugin' } }));
    fs.writeFile(`${nm}/@strapi/plugin-seo/strapi-server.js`, `module.exports = { services: { seo: () => ({ run() {} }) } };`);
    fs.writeFile(`${nm}/.package-lock.json`, '{}');
    // bypass the throttle for the test
    (engine as unknown as { lastInstalledCheck: number }).lastInstalledCheck = 0;
    await engine.refreshInstalledIfStale();
    expect(validateRef(project, 'plugin::seo.seo').status).toBe('valid');
    expect(validateRef(project, 'plugin::seo.sseo').status).toBe('unknown');
  });

  it('verifies strapi:: middlewares in config/middlewares once Strapi\'s registry is read', async () => {
    const coreMw = `${ROOT}/node_modules/@strapi/core/dist/middlewares`;
    const fs = v5App({
      [`${coreMw}/index.js`]: `'use strict';
var cors = require('./cors.js');
var errors = require('./errors.js');
const middlewares = {
    cors: cors.cors,
    errors: errors.errors,
};
exports.middlewares = middlewares;`,
      [`${coreMw}/cors.js`]: `'use strict';
const cors = (config) => async (ctx, next) => next();
exports.cors = cors;`,
      [`${coreMw}/errors.js`]: `'use strict';
const errors = () => async (ctx, next) => next();
exports.errors = errors;`,
    });
    const { engine } = await engineFor(fs);
    const file = `${ROOT}/config/middlewares.ts`;
    const diags = await engine.validateFile(file, `export default ['strapi::errors', 'strapi::corss'];`);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toMatch(/strapi::corss/);
    expect(diags[0]!.quickFixes?.[0]?.replacement).toBe('strapi::cors');
    const src = `export default ['strapi::cors'];`;
    const defs = await engine.getDefinitions(file, src.indexOf('cors') + 1, src);
    expect(defs[0]?.filePath).toBe(`${coreMw}/cors.js`);
  });

  it('stays silent on strapi:: middlewares when Strapi\'s registry is not readable', async () => {
    const { engine } = await engineFor(v5App());
    const diags = await engine.validateFile(`${ROOT}/config/middlewares.ts`, `export default ['strapi::corss'];`);
    expect(diags).toEqual([]);
  });

  it('an extension entry point added to an existing src/extensions folder is picked up without a watcher', async () => {
    const fs = v5App({ [`${ROOT}/src/extensions/users-permissions/content-types/user/schema.json`]: JSON.stringify({ kind: 'collectionType', info: { singularName: 'user' }, attributes: {} }) });
    const { engine, project } = await engineFor(fs);
    expect(validateRef(project, 'plugin::users-permissions.jwtt').status).toBe('unknown');
    fs.writeFile(`${ROOT}/src/extensions/users-permissions/strapi-server.js`, `module.exports = (plugin) => plugin;`);
    (engine as unknown as { lastInstalledCheck: number }).lastInstalledCheck = 0;
    await engine.refreshInstalledIfStale();
    expect(validateRef(project, 'plugin::users-permissions.jwtt').status).toBe('external');
  });

  it('refuses any edit that would write into node_modules', () => {
    const outside = pathsOutsideRoots([ROOT], {
      textEdits: [{ filePath: `${ROOT}/node_modules/@strapi/upload/dist/server/index.js`, start: 0, end: 0, newText: 'x' }],
      fileRenames: [],
    } as never);
    expect(outside).toHaveLength(1);
  });
});
