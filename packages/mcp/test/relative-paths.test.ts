import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { withRelativePaths } from '../src/relativePaths';

const answer = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const read = (r: CallToolResult): unknown => JSON.parse((r.content[0] as { text: string }).text);
const A = 'c:/work/app';
const B = 'c:/work/app2';

describe('answers name files relative to their project', () => {
  it("drops the project's root from values, keys and messages, and says `root` once", () => {
    const r = withRelativePaths(
      answer({
        references: [`${A}/src/index.ts:3`],
        byFile: { [`${A}/src/a.ts`]: 2 },
        note: `see ${A}/config/plugins.js`,
      }),
      [A, B],
    );
    expect(read(r)).toEqual({ root: A, references: ['src/index.ts:3'], byFile: { 'src/a.ts': 2 }, note: 'see config/plugins.js' });
  });

  it('a sibling folder whose name starts like the root is not inside it', () => {
    const r = withRelativePaths(answer({ file: `${B}/src/x.ts` }), [A, B]);
    expect(read(r)).toEqual({ root: B, file: 'src/x.ts' });
  });

  it('files of several projects, no file, a `root` meaning something else, or a non-JSON answer: left as is', () => {
    const two = answer({ files: [`${A}/x.ts`, `${B}/y.ts`] });
    expect(withRelativePaths(two, [A, B])).toBe(two);
    const none = answer({ total: 3 });
    expect(withRelativePaths(none, [A])).toBe(none);
    const other = answer({ root: 'c:/elsewhere', file: `${A}/x.ts` });
    expect(withRelativePaths(other, [A])).toBe(other);
    const text: CallToolResult = { content: [{ type: 'text', text: `erDiagram %% ${A}/x` }] };
    expect(withRelativePaths(text, [A])).toBe(text);
  });

  it('a second block of the same answer (unreadRoutes) is made relative too; `root` goes in the first', () => {
    const r = withRelativePaths(
      { content: [{ type: 'text', text: JSON.stringify({ routes: [{ filePath: `${A}/src/r.js` }] }) }, { type: 'text', text: JSON.stringify({ unreadRoutes: [{ file: `${A}/src/plugins/x/strapi-server.js` }] }) }] },
      [A],
    );
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ root: A, routes: [{ filePath: 'src/r.js' }] });
    expect(JSON.parse((r.content[1] as { text: string }).text)).toEqual({ unreadRoutes: [{ file: 'src/plugins/x/strapi-server.js' }] });
  });

  it('a root that is also a URL segment (`/app`, `/api` in a container) never touches a route URL nor a path where it is not the start', () => {
    const r = withRelativePaths(
      answer({
        routes: [
          { method: 'GET', path: '/app/status', fullPath: '/api/app/status', filePath: '/app/src/api/app/routes/app.js' },
          { method: 'GET', path: '/settings', fullPath: '/api/app/settings', filePath: '/app/src/api/app/routes/app.js' },
        ],
        matching: ['GET /app/status'],
        note: 'declared in /app/src/api/app/routes/app.js',
      }),
      ['/app'],
    );
    expect(read(r)).toEqual({
      root: '/app',
      routes: [
        { method: 'GET', path: '/app/status', fullPath: '/api/app/status', filePath: 'src/api/app/routes/app.js' },
        { method: 'GET', path: '/settings', fullPath: '/api/app/settings', filePath: 'src/api/app/routes/app.js' },
      ],
      matching: ['GET /app/status'],
      note: 'declared in src/api/app/routes/app.js',
    });
    const api = withRelativePaths(answer({ routes: [{ method: 'GET', path: '/articles', fullPath: '/api/articles', filePath: '/api/src/api/article/routes/article.js' }] }), ['/api']);
    expect(read(api)).toEqual({ root: '/api', routes: [{ method: 'GET', path: '/articles', fullPath: '/api/articles', filePath: 'src/api/article/routes/article.js' }] });
  });

  it('an answer already giving this project as `root` keeps it once', () => {
    const r = withRelativePaths(answer({ root: A, file: `${A}/x.ts` }), [A]);
    expect(read(r)).toEqual({ root: A, file: 'x.ts' });
  });
});
