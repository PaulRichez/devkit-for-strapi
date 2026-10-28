/**
 * A helper that builds a plugin's index from a sub-index (feedback v2 #18): the
 * evaluator follows `Object.keys(o).reduce(…)` building an object, template keys
 * and a computed key it can read — and nothing looser. Every variant that could
 * hide a key, or write into what it reads, stays unknown (the collection open).
 */
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { readInstalledPlugins, type InstalledPlugin } from '../src/plugins/installed';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
async function services(index: string, extra: Record<string, string> = {}): Promise<{ keys: string[]; complete: boolean }> {
  const files: Record<string, string> = {
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
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`${NM}/my-plugin/${k}`, v])),
  };
  const r = await readInstalledPlugins(new MemoryFileSystem(files), ROOT);
  const p: InstalledPlugin = r!.plugins.find((x) => x.name === 'my-plugin')!;
  return { keys: p.artifacts.filter((a) => a.kind === 'service').map((a) => a.name).sort(), complete: p.complete };
}

const EXPORT = "module.exports = { email: require('./email'), ...withPrefix('error', require('./error')) };";

describe('helpers that prefix a sub-index are followed exactly', () => {
  it('Object.keys(…).reduce, the accumulator written then returned', async () => {
    const r = await services(
      ['const withPrefix = (prefix, s) => Object.keys(s).reduce((acc, key) => {', '  acc[`${prefix}.${key}`] = s[key];', '  return acc;', '}, {});', EXPORT].join('\n'),
    );
    expect(r).toEqual({ keys: ['email', 'error.catch', 'error.log'], complete: true });
  });

  it('the spread form, a function declaration, and an index parameter', async () => {
    const r = await services(['function withPrefix(prefix, s) {', '  return Object.keys(s).reduce((acc, key, i) => ({ ...acc, [prefix + `.${key}`]: s[key] }), {});', '}', EXPORT].join('\n'));
    expect(r.complete).toBe(false); // `prefix + …` is a binary `+`: not followed (only templates are)
    const t = await services(['function withPrefix(prefix, s) {', '  return Object.keys(s).reduce((acc, key, i) => ({ ...acc, [`${prefix}.${key}`]: s[key] }), {});', '}', EXPORT].join('\n'));
    expect(t).toEqual({ keys: ['email', 'error.catch', 'error.log'], complete: true });
  });
});

describe('anything looser stays unknown (the collection is open, never a false key list)', () => {
  const variants: Record<string, string> = {
    key_reads_the_accumulator: 'const withPrefix = (p, s) => Object.keys(s).reduce((acc, k) => { acc[`${p}.${k}.${Object.keys(acc).length}`] = s[k]; return acc; }, {});',
    value_reads_the_accumulator: 'const withPrefix = (p, s) => Object.keys(s).reduce((acc, k) => { acc[`${p}.${k}`] = acc; return acc; }, {});',
    starts_from_a_non_empty_object: "const withPrefix = (p, s) => Object.keys(s).reduce((acc, k) => { acc[`${p}.${k}`] = s[k]; return acc; }, { hidden: require('./email') });",
    a_third_statement: 'const withPrefix = (p, s) => Object.keys(s).reduce((acc, k) => { acc[`${p}.${k}`] = s[k]; acc.extra = s[k]; return acc; }, {});',
    returns_something_else: 'const withPrefix = (p, s) => Object.keys(s).reduce((acc, k) => { acc[`${p}.${k}`] = s[k]; return s; }, {});',
    a_loop_writing_an_object: 'function withPrefix(p, s) { const out = {}; for (const k in s) out[`${p}.${k}`] = s[k]; return out; }',
    the_param_mutated_too: 'const withPrefix = (p, s) => { s.extra = require("./email"); return Object.keys(s).reduce((acc, k) => { acc[`${p}.${k}`] = s[k]; return acc; }, {}); };',
    a_template_with_an_unknown_part: 'const withPrefix = (p, s) => Object.keys(s).reduce((acc, k) => { acc[`${p}.${k}.${process.env.X}`] = s[k]; return acc; }, {});',
  };
  for (const [name, helper] of Object.entries(variants)) {
    it(name, async () => {
      const r = await services([helper, EXPORT].join('\n'));
      expect(r.complete).toBe(false);
      expect(r.keys.filter((k) => k.startsWith('error.'))).toEqual([]);
    });
  }

  it('Object.keys of an object that may have more keys is not a list known whole', async () => {
    const r = await services(
      ['const withPrefix = (prefix, s) => Object.keys(s).reduce((acc, key) => { acc[`${prefix}.${key}`] = s[key]; return acc; }, {});', EXPORT].join('\n'),
      { 'services/error/index.js': "module.exports = { catch: require('./catch'), ...globalThis.more };" },
    );
    expect(r.complete).toBe(false);
  });

  it('a computed key read only when it is known: s[key] with an unknown key stays unknown', async () => {
    const r = await services(`module.exports = { email: require('./email')[process.env.KEY] };`);
    expect(r.keys).toEqual(['email']);
  });
});
