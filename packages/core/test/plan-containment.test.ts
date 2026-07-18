import { describe, expect, it } from 'vitest';
import { pathsOutsideRoots, touchedPaths } from '../src/edit/plan';
import type { WorkspaceEdit } from '../src/model/types';

const ROOT = 'c:/proj';
const edit = (over: Partial<WorkspaceEdit>): WorkspaceEdit => ({ textEdits: [], fileRenames: [], ...over });

describe('plan containment (security: paths must stay inside the project root)', () => {
  it('touchedPaths covers every write/create/rename/delete path', () => {
    const e = edit({
      textEdits: [{ filePath: `${ROOT}/a.ts`, start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, newText: 'x' }],
      fileCreates: [{ path: `${ROOT}/new.ts`, content: '' }],
      fileRenames: [{ from: `${ROOT}/b.ts`, to: `${ROOT}/c.ts` }],
      fileDeletes: [`${ROOT}/d.ts`],
    });
    expect(touchedPaths(e).sort()).toEqual([`${ROOT}/a.ts`, `${ROOT}/b.ts`, `${ROOT}/c.ts`, `${ROOT}/d.ts`, `${ROOT}/new.ts`].sort());
  });

  it('flags paths outside every root, absolute escapes, and relative paths', () => {
    const escaping = edit({
      fileDeletes: ['/home/user/.ssh/id_rsa'],
      fileRenames: [{ from: `${ROOT}/x.ts`, to: '/etc/passwd' }],
      fileCreates: [{ path: 'relative/evil.ts', content: '' }],
      textEdits: [{ filePath: `${ROOT}/ok.ts`, start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, newText: '' }],
    });
    const outside = pathsOutsideRoots([ROOT], escaping);
    expect(outside).toContain('/home/user/.ssh/id_rsa');
    expect(outside).toContain('/etc/passwd');
    expect(outside).toContain('relative/evil.ts');
    expect(outside).not.toContain(`${ROOT}/ok.ts`); // the only in-root path
  });

  it('returns empty for a fully in-root plan; everything-outside when roots is empty', () => {
    const inRoot = edit({ fileDeletes: [`${ROOT}/sub/x.ts`] });
    expect(pathsOutsideRoots([ROOT], inRoot)).toEqual([]);
    expect(pathsOutsideRoots([], inRoot)).toEqual([`${ROOT}/sub/x.ts`]); // no project ⇒ refuse all
  });
});
