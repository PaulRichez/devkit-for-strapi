import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, MemoryFileSystem } from 'devkit-for-strapi-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerTools } from '../src/tools';

type Handler = (args?: unknown) => Promise<CallToolResult>;

// What the read tools say about the completeness of their answers: a broken
// service's method calls grouped under it, the calls whose UID can't be read,
// the callers that are archived migrations, and the kind-scoped verdict.
const R = 'c:/rc';
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
  [`${R}/src/api/a/services/live.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
  [`${R}/src/api/a/services/old.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
  [`${R}/src/api/a/services/caller.js`]: [
    'module.exports = ({ strapi }) => ({',
    "  go(name) { strapi.service('api::a.gone').run(); return strapi.service(name).run(); },",
    "  live() { return strapi.service('api::a.live').run(); },",
    '});',
    '',
  ].join('\n'),
  [`${R}/database/migrations/old/2024.01.01T00.00.00.x.js`]: "module.exports = { async up() { await strapi.service('api::a.old').run(); } };\n",
};

describe('MCP read tools say how complete their answer is', () => {
  const handlers = new Map<string, Handler>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (name: string, args?: unknown): Promise<any> => {
    const res = await handlers.get(name)!(args ?? {});
    return JSON.parse((res.content[0] as { text: string }).text);
  };

  beforeAll(async () => {
    const fs = new MemoryFileSystem(files);
    const engine = createEngine(fs);
    await engine.init([R]);
    await engine.whenReferencesReady();
    const fakeServer = { registerTool: (name: string, _config: unknown, cb: Handler) => handlers.set(name, cb) } as unknown as McpServer;
    registerTools(fakeServer, engine, fs, Promise.resolve());
  });

  it('list_broken_refs: a broken service with its method calls grouped under it, one entry', async () => {
    const { broken } = await call('list_broken_refs');
    expect(broken).toEqual([
      expect.objectContaining({ ref: 'api::a.gone', kind: 'service', total: 1, methods: [{ name: 'run', locations: [expect.stringContaining('caller.js:2:')] }] }),
    ]);
  });

  it('validate_reference with a kind gives the verdict list_broken_refs uses', async () => {
    expect(await call('validate_reference', { ref: 'api::a.gone', kind: 'service' })).toMatchObject({ status: 'unknown' });
    expect(await call('validate_reference', { ref: 'api::a.live', kind: 'service' })).toMatchObject({ status: 'valid', kinds: ['service'] });
    expect(await call('validate_reference', { ref: 'api::a.live', kind: 'policy' })).toMatchObject({ status: 'unknown' });
  });

  it('find_references: the calls whose UID DevKit cannot read come with the answer', async () => {
    const res = await call('find_references', { ref: 'api::a.live' });
    expect(res.total).toBe(1);
    expect(res.unresolvedCalls).toMatchObject({ total: 1, sample: [expect.stringContaining('strapi.service(name)')] });
  });

  it('list_unused: a service only an archived migration calls is listed, that caller said', async () => {
    const res = await call('list_unused', { kinds: ['service'] });
    const old = res.unused.find((u: { ref: string }) => u.ref === 'api::a.old');
    expect(old.onlyArchivedCallers).toEqual([`${R}/database/migrations/old/2024.01.01T00.00.00.x.js`]);
    expect(res.unresolvedCalls.total).toBe(1);
    const refs = await call('find_references', { ref: 'api::a.old' });
    expect(refs.references[0]).toContain('archived migration');
  });
});
