#!/usr/bin/env node
/**
 * DevKit test oracle — NOT shipped, NOT run on users' machines.
 *
 * Boots the Strapi app in the current working directory at the `register` level
 * (code + plugins loaded; no database, no bootstrap, no server) and prints what
 * Strapi itself registered, as JSON, between two marker lines. The core's
 * `oracle.e2e` test compares DevKit's *static* reading of the same app against
 * this ground truth.
 *
 * Routes are not normalised by Strapi until the server starts, so this script
 * applies Strapi's own rules (from `services/server/register-routes`): an API
 * router is always `content-api`; a plugin's array of routes is one `admin`
 * router prefixed `/<plugin>`; a plugin router defaults to `type: 'admin'` and
 * `prefix: '/<plugin>'`; a route whose `config` has a `prefix` key replaces the
 * router prefix; content-api routes sit under `api.rest.prefix`.
 *
 * Usage (from the app root): node /path/to/strapi-registries.cjs
 * Note: for a TypeScript v5 app, Strapi compiles the project into `dist/`.
 */
'use strict';

const path = require('path');
const { createRequire } = require('module');

const appDir = process.cwd();
const req = createRequire(path.join(appDir, 'package.json'));
const MARK = '@@DEVKIT_ORACLE@@';

function keysOf(registry) {
  if (!registry) return [];
  if (typeof registry.keys === 'function') return [...registry.keys()];
  if (typeof registry.getAll === 'function') return Object.keys(registry.getAll());
  return Object.keys(registry);
}

function registry(app, name) {
  for (const get of [() => app.get(name), () => app.container.get(name), () => app[name]]) {
    try {
      const r = get();
      if (r) return r;
    } catch {
      /* next */
    }
  }
  return undefined;
}

function instanceOf(reg, key) {
  try {
    if (typeof reg.get === 'function') return reg.get(key);
  } catch {
    /* fall through */
  }
  return reg[key];
}

function methodsOf(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const out = new Set(Object.keys(obj));
  return [...out].sort();
}

function groups(routes, isPlugin, pluginName, app) {
  if (!routes) return [];
  if (Array.isArray(routes)) {
    return [{ type: isPlugin ? 'admin' : 'content-api', prefix: isPlugin ? `/${pluginName}` : undefined, routes }];
  }
  return Object.values(routes).map((r) => {
    const router = typeof r === 'function' ? r({ strapi: app }) : r;
    return {
      type: isPlugin ? (router.type ?? 'admin') : 'content-api',
      prefix: isPlugin ? (router.prefix ?? `/${pluginName}`) : router.prefix,
      routes: router.routes || [],
    };
  });
}

function routeTable(app) {
  const apiPrefix = (app.config.get('api.rest.prefix') || '/api').replace(/\/$/, '');
  const out = [];
  const add = (owner, plugin, g, r) => {
    const cfg = r.config || {};
    const own = Object.prototype.hasOwnProperty.call(cfg, 'prefix') ? cfg.prefix || '' : g.prefix || '';
    let fullPath = ((g.type === 'content-api' ? apiPrefix : '') + own + r.path).replace(/\/{2,}/g, '/');
    if (fullPath.length > 1 && fullPath.endsWith('/')) fullPath = fullPath.slice(0, -1);
    let handler = typeof r.handler === 'string' ? r.handler : null;
    if (handler && plugin && !handler.includes('::')) handler = `plugin::${plugin}.${handler}`;
    out.push({ owner, type: g.type, method: r.method, fullPath, handler, public: cfg.auth === false });
  };
  const apis = app.apis && Object.keys(app.apis).length ? app.apis : app.api || {};
  for (const [name, api] of Object.entries(apis)) {
    for (const g of groups(api.routes, false, name, app)) for (const r of g.routes) add(`api::${name}`, null, g, r);
  }
  for (const [name, plugin] of Object.entries(app.plugins || {})) {
    for (const g of groups(plugin.routes, true, name, app)) for (const r of g.routes) add(`plugin::${name}`, name, g, r);
  }
  return out;
}

async function boot() {
  const s = req('@strapi/strapi');
  const version = req('@strapi/strapi/package.json').version;
  let app;
  if (parseInt(version, 10) >= 5) {
    const ctx = await s.compileStrapi();
    app = await s.createStrapi(ctx).register();
  } else {
    const factory = s.default || s;
    app = await factory({ appDir, distDir: appDir }).register();
  }
  return { app, version };
}

(async () => {
  const t0 = Date.now();
  const { app, version } = await boot();
  const result = { version, bootMs: Date.now() - t0, enabledPlugins: Object.keys(app.plugins || {}).sort(), registries: {}, routes: [] };
  for (const kind of ['content-types', 'components', 'services', 'controllers', 'policies', 'middlewares']) {
    const reg = registry(app, kind);
    const entries = {};
    for (const key of keysOf(reg).sort()) {
      const entry = {};
      if (kind === 'services' || kind === 'controllers') {
        const inst = instanceOf(reg, key);
        entry.methods = methodsOf(inst);
      }
      if (kind === 'content-types') {
        const ct = instanceOf(reg, key);
        if (ct && ct.attributes) entry.attributes = Object.keys(ct.attributes).sort();
      }
      entries[key] = entry;
    }
    result.registries[kind] = entries;
  }
  result.routes = routeTable(app);
  process.stdout.write(`\n${MARK}\n${JSON.stringify(result)}\n${MARK}\n`);
  try {
    await app.destroy();
  } catch {
    /* ignore */
  }
  process.exit(0);
})().catch((e) => {
  process.stderr.write(`ORACLE FAILED: ${(e && e.stack) || e}\n`);
  process.exit(1);
});
