import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, MemoryFileSystem } from 'devkit-for-strapi-core';
import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerTools } from '../src/tools';

type Handler = (args?: unknown) => Promise<CallToolResult>;

describe('get_model_diagram (Pro): the data model as a Mermaid erDiagram', () => {
  const licensed = new Map<string, Handler>();
  const free = new Map<string, Handler>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (h: Map<string, Handler>, args: unknown): Promise<any> => JSON.parse(((await h.get('get_model_diagram')!(args)).content[0] as { text: string }).text);

  beforeAll(async () => {
    const fx = loadFixture('panel-app');
    const fs = new MemoryFileSystem(fx.files);
    const engine = createEngine(fs);
    await engine.init([fx.root]);
    registerTools({ registerTool: (n: string, _c: unknown, cb: Handler) => licensed.set(n, cb) } as unknown as McpServer, engine, fs, Promise.resolve());
    registerTools({ registerTool: (n: string, _c: unknown, cb: Handler) => free.set(n, cb) } as unknown as McpServer, engine, fs, Promise.resolve(), () => [], () => Promise.resolve(false));
  });

  it('returns the erDiagram: entities, one line per association, cardinalities', async () => {
    const d = await call(licensed, {});
    expect(d.format).toBe('mermaid');
    expect(d.mermaid.startsWith('erDiagram')).toBe(true);
    expect(d.mermaid).toContain('api_article_article }o--o| api_author_author : "author / articles"');
    expect(d.entities).toBe(2);
  });

  it('narrows to some types and adds what Strapi gives every content-type', async () => {
    const d = await call(licensed, { focus: ['api::author.author'], strapiFields: true, components: true });
    expect(d.mermaid).toContain('admin_user');
    expect(d.mermaid).toContain('datetime createdAt "added by Strapi"');
  });

  it('is Pro: without a licence, the upsell', async () => {
    expect((await call(free, {})).proRequired).toBe(true);
  });
});
