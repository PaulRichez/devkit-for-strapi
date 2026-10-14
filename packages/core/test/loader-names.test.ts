import lodashKebabCase from 'lodash/kebabCase';
import { describe, expect, it } from 'vitest';
import { isKebabCase, isTestPath, normalizeApiName } from '../src/index/loaderNames';
import { kebabCase } from '../src/util/kebabCase';

/** Strapi's API loader `normalizeName`, written with the real lodash (the reference). */
const strapiNormalize = (name: string): string => (/^([a-z][a-z0-9]*)(-[a-z0-9]+)*$/.test(name) ? name : lodashKebabCase(name));

describe('kebabCase: identical to lodash', () => {
  const table = [
    'hasEditAccess',
    'foo-PDF',
    'foo_manager',
    'fooBar2',
    'foo2bar',
    'FOOBar',
    'XMLHttpRequest',
    'order_items',
    'report-PDF',
    'foo.service',
    'foo bar',
    '__FOO_BAR__',
    'déjà-vu',
    'Ærøskøbing',
    'ĳssel',
    "l'école",
    'step1st',
    'v2Api',
    'a1b2c3',
    'emoji😀name',
    'already-kebab',
    '',
    '---',
    'ÀÉÎõü',
    'snake_case_IDs',
    'HTTPServer2Go',
  ];
  it.each(table)('%j', (name) => {
    expect(kebabCase(name)).toBe(lodashKebabCase(name));
  });

  it('agrees on 5,000 random names (letters, digits, separators, Latin and astral characters)', () => {
    const alphabet = [...'abcXYZ019_-. ', 'é', 'Ö', 'ß', 'ĳ', 'Ł', '’', "'", '́', '😀', 'Σ', 'ж'];
    let seed = 42;
    const rand = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 5000; i++) {
      const len = 1 + rand(12);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[rand(alphabet.length)];
      expect(kebabCase(s), JSON.stringify(s)).toBe(lodashKebabCase(s));
    }
  });
});

describe("normalizeApiName: Strapi's API loader key", () => {
  it.each([
    ['hasEditAccess', 'has-edit-access'],
    ['foo-PDF', 'foo-pdf'],
    ['foo_manager', 'foo-manager'],
    ['fooBar2', 'foo-bar-2'],
    ['already-kebab', 'already-kebab'],
    ['v2', 'v2'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeApiName(raw)).toBe(expected);
    expect(normalizeApiName(raw)).toBe(strapiNormalize(raw));
  });

  it("keeps a kebab-case name as is (lodash would split 'a1' into 'a-1')", () => {
    expect(isKebabCase('step1')).toBe(true);
    expect(normalizeApiName('step1')).toBe('step1');
    expect(lodashKebabCase('step1')).toBe('step-1');
  });
});

describe('isTestPath', () => {
  it.each([
    ['__tests__/foo.test.js', true],
    ['__mocks__/foo.js', true],
    ['a/__tests__/b.js', true],
    ['foo.test.js', true],
    ['foo.spec.ts', true],
    ['foo.js', false],
    ['testing.js', false],
    ['contest.js', false],
  ])('%s → %s', (p, expected) => {
    expect(isTestPath(p)).toBe(expected);
  });
});
