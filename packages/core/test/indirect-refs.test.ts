import { beforeAll, describe, expect, it } from 'vitest';
import { analyzeAt, collectReferences } from '../src/analyze/callSite';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { requirersOf } from '../src/reference/references';
import { callFormCoverage, listBrokenRefs, listUnused, referencesOf, relationUsagesOf, unresolvedCallsOf } from '../src/query/refQuery';

// References that don't sit in a Strapi call as a literal: the object form of a
// route's middleware/policy, a UID passed through a `const`, a UID written as a
// plain value (a registry map, a config entry).
const R = 'c:/ir';
const relation = (target: string) => `{"type":"relation","relation":"oneToMany","target":"${target}"}`;
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
  [`${R}/config/plugins.js`]: "module.exports = { x: { enabled: true, resolve: './src/plugins/x', config: { adapters: { a: 'plugin::x.a-adapter' } } } };\n",
  [`${R}/src/plugins/x/server/content-types/thread/schema.json`]: `{"kind":"collectionType","info":{"singularName":"thread","pluralName":"threads"},"attributes":{"members":${relation('plugin::x.member')}}}`,
  [`${R}/src/plugins/x/server/content-types/member/schema.json`]: `{"kind":"collectionType","info":{"singularName":"member","pluralName":"members"},"attributes":{"user":${relation('plugin::users-permissions.user')},"role":{"type":"string"}}}`,
  [`${R}/src/plugins/x/server/content-types/review/schema.json`]: `{"kind":"collectionType","info":{"singularName":"review","pluralName":"reviews"},"attributes":{"thread":${relation('plugin::x.thread')}}}`,
  [`${R}/src/plugins/x/server/services/a-adapter.js`]: 'module.exports = ({ strapi }) => ({ go() {} });\n',
  [`${R}/src/api/foo/content-types/foo/schema.json`]: '{"kind":"collectionType","info":{"singularName":"foo","pluralName":"foos"},"attributes":{}}',
  [`${R}/src/api/foo/middlewares/check-access.js`]: 'module.exports = (config, { strapi }) => async (ctx, next) => next();\n',
  [`${R}/src/api/foo/policies/is-owner.js`]: 'module.exports = (ctx) => true;\n',
  [`${R}/src/api/foo/routes/01-foo.js`]: [
    'module.exports = { routes: [',
    "  { method: 'GET', path: '/foo/:id', handler: 'foo.findOne',",
    "    config: { middlewares: [{ name: 'api::foo.check-access', config: { scope: 'read' } }], policies: [{ name: 'api::foo.is-owner', config: {} }] } },",
    '] };',
    '',
  ].join('\n'),
  // v1 #36's repro, as written there.
  [`${R}/src/api/foo/services/foo.js`]: [
    "'use strict';",
    "const THREAD = 'plugin::x.thread';",
    'module.exports = ({ strapi }) => ({',
    '  async list(userId) {',
    '    return strapi.entityService.findMany(THREAD, {',
    "      filters: { members: { role: 'owner', user: { id: userId } } },",
    "      populate: { members: { populate: { user: { fields: ['id'] } } } },",
    '    });',
    '  },',
    "  async raw() { return strapi.db.query(THREAD).findMany({ where: { members: { role: 'owner' } } }); },",
    '});',
    '',
  ].join('\n'),
  // A UID in a registry map, resolved at runtime (v2 #6).
  [`${R}/src/api/foo/services/registry.js`]: "const TARGETS = { foo: 'api::foo.foo-target' };\nmodule.exports = ({ strapi }) => ({ run(type) { return strapi.service(TARGETS[type]).go(); } });\n",
  [`${R}/src/api/foo/services/foo-target.js`]: 'module.exports = ({ strapi }) => ({ go() {} });\n',
  // Nested populate / filters (v1 #37): each level through the relation's target.
  [`${R}/src/api/foo/services/review.js`]: [
    'module.exports = ({ strapi }) => ({',
    '  one(id) {',
    "    return strapi.entityService.findOne('plugin::x.review', id, {",
    "      populate: { thread: { populate: { members: { populate: { user: { fields: ['id'] } } } } } },",
    '    });',
    '  },',
    "  two() { return strapi.entityService.findMany('plugin::x.review', { filters: { $or: [{ thread: { members: { role: 'owner' } } }] } }); },",
    "  three() { return strapi.entityService.findMany('plugin::x.review', { populate: ['thread.members'] }); },",
    "  four() { return strapi.entityService.findMany('plugin::x.review', { populate: { thread: { populate: { title: true } } } }); },",
    '});',
    '',
  ].join('\n'),
  // A service called only through a constant, by a member call.
  [`${R}/src/api/foo/services/caller.js`]: "const SVC = 'api::foo.helper';\nmodule.exports = ({ strapi }) => ({ run() { return strapi.service(SVC).help(); } });\n",
  [`${R}/src/api/foo/services/helper.js`]: 'module.exports = ({ strapi }) => ({ help() {} });\n',
};

