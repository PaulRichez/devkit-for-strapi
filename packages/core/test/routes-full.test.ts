import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { listRoutes } from '../src/index/routes';

const ROOT = '/app';

function app(version: '4.25.0' | '5.10.0', extra: Record<string, string> = {}): MemoryFileSystem {
  const nm = `${ROOT}/node_modules`;
  return new MemoryFileSystem({
    [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { '@strapi/strapi': version, '@strapi/plugin-i18n': version } }),
    [`${nm}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version }),
    [`${nm}/@strapi/plugin-i18n/package.json`]: JSON.stringify({ name: '@strapi/plugin-i18n', version, strapi: { name: 'i18n', kind: 'plugin' } }),
    [`${nm}/@strapi/plugin-i18n/strapi-server.js`]: `module.exports = {
  routes: {
    'content-api': { type: 'content-api', routes: [{ method: 'GET', path: '/locales', handler: 'locales.listLocales' }] },
    admin: { type: 'admin', routes: [{ method: 'POST', path: '/locales', handler: 'locales.createLocale' }] },
  },
};`,
    [`${ROOT}/src/api/page/content-types/page/schema.json`]: JSON.stringify({
      kind: 'collectionType',
      info: { singularName: 'page', pluralName: 'pages' },
      pluginOptions: { i18n: { localized: true } },
      attributes: { title: { type: 'string' } },
    }),
    [`${ROOT}/src/api/page/routes/page.ts`]: `import { factories } from '@strapi/strapi';\nexport default factories.createCoreRouter('api::page.page', { only: ['find'] });`,
    [`${ROOT}/src/api/page/routes/custom.ts`]: `const customRoutes = {
  routes: [
    { method: 'GET', path: '/pages/featured', handler: 'page.featured', config: { auth: false } },
  ],
};
export default customRoutes;`,
    ...extra,
  });
}

async function routesOf(fs: MemoryFileSystem, opts?: Parameters<typeof listRoutes>[2]) {
  const engine = createEngine(fs);
  await engine.init([ROOT]);
  return listRoutes(fs, engine.allProjects()[0]!, opts);
}

describe('listRoutes — locations, mounted paths, plugins', () => {
  it('locates every project route and mounts it under the API prefix', async () => {
    const fs = app('5.10.0');
    const routes = await routesOf(fs);
    const find = routes.find((r) => r.handler === 'api::page.page.find')!;
    expect(find).toMatchObject({ method: 'GET', path: '/pages', fullPath: '/api/pages', origin: 'project', owner: 'api::page', type: 'content-api' });
    const src = await fs.readFile(find.filePath!);
    expect(src.slice(find.offset!).startsWith('factories.createCoreRouter(')).toBe(true);

    const custom = routes.find((r) => r.handler === 'page.featured')!;
    expect(custom).toMatchObject({ fullPath: '/api/pages/featured', public: true, source: 'router-file' });
    const csrc = await fs.readFile(custom.filePath!);
    expect(csrc.slice(custom.offset!).startsWith("{ method: 'GET'")).toBe(true);
  });

  it('honours a literal api.rest.prefix', async () => {
    const routes = await routesOf(app('5.10.0', { [`${ROOT}/config/api.ts`]: `export default { rest: { prefix: '/v1' } };` }));
    expect(routes.find((r) => r.handler === 'api::page.page.find')!.fullPath).toBe('/v1/pages');
    expect(routes.find((r) => r.owner === 'plugin::i18n')!.fullPath).toBe('/v1/i18n/locales');
  });

  it('includes plugin content-api routes, leaves admin ones out unless asked', async () => {
    const fs = app('5.10.0');
    const routes = await routesOf(fs);
    const plugin = routes.filter((r) => r.origin === 'installed-plugin');
    expect(plugin.map((r) => `${r.method} ${r.fullPath} ${r.handler}`)).toEqual(['GET /api/i18n/locales plugin::i18n.locales.listLocales']);
    const withAdmin = await routesOf(fs, { admin: true });
    expect(withAdmin.some((r) => r.type === 'admin' && r.fullPath === '/i18n/locales')).toBe(true);
    const noPlugins = await routesOf(fs, { plugins: false });
    expect(noPlugins.every((r) => r.origin === 'project')).toBe(true);
  });

  it('adds the Strapi 4 i18n localization route to localized content-types (only in v4)', async () => {
    const v4 = await routesOf(app('4.25.0'));
    expect(v4.find((r) => r.source === 'plugin-injected')).toMatchObject({
      method: 'POST',
      fullPath: '/api/pages/:id/localizations',
      handler: 'api::page.page.createLocalization',
    });
    const v5 = await routesOf(app('5.10.0'));
    expect(v5.some((r) => r.source === 'plugin-injected')).toBe(false);
  });
});
