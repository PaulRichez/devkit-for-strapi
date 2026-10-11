import * as assert from 'node:assert';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { paths } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import type { DevkitExports } from '../../extension';

// Opt-in (DEVKIT_CONFIG_SYNC_VSCODE_APP, see .vscode-test.mjs): Config Sync through the
// project's Strapi, from VS Code, on a disposable app — its node_modules installed, its
// database in step with config/sync. It writes to that app's database and files. The
// open-source build has no engine: the suite skips.
process.env.DEVKIT_DEV = '1';
process.env.DEVKIT_LICENSE_KEY = 'dev';

const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const root = paths.normalize(ws);
const syncFile = (name: string): string => path.join(ws, 'config/sync', name);

type AnyProvider = vscode.TreeDataProvider<unknown>;
type Json = { permissions: Array<{ action: string }> };

const labelOf = (p: AnyProvider, n: unknown): string => {
  const l = (p.getTreeItem(n) as vscode.TreeItem).label;
  return typeof l === 'string' ? l : (l?.label ?? '');
};
const children = async (p: AnyProvider, n?: unknown): Promise<unknown[]> => ((await p.getChildren(n as never)) as unknown[]) ?? [];
const child = async (p: AnyProvider, parent: unknown, label: string): Promise<unknown> => {
  const kids = await children(p, parent);
  const hit = kids.find((k) => labelOf(p, k) === label);
  assert.ok(hit, `"${label}" — got ${kids.map((k) => labelOf(p, k)).join(', ')}`);
  return hit;
};

suite('Config Sync through Strapi (Pro, a real app)', () => {
  let ext: DevkitExports;

  suiteSetup(async () => {
    ext = (await vscode.extensions.getExtension<DevkitExports>('paul-richez.devkit-for-strapi')!.activate())!;
  });

  /** Compare through the command, as the Database node does; the state it leaves. */
  const compare = async () => {
    await vscode.commands.executeCommand('strapiDevkit.configSync.compare', ws, { noPrompt: true });
    const s = ext.configSyncDb.state(root);
    assert.ok(s && s.kind !== 'running', 'the comparison settled');
    return s;
  };

  test('compare, open the diff, import an edited role, export an entry only in the database', async function () {
    const first = await compare();
    if (first.kind === 'failed' && /not included in the open-source build/.test(first.failure.message)) this.skip();
    assert.strictEqual(first.kind, 'done', JSON.stringify(first));
    // Start in step: whatever this app's last start changed, exported.
    if (ext.configSyncDb.entries(root).length) {
      assert.ok((await ext.configSyncDb.export(root, undefined, true))?.ok);
      assert.deepStrictEqual(ext.configSyncDb.entries(root), []);
    }
    const c = ext.views.configSync as AnyProvider;
    const database = async (): Promise<unknown> => child(c, undefined, 'Database');
    assert.match(String((c.getTreeItem(await database()) as vscode.TreeItem).description), /^0 differences · development · /);
    assert.deepStrictEqual((await children(c, await database())).map((n) => labelOf(c, n)), ['config/sync and the database agree']);

    // A role edited by hand: Different, and the diff editor shows the database on the left.
    const role = syncFile('user-role.public.json');
    const v = JSON.parse(readFileSync(role, 'utf8')) as Json;
    const action = 'api::article.article.find';
    const had = v.permissions.some((p) => p.action === action);
    v.permissions = had ? v.permissions.filter((p) => p.action !== action) : [...v.permissions, { action }].sort((a, b) => a.action.localeCompare(b.action));
    writeFileSync(role, `${JSON.stringify(v, null, 2)}\n`);
    await compare();
    const different = await child(c, await database(), 'Different');
    const entryNode = await child(c, different, 'Role Public');
    const item = c.getTreeItem(entryNode) as vscode.TreeItem;
    assert.match(String(item.description), new RegExp(had ? 'only in the database: permissions' : 'only in the file: permissions'));
    await vscode.commands.executeCommand(item.command!.command, ...(item.command!.arguments ?? []));
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(tab instanceof vscode.TabInputTextDiff, 'a diff editor');
    assert.strictEqual(tab.original.scheme, 'strapidevkit-configsync');
    assert.strictEqual(paths.normalize(tab.modified.fsPath), paths.normalize(role));
    const left = JSON.parse((await vscode.workspace.openTextDocument(tab.original)).getText()) as Json;
    assert.strictEqual(left.permissions.some((p) => p.action === action), had, 'the database side is the database');

    // Import it: the database takes the file, and the diff is empty.
    const entry = ext.configSyncDb.entries(root).find((e) => e.key === 'user-role.public')!;
    const imported = await ext.configSyncDb.import(root, [entry], true);
    assert.ok(imported?.ok, JSON.stringify(imported));
    assert.deepStrictEqual(imported.data.done, ['user-role.public']);
    assert.deepStrictEqual(ext.configSyncDb.entries(root), []);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    // A view file deleted: only in the database; exporting it writes it back.
    const view = syncFile('core-store.plugin_content_manager_configuration_content_types##api##article.article.json');
    const before = readFileSync(view, 'utf8');
    rmSync(view);
    await compare();
    const onlyDb = await child(c, await database(), 'Only in the database');
    assert.deepStrictEqual((await children(c, onlyDb)).map((n) => labelOf(c, n)), ['View — Article']);
    const exported = await ext.configSyncDb.export(root, ext.configSyncDb.entries(root), true);
    assert.ok(exported?.ok, JSON.stringify(exported));
    assert.deepStrictEqual(JSON.parse(readFileSync(view, 'utf8')), JSON.parse(before));
    assert.deepStrictEqual(ext.configSyncDb.entries(root), []);
  });
});
