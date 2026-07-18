import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixturePath } from 'devkit-for-strapi-test-fixtures';
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end: build the bundled CLI, spawn it as a real stdio MCP server, and
 * drive it with the SDK client — the wiring the unit tests can't reach.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..', 'dist', 'cli.cjs');

describe('MCP server over stdio (real round-trip)', () => {
  let client: Client;

  beforeAll(async () => {
    await build({
      entryPoints: [resolve(here, '..', 'src', 'cli.ts')],
      bundle: true,
      outfile: cli,
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      logLevel: 'silent',
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, fixturePath('monorepo-two-projects')],
    });
    client = new Client({ name: 'smoke', version: '0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists the thirty tools (read + graph + move/extract/rename/schema/apply + 2 deprecated aliases)', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(30);
  });

  it('answers get_schema with the real schema', async () => {
    const res = await client.callTool({
      name: 'get_schema',
      arguments: { uid: 'api::page.page', from: `${fixturePath('monorepo-two-projects')}/apps/cms-a` },
    });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text).uid).toBe('api::page.page');
  });
});

describe('MCP server discovers projects from the client\'s MCP roots (agnostic, no argv)', () => {
  let client: Client;

  beforeAll(async () => {
    // No path argument: the server must learn the workspace from the client's
    // `roots` capability — the mechanism that makes it work anywhere with no config.
    const transport = new StdioClientTransport({ command: process.execPath, args: [cli] });
    client = new Client({ name: 'smoke-roots', version: '0' }, { capabilities: { roots: {} } });
    client.setRequestHandler(ListRootsRequestSchema, () => ({
      roots: [{ uri: pathToFileURL(fixturePath('monorepo-two-projects')).href, name: 'workspace' }],
    }));
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it('lists the projects found under the client root', async () => {
    const res = await client.callTool({ name: 'list_projects', arguments: {} });
    const text = (res.content as { type: string; text: string }[])[0]!.text;
    const projects = JSON.parse(text) as { name: string }[];
    expect(projects.map((p) => p.name)).toEqual(expect.arrayContaining(['cms-a', 'cms-b']));
  });
});
