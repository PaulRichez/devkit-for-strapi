import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, MemoryFileSystem } from 'devkit-for-strapi-core';
import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../src/tools';

// The real diff loads Strapi: replaced by a fixed result, to check what reaches the agent.
const fake = vi.hoisted(() => ({ entries: [] as unknown[] }));
vi.mock('devkit-for-strapi-pro', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  configSyncDiff: async () => ({ ok: true, data: { entries: fake.entries }, target: { env: 'development', client: 'postgres', local: true }, versions: {}, timings: { total: 1 }, warnings: [] }),
}));

type Handler = (args?: unknown) => Promise<CallToolResult>;

const ROOT = 'c:/cs';
const SYNC = `${ROOT}/config/sync`;
const j = (v: unknown): string => JSON.stringify(v, null, 2);
const FILES: Record<string, string> = {
  [`${ROOT}/package.json`]: j({ dependencies: { '@strapi/strapi': '^5.0.0', 'strapi-plugin-config-sync': '^3.2.0' } }),
  [`${ROOT}/node_modules/@strapi/strapi/package.json`]: j({ name: '@strapi/strapi', version: '5.0.0' }),
  [`${ROOT}/node_modules/strapi-plugin-config-sync/package.json`]: j({ name: 'strapi-plugin-config-sync', version: '3.2.0' }),
  [`${SYNC}/admin-role.strapi-editor.json`]: j({ code: 'strapi-editor', permissions: [] }),
};

/** An Editor role of a big project: 300 permissions, 40 fields each — the file has one more field everywhere. */
const role = (fields: number) => ({
  code: 'strapi-editor',
  permissions: Array.from({ length: 300 }, (_, i) => ({
    action: 'plugin::content-manager.explorer.read',
    subject: `api::type${i}.type${i}`,
    properties: { fields: Array.from({ length: fields }, (_, f) => `field_${f}`) },
    conditions: [],
  })),
});
const editor = {
  key: 'admin-role.strapi-editor',
  state: 'different',
  file: role(41),
  db: role(40),
  summary: ['only in the file: permissions[plugin::content-manager.explorer.read · api::type0.type0].properties.fields field_40', '… 299 more'],
  differences: Array.from({ length: 300 }, (_, i) => `only in the file: permissions[plugin::content-manager.explorer.read · api::type${i}.type${i}].properties.fields field_40`),
};
const small = { key: 'user-role.public', state: 'different', file: { permissions: [{ action: 'a.find' }] }, db: { permissions: [] }, summary: ['only in the file: permissions a.find'], differences: ['only in the file: permissions a.find'] };

async function diff(args: Record<string, unknown> = {}): Promise<{ text: string; data: Record<string, unknown> }> {
  const fs = new MemoryFileSystem(FILES);
  const engine = createEngine(fs);
  await engine.init([ROOT]);
  const h = new Map<string, Handler>();
  registerTools({ registerTool: (name: string, _c: unknown, cb: Handler) => h.set(name, cb) } as unknown as McpServer, engine, fs, Promise.resolve());
  const text = ((await h.get('config_sync_diff')!(args)).content[0] as { text: string }).text;
  return { text, data: JSON.parse(text) };
}

describe('config_sync_diff stays within one answer on a big project', () => {
  it('one big entry: the differences that fit, said when some are left out, and the sides left out with the file path', async () => {
    fake.entries = [editor, small];
    const { text, data } = await diff({ key: 'admin-role.strapi-editor' });
    expect(JSON.stringify(editor.file).length + JSON.stringify(editor.db).length).toBeGreaterThan(80_000);
    expect(text.length).toBeLessThan(50_000);
    expect(data).not.toHaveProperty('file');
    expect(data).not.toHaveProperty('db');
    expect(data.path).toBe(`${SYNC}/admin-role.strapi-editor.json`);
    expect(data.sides).toMatch(/^Not included: the two sides are \d+ characters.*the first ones; the file side is .*admin-role\.strapi-editor\.json\.$/);
    const lines = data.differences as string[];
    expect(lines[0]).toContain('api::type0.type0');
    expect(lines.at(-1)).toMatch(/^… \d+ more, not shown: too long for one answer$/);
  });

  it('one small entry: every difference and both sides', async () => {
    fake.entries = [editor, small];
    const { data } = await diff({ key: 'user-role.public' });
    expect(data).toMatchObject({ key: 'user-role.public', differences: ['only in the file: permissions a.find'], file: small.file, db: small.db });
    expect(data).not.toHaveProperty('sides');
  });

  it('a first diff with hundreds of entries: the first ones, how many of each type, and how to narrow', async () => {
    fake.entries = Array.from({ length: 600 }, (_, i) => ({
      key: `${i % 3 ? 'core-store' : 'plugin_content_manager_configuration'}.entry_${i}_${'x'.repeat(40)}`,
      state: 'only-in-sync-dir',
      file: {},
      db: null,
      summary: ['only in config/sync'],
      differences: ['only in config/sync'],
    }));
    const { text, data } = await diff();
    expect(text.length).toBeLessThan(50_000);
    expect(data.differences).toBe(600);
    expect(data.byType).toEqual({ plugin_content_manager_configuration: 200, 'core-store': 400 });
    expect((data.entries as unknown[]).length).toBeLessThan(600);
    expect(data.shortened).toMatch(/^\d+ of 600 listed.*`type`.*`key`/);
    const one = await diff({ type: 'plugin_content_manager_configuration' });
    expect(one.data.differences).toBe(200);
  });

  it('a few entries: all of them, nothing shortened', async () => {
    fake.entries = [editor, small];
    const { data } = await diff();
    expect(data.differences).toBe(2);
    expect(data).not.toHaveProperty('shortened');
    expect((data.entries as { summary: string[] }[])[0]!.summary).toEqual(editor.summary);
  });
});
