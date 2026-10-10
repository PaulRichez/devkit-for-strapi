/**
 * config-sync, read from the files: detection, the options, the files of the sync
 * directory and their status, readable names, the synced roles of a route. The
 * plugin's rules come from config-sync 3.2.0 and 1.2.6 (`syncDir`, file names, types)
 * and Strapi 5 (`@strapi/core/dist/loaders/plugins/index.js` for the options merge).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXCLUDED_CONFIG, detectConfigSync } from '../src/configSync/detect';
import { configSyncLabel } from '../src/configSync/labels';
import { routeAccessForRoute, routeAccessInSync } from '../src/configSync/routeAccess';
import { configSyncStatus } from '../src/configSync/status';
import { escapeName, readSyncDir, unescapeName } from '../src/configSync/syncDir';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { RouteInfo, StrapiProject } from '../src/model/types';

const ROOT = 'c:/cs';
const SYNC = `${ROOT}/config/sync`;
const j = (v: unknown): string => JSON.stringify(v, null, 2);

const STRAPI_5 = { [`${ROOT}/node_modules/@strapi/strapi/package.json`]: j({ name: '@strapi/strapi', version: '5.0.0' }) };
const USERS_PERMISSIONS: Record<string, string> = {
  ...STRAPI_5,
  [`${ROOT}/node_modules/@strapi/plugin-users-permissions/package.json`]: j({ name: '@strapi/plugin-users-permissions', version: '5.0.0', strapi: { name: 'users-permissions', kind: 'plugin' } }),
  [`${ROOT}/node_modules/@strapi/plugin-users-permissions/strapi-server.js`]: 'module.exports = () => ({});',
};

async function load(files: Record<string, string>): Promise<{ fs: MemoryFileSystem; project: StrapiProject }> {
  const fs = new MemoryFileSystem(files);
  const engine = createEngine(fs);
  await engine.init([ROOT], { waitForInstalled: true });
  return { fs, project: engine.allProjects()[0]! };
}

const app = (deps: Record<string, string>, files: Record<string, string>): Record<string, string> => ({
  [`${ROOT}/package.json`]: j({ dependencies: { 'strapi-plugin-config-sync': '^3.2.0', ...deps } }),
  ...(deps['@strapi/strapi'] === '^5.0.0' ? STRAPI_5 : {}),
  ...files,
});
const v5 = { '@strapi/strapi': '^5.0.0' };
const withUp = { ...v5, '@strapi/plugin-users-permissions': '^5.0.0' };

const FILES: Record<string, string> = {
  ...app(withUp, USERS_PERMISSIONS),
  [`${ROOT}/node_modules/strapi-plugin-config-sync/package.json`]: j({ name: 'strapi-plugin-config-sync', version: '3.2.0' }),
  [`${ROOT}/config/plugins.ts`]: `import csConfig from './plugins.config-sync';
export default ({ env }) => ({ 'config-sync': { enabled: true, config: csConfig } });`,
  [`${ROOT}/config/plugins.config-sync.ts`]: `export default { excludedConfig: ['core-store.plugin_upload_metrics'], minify: false };`,
  [`${ROOT}/config/env/production/plugins.ts`]: `export default {};`,
  [`${ROOT}/src/api/article/content-types/article/schema.json`]: j({
    kind: 'collectionType',
    info: { singularName: 'article', pluralName: 'articles', displayName: 'Article' },
    attributes: { title: { type: 'string' } },
  }),
  [`${SYNC}/core-store.plugin_content_manager_configuration_content_types##api##article.article.json`]: j({ key: 'plugin_content_manager_configuration_content_types::api::article.article', value: {}, type: 'object' }),
  [`${SYNC}/user-role.public.json`]: j({ name: 'Public', type: 'public', permissions: [{ action: 'api::article.article.find' }] }),
  [`${SYNC}/user-role.authenticated.json`]: j({ name: 'Authenticated', type: 'authenticated', permissions: [{ action: 'api::article.article.find' }, { action: 'api::article.article.feature' }] }),
  [`${SYNC}/core-store.broken.json`]: '{ "key": ',
  [`${SYNC}/core-store.plugin_upload_metrics.json`]: j({ key: 'plugin_upload_metrics', value: {} }),
  [`${SYNC}/core-store.plugin_users-permissions_grant.json`]: j({ key: 'plugin_users-permissions_grant', value: {} }),
  [`${SYNC}/mytype.thing.json`]: j({ uid: 'thing' }),
};

describe('config-sync, read from the files', () => {
  it('detects the plugin, its options (through imports and a config function) and the env overrides', async () => {
    const { fs, project } = await load(FILES);
    const d = (await detectConfigSync(fs, project))!;
    expect(d.installedVersion).toBe('3.2.0');
    expect(d.targetsStrapi).toBe(5);
    expect(d.versionMismatch).toBe(false);
    expect(d.options.sources).toMatchObject({ excludedConfig: 'config', minify: 'config', syncDir: 'default' });
    expect(d.envOverrides).toEqual([`${ROOT}/config/env/production/plugins.ts`]);
    expect(d.syncDirExists).toBe(true);
  });

  it("merges a short excludedConfig with the plugin's defaults index by index, as Strapi does, and says so", async () => {
    const { fs, project } = await load(FILES);
    const d = (await detectConfigSync(fs, project))!;
    expect(d.options.excludedConfig).toEqual(['core-store.plugin_upload_metrics', ...DEFAULT_EXCLUDED_CONFIG.slice(1)]);
    expect(d.warnings.join(' ')).toContain('no longer does');
    expect(d.warnings.join(' ')).toContain('core-store.plugin_users-permissions_grant');
  });

  it('reads the files the way the plugin names them: escaping, excluded, invalid, unknown types', async () => {
    expect(unescapeName('plugin_content_manager_configuration_content_types##api##article.article')).toBe('plugin_content_manager_configuration_content_types::api::article.article');
    expect(escapeName('a::b/c')).toBe('a##b$c');
    const { fs, project } = await load(FILES);
    const st = (await configSyncStatus(fs, project))!;
    expect(st.partial).toBe(false);
    const byKey = Object.fromEntries(st.files.map((f) => [f.key, f.status]));
    expect(byKey).toEqual({
      'core-store.broken': 'invalid',
      'core-store.plugin_content_manager_configuration_content_types::api::article.article': 'ok',
      'core-store.plugin_upload_metrics': 'excluded',
      // The default `plugin_users-permissions_grant` is no longer excluded: the user list took its index.
      'core-store.plugin_users-permissions_grant': 'ok',
      'mytype.thing': 'unknown-type',
      'user-role.authenticated': 'ok',
      'user-role.public': 'ok',
    });
  });

  it('names entries readably', async () => {
    const { project } = await load(FILES);
    expect(configSyncLabel(project, 'core-store', 'plugin_content_manager_configuration_content_types::api::article.article').label).toBe('View — Article');
    expect(configSyncLabel(project, 'user-role', 'public').label).toBe('Role Public');
    expect(configSyncLabel(project, 'admin-role', 'strapi-editor').label).toBe('Admin role Editor');
    expect(configSyncLabel(project, 'core-store', 'plugin_upload_settings').label).toBe('Upload settings');
  });

  it('tells which synced roles allow an action, and says nothing when the roles do not decide', async () => {
    const { fs, project } = await load(FILES);
    const files = (await configSyncStatus(fs, project))!.files;
    expect(routeAccessInSync(files, 'api::article.article.feature')).toMatchObject({ allowed: ['authenticated'], denied: ['public'] });
    const route = { method: 'GET', path: '/articles', handler: 'article.find', owner: 'api::article', type: 'content-api' } as RouteInfo;
    expect(routeAccessForRoute(route, files)).toMatchObject({ action: 'api::article.article.find', allowed: ['authenticated', 'public'] });
    expect(routeAccessForRoute({ ...route, public: true }, files)).toBeUndefined();
  });

  it('is undefined when config-sync is not used', async () => {
    const { fs, project } = await load({ [`${ROOT}/package.json`]: j({ dependencies: v5 }), ...STRAPI_5 });
    expect(await configSyncStatus(fs, project)).toBeUndefined();
  });
});

describe('config-sync, the variants', () => {
  it('reads literal options and a custom syncDir, and warns when it has no trailing slash', async () => {
    const { fs, project } = await load(app(v5, { [`${ROOT}/config/plugins.js`]: "module.exports = { 'config-sync': { config: { syncDir: 'config/cs', minify: true, excludedTypes: ['i18n-locale'] } } };" }));
    const d = (await detectConfigSync(fs, project))!;
    expect(d.options).toMatchObject({ syncDir: 'config/cs', minify: true, excludedTypes: ['i18n-locale'], excludedConfig: DEFAULT_EXCLUDED_CONFIG });
    expect(d.options.sources).toMatchObject({ syncDir: 'config', minify: 'config', excludedConfig: 'default' });
    expect(d.syncDirPath).toBe(`${ROOT}/config/cs`);
    expect(d.syncDirExists).toBe(false);
    expect(d.warnings.join(' ')).toContain('no trailing slash');
    expect(await readSyncDir(fs, d.syncDirPath, d.options)).toEqual([]);
  });

  it("says when it can't read the options, and assumes the plugin defaults", async () => {
    const { fs, project } = await load(app(v5, { [`${ROOT}/config/plugins.js`]: "module.exports = { 'config-sync': { config: makeOptions() } };" }));
    const d = (await detectConfigSync(fs, project))!;
    expect(Object.values(d.options.sources)).toEqual(Array(7).fill('unresolved'));
    expect(d.options.syncDir).toBe('config/sync/');
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  it('flags config-sync 3.x on a Strapi 4 project, and takes 2.x for Strapi 5 (their peer dependencies)', async () => {
    const v4 = await load(app({ '@strapi/strapi': '^4.25.0' }, {}));
    const d4 = (await detectConfigSync(v4.fs, v4.project))!;
    expect(d4).toMatchObject({ targetsStrapi: 5, versionMismatch: true });
    expect(d4.warnings.join(' ')).toContain('is for Strapi 5');
    const v2 = await load(app({ ...v5, 'strapi-plugin-config-sync': '2.1.0' }, {}));
    expect(await detectConfigSync(v2.fs, v2.project)).toMatchObject({ targetsStrapi: 5, versionMismatch: false });
  });

  it('knows user-role only when users-permissions is installed', async () => {
    const role = { [`${SYNC}/user-role.public.json`]: j({ name: 'Public', permissions: [], type: 'public' }) };
    const without = await load(app(v5, role));
    expect((await configSyncStatus(without.fs, without.project))!.files[0]!.status).toBe('unknown-type');
    const up = await load(app(withUp, { ...role, ...USERS_PERMISSIONS }));
    expect((await configSyncStatus(up.fs, up.project))!.files[0]!.status).toBe('ok');
  });
});
