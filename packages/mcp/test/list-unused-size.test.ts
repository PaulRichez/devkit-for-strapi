import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, MemoryFileSystem } from 'devkit-for-strapi-core';
import { describe, expect, it } from 'vitest';
import { registerTools } from '../src/tools';

type Handler = (args?: unknown) => Promise<CallToolResult>;

const ROOT = 'c:/lu';
const N = 60;

/** One service of N methods nothing calls, imported by path by N controllers. */
function files(): Record<string, string> {
  const out: Record<string, string> = {
    [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
    [`${ROOT}/src/api/big/content-types/big/schema.json`]: '{"kind":"collectionType","info":{"singularName":"big","pluralName":"bigs"},"attributes":{}}',
    [`${ROOT}/src/api/big/services/big.ts`]: `export default ({ strapi }) => ({ ${Array.from({ length: N }, (_, i) => `m${i}() {}`).join(', ')} });\n`,
  };
  for (let i = 0; i < N; i++) out[`${ROOT}/src/api/big/controllers/c${i}.ts`] = "import big from '../services/big';\nexport default { big };\n";
  return out;
}

describe('list_unused stays within one answer', () => {
  it('names a few files per item, with their total', async () => {
    const fs = new MemoryFileSystem(files());
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const h = new Map<string, Handler>();
    registerTools({ registerTool: (name: string, _c: unknown, cb: Handler) => h.set(name, cb) } as unknown as McpServer, engine, fs, Promise.resolve());
    const text = ((await h.get('list_unused')!({ kinds: ['method'] })).content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(50_000);
    const data = JSON.parse(text) as { unused: Array<{ ref: string; requiredByPath?: string[]; requiredByPathTotal?: number }> };
    const m0 = data.unused.find((u) => u.ref === 'api::big.big.m0');
    expect(m0?.requiredByPath).toHaveLength(3);
    expect(m0?.requiredByPathTotal).toBe(N);
  });
});
