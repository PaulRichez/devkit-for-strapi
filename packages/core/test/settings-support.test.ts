import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { matchesAnyGlob, matchesGlob } from '../src/util/glob';

describe('glob matcher (exclude support)', () => {
  it('matches a bare token against any path segment', () => {
    expect(matchesGlob('c:/ws/examples/demo', 'examples')).toBe(true);
    expect(matchesGlob('c:/ws/src/app', 'examples')).toBe(false);
  });
  it('matches `**` across segments', () => {
    expect(matchesGlob('c:/ws/packages/fixtures/app', '**/fixtures/**')).toBe(true);
    expect(matchesGlob('c:/ws/packages/app', '**/fixtures/**')).toBe(false);
  });
  it('matches `*` and a slashed pattern', () => {
    expect(matchesGlob('c:/ws/test-app', 'test-*')).toBe(true);
    expect(matchesGlob('c:/ws/packages/demo', 'packages/demo')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(matchesGlob('C:/WS/Examples/App', 'examples')).toBe(true);
  });
  it('matchesAnyGlob ORs the patterns', () => {
    expect(matchesAnyGlob('c:/ws/examples/x', ['foo', 'examples'])).toBe(true);
    expect(matchesAnyGlob('c:/ws/src/x', ['foo', 'bar'])).toBe(false);
  });
});

describe('engine.setExcludes drops matching project roots', () => {
  const files: Record<string, string> = {
    'c:/ws/app/package.json': '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    'c:/ws/app/src/api/x/content-types/x/schema.json': '{"info":{"singularName":"x"},"attributes":{}}',
    'c:/ws/examples/demo/package.json': '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    'c:/ws/examples/demo/src/api/y/content-types/y/schema.json': '{"info":{"singularName":"y"},"attributes":{}}',
  };

  it('discovers both projects without excludes', async () => {
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init(['c:/ws']);
    expect(engine.getProjects().map((p) => p.root).sort()).toEqual(['c:/ws/app', 'c:/ws/examples/demo']);
  });

  it('drops a project under an excluded path', async () => {
    const engine = createEngine(new MemoryFileSystem(files));
    engine.setExcludes(['examples']);
    await engine.init(['c:/ws']);
    expect(engine.getProjects().map((p) => p.root)).toEqual(['c:/ws/app']);
  });
});

describe('CodeLensEntry.method flag', () => {
  const ROOT = 'c:/p';
  const NOTIFIER = `${ROOT}/src/api/page/services/notifier.ts`;
  const files: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [NOTIFIER]: `export default () => ({ async notify(m: string) {} });`,
    [`${ROOT}/src/x.ts`]: `strapi.service('api::page.notifier').notify('a');`,
  };
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
  });

  it('flags per-method lenses and leaves entity lenses unflagged', async () => {
    const lenses = await engine.getCodeLenses(NOTIFIER, files[NOTIFIER]!);
    const entity = lenses.find((l) => !l.method);
    const method = lenses.find((l) => l.method);
    expect(entity).toBeDefined(); // service-level lens
    expect(method).toBeDefined(); // the `notify` method lens
    expect(files[NOTIFIER]!.slice(method!.offset).startsWith('notify')).toBe(true);
  });
});
