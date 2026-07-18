import { describe, expect, it } from 'vitest';
import { MAX_PARSE_CHARS, parseSource } from '../src/analyze/parse';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { referencesOf } from '../src/query/refQuery';

describe('file-size cap before parse (L2 DoS guard)', () => {
  it('parseSource treats a file over the cap as empty (no AST allocated)', () => {
    const huge = `strapi.service('api::blog.blog');` + 'x'.repeat(MAX_PARSE_CHARS);
    expect(parseSource('big.ts', huge).statements.length).toBe(0);
    // a normal-sized file still parses
    expect(parseSource('ok.ts', "strapi.service('api::blog.blog');").statements.length).toBeGreaterThan(0);
  });

  it('memoizes the AST for the same (path, text) and re-parses on any change (parse-once)', () => {
    const text = "strapi.service('api::blog.blog');";
    const sf = parseSource('f.ts', text);
    expect(parseSource('f.ts', text)).toBe(sf); // same path + same string ref → cached AST
    expect(parseSource('f.ts', `${text} `)).not.toBe(sf); // changed text → fresh parse
    expect(parseSource('other.ts', text)).not.toBe(sf); // different path → fresh parse
  });

  it('the reference index skips a pathologically huge source file', async () => {
    const R = 'c:/cap';
    const huge = `strapi.service('api::blog.blog').go();\n` + '// padding '.repeat(MAX_PARSE_CHARS / 10);
    const files: Record<string, string> = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
      [`${R}/src/api/blog/services/blog.ts`]: 'export default { go() { return 1; } };\n',
      [`${R}/src/normal.ts`]: "strapi.service('api::blog.blog').go();\n",
      [`${R}/src/huge.ts`]: huge,
    };
    const engine: StrapiEngine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    const refs = referencesOf(engine.allProjects()[0]!, 'api::blog.blog');
    expect(refs.some((r) => r.filePath.endsWith('normal.ts'))).toBe(true);
    expect(refs.some((r) => r.filePath.endsWith('huge.ts'))).toBe(false); // skipped
  });
});
