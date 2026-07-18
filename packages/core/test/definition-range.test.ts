import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

// A hyphenated UID like `api::analyse.analyse-individuel` must resolve and link
// as ONE unit. Editors split links on word separators (`-`, `.`, `:`), so the
// client needs the full content range — which the engine exposes here.
const ROOT = 'c:/p';
const SCHEMA = `${ROOT}/src/api/analyse/content-types/analyse-individuel/schema.json`;
const X = `${ROOT}/src/x.ts`;
const files: Record<string, string> = {
  [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [SCHEMA]: '{"kind":"collectionType","info":{"singularName":"analyse-individuel"},"attributes":{}}',
  [X]: `strapi.documents('api::analyse.analyse-individuel').findMany({});`,
};

describe('reference range (hyphenated UID)', () => {
  let engine: StrapiEngine;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([ROOT]);
  });

  it('spans the whole UID even with the cursor on the hyphenated segment', () => {
    const code = files[X]!;
    // Cursor sitting on "individuel" — the segment an editor would treat as its own word.
    const range = engine.getReferenceRange(X, code.indexOf('individuel'), code);
    expect(range).toBeDefined();
    expect(code.slice(range!.start, range!.end)).toBe('api::analyse.analyse-individuel');
  });

  it('still resolves the definition from inside the hyphenated segment', async () => {
    const code = files[X]!;
    const defs = await engine.getDefinitions(X, code.indexOf('individuel'), code);
    expect(defs[0]?.filePath).toBe(SCHEMA);
  });

  it('returns undefined off any reference', () => {
    const code = files[X]!;
    expect(engine.getReferenceRange(X, code.indexOf('findMany'), code)).toBeUndefined();
  });
});