describe('references outside a literal Strapi call (feedback v2: 5, 6, 7)', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it("V2-5: a route's middleware and policy in object form `{ name, config }` are references", () => {
    expect(referencesOf(project, 'api::foo.check-access').map((l) => l.via)).toEqual(['route']);
    expect(referencesOf(project, 'api::foo.is-owner').map((l) => l.via)).toEqual(['route']);
    const unused = listUnused(project).map((u) => u.ref);
    expect(unused).not.toContain('api::foo.check-access');
    expect(unused).not.toContain('api::foo.is-owner');
  });

  it('V2-5: an unknown name in object form is diagnosed', async () => {
    const code = "module.exports = { routes: [{ method: 'GET', path: '/', handler: 'foo.find', config: { middlewares: [{ name: 'api::foo.check-acess' }] } }] };";
    const [d] = await engine.validateFile(`${R}/src/api/foo/routes/02.js`, code);
    expect(d?.code).toBe('devkit-for-strapi.unknown-middleware');
    expect(d?.quickFixes?.[0]?.replacement).toBe('api::foo.check-access');
  });

  it('V2-7: a UID passed through a const is referenced at each call (v1 #36: 2 references)', () => {
    const refs = referencesOf(project, 'plugin::x.thread').filter((l) => l.via !== 'schema');
    expect(refs.map((l) => l.via).sort()).toEqual(['db.query', 'entityService']);
    expect(refs.every((l) => l.filePath.endsWith('/services/foo.js'))).toBe(true);
  });

  it('V2-7: the relation fields of that content-type are found through the const (filters, populate, where)', () => {
    const [usage] = relationUsagesOf(project, 'plugin::x.thread', 'members');
    expect(usage?.locations.filter((l) => l.filePath.endsWith('/services/foo.js')).length).toBe(3);
  });

  it('V2-9: nested populate trees, populate paths and nested filters reach the relation (v1 #37)', () => {
    const [usage] = relationUsagesOf(project, 'plugin::x.thread', 'members');
    const lines = usage!.locations.filter((l) => l.filePath.endsWith('/services/review.js')).map((l) => l.start.line);
    expect(lines).toEqual([3, 6, 7]); // the populate tree, the $or filter, the 'thread.members' path
    // Three levels down: the member's user, found through thread → members.
    const [user] = relationUsagesOf(project, 'plugin::x.member', 'user');
    expect(user!.locations.some((l) => l.filePath.endsWith('/services/review.js') && l.start.line === 3)).toBe(true);
  });

  it('V2-9: the range of a path segment is the segment (a field rename rewrites just it)', () => {
    const code = files[`${R}/src/api/foo/services/review.js`]!.split('\n')[7]!;
    const [usage] = relationUsagesOf(project, 'plugin::x.thread', 'members');
    const loc = usage!.locations.find((l) => l.filePath.endsWith('/services/review.js') && l.start.line === 7)!;
    expect(code.slice(loc.start.character, loc.end.character)).toBe('members');
  });

  it('V2-9: a key that is not a relation of its level is never recorded, nor followed', () => {
    expect(relationUsagesOf(project, 'plugin::x.thread').map((u) => u.field)).toEqual(['members']);
  });

  it('V2-7: a service called through a const by a member call is used, and so is its method', () => {
    const unused = listUnused(project).map((u) => u.ref);
    expect(unused).not.toContain('api::foo.helper');
    expect(unused).not.toContain('api::foo.helper.help');
  });

  it('V2-7: the const literal is the reference the editor sees (diagnostics, hover, rename)', async () => {
    const code = "const BAD = 'api::foo.fooo';\nmodule.exports = ({ strapi }) => ({ run() { return strapi.db.query(BAD).findMany(); } });\n";
    const [d] = await engine.validateFile(`${R}/src/api/foo/services/bad.js`, code);
    expect(code.slice(d!.start, d!.end)).toBe('api::foo.fooo');
    expect(d?.quickFixes?.[0]?.replacement).toBe('api::foo.foo');
    const ctx = analyzeAt(`${R}/src/api/foo/services/bad.js`, code, code.indexOf('fooo'));
    expect(ctx).toMatchObject({ kind: 'content-type-uid', apiStyle: 'db.query', constant: true });
  });

  it('V2-7: never guessed — a let, a shadowing parameter, or a value from elsewhere is not followed', () => {
    const f = `${R}/src/api/foo/services/z.js`;
    const code = [
      "let A = 'api::foo.foo';",
      "const B = 'api::foo.foo';",
      'module.exports = ({ strapi }) => ({',
      '  a() { return strapi.db.query(A); },',
      '  b(B) { return strapi.db.query(B); },',
      "  c() { const B = make(); return strapi.db.query(B); },",
      '});',
    ].join('\n');
    expect(collectReferences(f, code)).toEqual([]);
  });

  it('V2-6: a UID written as a plain value (config registry, map) is a weak reference', () => {
    expect(referencesOf(project, 'plugin::x.a-adapter').map((l) => [l.via, l.filePath.endsWith('/config/plugins.js')])).toEqual([['literal', true]]);
    expect(referencesOf(project, 'api::foo.foo-target').map((l) => l.via)).toEqual(['literal']);
    const unused = listUnused(project).map((u) => u.ref);
    expect(unused).not.toContain('plugin::x.a-adapter');
    expect(unused).not.toContain('api::foo.foo-target');
  });

  it('V2-6: a string that is no known UID is not a reference', () => {
    const f = `${R}/src/api/foo/services/w.js`;
    expect(referencesOf(project, 'api::foo.unknown')).toEqual([]);
    expect(collectReferences(f, "const M = { k: 'api::foo.foo' };\nstrapi.log.info(M);")).toEqual([]);
  });
});

