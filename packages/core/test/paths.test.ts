import { describe, expect, it } from 'vitest';
import { basename, dirname, isPathInside, join, normalize, stripExt } from '../src/fs/paths';

describe('paths', () => {
  it('normalizes backslashes and collapses slashes', () => {
    expect(normalize('c:\\Users\\paul\\proj')).toBe('c:/Users/paul/proj');
    expect(normalize('a//b///c/')).toBe('a/b/c');
  });

  it('joins, dirname, basename, stripExt', () => {
    expect(join('a', 'b', 'c')).toBe('a/b/c');
    expect(join('a/', '/b')).toBe('a/b');
    expect(dirname('a/b/c.ts')).toBe('a/b');
    expect(basename('a/b/c.ts')).toBe('c.ts');
    expect(basename('a/b/c.ts', '.ts')).toBe('c');
    expect(stripExt('product.ts')).toBe('product');
    expect(stripExt('index')).toBe('index');
  });

  it('canonicalizes the Windows drive letter to lowercase (one key per project, #18)', () => {
    expect(normalize('C:/projects/app')).toBe('c:/projects/app');
    expect(normalize('C:\\projects\\app')).toBe('c:/projects/app');
    expect(normalize('c:/projects/app')).toBe('c:/projects/app');
    expect(normalize('D:')).toBe('d:');
    // Non-drive paths are untouched (POSIX, relative, UNC-ish).
    expect(normalize('/usr/Local/App')).toBe('/usr/Local/App');
    expect(normalize('Foo/Bar')).toBe('Foo/Bar');
  });

  it('matches project ownership case-insensitively', () => {
    expect(isPathInside('c:/proj/app', 'c:/proj/app/src/x.ts')).toBe(true);
    expect(isPathInside('c:/proj/app', 'C:/Proj/App/src/x.ts')).toBe(true);
    expect(isPathInside('c:/proj/app', 'c:/proj/app')).toBe(true);
    expect(isPathInside('c:/proj/app', 'c:/proj/app-other/x.ts')).toBe(false);
    expect(isPathInside('c:/proj/app', 'c:/proj/x.ts')).toBe(false);
  });
});
