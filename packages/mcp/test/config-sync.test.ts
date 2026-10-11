import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, MemoryFileSystem } from 'devkit-for-strapi-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { planRename } from 'devkit-for-strapi-pro';
import { registerTools } from '../src/tools';

type Handler = (args?: unknown) => Promise<CallToolResult>;

/** The open-source build ships a stub of the Pro refactor engine; the real one runs the refactor tests too. */
const HAS_PRO_ENGINE = await (async (): Promise<boolean> => {
  try {
    await planRename(new MemoryFileSystem({}), { index: { services: new Map(), controllers: new Map(), contentTypes: new Map(), policies: new Map(), middlewares: new Map(), components: new Map() } } as never, 'x', 'y');
    return true;
  } catch (e) {
    return !/not included in the open-source build/.test(String(e));
  }
})();

const ROOT = 'c:/cs';
const SYNC = `${ROOT}/config/sync`;
const j = (v: unknown): string => JSON.stringify(v, null, 2);
const FILES: Record<string, string> = {
  [`${ROOT}/package.json`]: j({ dependencies: { '@strapi/strapi': '^5.0.0', '@strapi/plugin-users-permissions': '^5.0.0', 'strapi-plugin-config-sync': '^3.2.0' } }),
  [`${ROOT}/node_modules/@strapi/strapi/package.json`]: j({ name: '@strapi/strapi', version: '5.0.0' }),
  [`${ROOT}/node_modules/@strapi/plugin-users-permissions/package.json`]: j({ name: '@strapi/plugin-users-permissions', version: '5.0.0', strapi: { name: 'users-permissions', kind: 'plugin' } }),
  [`${ROOT}/node_modules/@strapi/plugin-users-permissions/strapi-server.js`]: 'module.exports = () => ({});',
  [`${ROOT}/node_modules/strapi-plugin-config-sync/package.json`]: j({ name: 'strapi-plugin-config-sync', version: '3.2.0' }),
  [`${ROOT}/src/api/article/content-types/article/schema.json`]: j({
    kind: 'collectionType',
    info: { singularName: 'article', pluralName: 'articles', displayName: 'Article' },
    attributes: { title: { type: 'string' } },
  }),
  [`${ROOT}/src/api/article/routes/article.ts`]: "export default factories.createCoreRouter('api::article.article', { config: { delete: { auth: false } } });\n",
  [`${SYNC}/user-role.public.json`]: j({ name: 'Public', permissions: [{ action: 'api::article.article.find' }, { action: 'api::article.article.findOne' }], type: 'public' }),
  [`${SYNC}/user-role.authenticated.json`]: j({ name: 'Authenticated', permissions: [{ action: 'api::article.article.find' }], type: 'authenticated' }),
  [`${SYNC}/core-store.plugin_users-permissions_grant.json`]: j({ key: 'plugin_users-permissions_grant', value: {} }),
  [`${SYNC}/core-store.plugin_upload_settings.json`]: '{ "key": ',
};