describe('database/migrations (feedback v2: 8)', () => {
  const M = 'c:/mig';
  const mig: Record<string, string> = {
    [`${M}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
    [`${M}/src/plugins/p/server/services/backfill.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
    [`${M}/src/api/a/services/copy.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
    // Run by Strapi: the root of database/migrations.
    [`${M}/database/migrations/2026.10.07T09.00.00.backfill.js`]: "module.exports = { async up() { await strapi.plugin('p').service('backfill').run(); } };\n",
    // Never run: a subfolder.
    [`${M}/database/migrations/old/2024.01.01T00.00.00.copy.js`]: "module.exports = { async up() { await strapi.service('api::a.copy').run(); } };\n",
    // Services deleted since: called by an archived migration (never run), and by an active one.
    [`${M}/database/migrations/old/2023.01.01T00.00.00.gone.js`]: "module.exports = { async up() { await strapi.service('api::a.deleted-long-ago').run(); } };\n",
    [`${M}/database/migrations/2026.10.08T00.00.00.gone.js`]: "module.exports = { async up() { await strapi.service('api::a.deleted-recently').run(); } };\n",
    // Loaded by path, never by name (feedback v2 #21): from an archived migration, from live code.
    [`${M}/src/api/a/services/init.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
    [`${M}/src/api/a/services/move.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
    [`${M}/src/api/a/services/lone.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
    [`${M}/database/migrations/old/2024.02.01T00.00.00.init.js`]:
      "const init = require('../../../src/api/a/services/init');\nmodule.exports = { async up() { await init({ strapi }).run(); } };\n",
    [`${M}/src/lib/dir/index.js`]: 'module.exports = {};\n',
    // A local plugin registers its services by requiring them: that is not a use.
    [`${M}/config/plugins.js`]: "module.exports = { q: { enabled: true, resolve: './src/plugins/q' } };\n",
    [`${M}/src/plugins/q/strapi-server.js`]: "module.exports = require('./server');\n",
    [`${M}/src/plugins/q/server/index.js`]: "module.exports = { services: require('./services') };\n",
    [`${M}/src/plugins/q/server/services/index.js`]: "module.exports = { idle: require('./idle'), used: require('./used') };\n",
    [`${M}/src/plugins/q/server/services/idle.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
    [`${M}/src/plugins/q/server/services/used.js`]: "const idle = require('./idle');\nmodule.exports = ({ strapi }) => ({ run() {} });\n",
    [`${M}/src/index.js`]:
      "const move = require('./api/a/services/move');\nconst dir = require('./lib/dir');\nimport other from './api/a/./services/../services/lone.js';\nmodule.exports = { register() {}, bootstrap() {} };\n",
  };
  let project: StrapiProject;
  beforeAll(async () => {
    const engine = createEngine(new MemoryFileSystem(mig));
    await engine.init([M]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('a service called from a migration Strapi runs is used', () => {
    expect(referencesOf(project, 'plugin::p.backfill').length).toBe(1);
    expect(listUnused(project).map((u) => u.ref)).not.toContain('plugin::p.backfill');
    expect(listUnused(project).map((u) => u.ref)).not.toContain('plugin::p.backfill.run');
  });

  it('a deleted service called by an archived migration is not a broken ref; by an active one, it is', () => {
    const broken = listBrokenRefs(project).map((x) => x.ref);
    expect(broken).toContain('api::a.deleted-recently');
    expect(broken).not.toContain('api::a.deleted-long-ago');
  });

  it('a service called only from an archived migration is listed, with that caller said', () => {
    const [ref] = referencesOf(project, 'api::a.copy');
    expect(ref?.archived).toBe(true);
    const unused = listUnused(project).find((u) => u.ref === 'api::a.copy');
    expect(unused?.onlyArchivedCallers).toEqual([`${M}/database/migrations/old/2024.01.01T00.00.00.copy.js`]);
  });

  it('a file loaded by its path counts as a caller: archived, or said apart from live code (feedback v2 #21)', () => {
    const unused = listUnused(project);
    const of = (ref: string) => unused.find((u) => u.ref === ref);
    expect(of('api::a.init')?.onlyArchivedCallers).toEqual([`${M}/database/migrations/old/2024.02.01T00.00.00.init.js`]);
    expect(of('api::a.init')?.requiredByPath).toBeUndefined();
    expect(of('api::a.move')?.requiredByPath).toEqual([`${M}/src/index.js`]);
    expect(of('api::a.lone')?.requiredByPath).toEqual([`${M}/src/index.js`]);
    expect(of('api::a.move.run')?.requiredByPath).toEqual([`${M}/src/index.js`]);
    expect(of('api::a.copy')?.requiredByPath).toBeUndefined();
    // A plugin's registry requires its services to register them; another service requiring one uses it.
    expect(of('plugin::q.used')?.requiredByPath).toBeUndefined();
    expect(of('plugin::q.idle')?.requiredByPath).toEqual([`${M}/src/plugins/q/server/services/used.js`]);
    // A folder required for its index file.
    expect(requirersOf(project, `${M}/src/lib/dir/index.js`).map((l) => l.snippet)).toEqual(["const dir = require('./lib/dir');"]);
    // Not a reference to an entity: no count, no broken ref.
    expect(referencesOf(project, 'api::a.move')).toEqual([]);
    expect(listBrokenRefs(project).map((x) => x.ref)).not.toContain('api::a.move');
  });
});

describe('coverage says what is not indexed, and the calls that fall in it (feedback v2: 10)', () => {
  it('lists the forms indexed now, and the gaps with indexed: false', () => {
    const forms = callFormCoverage();
    expect(forms.filter((f) => !f.indexed).length).toBeGreaterThanOrEqual(3);
    for (const f of forms.filter((x) => !x.indexed)) expect(f.note, f.example).toBeTruthy();
    const examples = forms.filter((f) => f.indexed).map((f) => f.example).join('\n');
    expect(examples).toContain("{ name: 'api::x.z'");
    expect(examples).toContain("const UID = 'api::x.y'");
    expect(examples).toContain('database/migrations');
    expect(examples).toContain("populate: ['author.avatar']");
    expect(forms.some((f) => f.via === 'literal' && f.indexed)).toBe(true);
  });

  it('the calls whose UID DevKit cannot read are listed by the kind they may reach', async () => {
    const engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    const project = engine.allProjects()[0]!;
    const services = unresolvedCallsOf(project, ['service']);
    expect(services.map((l) => l.snippet)).toEqual([expect.stringContaining('strapi.service(TARGETS[type])')]);
    expect(unresolvedCallsOf(project, ['content-type'])).toEqual([]);
  });

  it('a call whose UID starts with a part DevKit reads reaches only the refs that start with it (feedback v2 #19)', async () => {
    const S = 'c:/scoped';
    const engine = createEngine(
      new MemoryFileSystem({
        [`${S}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
        [`${S}/src/api/bar/content-types/bar/schema.json`]: '{"kind":"collectionType","info":{"singularName":"bar","pluralName":"bars"},"attributes":{}}',
        [`${S}/src/api/bar/services/bar.js`]: 'module.exports = ({ strapi }) => ({ go() {} });\n',
        [`${S}/src/api/foo/services/calls.js`]: [
          "const PREFIX = 'api::foo.';",
          'module.exports = ({ strapi }) => ({',
          "  a(name) { return strapi.plugin('y').service(name); },",
          "  b(kind, id) { return strapi.entityService.findOne('api::foo.' + kind, id); },",
          '  c(name) { return strapi.service(`plugin::x.${name}`); },',
          '  d(kind) { return strapi.service((PREFIX + kind) + \'.x\'); },',
          '  e(uid) { return strapi.service(uid); },',
          "  f(n) { return strapi.service(1 + n + 'api::bar.'); },",
          '});',
          '',
        ].join('\n'),
      }),
    );
    await engine.init([S]);
    await engine.whenReferencesReady();
    const project = engine.allProjects()[0]!;
    const calls = (kinds: Parameters<typeof unresolvedCallsOf>[1], refs?: string[]) => unresolvedCallsOf(project, kinds, refs).map((l) => l.snippet);
    const all = calls(['service', 'content-type']);
    expect(all).toHaveLength(6);
    expect(calls(['service', 'content-type'], ['api::bar.bar'])).toEqual([expect.stringContaining('strapi.service(uid)'), expect.stringContaining("1 + n + 'api::bar.'")]);
    expect(calls(['service'], ['plugin::y.mail'])).toEqual(expect.arrayContaining([expect.stringContaining("strapi.plugin('y').service(name)")]));
    expect(calls(['service'], ['plugin::x.mail'])).toEqual(expect.arrayContaining([expect.stringContaining('`plugin::x.${name}`')]));
    expect(calls(['content-type'], ['api::foo.foo'])).toEqual([expect.stringContaining("'api::foo.' + kind")]);
    expect(calls(['service'], ['api::foo.foo'])).toEqual(expect.arrayContaining([expect.stringContaining('(PREFIX + kind)')]));
    expect(calls(['method'], ['api::foo.foo#run'])).toEqual(expect.arrayContaining([expect.stringContaining('(PREFIX + kind)')]));
    expect(project.references.get('unresolved:plugin-service-ref')?.[0]?.scope).toBe('plugin::y.');
  });
});
