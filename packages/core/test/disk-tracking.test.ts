/**
 * Clients without a file watcher (the MCP server): files changed on disk behind
 * the engine's back are picked up on the next query, `rescan({ cold })` reads
 * every plugin again, and each project reports how current its index is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { validateRef } from '../src/query/refQuery';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
const schema = (name: string): string =>
  JSON.stringify({ kind: 'collectionType', collectionName: `${name}s`, info: { singularName: name, pluralName: `${name}s`, displayName: name }, attributes: { title: { type: 'string' } } });

function project(): MemoryFileSystem {
  return new MemoryFileSystem({
    [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0', 'my-plugin': '1.0.0' } }),
    [`${ROOT}/src/api/article/content-types/article/schema.json`]: schema('article'),
    [`${NM}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
    [`${NM}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
    [`${NM}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${NM}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' } }),
    [`${NM}/my-plugin/strapi-server.js`]: `module.exports = { controllers: { main: ({ strapi }) => ({ async a(ctx) {} }) } };`,
  });
}

describe('files changed on disk without a watcher', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('are re-indexed on the next query once the check interval passed', async () => {
    const fs = project();
    const engine = createEngine(fs, { trackDiskChanges: true });
    await engine.init([ROOT]);
    const p = (): ReturnType<typeof engine.allProjects>[number] => engine.allProjects()[0]!;
    expect(validateRef(p(), 'api::page.page').status).toBe('unknown');

    // created behind the engine's back (git checkout, another tool…)
    fs.writeFile(`${ROOT}/src/api/page/content-types/page/schema.json`, schema('page'));
    vi.setSystemTime(Date.now() + 3_000);
    await engine.refreshIfStale();
    expect(validateRef(p(), 'api::page.page').status).toBe('valid');

    // deleted behind its back
    fs.delete(`${ROOT}/src/api/page/content-types/page/schema.json`);
    vi.setSystemTime(Date.now() + 3_000);
    await engine.refreshIfStale();
    expect(validateRef(p(), 'api::page.page').status).toBe('unknown');
  });

  it('are not tracked unless asked (an editor has its own watcher)', async () => {
    const fs = project();
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    fs.writeFile(`${ROOT}/src/api/page/content-types/page/schema.json`, schema('page'));
    vi.setSystemTime(Date.now() + 3_000);
    await engine.refreshIfStale();
    expect(validateRef(engine.allProjects()[0]!, 'api::page.page').status).toBe('unknown');
    expect(engine.getProjects()[0]!.freshness.diskCheckedAt).toBeUndefined();
  });
});

describe('freshness and cold rescans', () => {
  it('each project says when it was indexed and how its plugins were read', async () => {
    const fs = project();
    const engine = createEngine(fs, { trackDiskChanges: true });
    await engine.init([ROOT]);
    const f = engine.getProjects()[0]!.freshness;
    expect(f.indexedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(f.diskCheckedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(f.pluginsReadAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(f.pluginsLoading).toBeUndefined();
    expect(f.pluginReads).toEqual({ read: 1, fromCache: 0 });

    // A plain rescan reuses the unchanged plugin; a cold one reads it again.
    await engine.rescan();
    await engine.whenInstalledReady();
    expect(engine.getProjects()[0]!.freshness.pluginReads).toEqual({ read: 0, fromCache: 1 });
    await engine.rescan({ cold: true });
    await engine.whenInstalledReady();
    expect(engine.getProjects()[0]!.freshness.pluginReads).toEqual({ read: 1, fromCache: 0 });
  });
});
