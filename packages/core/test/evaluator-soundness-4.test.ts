/**
 * Fourth-round regressions (final adversarial verification): the cross-module
 * check never blocks the event loop on alias DAGs, a member read back out of a
 * fresh object is the module's value again, and following too deep is "can't
 * tell", never "no write".
 */
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { readInstalledPlugins, type InstalledPlugin } from '../src/plugins/installed';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
function app(pluginFiles: Record<string, string>): MemoryFileSystem {
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0', 'my-plugin': '1.0.0' } }),
    [`${NM}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
    [`${NM}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
    [`${NM}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${NM}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' } }),
  };
  for (const [k, v] of Object.entries(pluginFiles)) files[`${NM}/my-plugin/${k}`] = v;
  return new MemoryFileSystem(files);
}
async function read(fs: MemoryFileSystem): Promise<InstalledPlugin> {
  const r = await readInstalledPlugins(fs, ROOT);
  return r!.plugins.find((x) => x.name === 'my-plugin')!;
}
const C = `({ strapi }) => ({ async a(ctx) {} })`;
const PATCHED = (patch: string): Record<string, string> => ({
  'strapi-server.js': `module.exports = { ...require('./patch'), controllers: require('./c') };`,
  'c.js': `module.exports = { main: ${C} };`,
  'patch.js': patch,
});

describe('round 4: never complete with something missing', () => {
  const aliases12 = [`const a0 = require('./c');`, ...Array.from({ length: 12 }, (_, i) => `const a${i + 1} = a${i};`), `a12.extra = ${C};`, 'module.exports = {};'].join('\n');
  const cases: Record<string, Record<string, string>> = {
    P80_container_member_alias: PATCHED(`const h = { m: require('./c') };\nconst inner = h.m;\ninner.extra = ${C};\nmodule.exports = {};`),
    P80b_container_array_alias: PATCHED(`const arr = [require('./c')];\nconst first = arr[0];\nfirst.extra = ${C};\nmodule.exports = {};`),
    P81_forof_fresh_array: PATCHED(`for (const m of [require('./c')]) m.extra = ${C};\nmodule.exports = {};`),
    P82_alias_chain_12: PATCHED(aliases12),
    P83_helper_param_member_alias: PATCHED(`function patch(o) { const m = o.m; m.extra = ${C}; }\npatch({ m: require('./c') });\nmodule.exports = {};`),
    P90_container_in_evaluated_server: {
      'strapi-server.js': `const controllers = { main: ${C} };\nconst h = { c: controllers };\nconst inner = h.c;\ninner.extra = ${C};\nmodule.exports = { controllers };`,
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    it(name, async () => {
      const p = await read(app(files));
      if (p.complete) expect(p.artifacts.map((a) => a.ref), `${name}: complete but missing extra`).toContain('plugin::my-plugin.extra');
    });
  }
  it('adding keys to a fresh object holding a module value is still not a write', async () => {
    const p = await read(app(PATCHED(`const conf = { m: require('./c') };\nconf.other = 1;\nmodule.exports = {};`)));
    expect(p.gaps).toEqual([]);
    expect(p.complete).toBe(true);
  });
});

describe('round 4: alias DAGs stay linear and never block the event loop', () => {
  /** m aliases per layer, each assigned from every alias of the previous layer. */
  function server(m: number, layers: number): string {
    const L: string[] = [`const controllers = { main: ${C} };`, `function f() { return controllers; }`];
    L.push(`let ${Array.from({ length: m }, (_, i) => `a0_${i} = f`).join(', ')};`);
    for (let k = 1; k < layers; k++) {
      L.push(`let ${Array.from({ length: m }, (_, i) => `a${k}_${i}`).join(', ')};`);
      for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) L.push(`a${k}_${j} = a${k - 1}_${i};`);
    }
    L.push(`module.exports = { controllers };`);
    return L.join('\n');
  }
  it('m=16, 6 layers', async () => {
    let maxGap = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const n = Date.now();
      maxGap = Math.max(maxGap, n - last);
      last = n;
    }, 10);
    const t0 = Date.now();
    const p = await read(app({ 'strapi-server.js': server(16, 6) }));
    clearInterval(timer);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(maxGap).toBeLessThan(3_000);
    if (p.complete) expect(p.artifacts.map((a) => a.ref)).toEqual(['plugin::my-plugin.main']);
  }, 30_000);
});
