import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DevkitExports } from '../../extension';

// The DevKit panel on the `panel-app` fixture: routes with a pipeline (and a short
// global policy Strapi won't find), incoming relations, an orphan component, a local plugin.
process.env.DEVKIT_DEV = '1';
process.env.DEVKIT_LICENSE_KEY = 'dev';

const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;

type AnyProvider = vscode.TreeDataProvider<unknown>;

async function until<T>(produce: () => PromiseLike<T>, ok: (v: T) => boolean, tries = 60): Promise<T> {
  let v = await produce();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 250));
    v = await produce();
  }
  return v;
}

function labelOf(p: AnyProvider, n: unknown): string {
  const l = (p.getTreeItem(n) as vscode.TreeItem).label;
  return typeof l === 'string' ? l : (l?.label ?? '');
}

function descOf(p: AnyProvider, n: unknown): string {
  const d = (p.getTreeItem(n) as vscode.TreeItem).description;
  return typeof d === 'string' ? d : '';
}

async function children(p: AnyProvider, n?: unknown): Promise<unknown[]> {
  return ((await p.getChildren(n as never)) as unknown[]) ?? [];
}

async function child(p: AnyProvider, parent: unknown, label: string): Promise<unknown> {
  const kids = await children(p, parent);
  const hit = kids.find((k) => labelOf(p, k) === label);
  assert.ok(hit, `"${label}" under "${parent ? labelOf(p, parent) : '(root)'}" — got ${kids.map((k) => labelOf(p, k)).join(', ')}`);
  return hit;
}

