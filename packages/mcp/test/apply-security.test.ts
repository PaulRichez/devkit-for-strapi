import { createEngine } from 'devkit-for-strapi-core';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyWorkspaceEdit } from '../src/apply';
import { NodeFileSystem } from '../src/nodeFileSystem';

/** Real-disk security tests for the executor — throwaway dirs, never the fixtures. */
describe('applyWorkspaceEdit — root containment & overwrite guards (M-SEC1)', () => {
  let proj: string; // project root
  let outside: string; // a sibling dir OUTSIDE the project
  const px = (p: string): string => p.replace(/\\/g, '/');

  const write = async (root: string, rel: string, content: string): Promise<void> => {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  };

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), 'strapi-sec-'));
    proj = join(base, 'project');
    outside = join(base, 'outside');
    await write(proj, 'package.json', '{"dependencies":{"@strapi/strapi":"^5.0.0"}}');
    await write(proj, 'src/api/blog/services/blog.ts', 'export default {};\n');
    await write(outside, 'secret.txt', 'TOP SECRET');
  });

  afterAll(async () => {
    await rm(dirname(proj), { recursive: true, force: true });
  });

  const roots = (): string[] => [px(proj)];

  it('refuses a forged plan that deletes OUTSIDE the project root — nothing is deleted', async () => {
    const victim = px(join(outside, 'secret.txt'));
    const forged = { textEdits: [], fileRenames: [], fileCreates: [], fileDeletes: [victim], planId: 'x', fingerprints: [] };
    await expect(applyWorkspaceEdit(forged, roots())).rejects.toThrow(/outside the project root/i);
    expect(existsSync(join(outside, 'secret.txt'))).toBe(true); // intact
  });

  it('refuses a forged plan that writes a file outside the root', async () => {
    const forged = {
      textEdits: [],
      fileRenames: [],
      fileCreates: [{ path: px(join(outside, 'evil.ts')), content: 'pwned' }],
      fileDeletes: [],
      planId: 'x',
      fingerprints: [],
    };
    await expect(applyWorkspaceEdit(forged, roots())).rejects.toThrow(/outside the project root/i);
    expect(existsSync(join(outside, 'evil.ts'))).toBe(false);
  });

  it('refuses a rename whose destination already exists (no silent overwrite)', async () => {
    await write(proj, 'src/keep.ts', 'KEEP ME');
    await write(proj, 'src/from.ts', 'moving');
    const edit = { textEdits: [], fileRenames: [{ from: px(join(proj, 'src/from.ts')), to: px(join(proj, 'src/keep.ts')) }] };
    await expect(applyWorkspaceEdit(edit, roots())).rejects.toThrow(/already exists/i);
    expect(await readFile(join(proj, 'src/keep.ts'), 'utf8')).toBe('KEEP ME'); // not clobbered
  });

  it('refuses a text edit whose in-root target is a symlink pointing OUTSIDE (leaf symlink escape)', async () => {
    const link = join(proj, 'src', 'link.ts');
    let symlinkOk = true;
    try {
      await symlink(join(outside, 'secret.txt'), link, 'file');
    } catch {
      symlinkOk = false; // env forbids symlinks → skip
    }
    if (!symlinkOk) return;
    const edit = {
      textEdits: [{ filePath: px(link), start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, newText: 'PWNED' }],
      fileRenames: [],
    };
    await expect(applyWorkspaceEdit(edit, roots())).rejects.toThrow(/outside the project root|symlink/i);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('TOP SECRET'); // not written through the link
  });

  it('rolls back an applied text write when a later op fails (best-effort transaction — M4)', async () => {
    await write(proj, 'src/tx.ts', 'OLD');
    const edit = {
      textEdits: [{ filePath: px(join(proj, 'src/tx.ts')), start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, newText: 'NEW' }],
      // a rename whose source doesn't exist → throws ENOENT AFTER the text write landed
      fileRenames: [{ from: px(join(proj, 'src/does-not-exist.ts')), to: px(join(proj, 'src/dest.ts')) }],
    };
    await expect(applyWorkspaceEdit(edit, roots())).rejects.toThrow(/rolled back|Apply failed/i);
    expect(await readFile(join(proj, 'src/tx.ts'), 'utf8')).toBe('OLD'); // text write was undone
    expect(existsSync(join(proj, 'src/dest.ts'))).toBe(false);
  });

  it('applies a legitimate in-root edit', async () => {
    await write(proj, 'src/edit-me.ts', 'old');
    const edit = {
      textEdits: [{ filePath: px(join(proj, 'src/edit-me.ts')), start: { line: 0, character: 0 }, end: { line: 0, character: 3 }, newText: 'new' }],
      fileRenames: [],
    };
    const res = await applyWorkspaceEdit(edit, roots());
    expect(res.filesChanged.length).toBe(1);
    expect(await readFile(join(proj, 'src/edit-me.ts'), 'utf8')).toBe('new');
  });
});

describe('indexing terminates on a cyclic symlink (no infinite walk — M-SEC1.4)', () => {
  it('init() completes when a directory symlink loop exists under the project', async () => {
    const base = await mkdtemp(join(tmpdir(), 'strapi-symlink-'));
    await writeFile(join(base, 'package.json'), '{"dependencies":{"@strapi/strapi":"^5.0.0"}}', 'utf8');
    await mkdir(join(base, 'src/api/blog/services'), { recursive: true });
    await writeFile(join(base, 'src/api/blog/services/blog.ts'), 'export default {};\n', 'utf8');
    let symlinkOk = true;
    try {
      // a directory that links back to its ancestor → a cycle if followed
      await symlink(join(base, 'src'), join(base, 'src/api/blog/services/loop'), 'dir');
    } catch {
      symlinkOk = false; // some CI/Windows envs forbid symlink creation → skip the assertion
    }
    const engine = createEngine(new NodeFileSystem());
    await engine.init([base.replace(/\\/g, '/')]);
    await engine.whenReferencesReady(); // must resolve, not hang
    expect(engine.allProjects().length).toBe(1);
    if (symlinkOk) expect(true).toBe(true); // reaching here proves the walk terminated
    await rm(base, { recursive: true, force: true });
  }, 30_000);
});
