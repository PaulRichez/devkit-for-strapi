/** The `panel-app` fixture (the VS Code panel's integration workspace) reads as the panel tests expect. */
import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { modelOf } from '../src/query/model';
import { routePipeline } from '../src/query/routePipeline';

describe('panel-app fixture', () => {
  let engine: StrapiEngine;
  beforeAll(async () => {
    const fx = loadFixture('panel-app');
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([fx.root]);
    await engine.whenReferencesReady();
  });

  it('has the project API and the local plugin routes', async () => {
    const routes = (await engine.getRoutes())[0]!.routes;
    expect(routes.filter((r) => r.origin === 'project').length).toBe(11); // 5 + 5 core + 1 custom
    expect(routes.filter((r) => r.origin === 'local-plugin').map((r) => `${r.method} ${r.path} ${r.handler}`)).toEqual(['GET /items plugin::shop.item.list']);
  });

  it("flags the short global policy, and resolves the plugin route's handler", async () => {
    const project = engine.allProjects()[0]!;
    const routes = (await engine.getRoutes())[0]!.routes;
    const global = await engine.getGlobalMiddlewares(project.root);
    const publish = routes.find((r) => r.path === '/articles/:id/publish')!;
    expect(routePipeline(project, publish, global).steps.filter((s) => s.phase !== 'global-middleware').map((s) => `${s.phase}:${s.status}`)).toEqual([
      'auth:ok',
      'policy:not-found-by-strapi',
      'route-middleware:ok',
      'handler:ok',
    ]);
    const items = routes.find((r) => r.path === '/items')!;
    expect(routePipeline(project, items, global).steps.at(-1)!.status).toBe('ok');
  });

  it('models incoming relations and the orphan component', () => {
    const m = modelOf(engine.allProjects()[0]!);
    expect(m.contentTypes.find((c) => c.uid === 'api::author.author')!.incoming.length).toBe(3);
    expect(m.components.find((c) => c.uid === 'shared.orphan')!.usedBy).toEqual([]);
  });
});
