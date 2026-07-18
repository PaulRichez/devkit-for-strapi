import type { WorkspaceEdit } from 'devkit-for-strapi-core';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyWorkspaceEdit } from '../src/apply';

/** apply is the hard write-side safety boundary: it must never silently corrupt a file. */
describe('applyWorkspaceEdit text-edit safety', () => {
  let dir: string;
  let file: string;
  const pos = (line: number, character: number) => ({ line, character });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'devkit-apply-'));
    file = join(dir, 'x.ts');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses overlapping text edits (throws, leaves the file untouched)', async () => {
    const original = "const x = 'api::blog.article';\n";
    await writeFile(file, original, 'utf8');
    const edit: WorkspaceEdit = {
      textEdits: [
        { filePath: file, start: pos(0, 11), end: pos(0, 28), newText: 'A' },
        { filePath: file, start: pos(0, 15), end: pos(0, 28), newText: 'B' }, // overlaps the first
      ],
      fileRenames: [],
    };
    await expect(applyWorkspaceEdit(edit, [dir.replace(/\\/g, '/')])).rejects.toThrow(/[Oo]verlapping/);
    expect(await readFile(file, 'utf8')).toBe(original); // atomic refusal — nothing written
  });

  it('drops exact-duplicate edits instead of double-applying', async () => {
    await writeFile(file, "const x = 'api::blog.article';\n", 'utf8');
    const e = { filePath: file, start: pos(0, 11), end: pos(0, 28), newText: 'plugin::content.article' };
    await applyWorkspaceEdit({ textEdits: [e, { ...e }], fileRenames: [] }, [dir.replace(/\\/g, '/')]);
    expect(await readFile(file, 'utf8')).toBe("const x = 'plugin::content.article';\n");
  });

  // The real multi-op write path (text → creates → renames → deletes) — the
  // content-type-move/extract apply was previously only exercised by a test-local helper.
  it('applies a multi-op WorkspaceEdit: text edit lands before rename, create does mkdir -p, delete removes', async () => {
    const moved = join(dir, 'moved.ts');
    const dest = join(dir, 'sub', 'dest.ts');
    const doomed = join(dir, 'doomed.ts');
    await writeFile(moved, "const uid = 'api::blog.article';\n", 'utf8');
    await writeFile(doomed, 'bye\n', 'utf8');

    const result = await applyWorkspaceEdit(
      {
        textEdits: [{ filePath: moved, start: pos(0, 13), end: pos(0, 30), newText: 'plugin::content.article' }],
        fileCreates: [{ path: join(dir, 'made', 'new.ts'), content: 'new\n' }],
        fileRenames: [{ from: moved, to: dest }],
        fileDeletes: [doomed],
      },
      [dir.replace(/\\/g, '/')],
    );

    // Text edit applied to `moved` BEFORE the rename → `dest` carries the edited content.
    expect(await readFile(dest, 'utf8')).toContain('plugin::content.article');
    // Create did mkdir -p of the new subdir.
    expect(await readFile(join(dir, 'made', 'new.ts'), 'utf8')).toBe('new\n');
    // Delete removed the file.
    await expect(readFile(doomed, 'utf8')).rejects.toThrow();
    expect(result.filesRenamed).toContainEqual({ from: moved, to: dest });
  });
});
