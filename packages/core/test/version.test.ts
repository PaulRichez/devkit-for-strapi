import { describe, expect, it } from 'vitest';
import { detectVersion, parseMajor } from '../src/workspace/version';

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
