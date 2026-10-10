/**
 * Regressions from the final audit of the background loading, the read caches
 * and the MCP disk tracking: never a stale answer after an edit, never a cached
 * read of a half-rebuilt plugin, never a missed rewrite — and project_info tells
 * the truth in a hoisted monorepo.
 */
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { StaticEvaluator } from '../src/plugins/evaluate';
import { MAY_REWRITE_PLUGINS, pluginWriteTargets } from '../src/plugins/rewrites';
import { projectInfo } from '../src/query/projectInfo';
import { validateRef } from '../src/query/refQuery';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
const C = `({ strapi }) => ({ async a(ctx) {} })`;
const schema = (name: string): string =>
  JSON.stringify({ kind: 'collectionType', collectionName: `${name}s`, info: { singularName: name, pluralName: `${name}s`, displayName: name }, attributes: { title: { type: 'string' } } });

function base(extra: Record<string, string> = {}, root = ROOT, nm = NM): Record<string, string> {
  return {
    [`${root}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0', 'my-plugin': '1.0.0' } }),
    [`${nm}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
    [`${nm}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
    [`${nm}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${nm}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' } }),
    [`${nm}/my-plugin/strapi-server.js`]: `module.exports = { controllers: require('./controllers') };`,
    [`${nm}/my-plugin/controllers.js`]: `module.exports = { main: ${C} };`,
    [`${root}/src/index.ts`]: `export default {};`,
    [`${root}/package-lock.json`]: `{}`,
    ...extra,
  };
}

describe('MCP disk tracking', () => {
  it('an edit made right after a call is seen by the next call (no throttle on small projects)', async () => {
    const fs = new MemoryFileSystem(base());
    const engine = createEngine(fs, { trackDiskChanges: true });
    await engine.init([ROOT]);
    await engine.refreshIfStale();
    fs.writeFile(`${ROOT}/src/api/page/content-types/page/schema.json`, schema('page'));
    await engine.refreshIfStale(); // immediately: an agent's Write tool, then its next call
    expect(validateRef(engine.allProjects()[0]!, 'api::page.page').status).toBe('valid');
  });

  it('covers local plugins resolved outside src/ (inside the project root)', async () => {
    const fs = new MemoryFileSystem(
      base({
        [`${ROOT}/config/plugins.js`]: `module.exports = { local: { enabled: true, resolve: './plugins/local' } };`,
        [`${ROOT}/plugins/local/package.json`]: JSON.stringify({ name: 'local' }),
        [`${ROOT}/plugins/local/strapi-server.js`]: `module.exports = { register() {} };`,
      }),
    );
    const engine = createEngine(fs, { trackDiskChanges: true });
    await engine.init([ROOT]);
    await engine.refreshIfStale(); // the snapshot now covers ./plugins/local
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status).toBe('unknown');
    fs.writeFile(`${ROOT}/plugins/local/strapi-server.js`, `module.exports = { register({ strapi }) { strapi.plugin('my-plugin').controllers.extra = ${C}; } };`);
    await engine.refreshIfStale();
    await engine.refreshIfStale();
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status).not.toBe('unknown');
  });
});

