import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { paths } from 'devkit-for-strapi-core';
import type { DevkitExports } from '../../extension';
import { dbUri, unsavedSyncFiles } from '../../views/configSyncDb';

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
  type Plan = { textEdits: Array<{ filePath: string; newText: string }>; fileRenames: Array<{ from: string; to: string }>; fileCreates?: Array<{ path: string }> };
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

  test('pro: a rename updates config/sync, unless strapiDevkit.configSync.followRefactors is off', async function () {
    const m = views.model as AnyProvider;
    const article = await child(m, await child(m, undefined, 'Content-types'), 'Article');
    const syncFiles = (e: Plan): string[] =>
      [...e.textEdits.map((t) => t.filePath), ...e.fileRenames.map((r) => r.from)].filter((f) => f.replace(/\\/g, '/').includes('/config/sync/'));
    const followed = await dryRun(this, 'strapiDevkit.refactor.renameType', article, { newName: 'post' });
    assert.ok(syncFiles(followed).some((f) => f.endsWith('user-role.public.json')), JSON.stringify(syncFiles(followed)));
    const cfg = vscode.workspace.getConfiguration('strapiDevkit.configSync');
    await cfg.update('followRefactors', false, vscode.ConfigurationTarget.Global);
    try {
      const left = await dryRun(this, 'strapiDevkit.refactor.renameType', article, { newName: 'post' });
      assert.deepStrictEqual(syncFiles(left), []);
      assert.ok(left.textEdits.some((e) => e.newText.includes('post')), 'the code is still renamed');
    } finally {
      await cfg.update('followRefactors', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  test('pro: rename a field from the Model view (the schema plan, with config/sync following)', async function () {
    const m = views.model as AnyProvider;
    const article = await child(m, await child(m, undefined, 'Content-types'), 'Article');
    const title = await child(m, await child(m, article, 'Fields'), 'title');
    const edit = await dryRun(this, 'strapiDevkit.refactor.renameField', title, { newName: 'headline' });
    assert.ok(edit.textEdits.some((e) => e.filePath.endsWith('schema.json') && e.newText.includes('headline')), JSON.stringify(edit.textEdits.map((e) => e.filePath)));
    assert.deepStrictEqual(edit.fileRenames, []);
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

  test('Ctrl+T finds Strapi names: UIDs, actions, routes', async () => {
    const find = async (q: string): Promise<string[]> =>
      ((await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', q)) ?? []).map((s) => s.name);
    assert.ok((await find('api::author')).includes('api::author.author'));
    assert.ok((await find('article.publish')).includes('api::article.article.publish'));
    assert.ok((await find('GET /api/articles')).includes('GET /api/articles'));
    assert.ok((await find('shared.orphan')).includes('shared.orphan'));
  });

  test('reveal in panel: a schema opens its type in Model', async () => {
    const schema = vscode.Uri.file(path.join(ws, 'src/api/author/content-types/author/schema.json'));
    await vscode.commands.executeCommand('strapiDevkit.revealInPanel', schema);
    const m = views.model as AnyProvider;
    const author = await child(m, await child(m, undefined, 'Content-types'), 'Author');
    assert.ok(author);
  });

  test('pro: the relations diagram opens as a webview', async function () {
    await vscode.commands.executeCommand('strapiDevkit.model.diagram');
    const tabs = await until(
      () => Promise.resolve(vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label))),
      (labels) => labels.includes('Strapi relations'),
      20,
    );
    if (!tabs.includes('Strapi relations')) this.skip(); // the open-source build: Pro required
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
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

  test('config sync: the plugin, its options, and its files with readable names', async () => {
    const c = views.configSync as AnyProvider;
    const roots = await until(
      () => { views.configSync.refresh(); return children(c); },
      (nodes) => nodes.length > 0,
    );
    // The fixture has no node_modules: the plugin is declared, not installed — and said so.
    assert.deepStrictEqual(roots.map((n) => labelOf(c, n)), [
      'config-sync ^3.2.0',
      'strapi-plugin-config-sync is declared but not installed.',
      'Unreadable files',
      'Database',
      'Files',
    ]);
    assert.strictEqual(descOf(c, roots[0]), 'config/sync');
    assert.deepStrictEqual((await children(c, roots[2])).map((n) => labelOf(c, n)), ['Media library view']);
    assert.strictEqual(descOf(c, roots[4]), '6 · ok 4 · invalid 1 · excluded 1');
    const roles = await child(c, roots[4], 'Roles (Users & Permissions)');
    assert.deepStrictEqual((await children(c, roles)).map((n) => labelOf(c, n)), ['Role Authenticated', 'Role Public']);
    const settings = await child(c, roots[4], 'Settings');
    assert.strictEqual(descOf(c, await child(c, settings, 'Users & Permissions — providers')), 'excluded');
  });

  test('config sync, Pro: comparing with the database runs the real plugin, or says plainly why not', async () => {
    const c = views.configSync as AnyProvider;
    const db = async (): Promise<unknown> => (await children(c)).find((n) => labelOf(c, n) === 'Database');
    assert.strictEqual(descOf(c, await db()), 'not compared yet');
    await vscode.commands.executeCommand('strapiDevkit.configSync.compare', ws, { noPrompt: true });
    if (!vscode.workspace.isTrusted) {
      // Restricted mode: DevKit never runs the project's code.
      assert.strictEqual(descOf(c, await db()), 'not compared yet');
      return;
    }
    const node = await until(
      () => { views.configSync.refresh(); return db(); },
      (n) => !!n && !/…$|not compared yet/.test(descOf(c, n)),
    );
    // The open-source build: the engine isn't there. The real one: no node_modules in this fixture.
    const desc = descOf(c, node);
    assert.ok(desc === 'not available' || desc === 'no-strapi', desc);
    const notes = (await children(c, node)).map((n) => labelOf(c, n)).join(' | ');
    assert.ok(/not included in the open-source build|not installed in this project/.test(notes), notes);
    if (desc === 'no-strapi') assert.ok(/Install the project's dependencies/.test(notes), notes);
  });

  test('config sync: a file config-sync cannot read is an error in the file', async () => {
    const file = vscode.Uri.file(path.join(ws, 'config/sync/core-store.plugin_upload_view_configuration.json'));
    const diags = await until(
      () => Promise.resolve(vscode.languages.getDiagnostics(file)),
      (d) => d.some((x) => x.source === 'DevKit config-sync'),
    );
    const mine = diags.filter((d) => d.source === 'DevKit config-sync');
    assert.deepStrictEqual(mine.map((d) => [String(d.code), d.severity]), [['invalid-json', vscode.DiagnosticSeverity.Error]]);
    const ok = vscode.Uri.file(path.join(ws, 'config/sync/user-role.public.json'));
    assert.deepStrictEqual(vscode.languages.getDiagnostics(ok).filter((d) => d.source === 'DevKit config-sync'), []);
  });

  test('config sync in Model and Routes: the view in config/sync, the roles that allow a route', async () => {
    const m = views.model as AnyProvider;
    views.model.refresh();
    const article = await child(m, await child(m, undefined, 'Content-types'), 'Article');
    assert.strictEqual(descOf(m, await child(m, article, 'Content-manager view')), 'in config/sync');
    const r = views.routes as AnyProvider;
    views.routes.refresh();
    const articleRoutes = await child(r, await child(r, undefined, 'API'), 'article');
    const auth = async (route: string): Promise<unknown> => (await children(r, await child(r, articleRoutes, route))).find((s) => labelOf(r, s).startsWith('Auth:'));
    assert.strictEqual(descOf(r, await auth('POST /api/articles/:id/publish')), 'synced: authenticated');
    assert.strictEqual(descOf(r, await auth('GET /api/articles/:id')), 'synced: public');
    // `auth: false`: the roles don't decide, nothing is said.
    assert.strictEqual(descOf(r, await auth('GET /api/articles')), '');
  });

  test('config sync: a database ↔ config/sync diff is an entry its editor title can export or import; another file is not', async () => {
    const exp = (await vscode.extensions.getExtension<DevkitExports>('paul-richez.devkit-for-strapi')!.activate())!;
    const file = vscode.Uri.file(path.join(ws, 'config', 'sync', 'user-role.authenticated.json'));
    await vscode.commands.executeCommand('vscode.diff', dbUri(ws, 'user-role.authenticated', file.fsPath), file, 'user-role.authenticated: database ↔ config/sync');
    const open = await until(async () => exp.configSyncEditorEntry(), (v) => v !== undefined, 20);
    assert.deepStrictEqual(open, { root: paths.normalize(ws), key: 'user-role.authenticated' });
    await vscode.window.showTextDocument(vscode.Uri.file(path.join(ws, 'package.json')));
    assert.strictEqual(exp.configSyncEditorEntry(), undefined);
    // The same sync file in a plain editor is not the entry: its title has no buttons.
    await vscode.window.showTextDocument(file, { preview: false });
    assert.strictEqual(exp.configSyncEditorEntry(), undefined);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('config sync: unsaved changes to an entry\'s sync file are found (an import saves them first)', async () => {
    const file = vscode.Uri.file(path.join(ws, 'config', 'sync', 'user-role.public.json'));
    const editor = await vscode.window.showTextDocument(file);
    assert.deepStrictEqual(unsavedSyncFiles(ws, ['user-role.public']), []);
    await editor.edit((e) => e.insert(new vscode.Position(0, 0), ' '));
    try {
      assert.deepStrictEqual(unsavedSyncFiles(ws, ['user-role.public']).map((d) => d.uri.fsPath), [file.fsPath]);
      assert.deepStrictEqual(unsavedSyncFiles(ws, ['user-role.authenticated']), []);
    } finally {
      await vscode.commands.executeCommand('workbench.action.files.revert');
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  });
});
