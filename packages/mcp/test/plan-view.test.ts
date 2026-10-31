import type { FileSystem, TextEditOp } from 'devkit-for-strapi-core';
import { describe, expect, it } from 'vitest';
import { planView } from '../src/planView';
import { relativeTo } from '../src/relativePaths';

const ROOT = 'C:/work/app';
const files: Record<string, string> = {
  [`${ROOT}/src/api/restaurant/content-types/restaurant/schema.json`]: '{\n  "kind": "collectionType",\n  "target": "api::restaurant.restaurant"\n}\n',
  [`${ROOT}/src/index.ts`]: "strapi.service('api::restaurant.restaurant').find();\nconst a = 1;\nconst b = 2;\n",
};
const fs = { readFile: async (p: string) => files[p] ?? Promise.reject(new Error('ENOENT')) } as unknown as FileSystem;
const edit = (filePath: string, sl: number, sc: number, el: number, ec: number, newText: string): TextEditOp => ({
  filePath,
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
  newText,
});
const schema = `${ROOT}/src/api/restaurant/content-types/restaurant/schema.json`;
const index = `${ROOT}/src/index.ts`;

describe('plan view (what a plan_* tool answers)', () => {
  it('shows each edit with the text it replaces, paths relative to the project root, no fingerprints', async () => {
    const view = await planView(
      fs,
      ROOT,
      {
        planId: 'p1',
        textEdits: [
          edit(index, 0, 16, 0, 42, 'api::restaurant.eatery'),
          edit(schema, 2, 13, 2, 39, 'api::restaurant.eatery'),
          edit(index, 0, 16, 0, 42, 'api::restaurant.eatery'), // an exact duplicate: applied once, shown once
        ],
        fileRenames: [{ from: `${ROOT}/src/api/restaurant`, to: `${ROOT}/src/api/eatery` }],
      },
      ['a warning'],
      40_000,
    );
    expect(view).toEqual({
      planId: 'p1',
      root: ROOT,
      summary: '2 edits in 2 files, 1 rename',
      edits: {
        'src/index.ts': ['1: "api::restaurant.restaurant" → "api::restaurant.eatery"'],
        'src/api/restaurant/content-types/restaurant/schema.json': ['3: "api::restaurant.restaurant" → "api::restaurant.eatery"'],
      },
      renames: ['src/api/restaurant → src/api/eatery'],
      warnings: ['a warning'],
    });
  });

  it('a multi-line range shows its lines and its text escaped; a long text is clipped and says its length', async () => {
    const long = 'x'.repeat(500);
    const view = await planView(fs, ROOT, { planId: 'p2', textEdits: [edit(index, 1, 0, 2, 12, long)], fileRenames: [] }, undefined, 40_000);
    const [line] = view.edits['src/index.ts']!;
    expect(line).toMatch(/^2-3: "const a = 1;\\nconst b = 2;" → "x{240}…" \(500 chars\)$/);
  });

  it('a file it cannot read says so instead of guessing the old text', async () => {
    const view = await planView(fs, ROOT, { planId: 'p3', textEdits: [edit(`${ROOT}/src/gone.ts`, 0, 0, 0, 3, 'new')], fileRenames: [] }, undefined, 40_000);
    expect(view.edits['src/gone.ts']).toEqual(['1: (file unreadable) → "new"']);
  });

  it('new files with their content, and deletes, relative too', async () => {
    const view = await planView(
      fs,
      ROOT,
      { planId: 'p4', textEdits: [], fileRenames: [], fileCreates: [{ path: `${ROOT}/src/plugins/x/package.json`, content: '{}' }], fileDeletes: [`${ROOT}/old.js`] },
      undefined,
      40_000,
    );
    expect(view.creates).toEqual({ 'src/plugins/x/package.json': '{}' });
    expect(view.deletes).toEqual(['old.js']);
    expect(view.summary).toBe('0 edits in 0 files, 1 delete, 1 new file');
  });

  it('too long for one answer: the last files become counts and the answer says the planId still applies them', async () => {
    const many = Array.from({ length: 30 }, (_, i) => edit(`${ROOT}/src/f${i}.ts`, 0, 0, 0, 0, 'y'.repeat(200)));
    const view = await planView(fs, ROOT, { planId: 'p5', textEdits: many, fileRenames: [] }, undefined, 4_000);
    expect(JSON.stringify(view, null, 2).length).toBeLessThanOrEqual(4_000);
    expect(view.edits['src/f0.ts']![0]).toMatch(/^1: \(file unreadable\) → "y{200}"$/);
    expect(view.edits['src/f29.ts']).toEqual(['1 edit, not shown']);
    expect(view.summary).toBe('30 edits in 30 files');
    expect(view.shortened).toMatch(/left out: the edits of \d+ files \(counted only\)\. apply_edits applies the whole plan/);
  });

  it('a whole sync file rewritten in one edit shows the lines it changes, and a change of line endings', async () => {
    const sync = `${ROOT}/config/sync/user-role.public.json`;
    files[sync] = '{\r\n  "action": "api::restaurant.restaurant.find",\r\n  "role": "public"\r\n}';
    const view = await planView(
      fs,
      ROOT,
      { planId: 'p6', textEdits: [edit(sync, 0, 0, 3, 1, '{\n  "action": "api::restaurant.eatery.find",\n  "role": "public"\n}')], fileRenames: [] },
      undefined,
      40_000,
    );
    expect(view.edits['config/sync/user-role.public.json']).toEqual([
      '2: "  \\"action\\": \\"api::restaurant.restaurant.find\\"," → "  \\"action\\": \\"api::restaurant.eatery.find\\","',
      '1-4: line endings CRLF → LF',
    ]);
    expect(view.summary).toBe('1 edit in 1 file'); // one edit, however many lines it changes
  });

  it('lines added: the block between the lines both sides keep', async () => {
    const cfg = `${ROOT}/config/plugins.js`;
    files[cfg] = 'module.exports = {\n  a: {},\n};\n';
    const view = await planView(fs, ROOT, { planId: 'p7', textEdits: [edit(cfg, 0, 0, 2, 2, 'module.exports = {\n  a: {},\n  b: { enabled: true },\n};')], fileRenames: [] }, undefined, 40_000);
    expect(view.edits['config/plugins.js']).toEqual(['3: "" → "  b: { enabled: true },"']);
  });

  it('a plan far too long — 800 files, or 600 renames alone — still fits, and says exactly what it leaves out', async () => {
    const wide = Array.from({ length: 800 }, (_, i) => edit(`${ROOT}/src/api/a${i}/services/s${i}.ts`, 0, 0, 0, 0, 'z'.repeat(100)));
    const v1 = await planView(fs, ROOT, { planId: 'p8', textEdits: wide, fileRenames: [] }, undefined, 40_000);
    expect(JSON.stringify(v1, null, 2).length).toBeLessThanOrEqual(40_000);
    expect(v1.summary).toBe('800 edits in 800 files');
    expect(v1.shortened).toMatch(/the edits of \d+ files \(counted only\); \d+ files not even named/);
    const renames = Array.from({ length: 600 }, (_, i) => ({ from: `${ROOT}/src/api/long-folder-name-${i}/services/x.ts`, to: `${ROOT}/src/api/long-folder-name-${i}/services/y.ts` }));
    const v2 = await planView(fs, ROOT, { planId: 'p9', textEdits: [], fileRenames: renames }, undefined, 40_000);
    expect(JSON.stringify(v2, null, 2).length).toBeLessThanOrEqual(40_000);
    expect(v2.renames!.at(-1)).toMatch(/^… \d+ more$/);
    expect(v2.shortened).toMatch(/left out: \d+ renames\./);
    expect(v2.shortened).not.toMatch(/files/);
  });

  it('a path outside the root stays absolute', () => {
    expect(relativeTo(ROOT, 'C:/other/x.ts')).toBe('c:/other/x.ts'); // normalized, as DevKit writes paths
    expect(relativeTo(ROOT, 'C:/work/app2/x.ts')).toBe('c:/work/app2/x.ts');
    expect(relativeTo(ROOT, `${ROOT}/a/b.ts`)).toBe('a/b.ts');
  });
});
