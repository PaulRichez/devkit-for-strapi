/**
 * What a review of the feedback-v2-2 changes found: each case fails without its fix.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { readInstalledPlugins, type InstalledPlugin } from '../src/plugins/installed';
import { listUnused, unresolvedCallsOf } from '../src/query/refQuery';

const R = 'c:/fv22';
const ct = (name: string) => `{"kind":"collectionType","info":{"singularName":"${name}","pluralName":"${name}s"},"attributes":{}}`;

async function open(files: Record<string, string>): Promise<{ project: StrapiProject; engine: ReturnType<typeof createEngine> }> {
  const engine = createEngine(new MemoryFileSystem({ [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}', ...files }));
  await engine.init([R]);
  await engine.whenReferencesReady();
  return { project: engine.allProjects()[0]!, engine };
}

describe('a call whose UID starts with a bare name may reach any of its kind', () => {
  it("`strapi.policy('is-' + kind)` stays a candidate caller of global::is-admin (a bare name is qualified by its file)", async () => {
    const { project } = await open({
      [`${R}/src/policies/is-admin.js`]: 'module.exports = () => true;\n',
      [`${R}/src/middlewares/my-log.js`]: 'module.exports = () => async (ctx, next) => next();\n',
      [`${R}/src/api/foo/content-types/foo/schema.json`]: ct('foo'),
      [`${R}/src/api/foo/services/calls.js`]: [
        'module.exports = ({ strapi }) => ({',
        "  b(kind) { return strapi.policy('is-' + kind); },",
        '  c(kind) { return strapi.policy(`is-${kind}`); },',
        "  d(kind) { return strapi.middleware('my-' + kind); },",
        '});',
        '',
      ].join('\n'),
    });
    expect(unresolvedCallsOf(project, ['policy'], ['global::is-admin'])).toHaveLength(2);
    expect(unresolvedCallsOf(project, ['middleware'], ['global::my-log'])).toHaveLength(1);
  });
});

describe('what counts as loading a file by its path', () => {
  const files = (controller: string, extra: Record<string, string> = {}): Record<string, string> => ({
    [`${R}/src/api/foo/content-types/foo/schema.json`]: ct('foo'),
    [`${R}/src/api/foo/services/lone.ts`]: 'export type Lone = { a: 1 };\nexport default ({ strapi }) => ({ go() {} });\n',
    [`${R}/src/api/foo/controllers/foo.ts`]: controller,
    ...extra,
  });
  const lone = (project: StrapiProject) => listUnused(project, { kinds: ['service'] }).find((u) => u.ref === 'api::foo.lone');

  it('an import of types only is erased by TypeScript: not a caller', async () => {
    for (const c of [
      "import type { Lone } from '../services/lone';\nexport default {};\n",
      "import { type Lone } from '../services/lone';\nexport default {};\n",
      "export type { Lone } from '../services/lone';\nexport default {};\n",
    ]) {
      const { project } = await open(files(c));
      expect(lone(project)?.requiredByPath, c).toBeUndefined();
    }
    const { project } = await open(files("import lone from '../services/lone';\nexport default { lone };\n"));
    expect(lone(project)?.requiredByPath).toEqual([`${R}/src/api/foo/controllers/foo.ts`]);
  });

  it("TypeScript's ESM style (`./lone.js` for lone.ts) is a caller; a test isn't", async () => {
    const esm = await open(files("import lone from '../services/lone.js';\nexport default { lone };\n"));
    expect(lone(esm.project)?.requiredByPath).toEqual([`${R}/src/api/foo/controllers/foo.ts`]);
    const test = await open(files('export default {};\n', { [`${R}/src/api/foo/services/__tests__/lone.test.js`]: "require('../lone');\n" }));
    expect(lone(test.project)?.requiredByPath).toBeUndefined();
  });
});

describe('a helper DevKit must not take for an exact one', () => {
  const ROOT = '/app';
  const NM = `${ROOT}/node_modules`;
  async function services(index: string): Promise<{ keys: string[]; complete: boolean }> {
    const r = await readInstalledPlugins(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0', 'my-plugin': '1.0.0' } }),
        [`${NM}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
        [`${NM}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
        [`${NM}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
        [`${NM}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' } }),
        [`${NM}/my-plugin/strapi-server.js`]: `module.exports = { services: require('./services') };`,
        [`${NM}/my-plugin/services/index.js`]: index,
        [`${NM}/my-plugin/services/email.js`]: `module.exports = ({ strapi }) => ({ send() {} });`,
        [`${NM}/my-plugin/services/error/index.js`]: `module.exports = { catch: require('./catch'), log: require('./log') };`,
        [`${NM}/my-plugin/services/error/catch.js`]: `module.exports = ({ strapi }) => ({ run() {} });`,
        [`${NM}/my-plugin/services/error/log.js`]: `module.exports = ({ strapi }) => ({ write() {} });`,
      }),
      ROOT,
    );
    const p: InstalledPlugin = r!.plugins.find((x) => x.name === 'my-plugin')!;
    return { keys: p.artifacts.filter((a) => a.kind === 'service').map((a) => a.name).sort(), complete: p.complete };
  }
  const EXPORT = "module.exports = { email: require('./email'), ...withPrefix('error', require('./error')) };";

  it('a rest parameter, or a default value, in the callback', async () => {
    for (const params of ['(acc, ...k)', '(acc, k = "x")']) {
      const key = params.includes('...') ? 'k' : 'k';
      const r = await services([`const withPrefix = (p, s) => Object.keys(s).reduce(${params} => {`, `  acc[\`\${p}.\${${key}}\`] = s[${key}];`, '  return acc;', '}, {});', EXPORT].join('\n'));
      expect(r.complete, params).toBe(false);
    }
  });

  it('`arguments` in a function callback (another name for the accumulator)', async () => {
    const r = await services(
      [
        'const withPrefix = (p, s) => Object.keys(s).reduce(function (acc, k) {',
        "  acc[`${p}.${k}`] = (arguments[0].extra = require('./email'), s[k]);",
        '  return acc;',
        '}, {});',
        EXPORT,
      ].join('\n'),
    );
    expect(r.complete).toBe(false);
  });

  it('a source object the file writes into after the keys are read', async () => {
    const r = await services(
      [
        "const base = { catch: require('./error/catch') };",
        'const prefixed = Object.keys(base).reduce((acc, k) => { acc[`error.${k}`] = base[k]; return acc; }, {});',
        "base.log = require('./error/log');",
        "module.exports = { email: require('./email'), ...prefixed };",
      ].join('\n'),
    );
    expect(r.keys).not.toContain('error.log');
    expect(r.complete).toBe(false);
  });
});

describe('a TypeScript source runs compiled', () => {
  const ROUTES = "export default { admin: { type: 'admin', routes: [{ method: 'GET', path: '/things', handler: 'admin.list', config: { policies: [] } }] } };\n";
  async function routes(entryName: string, entry: string): Promise<{ handlers: string[]; unread: number }> {
    const engine = createEngine(
      new MemoryFileSystem({
        [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
        [`${R}/config/plugins.js`]: "module.exports = { x: { enabled: true, resolve: './src/plugins/x' } };\n",
        [`${R}/src/plugins/x/${entryName}`]: entry,
        [`${R}/src/plugins/x/server/routes/index.ts`]: ROUTES,
        [`${R}/src/plugins/x/server/controllers/admin.js`]: 'module.exports = ({ strapi }) => ({ list() {} });\n',
      }),
    );
    await engine.init([R]);
    const [read] = await engine.getRoutes({ admin: true, root: R });
    return { handlers: read!.routes.filter((r) => (r.fullPath ?? r.path) === '/x/things').map((r) => r.handler), unread: read!.unread.length };
  }

  it("fs.existsSync of a .ts file is false once compiled (dist): no route invented, the loader said unread", async () => {
    const r = await routes(
      'strapi-server.ts',
      [
        "import fs from 'fs';",
        "import path from 'path';",
        "const file = path.join(__dirname, 'server', 'routes', 'index.ts');",
        "export default { controllers: { admin: require('./server/controllers/admin') }, routes: fs.existsSync(file) ? require(file).default : {} };",
        '',
      ].join('\n'),
    );
    expect(r.handlers).toEqual([]);
    expect(r.unread).toBe(1);
  });

  it('JavaScript requiring a TypeScript source in a try: Node gets the catch value — unread, not invented', async () => {
    const r = await routes(
      'strapi-server.js',
      [
        'function loadRoutes() {',
        "  try { return require('./server/routes'); } catch { return {}; }",
        '}',
        "module.exports = () => ({ controllers: { admin: require('./server/controllers/admin') }, routes: loadRoutes() });",
        '',
      ].join('\n'),
    );
    expect(r.handlers).toEqual([]);
    expect(r.unread).toBe(1);
  });
});
