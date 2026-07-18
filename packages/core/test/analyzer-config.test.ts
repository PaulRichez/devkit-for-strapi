import { describe, expect, it } from 'vitest';
import { analyzeAt, collectReferences } from '../src/analyze/callSite';

const CFG_TS = 'c:/p/config/middlewares.ts';
const CFG_JS = 'c:/p/config/middlewares.js';

function inside(text: string, needle: string): number {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`needle not found: ${needle}`);
  return i + Math.floor(needle.length / 2);
}

describe('config/middlewares analyzer', () => {
  it('classifies a string element of the top-level export array', () => {
    const code = `export default ['global::my-mw'];`;
    const ctx = analyzeAt(CFG_TS, code, inside(code, 'my-mw'));
    expect(ctx?.kind).toBe('middleware-ref');
    expect(ctx?.apiStyle).toBe('config');
    expect(ctx?.text).toBe('global::my-mw');
  });

  it('works in CommonJS (module.exports = [...])', () => {
    const code = `module.exports = ['global::my-mw'];`;
    const ctx = analyzeAt(CFG_JS, code, inside(code, 'my-mw'));
    expect(ctx?.kind).toBe('middleware-ref');
    expect(ctx?.apiStyle).toBe('config');
  });

  it('classifies the name: value of an object element', () => {
    const code = `export default [{ name: 'global::rate-limit', config: {} }];`;
    const ctx = analyzeAt(CFG_TS, code, inside(code, 'rate-limit'));
    expect(ctx?.kind).toBe('middleware-ref');
    expect(ctx?.text).toBe('global::rate-limit');
  });

  it('skips strapi:: built-ins (emits no ref)', () => {
    const code = `export default ['strapi::logger', 'strapi::errors'];`;
    expect(collectReferences(CFG_TS, code)).toEqual([]);
  });

  it('skips the { resolve } path form', () => {
    const code = `export default [{ resolve: './src/middlewares/x', config: {} }];`;
    expect(collectReferences(CFG_TS, code)).toEqual([]);
  });

  it('collects only the real refs from a mixed stack, ignoring nested arrays', () => {
    const code = `export default ['strapi::logger', 'global::a', { name: 'global::b', config: { extra: ['global::nested'] } }, { resolve: './x' }];`;
    const refs = collectReferences(CFG_TS, code);
    expect(refs.map((r) => r.text)).toEqual(['global::a', 'global::b']);
    expect(refs.every((r) => r.kind === 'middleware-ref' && r.apiStyle === 'config')).toBe(true);
  });

  it('does not treat a top-level array OUTSIDE config/ as a middleware stack', () => {
    const code = `export default ['global::a'];`;
    expect(collectReferences('c:/p/src/foo/middlewares.ts', code)).toEqual([]);
  });

  it('leaves route-config middlewares as apiStyle "route"', () => {
    const code = `export default { config: { middlewares: ['global::a'] } };`;
    const ctx = analyzeAt('c:/p/src/api/x/routes/r.ts', code, inside(code, 'global::a'));
    expect(ctx?.kind).toBe('middleware-ref');
    expect(ctx?.apiStyle).toBe('route');
  });

  it('bypasses the substring prefilter for a global::-only config file', () => {
    // No "strapi"/"middleware" substring → a normal file would be skipped.
    const code = `export default ['global::only'];`;
    const refs = collectReferences(CFG_TS, code);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.text).toBe('global::only');
  });
});