suite('DevKit panel', () => {
  let views: DevkitExports['views'];

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension<DevkitExports>('paul-richez.devkit-for-strapi')!;
    views = (await ext.activate())!.views;
    // Indexing is async on activation: wait for the routes to land.
    await until(
      () => { views.routes.refresh(); return children(views.routes); },
      (nodes) => nodes.length > 0,
    );
  });

  test('routes: a route unfolds into its pipeline, in Strapi order, with the short policy flagged', async () => {
    const r = views.routes as AnyProvider;
    const api = await child(r, undefined, 'API');
    const article = await child(r, api, 'article');
    const publish = await child(r, article, 'POST /api/articles/:id/publish');
    const steps = await children(r, publish);
    assert.deepStrictEqual(steps.map((s) => labelOf(r, s)), ['Global middlewares', 'Auth: Default', 'is-owner', 'global::audit', 'article.publish']);
    assert.match(descOf(r, steps[2]), /policy → global::is-owner/);
    const global = await children(r, steps[0]);
    assert.deepStrictEqual(global.map((s) => labelOf(r, s)), ['strapi::errors', 'strapi::cors', 'global::request-id', 'request-id']);
    // The route's own icon says it has a problem.
    assert.strictEqual(((r.getTreeItem(publish) as vscode.TreeItem).iconPath as vscode.ThemeIcon).id, 'warning');
    // Plugin routes are listed under Plugins.
    const plugins = await child(r, undefined, 'Plugins');
    const shop = await child(r, plugins, 'shop');
    await child(r, shop, 'GET /api/shop/items');
  });

  test('routes: the problems filter keeps only the routes Strapi would choke on', async () => {
    await views.routes.setFilter({ problemsOnly: true });
    try {
      const r = views.routes as AnyProvider;
      const article = await child(r, await child(r, undefined, 'API'), 'article');
      assert.deepStrictEqual((await children(r, article)).map((n) => labelOf(r, n)), ['POST /api/articles/:id/publish']);
    } finally {
      await views.routes.setFilter({});
    }
  });

  test('model: incoming relations by field, field details, the orphan component', async () => {
    const m = views.model as AnyProvider;
    const types = await child(m, undefined, 'Content-types');
    const author = await child(m, types, 'Author');
    const incoming = await child(m, author, 'Pointed at by');
    assert.deepStrictEqual((await children(m, incoming)).map((n) => labelOf(m, n)).sort(), ['Article.author', 'Author.mentor', 'Quote.by']);
    const article = await child(m, types, 'Article');
    const fields = await child(m, article, 'Fields');
    assert.strictEqual(descOf(m, await child(m, fields, 'author')), '→ Author (manyToOne)');
    assert.strictEqual(descOf(m, await child(m, fields, 'title')), 'string · required');
    await child(m, article, 'Routes');
    const shared = await child(m, await child(m, undefined, 'Components'), 'shared');
    assert.match(descOf(m, await child(m, shared, 'Orphan')), /unused/);
  });

  test("health: names Strapi won't find, with the project summary", async () => {
    const h = views.health as AnyProvider;
    const roots = await children(h);
    assert.match(labelOf(h, roots[0]), /^Strapi /);
    const startup = await child(h, undefined, "Names Strapi won't find at startup");
    const names = await children(h, startup);
    assert.deepStrictEqual(names.map((n) => labelOf(h, n)).sort(), ['is-owner', 'request-id']);
    assert.strictEqual(views.health.problemCount(), 2);
  });

  test('plugins: the local plugin and what it adds', async () => {
    const p = views.plugins as AnyProvider;
    const local = await child(p, undefined, 'Local');
    const shop = await child(p, local, 'shop');
    const kids = (await children(p, shop)).map((n) => labelOf(p, n));
    assert.ok(kids.includes('Controllers') && kids.includes('Routes'), kids.join(', '));
  });

  // The Pro refactors, in dry-run (the plan is returned, nothing is opened or applied).
  // The open-source build ships a stub of the Pro engine: these run against the real one only.
  type Plan = { textEdits: Array<{ filePath: string; newText: string }>; fileRenames: unknown[]; fileCreates?: Array<{ path: string }> };
  const dryRun = async (ctx: Mocha.Context, command: string, node: unknown, args: Record<string, unknown>): Promise<Plan> => {
    const res = await vscode.commands.executeCommand<Plan | string>(command, node, { ...args, dryRun: true });
    if (typeof res === 'string' && /not included in the open-source build/.test(res)) ctx.skip();
    assert.ok(res && typeof res === 'object' && Array.isArray(res.textEdits), `${command}: ${String(res)}`);
    return res as Plan;
  };

  test('pro: rename a content-type from the Model view', async function () {
    const m = views.model as AnyProvider;
    const author = await child(m, await child(m, undefined, 'Content-types'), 'Author');
    const edit = await dryRun(this, 'strapiDevkit.refactor.renameType', author, { newName: 'writer' });
    assert.ok(edit.textEdits.some((e) => e.newText.includes('writer')));
    assert.ok(edit.fileRenames.length > 0); // its folder and files
  });

  test('pro: rename a controller action from its route pipeline', async function () {
    const r = views.routes as AnyProvider;
    const publish = await child(r, await child(r, await child(r, undefined, 'API'), 'article'), 'POST /api/articles/:id/publish');
    const handler = (await children(r, publish)).at(-1);
    assert.strictEqual((r.getTreeItem(handler) as vscode.TreeItem).contextValue, 'strapiStep.handler.declared');
    const edit = await dryRun(this, 'strapiDevkit.refactor.renameMethod', handler, { newName: 'release' });
    assert.ok(edit.textEdits.some((e) => e.filePath.endsWith('controllers/article.ts') && e.newText === 'release'));
    assert.ok(edit.textEdits.some((e) => e.filePath.endsWith('routes/custom.ts')), 'the route handler follows');
  });

  test('pro: scaffold a plugin from the Plugins view', async function () {
    const edit = await dryRun(this, 'strapiDevkit.refactor.createPlugin', undefined, { newName: 'blog' });
    assert.ok((edit.fileCreates ?? []).some((f) => f.path.includes('/plugins/blog/')));
  });

  test('routes CodeLens: a controller action shows the routes it handles', async () => {
    const file = vscode.Uri.file(path.join(ws, 'src/api/article/controllers/article.ts'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file));
    const lenses = await until(
      () => vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', file, 50),
      (ls) => (ls ?? []).some((l) => l.command?.title.includes('/api/articles')),
    );
    const titles = (lenses ?? []).map((l) => l.command?.title ?? '');
    assert.ok(titles.some((t) => t.includes('GET /api/articles') && !t.includes(':id')), titles.join(' | '));
    assert.ok(titles.some((t) => t.includes('POST /api/articles/:id/publish')), titles.join(' | '));
  });
});
