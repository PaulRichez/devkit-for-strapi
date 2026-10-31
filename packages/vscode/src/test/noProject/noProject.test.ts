import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DevkitExports } from '../../extension';

/** Polls `get` until `ok` (the file watcher and the rescan are debounced). */
async function until<T>(get: () => T | Promise<T>, ok: (v: T) => boolean, tries = 40): Promise<T> {
  let v = await get();
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 250));
    v = await get();
  }
  return v;
}

// A workspace with no Strapi project: DevKit stays out of the way — no status bar item,
// and no MCP server offered to the agents (its tools would ride along with every request).
suite('No Strapi project in the workspace', () => {
  test('no MCP server offered, no status bar item', async () => {
    const ext = vscode.extensions.getExtension<DevkitExports>('paul-richez.devkit-for-strapi')!;
    const presence = (await ext.activate())!.presence;
    await presence.ready;
    assert.strictEqual(await presence.mcpServers(), 0);
    assert.strictEqual(presence.statusShown(), false);
  });

  test('a Strapi project appearing offers the server (the editor is told), and its removal withdraws it', async () => {
    const presence = (await vscode.extensions.getExtension<DevkitExports>('paul-richez.devkit-for-strapi')!.activate())!.presence;
    await presence.ready;
    const dir = path.join(vscode.workspace.workspaceFolders![0]!.uri.fsPath, 'late-app');
    const before = presence.mcpRefreshes();
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'late-app', dependencies: { '@strapi/strapi': '5.0.0' } }));
      const shown = await until(() => presence.mcpRefreshes(), (n) => n > before);
      assert.ok(shown > before, 'the editor was not told to ask for the MCP servers again');
      assert.strictEqual(await presence.mcpServers(), 1);
      assert.strictEqual(presence.statusShown(), true);
    } finally {
      // The whole folder at once, as a user removes an app.
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const after = presence.mcpRefreshes();
    const gone = await until(() => presence.mcpRefreshes(), (n) => n > after);
    assert.ok(gone > after, 'the editor was not told the MCP server went');
    assert.strictEqual(await presence.mcpServers(), 0);
    assert.strictEqual(presence.statusShown(), false);
  });
});