describe('config_sync_status, and config-sync in project_info and list_routes', () => {
  const handlers = new Map<string, Handler>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (name: string, args: unknown = {}): Promise<any> => JSON.parse(((await handlers.get(name)!(args)).content[0] as { text: string }).text);

  beforeAll(async () => {
    const fs = new MemoryFileSystem(FILES);
    const engine = createEngine(fs);
    await engine.init([ROOT], { waitForInstalled: true });
    const fakeServer = { registerTool: (name: string, _c: unknown, cb: Handler) => handlers.set(name, cb) } as unknown as McpServer;
    registerTools(fakeServer, engine, fs, Promise.resolve());
  });

  it('sums up the plugin, its options and its files by status', async () => {
    const data = await call('config_sync_status');
    expect(data.detected).toBe(true);
    expect(data.plugin).toMatchObject({ package: 'strapi-plugin-config-sync', installed: '3.2.0', forStrapi: 5 });
    expect(data.optionSources.syncDir).toBe('default');
    expect(data.files).toEqual({ total: 4, byStatus: { ok: 2, excluded: 1, invalid: 1 } });
    expect(data.invalid).toEqual(['core-store.plugin_upload_settings']);
    expect(data.partial).toBeUndefined();
  });

  it('lists the files with readable labels on request, and gives one file in full', async () => {
    const data = await call('config_sync_status', { files: true });
    expect(data.files.list).toContainEqual({ key: 'user-role.public', label: 'Role Public', status: 'ok' });
    const one = await call('config_sync_status', { key: 'user-role.public' });
    expect(one).toMatchObject({ key: 'user-role.public', label: 'Role Public', status: 'ok' });
    expect(one.content.type).toBe('public');
    expect((await call('config_sync_status', { key: 'user-role.publik' })).found).toBe(false);
  });

  it('tells the agent in project_info that config-sync is used', async () => {
    const info = await call('project_info');
    expect(info.configSync).toEqual({ version: '3.2.0', syncDir: 'config/sync', files: 4, invalid: 1 });
    expect(info.notes.join(' ')).toContain('config_sync_status');
  });

  it('says which synced roles may call a route, and nothing when the roles do not decide', async () => {
    const data = await call('list_routes', { path: '/api/articles', pipeline: true });
    const auth = (method: string, path: string) =>
      data.routes.find((r: { method: string; path: string }) => r.method === method && r.path === path).pipeline.find((s: { phase: string }) => s.phase === 'auth');
    expect(auth('GET', '/articles').syncedRoles).toMatchObject({ action: 'api::article.article.find', allowed: ['authenticated', 'public'], denied: [] });
    expect(auth('POST', '/articles').syncedRoles).toMatchObject({ allowed: [], denied: ['authenticated', 'public'] });
    const del = await call('list_routes', { method: 'DELETE', pipeline: true });
    expect(del.routes[0].pipeline[0].syncedRoles).toBeUndefined();
  });

  it('the Pro diff, export and import: the upsell without a licence, a plain failure otherwise', async () => {
    const fs = new MemoryFileSystem(FILES);
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const unlicensed = new Map<string, Handler>();
    registerTools({ registerTool: (name: string, _c: unknown, cb: Handler) => unlicensed.set(name, cb) } as unknown as McpServer, engine, fs, Promise.resolve(), () => [], () => Promise.resolve(false));
    for (const tool of ['config_sync_diff', 'config_sync_export', 'config_sync_import']) {
      const up = JSON.parse(((await unlicensed.get(tool)!({ keys: ['user-role.public'] })).content[0] as { text: string }).text);
      expect(up).toMatchObject({ proRequired: true, feature: 'Config sync', tool });
    }
    // Licensed: the open-source build says the engine isn't there; the real one finds no project on disk.
    const data = await call('config_sync_diff');
    expect(data.ok).toBe(false);
    expect(data.kind === 'no-strapi' || /not included in the open-source build/.test(data.message)).toBe(true);
  });

  it('the Pro tools say so, without loading Strapi, when the plugin is not used or disabled', async () => {
    const run = async (files: Record<string, string>): Promise<Record<string, unknown>> => {
      const fs = new MemoryFileSystem(files);
      const engine = createEngine(fs);
      await engine.init([ROOT]);
      const h = new Map<string, Handler>();
      registerTools({ registerTool: (name: string, _c: unknown, cb: Handler) => h.set(name, cb) } as unknown as McpServer, engine, fs, Promise.resolve());
      return JSON.parse(((await h.get('config_sync_diff')!({})).content[0] as { text: string }).text);
    };
    expect(await run({ [`${ROOT}/package.json`]: j({ dependencies: { '@strapi/strapi': '^5.0.0' } }) })).toMatchObject({ detected: false });
    expect(await run({ ...FILES, [`${ROOT}/config/plugins.js`]: "module.exports = { 'config-sync': { enabled: false } };" })).toMatchObject({ detected: true, disabled: true });
  });

  it.skipIf(!HAS_PRO_ENGINE)('a refactor updates the config/sync files it concerns — unless configSync: false, or the default says so — and the plan tells the agent', async () => {
    const fs = new MemoryFileSystem(FILES);
    const engine = createEngine(fs);
    await engine.init([ROOT], { waitForInstalled: true });
    await engine.whenReferencesReady();
    const h = new Map<string, Handler>();
    registerTools({ registerTool: (name: string, _c: unknown, cb: Handler) => h.set(name, cb) } as unknown as McpServer, engine, fs, Promise.resolve());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plan = async (args: Record<string, unknown>): Promise<any> => JSON.parse(((await h.get('plan_rename_entity')!({ ref: 'api::article.article', newName: 'post', ...args })).content[0] as { text: string }).text);
    // The files the plan edits or renames (not its warnings, which name them too).
    const touched = (p: { textEdits: unknown[]; fileRenames: unknown[] }): string => JSON.stringify([p.textEdits, p.fileRenames]);
    const role = 'user-role.public.json';

    const followed = await plan({});
    expect(touched(followed)).toContain(role);
    expect(followed.warnings.join(' ')).toMatch(/config\/sync: this plan also updates 2 files .*user-role\.public\.json/);

    const left = await plan({ configSync: false });
    expect(touched(left)).not.toContain(role);
    expect(touched(left)).toContain('schema.json');
    expect(left.warnings.join(' ')).toMatch(/config\/sync: left as it is .*still use the old names \(.*user-role\.public\.json/);

    process.env.DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS = '0';
    try {
      expect(touched(await plan({}))).not.toContain(role);
      expect(touched(await plan({ configSync: true }))).toContain(role);
    } finally {
      delete process.env.DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS;
    }
    // VS Code's per-folder setting: the folders that turned it off.
    process.env.DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS_OFF = JSON.stringify(['C:\\cs']);
    try {
      expect(touched(await plan({}))).not.toContain(role);
      process.env.DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS_OFF = JSON.stringify(['c:/other']);
      expect(touched(await plan({}))).toContain(role);
    } finally {
      delete process.env.DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS_OFF;
    }
  });

  it('says plainly when config-sync is not used', async () => {
    const fs = new MemoryFileSystem({ [`${ROOT}/package.json`]: j({ dependencies: { '@strapi/strapi': '^5.0.0' } }) });
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const h = new Map<string, Handler>();
    registerTools({ registerTool: (name: string, _c: unknown, cb: Handler) => h.set(name, cb) } as unknown as McpServer, engine, fs, Promise.resolve());
    const data = JSON.parse(((await h.get('config_sync_status')!({})).content[0] as { text: string }).text);
    expect(data.detected).toBe(false);
  });
});
