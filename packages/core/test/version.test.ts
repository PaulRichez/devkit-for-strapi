import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { projectInfo } from '../src/query/projectInfo';
import { detectVersion, parseMajor, unsupportedVersion } from '../src/workspace/version';

describe('version detection', () => {
  it('parses semver majors', () => {
    expect(parseMajor('^4.25.0')).toBe(4);
    expect(parseMajor('~5.0.0')).toBe(5);
    expect(parseMajor('5.4.1')).toBe(5);
    expect(parseMajor('5')).toBe(5);
    expect(parseMajor('latest')).toBeUndefined();
    expect(parseMajor(undefined)).toBeUndefined();
  });

  it('detects version from package.json', () => {
    expect(detectVersion({ dependencies: { '@strapi/strapi': '^4.25.0' } }).version).toBe(4);
    expect(detectVersion({ dependencies: { '@strapi/strapi': '^5.4.0' } }).version).toBe(5);
    expect(detectVersion({ devDependencies: { '@strapi/strapi': '4.0.0' } }).version).toBe(4);
    // Unknown spec defaults to v5 (the current default).
    expect(detectVersion({}).version).toBe(5);
    expect(detectVersion({ dependencies: { '@strapi/strapi': '^4.0.0' } }).signals.packageMajor).toBe(4);
  });
});

describe('a Strapi newer than DevKit knows (Strapi 6)', () => {
  it('is said — from the installed version, else the declared range — never for 4 or 5', () => {
    expect(unsupportedVersion('6.0.0', 5)).toMatch(/^Strapi 6 isn't supported yet: DevKit reads this project as Strapi 5/);
    expect(unsupportedVersion(undefined, 6)).toMatch(/^Strapi 6 /);
    expect(unsupportedVersion('6.0.0-beta.2', undefined)).toMatch(/^Strapi 6 /);
    expect(unsupportedVersion('5.60.0', 6)).toBeUndefined(); // the installed version wins
    expect(unsupportedVersion(undefined, 4)).toBeUndefined();
    expect(unsupportedVersion(undefined, undefined)).toBeUndefined();
  });

  it('reaches the project summary (list_projects) and project_info, first among its notes', async () => {
    const fs = new MemoryFileSystem({
      '/s6/package.json': JSON.stringify({ dependencies: { '@strapi/strapi': '^6.0.0' } }),
      '/s6/node_modules/@strapi/strapi/package.json': JSON.stringify({ name: '@strapi/strapi', version: '6.0.1' }),
      '/s6/src/api/a/content-types/a/schema.json': JSON.stringify({ kind: 'collectionType', info: { singularName: 'a', pluralName: 'as' }, attributes: {} }),
    });
    const engine = createEngine(fs);
    await engine.init(['/s6']);
    const summary = engine.getProjects()[0]!;
    expect(summary.version).toBe(5);
    expect(summary.unsupportedVersion).toMatch(/^Strapi 6 isn't supported yet/);
    const info = await projectInfo(fs, engine.allProjects()[0]!, summary);
    expect(info.notes[0]).toBe(summary.unsupportedVersion);
    expect(info.strapi.unsupported).toBe(summary.unsupportedVersion); // the Health view reads it here
  });

  it('found where Node finds it (hoisted to a monorepo root), and said with the version DevKit reads', async () => {
    const fs = new MemoryFileSystem({
      '/mono/node_modules/@strapi/strapi/package.json': JSON.stringify({ name: '@strapi/strapi', version: '6.0.1' }),
      '/mono/apps/cms/package.json': JSON.stringify({ dependencies: { '@strapi/strapi': 'workspace:*' } }),
      '/mono/apps/old/package.json': JSON.stringify({ dependencies: { '@strapi/strapi': '^4.25.0 || ^6.0.0' } }),
    });
    const engine = createEngine(fs);
    await engine.init(['/mono']);
    const byRoot = Object.fromEntries(engine.getProjects().map((p) => [p.root, p]));
    expect(byRoot['/mono/apps/cms']!.unsupportedVersion).toMatch(/^Strapi 6 isn't supported yet: DevKit reads this project as Strapi 5,/);
    expect(byRoot['/mono/apps/old']!.version).toBe(4);
    expect(byRoot['/mono/apps/old']!.unsupportedVersion).toMatch(/^Strapi 6 isn't supported yet: DevKit reads this project as Strapi 4,/);
  });
});
