import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { getSchema } from '../src/query/refQuery';

const R = 'c:/pp';
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  // A hostile/malformed schema with a prototype-poisoning attribute key.
  [`${R}/src/api/blog/content-types/article/schema.json`]:
    '{"kind":"collectionType","info":{"singularName":"article"},"attributes":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"title":{"type":"string"}}}',
};

describe('schema parsing ignores prototype-poisoning attribute keys (L3)', () => {
  it('skips __proto__/constructor and keeps real attributes, without corrupting the object', async () => {
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    const schema = getSchema(engine.allProjects()[0]!, 'api::blog.article');
    const names = schema!.attributes.map((a) => a.name);
    expect(names).toContain('title');
    expect(names).not.toContain('__proto__');
    expect(names).not.toContain('constructor');
  });
});
