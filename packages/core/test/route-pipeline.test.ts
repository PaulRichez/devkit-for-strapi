/**
 * The route pipeline (what a request goes through, in Strapi's order) and the
 * exact name rules behind it. Strapi references, identical in both versions:
 * - order: `@strapi/strapi/lib/services/server/compose-endpoint.js` (4.13.5) and
 *   `@strapi/core/dist/services/server/compose-endpoint.js` (5.48);
 * - policy names: `@strapi/utils/dist/policy.js#findPolicy` (4.13.5) and
 *   `@strapi/core/dist/registries/policies.js#find` (5.48) — exact, then the route's
 *   plugin XOR API, never `global::`;
 * - middleware names: `services/server/middleware.js#resolveMiddlewares` — exact only.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { readGlobalMiddlewares } from '../src/index/globalMiddlewares';
import type { RouteInfo, StrapiProject } from '../src/model/types';
import { modelOf } from '../src/query/model';
import { qualifiedHandler, routePipeline, routesByAction } from '../src/query/routePipeline';
import { devkitNameCandidates, lookupStrapiName, strapiNameCandidates } from '../src/resolve/strapiNames';

const ROOT = 'c:/rp';

const FILES: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/config/middlewares.ts`]: `export default [
  'strapi::errors',
  { name: 'strapi::cors', config: { origin: ['*'] } },
  'global::request-id',
  'request-id',
  { resolve: './src/custom/timer' },
];`,
  [`${ROOT}/src/middlewares/request-id.ts`]: 'export default () => async (ctx, next) => next();\n',
  [`${ROOT}/src/middlewares/audit.ts`]: 'export default () => async (ctx, next) => next();\n',
  [`${ROOT}/src/policies/is-owner.ts`]: 'export default () => true;\n',
  [`${ROOT}/src/api/article/policies/is-published.ts`]: 'export default () => true;\n',
  [`${ROOT}/src/api/article/content-types/article/schema.json`]: JSON.stringify({
    kind: 'collectionType',
    collectionName: 'articles',
    info: { singularName: 'article', pluralName: 'articles', displayName: 'Article' },
    attributes: {
      title: { type: 'string', required: true },
      author: { type: 'relation', relation: 'manyToOne', target: 'api::author.author', inversedBy: 'articles' },
      seo: { type: 'component', component: 'shared.seo', repeatable: false },
      blocks: { type: 'dynamiczone', components: ['shared.seo', 'shared.quote'] },
    },
  }),
  [`${ROOT}/src/api/author/content-types/author/schema.json`]: JSON.stringify({
    kind: 'collectionType',
    info: { singularName: 'author', pluralName: 'authors', displayName: 'Author' },
    attributes: {
      articles: { type: 'relation', relation: 'oneToMany', target: 'api::article.article', mappedBy: 'author' },
      mentor: { type: 'relation', relation: 'oneToOne', target: 'api::author.author' },
    },
  }),
  [`${ROOT}/src/components/shared/seo.json`]: JSON.stringify({ info: { displayName: 'Seo' }, attributes: { metaTitle: { type: 'string' } } }),
  [`${ROOT}/src/components/shared/quote.json`]: JSON.stringify({ info: { displayName: 'Quote' }, attributes: { by: { type: 'relation', relation: 'oneToOne', target: 'api::author.author' } } }),
  [`${ROOT}/src/components/shared/orphan.json`]: JSON.stringify({ info: { displayName: 'Orphan' }, attributes: {} }),
  [`${ROOT}/src/api/article/controllers/article.ts`]:
    "import { factories } from '@strapi/strapi';\nexport default factories.createCoreController('api::article.article', () => ({ async find(ctx) { return super.find(ctx); }, async publish(ctx) {} }));\n",
  [`${ROOT}/src/api/article/routes/article.ts`]:
    "import { factories } from '@strapi/strapi';\nexport default factories.createCoreRouter('api::article.article', { config: { find: { auth: false }, findOne: { policies: ['is-published'] }, create: { auth: { scope: ['api::article.article.create'] } } } });\n",
  [`${ROOT}/src/api/article/routes/custom.ts`]: `export default {
  routes: [
    { method: 'POST', path: '/articles/:id/publish', handler: 'article.publish', config: { policies: ['is-owner', 'global::is-owner', (ctx) => true, 'nope'], middlewares: ['audit', 'global::audit'] } },
    { method: 'GET', path: '/articles/dyn', handler: 'article.find', config: sharedConfig },
  ],
};`,
  [`${ROOT}/src/api/author/routes/author.ts`]: "import { factories } from '@strapi/strapi';\nexport default factories.createCoreRouter('api::author.author');\n",
};

describe('strapi name rules', () => {
  it('a policy: exact, then the route plugin XOR its API — never global::', () => {
    expect(strapiNameCandidates('policy', 'is-owner', { api: 'article' })).toEqual(['is-owner', 'api::article.is-owner']);
    expect(strapiNameCandidates('policy', 'is-owner', { plugin: 'shop' })).toEqual(['is-owner', 'plugin::shop.is-owner']);
    expect(strapiNameCandidates('policy', 'global::is-owner', { api: 'article' })).toEqual(['global::is-owner']);
  });

  it('a middleware: its exact name only', () => {
    expect(strapiNameCandidates('middleware', 'audit', { api: 'article' })).toEqual(['audit']);
  });

  it('says what the author meant when Strapi would not find it', () => {
    const has = (k: string): boolean => k === 'global::is-owner';
    expect(devkitNameCandidates('is-owner', { api: 'article' })).toEqual(['api::article.is-owner', 'global::is-owner']);
    expect(lookupStrapiName(has, 'policy', 'is-owner', { api: 'article' })).toEqual({ status: 'not-found-by-strapi', ref: 'global::is-owner' });
    expect(lookupStrapiName(has, 'policy', 'global::is-owner', { api: 'article' })).toEqual({ status: 'found', ref: 'global::is-owner' });
    expect(lookupStrapiName(has, 'policy', 'missing', { api: 'article' })).toEqual({ status: 'unknown' });
  });
});

describe('the route pipeline', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  let routes: RouteInfo[];
  const route = (method: string, path: string): RouteInfo => routes.find((r) => r.method === method && r.path === path)!;

  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(FILES));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
    routes = (await engine.getRoutes({ admin: true }))[0]!.routes;
  });

  it('flags a bare global policy or middleware in a route: Strapi throws at startup', async () => {
    const code = FILES[`${ROOT}/src/api/article/routes/custom.ts`]!;
    const diags = await engine.validateFile(`${ROOT}/src/api/article/routes/custom.ts`, code);
    const byText = (t: string) => diags.find((d) => code.slice(d.start, d.end) === t);
    const policy = byText('is-owner');
    expect(policy?.code).toBe('devkit-for-strapi.not-found-by-strapi');
    expect(policy?.message).toContain('never in `global::`');
    expect(policy?.quickFixes?.[0]?.replacement).toBe('global::is-owner');
    expect(byText('audit')?.quickFixes?.[0]?.replacement).toBe('global::audit');
    expect(byText('nope')?.code).toBe('devkit-for-strapi.unknown-policy');
    // The qualified forms are what Strapi finds.
    expect(diags.filter((d) => code.slice(d.start, d.end).startsWith('global::'))).toEqual([]);
  });

  it('flags a bare global middleware in config/middlewares', async () => {
    const file = `${ROOT}/config/middlewares.ts`;
    const code = FILES[file]!;
    const diags = await engine.validateFile(file, code);
    expect(diags.map((d) => [code.slice(d.start, d.end), d.code])).toEqual([['request-id', 'devkit-for-strapi.not-found-by-strapi']]);
  });

  it('keeps accepting a bare policy where the route owner is unknown (src/extensions)', async () => {
    const code = `export default (plugin) => { plugin.routes['content-api'].routes.push({ method: 'GET', path: '/x', handler: 'user.me', config: { policies: ['is-owner'] } }); return plugin; };`;
    expect(await engine.validateFile(`${ROOT}/src/extensions/users-permissions/strapi-server.ts`, code)).toEqual([]);
  });

  it('reads auth: public, custom and unread, per core-router action too', () => {
    const find = route('GET', '/articles');
    expect(find.public).toBe(true);
    expect(find.auth).toEqual({ mode: 'public' });
    expect(route('POST', '/articles').auth).toEqual({ mode: 'custom', scope: ['api::article.article.create'] });
    expect(route('GET', '/articles/:id').policies).toEqual(['is-published']);
    expect(route('GET', '/articles/:id').auth).toBeUndefined();
    const dyn = route('GET', '/articles/dyn');
    expect(dyn.auth).toEqual({ mode: 'unread' });
    expect(dyn.policies).toEqual(['<unread>']);
    expect(route('POST', '/articles/:id/publish').policies).toEqual(['is-owner', 'global::is-owner', '<inline>', 'nope']);
  });

  it("orders the steps the way Strapi composes them, each with Strapi's verdict", async () => {
    const global = await engine.getGlobalMiddlewares(ROOT);
    const p = routePipeline(project, route('POST', '/articles/:id/publish'), global);
    expect(p.global.status).toBe('read');
    expect(p.steps.map((s) => `${s.phase}:${s.name}:${s.status}`)).toEqual([
      'global-middleware:strapi::errors:unverified', // Strapi's own registry isn't installed in this fixture
      'global-middleware:strapi::cors:unverified',
      'global-middleware:global::request-id:ok',
      'global-middleware:request-id:not-found-by-strapi',
      'global-middleware:./src/custom/timer:unverified',
      'auth:Default:ok',
      'policy:is-owner:not-found-by-strapi',
      'policy:global::is-owner:ok',
      'policy:<inline>:inline',
      'policy:nope:unknown',
      'route-middleware:audit:not-found-by-strapi',
      'route-middleware:global::audit:ok',
      'handler:article.publish:ok',
    ]);
    const handler = p.steps.at(-1)!;
    expect(handler.ref).toBe('api::article.article.publish');
    expect(handler.target?.filePath).toBe(`${ROOT}/src/api/article/controllers/article.ts`);
    expect(p.steps[6]!.ref).toBe('global::is-owner');
    // Where each step is written: the config entry, the route declaration.
    expect(p.steps[3]!.declaredAt?.filePath).toBe(`${ROOT}/config/middlewares.ts`);
    expect(FILES[`${ROOT}/config/middlewares.ts`]!.slice(p.steps[3]!.declaredAt!.offset!).startsWith("request-id'")).toBe(true);
    expect(p.steps[6]!.declaredAt?.filePath).toBe(`${ROOT}/src/api/article/routes/custom.ts`);
  });

  it('says what auth means without claiming more than the code shows', async () => {
    const global = await engine.getGlobalMiddlewares(ROOT);
    const auth = (m: string, path: string) => routePipeline(project, route(m, path), global).steps.find((s) => s.phase === 'auth')!;
    expect(auth('GET', '/articles').name).toBe('Public');
    expect(auth('POST', '/articles').note).toContain('scope api::article.article.create');
    expect(auth('GET', '/articles/:id').note).toContain('set in the admin');
    expect(auth('GET', '/articles/dyn').status).toBe('unread');
  });

  it('resolves core actions: overridden, inherited, and generated for a schema-only type', async () => {
    const global = await engine.getGlobalMiddlewares(ROOT);
    const handler = (m: string, path: string) => routePipeline(project, route(m, path), global).steps.at(-1)!;
    expect(handler('GET', '/articles').target?.offset).toBeGreaterThan(0); // the overriding `find`
    expect(handler('GET', '/articles').note).toBeUndefined();
    expect(handler('DELETE', '/articles/:id').note).toContain('not overridden');
    expect(handler('GET', '/authors').note).toContain('no controller file');
    expect(handler('GET', '/authors').target?.filePath).toBe(`${ROOT}/src/api/author/content-types/author/schema.json`);
  });

  it('maps every action to the routes calling it (short handlers qualified)', () => {
    const map = routesByAction(routes);
    expect(map.get('api::article.article.publish')?.map((r) => r.path)).toEqual(['/articles/:id/publish']);
    expect(map.get('api::article.article.find')?.map((r) => r.path).sort()).toEqual(['/articles', '/articles/dyn']);
    expect(qualifiedHandler({ handler: 'article.find', owner: 'api::article' })).toBe('api::article.article.find');
  });

  it('caches the route table until a route-relevant file changes', async () => {
    const a = (await engine.getRoutes())[0]!.routes;
    const b = (await engine.getRoutes())[0]!.routes;
    expect(b[0]).toBe(a[0]); // same objects: not re-read
    await engine.onFilesChanged([`${ROOT}/src/api/article/controllers/article.ts`], []);
    expect((await engine.getRoutes())[0]!.routes[0]).toBe(a[0]); // a controller edit doesn't touch routes
    await engine.onFilesChanged([`${ROOT}/src/api/article/routes/custom.ts`], []);
    expect((await engine.getRoutes())[0]!.routes[0]).not.toBe(a[0]);
  });
});

describe('the global middleware stack', () => {
  const read = (text: string | undefined, extra: Record<string, string> = {}) => {
    const files: Record<string, string> = { ...extra };
    if (text !== undefined) files['c:/gm/config/middlewares.js'] = text;
    return readGlobalMiddlewares(new MemoryFileSystem(files), 'c:/gm');
  };

  it('reads module.exports and config functions returning the literal array', async () => {
    expect((await read("module.exports = ['strapi::errors', { name: 'global::x', config: {} }];")).entries.map((e) => [e.name, e.form, e.hasConfig])).toEqual([
      ['strapi::errors', 'name', false],
      ['global::x', 'name', true],
    ]);
    expect((await read("module.exports = ({ env }) => ['strapi::errors', () => {}];")).entries.map((e) => e.form)).toEqual(['name', 'inline']);
    expect((await read("export default ({ env }) => { return ['strapi::body']; };")).status).toBe('read');
  });

  it('never guesses a stack built at runtime', async () => {
    expect((await read("const base = ['strapi::errors']; module.exports = [...base, 'strapi::body'];")).status).toBe('not-literal');
    expect((await read('module.exports = buildStack();')).status).toBe('not-literal');
    expect((await read(undefined, { 'c:/gm/config/middlewares.json': '[]' })).status).toBe('not-literal');
  });

  it('says when the file is missing (Strapi then uses its default stack) and lists env overlays', async () => {
    const r = await read(undefined, { 'c:/gm/config/env/production/middlewares.js': 'module.exports = [];' });
    expect(r.status).toBe('missing');
    expect(r.envFiles).toEqual(['c:/gm/config/env/production/middlewares.js']);
  });
});

describe('modelOf', () => {
  let project: StrapiProject;
  beforeAll(async () => {
    const engine = createEngine(new MemoryFileSystem(FILES));
    await engine.init([ROOT]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('lists every field with its details, and the table name', () => {
    const article = modelOf(project).contentTypes.find((c) => c.uid === 'api::article.article')!;
    expect(article.collectionName).toBe('articles');
    expect(article.origin).toBe('api');
    const author = article.fields.find((f) => f.name === 'author')!;
    expect(author).toMatchObject({ type: 'relation', relation: 'manyToOne', target: 'api::author.author', inversedBy: 'articles' });
    expect(article.fields.find((f) => f.name === 'title')?.required).toBe(true);
  });

  it('knows who points at a type — by field, self-relations and components included', () => {
    const author = modelOf(project).contentTypes.find((c) => c.uid === 'api::author.author')!;
    expect(author.incoming.map((i) => `${i.fromKind}:${i.fromUid}.${i.field}:${i.relation ?? ''}`).sort()).toEqual([
      'component:shared.quote.by:oneToOne',
      'content-type:api::article.article.author:manyToOne',
      'content-type:api::author.author.mentor:oneToOne',
    ]);
  });

  it('knows which types use a component, and flags none as used when nothing does', () => {
    const { components } = modelOf(project);
    expect(components.find((c) => c.uid === 'shared.seo')!.usedBy.map((u) => u.field).sort()).toEqual(['blocks', 'seo']);
    expect(components.find((c) => c.uid === 'shared.orphan')!.usedBy).toEqual([]);
  });
});
