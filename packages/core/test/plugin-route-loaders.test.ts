/**
 * A local plugin whose `strapi-server.js` loads its routes itself (feedback v2 #23):
 * a function returning a path built from `__dirname` behind `fs.existsSync`, or a
 * `require` in a `try` — followed to the file required. Any other loader is said
 * (`unread`, with the file and line), never taken for a plugin without routes.
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { projectInfo } from '../src/query/projectInfo';

const R = 'c:/loaders';
const ROUTES = "module.exports = { admin: { type: 'admin', routes: [{ method: 'GET', path: '/things', handler: 'admin.list', config: { policies: [] } }] } };\n";

async function routesOf(entry: string) {
  const files = {
    [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
    [`${R}/config/plugins.js`]: "module.exports = { x: { enabled: true, resolve: './src/plugins/x' } };\n",
    [`${R}/src/plugins/x/strapi-server.js`]: entry,
    [`${R}/src/plugins/x/server/routes/index.js`]: ROUTES,
    [`${R}/src/plugins/x/server/controllers/admin.js`]: 'module.exports = ({ strapi }) => ({ list() {} });\n',
  };
  const engine = createEngine(new MemoryFileSystem(files));
  await engine.init([R]);
  const [read] = await engine.getRoutes({ admin: true, root: R });
  return { read: read!, engine, fs: new MemoryFileSystem(files) };
}

const things = (routes: Array<{ fullPath?: string; path: string; handler: string }>) => routes.filter((r) => (r.fullPath ?? r.path) === '/x/things').map((r) => r.handler);

describe('routes a local plugin loads itself', () => {
  it("the feedback's repro: path.join(__dirname, …) behind fs.existsSync", async () => {
    const { read } = await routesOf(
      [
        "const fs = require('fs');",
        "const path = require('path');",
        'function loadRoutes() {',
        "  const file = path.join(__dirname, 'server', 'routes', 'index.js');",
        '  return fs.existsSync(file) ? require(file) : {};',
        '}',
        "module.exports = () => ({ controllers: { admin: require('./server/controllers/admin') }, routes: loadRoutes() });",
        '',
      ].join('\n'),
    );
    expect(things(read.routes)).toEqual(['plugin::x.admin.list']);
    expect(read.unread).toEqual([]);
  });

  it('a require in a try, its catch the fallback', async () => {
    const { read } = await routesOf(
      ['function loadRoutes() {', '  try {', "    return require('./server/routes');", '  } catch {', '    return {};', '  }', '}', 'module.exports = () => ({ routes: loadRoutes() });', ''].join('\n'),
    );
    expect(things(read.routes)).toEqual(['plugin::x.admin.list']);
  });

  it('a file that is not there, or a try doing more than the require, is said with its line — never an empty table', async () => {
    for (const entry of [
      ["const fs = require('fs');", "const path = require('path');", 'module.exports = () => ({', "  routes: fs.existsSync(path.join(__dirname, 'routes.js')) ? require(path.join(__dirname, 'routes.js')) : {},", '});', ''].join('\n'),
      ['function loadRoutes() {', '  try {', '    check();', "    return require('./server/routes');", '  } catch {', '    return {};', '  }', '}', 'module.exports = () => ({', '  routes: loadRoutes(),', '});', ''].join('\n'),
    ]) {
      const { read, engine, fs } = await routesOf(entry);
      expect(things(read.routes)).toEqual([]);
      expect(read.unread).toEqual([{ plugin: 'x', file: `${R}/src/plugins/x/strapi-server.js`, line: entry.split('\n').findIndex((l) => l.trim().startsWith('routes:')) + 1, why: expect.any(String) }]);
      const project = engine.allProjects()[0]!;
      const info = await projectInfo(fs, project, engine.getProjects()[0]!);
      expect(info.notes).toContainEqual(expect.stringContaining("Routes of plugin 'x' built by code DevKit can't read (src/plugins/x/strapi-server.js:"));
    }
  });
});
