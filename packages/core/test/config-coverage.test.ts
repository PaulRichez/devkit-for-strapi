import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

const ROOT = 'c:/p';
const LOGGER = `${ROOT}/src/middlewares/logger.ts`;
const CONFIG = `${ROOT}/config/middlewares.ts`;
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [LOGGER]: `export default () => async (_ctx: any, next: () => Promise<void>) => next();`,
  [CONFIG]:
    `export default [
  'strapi::logger',
  'strapi::errors',
  'global::logger',
  { name: 'global::logger', config: {} },
  'global::nope',
  { resolve: './src/middlewares/x' },
];`,
};

describe('config/middlewares — coverage (F2/F3/F4)', () => {
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('F2: flags only the unknown middleware (strapi:: + resolve never flagged)', async () => {
    const diags = await engine.validateFile(CONFIG, files[CONFIG]!);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.code).toBe('devkit-for-strapi.unknown-middleware');
    expect(files[CONFIG]!.slice(diags[0]!.start, diags[0]!.end)).toBe('global::nope');
  });

  it('F3: go-to-def from a config element resolves to the middleware file', async () => {
    const code = files[CONFIG]!;
    const defs = await engine.getDefinitions(CONFIG, code.indexOf('global::logger') + 2, code);
    expect(defs[0]?.filePath).toBe(LOGGER);
  });

  it('F3: strapi:: built-ins and unknown refs resolve to nothing', async () => {
    const code = files[CONFIG]!;
    expect(await engine.getDefinitions(CONFIG, code.indexOf('strapi::logger') + 2, code)).toEqual([]);
    expect(await engine.getDefinitions(CONFIG, code.indexOf('global::nope') + 2, code)).toEqual([]);
  });

  it('F4: the middleware CodeLens counts both config usages (array + name forms)', async () => {
    const [lens] = await engine.getCodeLenses(LOGGER, files[LOGGER]!);
    expect(lens!.count).toBe(2);
  });

  it('F4: find-references from a config element lists the config usages', async () => {
    const code = files[CONFIG]!;
    const refs = await engine.getReferences(CONFIG, code.indexOf('global::logger') + 2, code);
    expect(refs.length).toBe(2);
    expect(refs.every((r) => r.filePath === CONFIG)).toBe(true);
  });
});

describe('config/middlewares — CommonJS (.js)', () => {
  const JS_LOGGER = `${ROOT}/src/middlewares/logger.js`;
  const JS_CONFIG = `${ROOT}/config/middlewares.js`;
  const jsFiles: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
    [JS_LOGGER]: `module.exports = () => async (_ctx, next) => next();`,
    [JS_CONFIG]: `module.exports = ['strapi::logger', 'global::logger', 'global::nope'];`,
  };
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(jsFiles));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('classifies, validates and counts refs the same as TS', async () => {
    const diags = await engine.validateFile(JS_CONFIG, jsFiles[JS_CONFIG]!);
    expect(diags.map((d) => d.code)).toEqual(['devkit-for-strapi.unknown-middleware']);
    const [lens] = await engine.getCodeLenses(JS_LOGGER, jsFiles[JS_LOGGER]!);
    expect(lens!.count).toBe(1);
  });
});
