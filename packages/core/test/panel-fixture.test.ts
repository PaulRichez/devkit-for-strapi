/** The `panel-app` fixture (the VS Code panel's integration workspace) reads as the panel tests expect. */
import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { modelOf } from '../src/query/model';
import { routePipeline } from '../src/query/routePipeline';
import { configSyncStatus } from '../src/configSync/status';

describe('panel-app fixture', () => {
  let engine: StrapiEngine;
  let fs: MemoryFileSystem;
  beforeAll(async () => {
    const fx = loadFixture('panel-app');
    fs = new MemoryFileSystem(fx.files);
    engine = createEngine(fs);
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

  it('has config-sync files: the ones the panel lists, one excluded, one unreadable', async () => {
    const st = (await configSyncStatus(fs, engine.allProjects()[0]!))!;
    expect(st.files.map((f) => `${f.key} ${f.status}`).sort()).toEqual([
      'core-store.plugin_content_manager_configuration_content_types::api::article.article ok',
      'core-store.plugin_upload_settings ok',
      'core-store.plugin_upload_view_configuration invalid',
      'core-store.plugin_users-permissions_grant excluded',
      'user-role.authenticated ok',
      'user-role.public ok',
    ]);
  });
});
