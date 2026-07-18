import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, type WorkspaceEdit } from 'devkit-for-strapi-core';
import { fingerprintEdit, planEdit, verifyFingerprints } from '../src/edit/plan';

const ROOT = 'c:/p';
const editFor = (): WorkspaceEdit => ({
  textEdits: [{ filePath: `${ROOT}/a.ts`, start: { line: 0, character: 0 }, end: { line: 0, character: 1 }, newText: 'X' }],
  fileRenames: [],
});

describe('contractual plan (edit/plan)', () => {
  it('fingerprints the touched files and produces a stable planId', async () => {
    const fs = new MemoryFileSystem({ [`${ROOT}/a.ts`]: 'hello' });
    const p1 = await planEdit(fs, editFor());
    const p2 = await planEdit(fs, editFor());
    expect(p1.planId).toBe(p2.planId); // deterministic for the same edit + disk
    expect(p1.fingerprints).toHaveLength(1);
    expect(p1.fingerprints[0]!.path).toBe(`${ROOT}/a.ts`);
  });

  it('verifyFingerprints passes when the disk is unchanged', async () => {
    const fs = new MemoryFileSystem({ [`${ROOT}/a.ts`]: 'hello' });
    const planned = await planEdit(fs, editFor());
    expect((await verifyFingerprints(fs, planned.fingerprints)).ok).toBe(true);
  });

  it('verifyFingerprints reports the changed file when the disk moved (anti-TOCTOU)', async () => {
    const fs = new MemoryFileSystem({ [`${ROOT}/a.ts`]: 'hello' });
    const planned = await planEdit(fs, editFor());
    fs.writeFile(`${ROOT}/a.ts`, 'hello world'); // someone edited it after the plan
    const check = await verifyFingerprints(fs, planned.fingerprints);
    expect(check.ok).toBe(false);
    expect(check.changed).toContain(`${ROOT}/a.ts`);
  });

  it('marks a create target absent and detects if it appears (no overwrite)', async () => {
    const fs = new MemoryFileSystem({});
    const edit: WorkspaceEdit = { textEdits: [], fileRenames: [], fileCreates: [{ path: `${ROOT}/new.ts`, content: 'x' }] };
    const fps = await fingerprintEdit(fs, edit);
    expect(fps[0]!.hash).toBe('absent');
    fs.writeFile(`${ROOT}/new.ts`, 'oops already here');
    expect((await verifyFingerprints(fs, fps)).ok).toBe(false);
  });

  it('fingerprints a rename destination by its on-disk state (catches a silent overwrite)', async () => {
    const fs = new MemoryFileSystem({ [`${ROOT}/from.ts`]: 'a', [`${ROOT}/to.ts`]: 'EXISTS' });
    const fps = await fingerprintEdit(fs, { textEdits: [], fileRenames: [{ from: `${ROOT}/from.ts`, to: `${ROOT}/to.ts` }] });
    const toFp = fps.find((f) => f.path === `${ROOT}/to.ts`)!;
    // `to` exists on disk → its hash is NOT 'absent' → verify will flag the collision.
    expect(toFp.hash).not.toBe('absent');
  });
});
