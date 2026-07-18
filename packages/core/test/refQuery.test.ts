import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { callFormCoverage, getSchema, listContentTypes, referencesOf, resolveRef, validateRef } from '../src/query/refQuery';
import { selectProject } from '../src/query/select';

describe('ref-keyed query API (refQuery + select)', () => {
  let engine: StrapiEngine;
  let cmsA: StrapiProject;
  let cmsB: StrapiProject;

  beforeAll(async () => {
    const fx = loadFixture('monorepo-two-projects');
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([fx.root]);
    await engine.whenReferencesReady();
    const projects = engine.allProjects();
    cmsA = projects.find((p) => p.root.endsWith('apps/cms-a'))!;
    cmsB = projects.find((p) => p.root.endsWith('apps/cms-b'))!;
  });

  it('lists the real content-type UIDs (F1)', () => {
    expect(listContentTypes(cmsA).map((c) => c.uid)).toContain('api::page.page');
  });

  it('returns the real schema for a UID (F1)', () => {
    const schema = getSchema(cmsA, 'api::page.page');
    expect(schema?.uid).toBe('api::page.page');
    expect(schema?.kind).toMatch(/collectionType|singleType/);
    expect(Array.isArray(schema?.attributes)).toBe(true);
    expect(getSchema(cmsA, 'api::page.nope')).toBeUndefined();
  });

  it('resolves a UID to its defining file, tagged by kind (F3)', () => {
    const targets = resolveRef(cmsA, 'api::page.page');
    expect(targets.some((t) => t.kind === 'content-type' && t.filePath.endsWith('schema.json'))).toBe(true);
  });

  it('validates a known ref and suggests a fix for a typo (F2)', () => {
    expect(validateRef(cmsA, 'api::page.page').status).toBe('valid');
    const bad = validateRef(cmsA, 'api::page.pge');
    expect(bad.status).toBe('unknown');
    expect(bad.didYouMean).toBe('api::page.page');
  });

  it('skips an unverifiable external plugin (garantir, ne pas deviner)', () => {
    expect(validateRef(cmsA, 'plugin::definitely-not-here.thing').status).toBe('external');
  });

  it('finds references of a UID (F4)', () => {
    expect(referencesOf(cmsA, 'api::page.page').length).toBeGreaterThan(0);
  });

  it('disambiguates the project by `from` path — never a silent guess', () => {
    const projects = engine.allProjects();
    const a = selectProject(projects, { from: `${cmsA.root}/src/api/page/controllers/page.ts` });
    const b = selectProject(projects, { from: `${cmsB.root}/src/index.ts` });
    expect('project' in a && a.project === cmsA).toBe(true);
    expect('project' in b && b.project === cmsB).toBe(true);
    const ambiguous = selectProject(projects, {});
    expect('ambiguous' in ambiguous && ambiguous.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('selects a project by name, and is ambiguous (never a silent guess) for a name that matches nothing', () => {
    const projects = engine.allProjects();
    // Exact basename match → that project.
    const byName = selectProject(projects, { project: 'cms-a' });
    expect('project' in byName && byName.project === cmsA).toBe(true);
    // A name matching nothing → candidates, NOT a silent pick.
    const missMulti = selectProject(projects, { project: 'does-not-exist' });
    expect('ambiguous' in missMulti).toBe(true);
    // The bug: in a SINGLE-project workspace, a wrong/typo'd name must NOT fall
    // through to the lone project — the caller named something unsatisfiable.
    const single = selectProject([cmsA], { project: 'totally-wrong' });
    expect('ambiguous' in single).toBe(true);
    // …but no selector at all in a single-project workspace still just uses it.
    const noSel = selectProject([cmsA], {});
    expect('project' in noSel && noSel.project === cmsA).toBe(true);
  });

  it('also covers the second (v4/JS) project', () => {
    expect(listContentTypes(cmsB).length).toBeGreaterThan(0);
  });

  it('handles #method addresses in resolve/validate (J2.0.4)', () => {
    expect(validateRef(cmsA, 'api::page.notifier#notify').status).toBe('valid');
    expect(resolveRef(cmsA, 'api::page.notifier#notify').some((t) => t.kind === 'service')).toBe(true);
    const bad = validateRef(cmsA, 'api::page.notifier#notiff');
    expect(bad.status).toBe('unknown');
    // find_references on a #method address returns the method's call-sites (an array).
    expect(Array.isArray(referencesOf(cmsA, 'api::page.notifier#notify'))).toBe(true);
  });

  it('reports call-form coverage, including honest gaps (J1.1b)', () => {
    const forms = callFormCoverage();
    const byVia = new Map(forms.map((f) => [f.via, f]));
    // The bare `strapi.query` form is now indexed…
    expect(byVia.get('query')?.indexed).toBe(true);
    expect(byVia.get('contentType')?.indexed).toBe(true);
    // …and relation-field usage (top-level populate/filters) is now indexed too.
    expect(byVia.get('relation-field')?.indexed).toBe(true);
  });
});

describe('ref-keyed query: auto-CRUD on a schema-only content-type (kind- and source-aware)', () => {
  it('treats an api core action as valid, but not a singleType findOne/create nor a plugin CT', async () => {
    const ROOT = 'c:/sc';
    const eng = createEngine(
      new MemoryFileSystem({
        [`${ROOT}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
        [`${ROOT}/src/api/widget/content-types/widget/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"widget"},"attributes":{}}',
        [`${ROOT}/src/api/homepage/content-types/homepage/schema.json`]:
          '{"kind":"singleType","info":{"singularName":"homepage"},"attributes":{}}',
        [`${ROOT}/src/plugins/shop/server/content-types/thing/schema.json`]:
          '{"kind":"collectionType","info":{"singularName":"thing"},"attributes":{}}',
      }),
    );
    await eng.init([ROOT]);
    const p = eng.allProjects()[0]!;
    // api collectionType: any core action valid (route-handler form + #method form).
    expect(validateRef(p, 'api::widget.widget.find').status).toBe('valid');
    expect(resolveRef(p, 'api::widget.widget.find').some((t) => t.kind === 'controller')).toBe(true);
    expect(validateRef(p, 'api::widget.widget#find').status).toBe('valid');
    expect(validateRef(p, 'api::widget.widget.customExport').status).toBe('unknown'); // non-core → unknown
    // api singleType: find/update/delete are served; findOne/create are NOT (no :id) → unknown.
    expect(validateRef(p, 'api::homepage.homepage.update').status).toBe('valid');
    expect(validateRef(p, 'api::homepage.homepage.findOne').status).toBe('unknown');
    expect(validateRef(p, 'api::homepage.homepage.create').status).toBe('unknown');
    // local-plugin CT: Strapi doesn't auto-CRUD it → never asserted valid.
    expect(validateRef(p, 'plugin::shop.thing.find').status).not.toBe('valid');
  });
});
