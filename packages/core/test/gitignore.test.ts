import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { isIgnoredDir, parseGitignore } from '../src/workspace/gitignore';
import { discoverProjectRoots } from '../src/workspace/discovery';

describe('.gitignore, for the folders project discovery skips', () => {
  const rules = parseGitignore(
    ['# build output', '.release/', '/backup', 'apps/*/tmp', '**/old-copy', 'cache-*', '!cache-keep', '', 'docs/**/draft'].join('\n'),
    '/repo',
  );
  const ignored = (dir: string): boolean => isIgnoredDir(rules, dir);

  it('a name matches at any depth; a leading or middle slash anchors it to the .gitignore folder', () => {
    expect(ignored('/repo/.release')).toBe(true);
    expect(ignored('/repo/packages/x/.release')).toBe(true);
    expect(ignored('/repo/backup')).toBe(true);
    expect(ignored('/repo/apps/backup')).toBe(false); // `/backup`: the root's only
    expect(ignored('/repo/apps/web/tmp')).toBe(true);
    expect(ignored('/repo/apps/web/src/tmp')).toBe(false);
  });

  it('`**`, wildcards, and the last match winning (negation)', () => {
    expect(ignored('/repo/old-copy')).toBe(true);
    expect(ignored('/repo/a/b/old-copy')).toBe(true);
    expect(ignored('/repo/docs/x/y/draft')).toBe(true);
    expect(ignored('/repo/cache-1')).toBe(true);
    expect(ignored('/repo/cache-keep')).toBe(false);
    expect(ignored('/repo/apps')).toBe(false);
    expect(ignored('/repo')).toBe(false); // the folder itself, never
  });

  it('as git reads patterns: `**` only between slashes, escapes, classes, case, a BOM, a bad pattern dropped alone', () => {
    const r = parseGitignore(
      ['\uFEFFfirst', 'x/**y', 'es\\d', 'tab\t', '[]q]w', '[[:digit:]]p', '[z-a]', 'Mixed', 'after-bad'].join('\n'),
      '/r',
    );
    const ig = (d: string): boolean => isIgnoredDir(r, d);
    expect(ig('/r/first')).toBe(true); // the BOM isn't part of the first rule
    expect(ig('/r/x/wy')).toBe(true);
    expect(ig('/r/x/z/wy')).toBe(false); // `**` glued to a name is a `*`: it doesn't cross a slash
    expect(ig('/r/esd')).toBe(true);
    expect(ig('/r/es1')).toBe(false); // `\d` is a `d`, not a digit
    expect(ig('/r/tab\t')).toBe(true); // git trims trailing spaces only
    expect(ig('/r/tab')).toBe(false);
    expect(ig('/r/qw')).toBe(true);
    expect(ig('/r/]w')).toBe(true); // a `]` first in a class is a literal
    expect(ig('/r/1p')).toBe(true);
    expect(ig('/r/d]p')).toBe(false);
    expect(ig('/r/mixed')).toBe(true); // case-insensitive, as git on Windows and macOS
    expect(ig('/r/after-bad')).toBe(true); // `[z-a]` is dropped, not the whole file
  });

  it('a nested .gitignore applies below its own folder only', () => {
    const nested = [...rules, ...parseGitignore('generated\n', '/repo/apps/api')];
    expect(isIgnoredDir(nested, '/repo/apps/api/generated')).toBe(true);
    expect(isIgnoredDir(nested, '/repo/apps/web/generated')).toBe(false);
  });
});

describe('project discovery skips what git ignores', () => {
  const app = (name: string): Record<string, string> => ({
    [`${name}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  });

  it('a release build or a backup copy of the app is not a second project — unless that folder is the one passed', async () => {
    const fs = new MemoryFileSystem({
      '/ws/.gitignore': '.release/\nbackup\n',
      ...app('/ws/apps/api'),
      ...app('/ws/.release/apps/api'),
      ...app('/ws/backup/api'),
      ...app('/ws/apps/other'),
    });
    expect((await discoverProjectRoots(fs, ['/ws'])).sort()).toEqual(['/ws/apps/api', '/ws/apps/other']);
    expect(await discoverProjectRoots(fs, ['/ws/backup'])).toEqual(['/ws/backup/api']);
  });

  it('a repository of its own inside the folder is walked, under its own rules only', async () => {
    // An umbrella folder that ignores the clones it holds (each with its own .git).
    const fs = new MemoryFileSystem({
      '/ws/.gitignore': 'backend/\ncopy\n',
      '/ws/backend/.git/HEAD': 'ref: refs/heads/main',
      ...app('/ws/backend/cms'),
      ...app('/ws/backend/copy/cms'), // `copy` is the umbrella's rule: not applied inside the clone
      ...app('/ws/copy/cms'),
    });
    expect((await discoverProjectRoots(fs, ['/ws'])).sort()).toEqual(['/ws/backend/cms', '/ws/backend/copy/cms']);
  });
});