describe('the rewrite pre-filter keeps renamed / bound getters', () => {
  const cases: Record<string, string> = {
    destructured_rename: `module.exports = ({ strapi }) => { const { service: getService } = strapi; return { register(name) { getService(name).extra = 1; } }; };`,
    param_rename: `module.exports = { register({ strapi: { controller: ctl } }) { const n = process.env.N; ctl(n).extra = ${C}; } };`,
    bind: `module.exports = { register({ strapi }) { const get = strapi.controller.bind(strapi); get(process.env.N).extra = ${C}; } };`,
    property_read: `module.exports = { register({ strapi }) { const get = strapi.controller; get(process.env.N).extra = ${C}; } };`,
    minified: `module.exports={register({strapi:t}){const{controller:a}=t;a(process.env.N).extra=1}};`,
  };
  for (const [name, code] of Object.entries(cases)) {
    it(name, () => {
      expect(MAY_REWRITE_PLUGINS.test(code)).toBe(true);
      const r = pluginWriteTargets(ts.createSourceFile('/x.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
      expect(r.plugins.size + r.artifacts.size).toBeGreaterThan(0);
    });
  }
});

describe('plugin reads are never cached in a transient state', () => {
  it('a plugin rebuilt while it was read is read again at the next reload', async () => {
    class RebuildDuringRead extends MemoryFileSystem {
      armed = true;
      override async readFile(path: string): Promise<string> {
        const text = await super.readFile(path);
        if (this.armed && path === `${NM}/my-plugin/controllers.js`) {
          this.armed = false;
          this.writeFile(path, `module.exports = { main: ${C}, extra: ${C} };`);
        }
        return text;
      }
    }
    const fs = new RebuildDuringRead(base());
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    fs.writeFile(`${ROOT}/package-lock.json`, `{ "v": 2 }`); // the install finishes
    await engine.onFilesChanged([`${ROOT}/package-lock.json`], []);
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status).toBe('valid');
  });

  it('a read that failed once is retried', async () => {
    class FlakyFs extends MemoryFileSystem {
      fails = 1;
      override async readFile(path: string): Promise<string> {
        if (this.fails > 0 && path === `${NM}/my-plugin/strapi-server.js`) {
          this.fails--;
          throw new Error('EBUSY');
        }
        return super.readFile(path);
      }
    }
    const fs = new FlakyFs(base());
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    fs.writeFile(`${ROOT}/package-lock.json`, `{ "v": 2 }`);
    await engine.onFilesChanged([`${ROOT}/package-lock.json`], []);
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.nope').status).toBe('unknown');
  });
});

describe('edits made during the background load', () => {
  it('the client is never told a state that ignores them', async () => {
    class GatedFs extends MemoryFileSystem {
      private gate: Promise<void> | undefined;
      private open!: () => void;
      hold(): void {
        this.gate = new Promise((res) => (this.open = res));
      }
      release(): void {
        this.open();
        this.gate = undefined;
      }
      override async readFile(path: string): Promise<string> {
        if (this.gate && path.includes('/node_modules/my-plugin/')) await this.gate;
        return super.readFile(path);
      }
    }
    const fs = new GatedFs(base());
    fs.hold();
    const engine = createEngine(fs);
    const seen: string[] = [];
    engine.onReferencesChanged(() => seen.push(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status));
    await engine.init([ROOT], { waitForInstalled: false });
    await new Promise((r) => setTimeout(r, 20)); // the rewrite scan is done, the plugin read is held
    fs.writeFile(`${ROOT}/src/index.ts`, `export default { register({ strapi }) { strapi.plugin('my-plugin').controllers.extra = ${C}; } };`);
    await engine.onFilesChanged([`${ROOT}/src/index.ts`], []);
    fs.release();
    await engine.whenInstalledReady();
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status).toBe('external');
    expect(seen).not.toContain('unknown');
  });
});

describe('project_info in a hoisted monorepo', () => {
  it('reports the installed plugins found above the project', async () => {
    const MONO = '/mono';
    const root = `${MONO}/apps/api`;
    const fs = new MemoryFileSystem({ ...base({}, root, `${MONO}/node_modules`), [`${MONO}/package.json`]: JSON.stringify({ name: 'mono', private: true, workspaces: ['apps/*'] }) });
    const engine = createEngine(fs);
    await engine.init([root]);
    await engine.whenReferencesReady();
    const p = engine.allProjects()[0]!;
    const info = await projectInfo(fs, p, engine.getProjects()[0]!);
    expect(info.nodeModules).toBe(true);
    expect(info.strapi.installed).toBe('5.10.0');
    expect(info.notes.join(' ')).not.toMatch(/not installed/);
    expect(info.plugins.find((x) => x.name === 'my-plugin')?.verified).toBe(true);
  });
});

describe('resolution stays inside the plugin', () => {
  it("require('.') looks for the folder's index only, never a sibling `<plugin>.js`", async () => {
    const fs = new MemoryFileSystem({
      [`${NM}/my-plugin.js`]: `module.exports = 'outside';`,
      [`${NM}/my-plugin/index.js`]: `module.exports = 'inside';`,
      [`${NM}/my-plugin/strapi-server.js`]: `module.exports = require('.');`,
    });
    const ev = new StaticEvaluator(fs, { roots: [`${NM}/my-plugin`] });
    expect(await ev.resolveRelative(`${NM}/my-plugin/strapi-server.js`, '.')).toBe(`${NM}/my-plugin/index.js`);
    expect(await ev.resolveRelative(`${NM}/my-plugin/lib/x.js`, '..')).toBe(`${NM}/my-plugin/index.js`);
  });
});
