import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, MemoryFileSystem, type StrapiEngine } from 'devkit-for-strapi-core';
import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { registerTools } from '../src/tools';

type Handler = (args?: unknown) => Promise<CallToolResult>;

describe('MCP tools (engine-backed handlers)', () => {
  let engine: StrapiEngine;
  let cmsARoot: string;
  const handlers = new Map<string, Handler>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const call = async (name: string, args?: unknown): Promise<any> => {
    const res = await handlers.get(name)!(args ?? {});
    return JSON.parse((res.content[0] as { text: string }).text);
  };

  beforeAll(async () => {
    const fx = loadFixture('monorepo-two-projects');
    const fs = new MemoryFileSystem(fx.files);
    engine = createEngine(fs);
    await engine.init([fx.root]);
    await engine.whenReferencesReady();
    cmsARoot = engine.allProjects().find((p) => p.root.endsWith('apps/cms-a'))!.root;

    const fakeServer = {
      registerTool: (name: string, _config: unknown, cb: Handler) => handlers.set(name, cb),
    } as unknown as McpServer;
    registerTools(fakeServer, engine, fs, Promise.resolve());
  });

  it('registers all thirty tools (read + graph + move/extract/rename/schema/apply; schema helpers are plan_* + deprecated aliases)', () => {
    expect([...handlers.keys()].sort()).toEqual(
      [
        'add_project',
        'apply_edits',
        'apply_rename',
        'change_relation', // deprecated alias
        'coverage',
        'create_plugin',
        'dependencies',
        'dependents',
        'extract_to_plugin',
        'find_references',
        'find_relation_usages',
        'get_schema',
        'list_artifacts',
        'list_broken_refs',
        'list_components',
        'list_content_types',
        'list_projects',
        'list_refs',
        'list_routes',
        'list_unused',
        'plan_change_relation',
        'plan_move',
        'plan_move_entities',
        'plan_rename_attribute',
        'plan_rename_entity',
        'plan_rename_method',
        'refresh',
        'rename_attribute', // deprecated alias
        'resolve',
        'validate_reference',
      ].sort(),
    );
  });

  it('list_projects tags projects under a fixtures folder (#16 — prefer untagged candidates)', async () => {
    const data = await call('list_projects');
    // The test fixture itself lives under packages/test-fixtures/fixtures/… → tagged.
    expect(data.every((p: { fixture?: boolean }) => p.fixture === true)).toBe(true);
  });

  it('list_projects exposes the declared Strapi version range (#19)', async () => {
    const data = await call('list_projects');
    expect(data.some((p: { declaredVersion?: string }) => typeof p.declaredVersion === 'string')).toBe(true);
  });

  it('list_unused returns the unused list for the selected project', async () => {
    const data = await call('list_unused', { from: cmsARoot, kinds: ['method'] });
    expect(Array.isArray(data.unused)).toBe(true);
  });

  it('list_routes returns the route table of the selected project', async () => {
    const data = await call('list_routes', { from: cmsARoot });
    expect(Array.isArray(data)).toBe(true);
    if (data.length > 0) {
      expect(data[0]).toHaveProperty('method');
      expect(data[0]).toHaveProperty('handler');
    }
  });

  it.skip('plan_rename_method returns a contractual plan (edits + planId + fingerprints), writes nothing', async () => {
    const data = await call('plan_rename_method', {
      ref: 'api::page.notifier',
      method: 'notify',
      newName: 'announce',
      from: cmsARoot,
    });
    expect(data.textEdits.length).toBeGreaterThanOrEqual(2); // declaration + ≥1 call-site
    expect(data.textEdits.every((e: { newText: string }) => e.newText === 'announce')).toBe(true);
    expect(typeof data.planId).toBe('string');
    expect(Array.isArray(data.fingerprints)).toBe(true);
  });

  it('apply_edits refuses an unknown planId (never writes a guessed plan)', async () => {
    const data = await call('apply_edits', { planId: 'nope-not-a-real-id' });
    expect(data.applied).toBe(false);
    expect(data.reason).toMatch(/Unknown planId/);
  });

  it('find_references resolves a #method address (J2.0.4)', async () => {
    const data = await call('find_references', { ref: 'api::page.notifier#notify', from: cmsARoot });
    // The fixture has exactly one call-site: strapi.service('api::page.notifier').notify('hi')
    // in cms-a/src/playground.ts — assert the #method actually resolves to it, not just
    // that the shape is an array (which was vacuously true even for 0 results).
    expect(data.total).toBe(1);
    expect(data.references).toHaveLength(1);
    expect(data.references[0]).toMatch(/playground\.ts/);
  });

  it('list_content_types returns real UIDs for the selected project (F1)', async () => {
    const data = await call('list_content_types', { from: cmsARoot });
    expect(data.map((c: { uid: string }) => c.uid)).toContain('api::page.page');
  });

  it('get_schema returns the real schema (F1)', async () => {
    const data = await call('get_schema', { uid: 'api::page.page', from: cmsARoot });
    expect(data.uid).toBe('api::page.page');
    expect(Array.isArray(data.attributes)).toBe(true);
  });

  it('validate_reference flags a typo with a suggestion (F2)', async () => {
    const data = await call('validate_reference', { ref: 'api::page.pge', from: cmsARoot });
    expect(data.status).toBe('unknown');
    expect(data.didYouMean).toBe('api::page.page');
  });

  it('find_references returns total + compact call-sites by default (F4)', async () => {
    const data = await call('find_references', { ref: 'api::page.page', from: cmsARoot });
    expect(data.total).toBeGreaterThan(0);
    expect(data.references.length).toBeGreaterThan(0);
    // Compact form: `path:line:col [via]  snippet` strings, not objects.
    expect(typeof data.references[0]).toBe('string');
    expect(data.references[0]).toMatch(/:\d+:\d+/);
  });

  it('find_references with compact:false returns full objects with a snippet', async () => {
    const data = await call('find_references', { ref: 'api::page.page', from: cmsARoot, compact: false });
    expect(typeof data.references[0]).toBe('object');
    expect(data.references[0]).toHaveProperty('start');
    expect(data.references[0]).toHaveProperty('snippet');
  });

  it('coverage lists indexed forms and honest gaps (J1.1b)', async () => {
    const data = await call('coverage', {});
    const byVia = new Map(data.forms.map((f: { via: string; indexed: boolean }) => [f.via, f.indexed]));
    expect(byVia.get('query')).toBe(true);
    expect(byVia.get('relation-field')).toBe(true);
  });

  it('find_relation_usages returns relation usages (J4)', async () => {
    const data = await call('find_relation_usages', { uid: 'api::page.page', from: cmsARoot });
    expect(Array.isArray(data.relations)).toBe(true);
  });

  it('add_project returns the known projects (idempotent on an already-indexed path)', async () => {
    const data = await call('add_project', { path: cmsARoot });
    expect(data.found).toBeGreaterThanOrEqual(1);
    expect(data.projects.some((p: { name: string }) => p.name === 'cms-a')).toBe(true);
  });

  it('list_broken_refs returns an array (J5 safety net)', async () => {
    const data = await call('list_broken_refs', { from: cmsARoot });
    expect(Array.isArray(data.broken)).toBe(true);
  });

  it.skip('plan_move refuses unsafe moves all-or-nothing (J5)', async () => {
    // Unknown ref → refused with errors, never a partial plan.
    const data = await call('plan_move', { ref: 'api::page.ghost', toNamespace: 'plugin::dst', from: cmsARoot });
    expect(data.moved).toBe(false);
    expect(Array.isArray(data.errors)).toBe(true);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it.skip('plan_change_relation refuses a non-relation field (J5 schema helper)', async () => {
    const data = await call('plan_change_relation', { uid: 'api::page.page', field: 'title', newTarget: 'api::page.page', from: cmsARoot });
    expect(data.changed).toBe(false);
    expect(Array.isArray(data.errors)).toBe(true);
  });

  it.skip('plan_rename_attribute refuses an unknown attribute (J5 schema helper)', async () => {
    const data = await call('plan_rename_attribute', { uid: 'api::page.page', oldName: 'nope_not_here', newName: 'whatever', from: cmsARoot });
    expect(data.renamed).toBe(false);
  });

  it.skip('keeps deprecated aliases working (change_relation → plan_change_relation)', async () => {
    const data = await call('change_relation', { uid: 'api::page.page', field: 'title', newTarget: 'api::page.page', from: cmsARoot });
    expect(data.changed).toBe(false); // same handler as plan_change_relation
  });

  it.skip('create_plugin returns a contractual scaffold plan with warnings (J5)', async () => {
    const data = await call('create_plugin', { name: 'brand-new-plugin', from: cmsARoot });
    expect(typeof data.planId).toBe('string');
    expect(data.fileCreates.some((c: { path: string }) => c.path.includes('plugins/brand-new-plugin/strapi-server.js'))).toBe(true);
    expect(Array.isArray(data.warnings)).toBe(true);
  });

  it.skip('extract_to_plugin refuses unsafe extraction all-or-nothing (J5)', async () => {
    const data = await call('extract_to_plugin', { refs: ['api::page.ghost'], name: 'brand-new-plugin', from: cmsARoot });
    expect(data.extracted).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it('get_schema batches several UIDs at once (J3)', async () => {
    const data = await call('get_schema', { uids: ['api::page.page', 'api::page.nope'], from: cmsARoot });
    expect(data.schemas).toHaveLength(2);
    expect(data.schemas[0].uid).toBe('api::page.page');
    expect(data.schemas[1].found).toBe(false);
  });

  it('find_references batches several refs at once (J3)', async () => {
    const data = await call('find_references', { refs: ['api::page.page'], from: cmsARoot });
    expect(data.results).toHaveLength(1);
    expect(data.results[0].ref).toBe('api::page.page');
    expect(typeof data.results[0].total).toBe('number');
  });

  it('list_refs returns a plugin/api surface by glob (J3)', async () => {
    const data = await call('list_refs', { pattern: 'api::*', from: cmsARoot });
    expect(data.refs.map((r: { ref: string }) => r.ref)).toContain('api::page.page');
  });

  it('dependents/dependencies expose the graph both ways (J3)', async () => {
    const dep = await call('dependents', { ref: 'api::page.page', from: cmsARoot });
    expect(Array.isArray(dep.dependents)).toBe(true);
    const deps = await call('dependencies', { ref: 'api::page.page', from: cmsARoot });
    expect(Array.isArray(deps.dependencies)).toBe(true);
  });

  it('asks which project when ambiguous instead of guessing', async () => {
    const data = await call('list_content_types', {});
    expect(data.ambiguous).toBe(true);
    expect(data.candidates.length).toBeGreaterThanOrEqual(2);
  });
});

describe('MCP tools with zero discovered projects', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers = new Map<string, (args?: unknown) => Promise<any>>();
  const call = async (name: string, args?: unknown) => {
    const res = await handlers.get(name)!(args ?? {});
    return JSON.parse((res.content[0] as { text: string }).text);
  };

  beforeAll(async () => {
    const fs = new MemoryFileSystem({});
    const engine = createEngine(fs);
    await engine.init(['/nowhere']);
    const fakeServer = {
      registerTool: (name: string, _c: unknown, cb: (a?: unknown) => Promise<unknown>) => handlers.set(name, cb),
    } as unknown as Parameters<typeof registerTools>[0];
    // roots getter reports where discovery looked — surfaced in the result.
    registerTools(fakeServer, engine, fs, Promise.resolve(), () => ['/nowhere']);
  });

  it('reports noProject (not "ambiguous"), names the searched roots, and points to add_project', async () => {
    const data = await call('list_content_types', { project: 'whatever' });
    expect(data.ambiguous).toBeUndefined();
    expect(data.noProject).toBe(true);
    expect(data.searchedRoots).toEqual(['/nowhere']);
    expect(data.message).toMatch(/add_project/);
  });

  it('add_project finds nothing at a bogus path (never guesses)', async () => {
    const data = await call('add_project', { path: '/nowhere/at/all' });
    expect(data.added).toBe(false);
    expect(data.found).toBe(0);
  });
});

describe('MCP Pro gate (licence)', () => {
  const handlers = new Map<string, Handler>();
  const call = async (name: string, args?: unknown) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    JSON.parse(((await handlers.get(name)!(args ?? {})).content[0] as { text: string }).text) as any;
  let cmsA: string;

  beforeAll(async () => {
    const fx = loadFixture('monorepo-two-projects');
    const fs = new MemoryFileSystem(fx.files);
    const engine = createEngine(fs);
    await engine.init([fx.root]);
    await engine.whenReferencesReady();
    cmsA = engine.allProjects().find((p) => p.root.endsWith('apps/cms-a'))!.root;
    const fakeServer = {
      registerTool: (name: string, _c: unknown, cb: Handler) => handlers.set(name, cb),
    } as unknown as McpServer;
    // Unlicensed server: isLicensed → false → Pro tools return the upsell.
    registerTools(fakeServer, engine, fs, Promise.resolve(), () => [fx.root], async () => false);
  });

  it('a plan_* tool returns the upsell, not the plan, when unlicensed', async () => {
    const data = await call('plan_rename_method', { ref: 'api::page.notifier', method: 'notify', newName: 'announce', from: cmsA });
    expect(data.proRequired).toBe(true);
    expect(data.tool).toBe('plan_rename_method');
    expect(data.getPro).toContain('devkit-for-strapi');
    expect(data.textEdits).toBeUndefined(); // the plan was never computed
  });

  it('apply_edits is gated too (no applying a free plan via this tool)', async () => {
    const data = await call('apply_edits', { planId: 'whatever' });
    expect(data.proRequired).toBe(true);
    expect(data.applied).toBeUndefined();
  });

  it('the deprecated change_relation alias is gated as well', async () => {
    const data = await call('change_relation', { uid: 'api::page.page', field: 'x', newTarget: 'api::page.page', from: cmsA });
    expect(data.proRequired).toBe(true);
  });

  it('read/analyse tools still work unlicensed', async () => {
    const data = await call('list_content_types', { from: cmsA });
    expect(data.map((c: { uid: string }) => c.uid)).toContain('api::page.page');
  });
});
