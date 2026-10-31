import * as assert from 'node:assert';
import * as vscode from 'vscode';
import type { DevkitExports } from '../../extension';

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
});
