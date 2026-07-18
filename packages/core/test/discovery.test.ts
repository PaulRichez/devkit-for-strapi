import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { discoverProjectRoots, isStrapiPackageJson } from '../src/workspace/discovery';

describe('discovery', () => {
  it('recognizes a Strapi package.json', () => {
    expect(isStrapiPackageJson('{"dependencies":{"@strapi/strapi":"^5.0.0"}}')).toBe(true);
    expect(isStrapiPackageJson('{"devDependencies":{"@strapi/strapi":"5"}}')).toBe(true);
    expect(isStrapiPackageJson('{"dependencies":{"react":"^18"}}')).toBe(false);
    expect(isStrapiPackageJson('not json')).toBe(false);
  });

  it('finds both projects in a monorepo and prunes node_modules', async () => {
    const { root, files } = loadFixture('monorepo-two-projects');
    const fs = new MemoryFileSystem(files);
    const roots = await discoverProjectRoots(fs, [root]);
    expect([...roots].sort()).toEqual([`${root}/apps/cms-a`, `${root}/apps/cms-b`]);
  });

  it('finds a project nested below a non-Strapi workspace root', async () => {
    const { root, files } = loadFixture('nested-not-at-root');
    const fs = new MemoryFileSystem(files);
    const roots = await discoverProjectRoots(fs, [root]);
    expect(roots).toEqual([`${root}/backend`]);
  });
});
