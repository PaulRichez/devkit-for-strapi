import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, MemoryFileSystem } from 'devkit-for-strapi-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerTools } from '../src/tools';

type Handler = (args?: unknown) => Promise<CallToolResult>;

const ROOT = 'c:/lr';
const FILES: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${ROOT}/config/middlewares.ts`]: "export default ['strapi::errors', 'global::request-id'];",
  [`${ROOT}/src/middlewares/request-id.ts`]: 'export default () => async (ctx, next) => next();\n',
  [`${ROOT}/src/policies/is-owner.ts`]: 'export default () => true;\n',
  [`${ROOT}/src/api/article/content-types/article/schema.json`]: JSON.stringify({
    kind: 'collectionType',
    info: { singularName: 'article', pluralName: 'articles' },
    attributes: {},
  }),
  [`${ROOT}/src/api/article/controllers/article.ts`]:
    "export default factories.createCoreController('api::article.article', () => ({ async publish(ctx) {} }));\n",
  [`${ROOT}/src/api/article/routes/article.ts`]: "export default factories.createCoreRouter('api::article.article', { config: { find: { auth: false } } });\n",
  [`${ROOT}/src/api/article/routes/custom.ts`]:
    "export default { routes: [{ method: 'POST', path: '/articles/:id/publish', handler: 'article.publish', config: { policies: ['is-owner'] } }] };\n",
};

describe('list_routes: filters and pipeline', () => {
  const handlers = new Map<string, Handler>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (args: unknown): Promise<any> => JSON.parse(((await handlers.get('list_routes')!(args)).content[0] as { text: string }).text);

  beforeAll(async () => {
    const fs = new MemoryFileSystem(FILES);
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const fakeServer = { registerTool: (name: string, _c: unknown, cb: Handler) => handlers.set(name, cb) } as unknown as McpServer;
    registerTools(fakeServer, engine, fs, Promise.resolve());
  });

  it('filters by method, by a concrete URL, and by handler', async () => {
    expect((await call({ method: 'get' })).routes.map((r: { path: string }) => r.path).sort()).toEqual(['/articles', '/articles/:id']);
    expect((await call({ path: '/api/articles/12' })).routes.map((r: { method: string }) => r.method).sort()).toEqual(['DELETE', 'GET', 'PUT']);
    expect((await call({ handler: 'article.publish' })).routes.map((r: { path: string }) => r.path)).toEqual(['/articles/:id/publish']);
  });

  it("explains a route: Strapi's order, and a policy Strapi won't find under its short name", async () => {
    const data = await call({ method: 'POST', path: '/api/articles/7/publish', pipeline: true });
    // The global stack in order: a middleware Strapi finds is just its name, any other its detail.
    const [errors, requestId] = data.globalMiddlewares.steps;
    expect(errors).toMatchObject({ name: 'strapi::errors', status: 'unverified' });
    expect(errors.phase).toBeUndefined();
    expect(requestId).toBe('global::request-id');
    const steps = data.routes[0].pipeline.map((s: { phase: string; status: string }) => `${s.phase}:${s.status}`);
    expect(steps).toEqual(['auth:ok', 'policy:not-found-by-strapi', 'handler:ok']);
    expect(data.routes[0].pipeline[1].ref).toBe('global::is-owner');
    // A step written in the route's own declaration doesn't repeat where that is.
    expect(data.routes[0].pipeline[0].declaredAt).toBeUndefined();
  });

  it('says when auth is off for a route', async () => {
    const data = await call({ method: 'GET', path: '/api/articles', pipeline: true });
    const find = data.routes.find((r: { path: string }) => r.path === '/articles');
    expect(find.auth).toEqual({ mode: 'public' });
    expect(find.pipeline[0].name).toBe('Public');
  });

  it('refuses an unbounded pipeline', async () => {
    expect((await call({ pipeline: true })).error).toMatch(/needs a filter/);
  });
});
