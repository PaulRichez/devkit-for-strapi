import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  callFormCoverage,
  dependencies,
  dependents,
  type FileSystem,
  getSchema,
  listArtifacts,
  listBrokenRefs,
  listComponents,
  listContentTypes,
  listRefs,
  listRoutes,
  listUnused,
  paths,
  type ReferenceLocation,
  referencesOf,
  relationUsagesOf,
  resolveRef,
  selectProject,
  type StrapiEngine,
  type StrapiProject,
  validateRef,
} from 'devkit-for-strapi-core';
import {
  planChangeRelation,
  planCreatePlugin,
  planEdit,
  planMove,
  planRename,
  planRenameAttribute,
  proRequired,
  proToolNames,
  verifyFingerprints,
  type MoveSpec,
  type PlannedEdit,
  type SchemaEditPlan,
} from 'devkit-for-strapi-pro';
import { z } from 'zod';
import { applyWorkspaceEdit, type ApplyResult } from './apply';
import { saveRootsCache } from './rootsCache';

/** Render any value as the MCP text result agents read. */
const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/** Human-readable text for a thrown value (for structured apply-failure reasons). */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** One reference as a compact, token-cheap line: `path:line:col [via]  snippet` (1-based). */
const compactRef = (r: ReferenceLocation): string =>
  `${r.filePath}:${r.start.line + 1}:${r.start.character + 1}${r.via ? ` [${r.via}]` : ''}${r.snippet ? `  ${r.snippet}` : ''}`;

/** A bare name has no `::`/`.` — renames change the last segment only, never the namespace. */
const RENAME_HINT =
  '`newName` must be a bare name (the entity\'s last segment), not a UID; renaming never changes the api/plugin namespace. To move an entity to another namespace, a move is required (see roadmap).';

/**
 * Heuristic tag for projects living under a fixtures/test-fixtures folder —
 * usually another package's test data, not the project the user works on. Only
 * a *tag* (never an exclusion): an agent should prefer untagged candidates, but
 * a legitimately-named `fixtures` folder still works by explicit selection.
 */
const isFixturePath = (root: string): boolean => /(^|\/)(test-)?fixtures(\/|$)/i.test(root);

/** Tag a project/candidate object with `fixture: true` when its root looks like test data. */
const tagFixture = <T extends { root: string }>(p: T): T & { fixture?: true } =>
  isFixturePath(p.root) ? { ...p, fixture: true } : p;

/** `from`/`project` selector shared by every project-scoped tool. */
const selector = {
  from: z
    .string()
    .optional()
    .describe('A path inside the target project (e.g. the file you are editing). Disambiguates a multi-project workspace.'),
  project: z
    .string()
    .optional()
    .describe('A project name (its folder) or root path. Use when you have no file path in hand.'),
};

/** Resolve the project for a call, or a "specify which project" result (never a silent guess). */
function pick(
  engine: StrapiEngine,
  sel: { from?: string; project?: string },
  roots: readonly string[],
): { project: StrapiProject } | { result: CallToolResult } {
  const s = selectProject(engine.allProjects(), sel);
  if ('project' in s) return { project: s.project };
  // Zero discovered projects is *not* ambiguity — saying "multiple … candidates: []"
  // (the old behaviour) is a lie. Tell the truth and surface where we looked, since
  // `from`/`project` only *select* among discovered projects, they never add one.
  if (s.candidates.length === 0) {
    return {
      result: json({
        noProject: true,
        message:
          'No Strapi project found under the indexed root(s). Call `add_project` with an ABSOLUTE path to your Strapi project (or to any file inside it — the server walks up to the project root), then retry this tool. `from`/`project` only choose among already-discovered projects; they do not add new roots.',
        searchedRoots: [...roots],
      }),
    };
  }
  return {
    result: json({
      ambiguous: true,
      message:
        'Multiple Strapi projects in this workspace. Re-call with `from` (a path inside the project) or `project` (a name below). Candidates tagged `fixture: true` are another package\'s test data — prefer the untagged ones.',
      candidates: s.candidates.map(tagFixture),
    }),
  };
}

/** Register the F1→F4 read tools + the rename tools on the MCP server. */
/** Strict shape of a contractual plan — closes the `z.any()` hole on apply_edits. */
const positionSchema = z.object({ line: z.number().int().nonnegative(), character: z.number().int().nonnegative() });
const planObjectSchema = z.object({
  textEdits: z.array(z.object({ filePath: z.string(), start: positionSchema, end: positionSchema, newText: z.string() })),
  fileRenames: z.array(z.object({ from: z.string(), to: z.string() })),
  fileCreates: z.array(z.object({ path: z.string(), content: z.string() })).optional(),
  fileDeletes: z.array(z.string()).optional(),
  planId: z.string(),
  fingerprints: z.array(z.object({ path: z.string(), hash: z.string() })),
});

export function registerTools(
  server: McpServer,
  engine: StrapiEngine,
  fs: FileSystem,
  ready: Promise<void>,
  roots: () => readonly string[] = () => [],
  // Default unlocked: the test harness / unwired callers see the Pro tools work;
  // the real server (server.ts) passes a license-gated check (createLicenseCheck).
  isLicensed: () => Promise<boolean> = () => Promise.resolve(true),
): void {
  // Plans computed by plan_* this session, keyed by planId, so apply_edits can
  // apply exactly the reviewed plan (no recompute → no TOCTOU window).
  const plans = new Map<string, PlannedEdit>();
  const PLAN_CAP = 50;
  /** Store a plan, capping the Map oldest-first so a long planning session can't grow it unbounded. */
  const rememberPlan = (p: PlannedEdit): void => {
    plans.set(p.planId, p);
    if (plans.size > PLAN_CAP) {
      const oldest = plans.keys().next().value;
      if (oldest !== undefined) plans.delete(oldest);
    }
  };

  // The MCP SDK does not serialize tool handlers; two concurrent applies could
  // interleave verify→write and lose an update despite the fingerprint check.
  // One async lock makes the mutating tools (apply_edits/apply_rename) exclusive.
  let applyChain: Promise<unknown> = Promise.resolve();
  const withApplyLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = applyChain.then(fn, fn);
    applyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  /** The discovered project roots — the containment boundary for any disk write. */
  const projectRoots = (): string[] => engine.allProjects().map((p) => p.root);

  /** Changed/deleted paths an apply result implies — for an incremental re-index. */
  const applyDelta = (r: ApplyResult): { changed: string[]; deleted: string[] } => ({
    changed: [...r.filesChanged, ...r.filesCreated, ...r.filesRenamed.map((x) => x.to)],
    deleted: [...r.filesRenamed.map((x) => x.from), ...r.filesDeleted],
  });

  /**
   * After a write: report any dangling refs (the loop's safety net, target 0).
   * Scoped to the project(s) the apply touched — not the whole workspace.
   */
  const verifyAfterApply = async (changed: string[] = []): Promise<{ brokenRefs: number; broken: Array<{ ref: string; kind: string; count: number }> }> => {
    await engine.whenReferencesReady();
    const touched = [...new Set(changed.map((f) => engine.projectForFile(f)).filter((p): p is StrapiProject => p !== undefined))];
    const projects = touched.length ? touched : engine.allProjects();
    const broken = projects.flatMap((pr) => listBrokenRefs(pr).map((b) => ({ ref: b.ref, kind: b.kind, count: b.locations.length })));
    return { brokenRefs: broken.length, broken };
  };

  /** A schema-edit plan → a contractual plan result, or refusal. */
  const schemaResult = async (plan: SchemaEditPlan, verb: string): Promise<CallToolResult> => {
    if (!plan.ok) return json({ [verb]: false, errors: plan.errors, warnings: plan.warnings });
    const planned = await planEdit(fs, { textEdits: plan.textEdits, fileRenames: [] });
    rememberPlan(planned);
    return json({ ...planned, warnings: plan.warnings });
  };

  /** Plan a move (single or grouped) → a contractual plan result, or refusal. */
  const moveResult = async (project: StrapiProject, specs: MoveSpec[]): Promise<CallToolResult> => {
    const move = await planMove(fs, project, specs);
    if (!move.ok) return json({ moved: false, errors: move.errors, warnings: move.warnings });
    const planned = await planEdit(fs, { textEdits: move.textEdits, fileRenames: move.fileRenames });
    rememberPlan(planned);
    return json({ ...planned, warnings: move.warnings });
  };

  // Auto-gate the Pro (write/refactor) tools: without a licence they return the
  // upsell instead of running, so an agent learns the capability exists and how
  // to unlock it. Read/analyse tools are never gated; plan_* is gated as well as
  // apply_* so an agent can't apply a free plan with its own edit tools.
  const GATED = new Set<string>(proToolNames());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gate = (cb: (...a: any[]) => unknown, name: string) =>
    async (...a: unknown[]): Promise<unknown> => ((await isLicensed()) ? cb(...a) : json(proRequired(name)));
  const reg: typeof server.registerTool = (name, config, cb) =>
    server['registerTool'](name, config, (GATED.has(name) ? gate(cb as never, name) : cb) as typeof cb);

  reg(
    'list_projects',
    {
      title: 'List Strapi projects',
      description:
        'List the Strapi projects discovered in the workspace (name, root, version, counts). Call this first in a multi-project workspace.',
    },
    async () => {
      await ready;
      return json(engine.getProjects().map((p) => tagFixture({ name: paths.basename(p.root), ...p })));
    },
  );

  reg(
    'add_project',
    {
      title: 'Register a Strapi project by path',
      description:
        'Locate and index a Strapi project on demand from an ABSOLUTE path — either the project root, or any file/folder inside it (the server walks up to the project root; a folder is also scanned downward for monorepos). Use this when a tool returns `noProject`. Idempotent. Returns the projects now known (use a name/root with `from`/`project`).',
      inputSchema: {
        path: z.string().describe('Absolute path to the Strapi project root, or to any file/folder inside it.'),
      },
    },
    async (args) => {
      await ready;
      const before = engine.getProjects().length;
      const projects = await engine.addRoot(args.path);
      // Persist so the project survives server respawns (no re-add after a rebuild).
      if (projects.length) saveRootsCache(projects.map((p) => p.root));
      const named = projects.map((p) => tagFixture({ name: paths.basename(p.root), ...p }));
      return json({
        added: projects.length > before,
        found: projects.length,
        projects: named,
        ...(projects.length === 0
          ? { message: `No Strapi project found at or above \`${args.path}\`. Pass an absolute path inside a project whose package.json declares @strapi/strapi.` }
          : {}),
      });
    },
  );

  reg(
    'refresh',
    {
      title: 'Re-index projects from disk (pick up external changes)',
      description:
        'Re-scan every discovered Strapi project from disk and rebuild the index. The server does not watch the filesystem: files created, edited, or deleted OUTSIDE this MCP session (a manual edit, another tool, git checkout/pull, a branch switch) are invisible to every other tool until this runs — call it before find_references/list_broken_refs/list_unused/coverage whenever files may have changed outside apply_edits/apply_rename, or those tools reason over a stale snapshot and can wrongly report 0 references. Cheap to call defensively.',
    },
    async () => {
      await ready;
      await engine.rescan();
      await engine.whenReferencesReady();
      return json({ refreshed: true, projects: engine.getProjects().map((p) => tagFixture({ name: paths.basename(p.root), ...p })) });
    },
  );

  reg(
    'list_content_types',
    {
      title: 'List content-types',
      description:
        'List the real content-type UIDs (e.g. api::article.article) of a Strapi project. Use these exact UIDs — do not invent them.',
      inputSchema: { ...selector },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json(listContentTypes(p.project));
    },
  );

  reg(
    'list_components',
    {
      title: 'List components',
      description: 'List the real component UIDs (e.g. shared.seo) of a Strapi project.',
      inputSchema: { ...selector },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json(listComponents(p.project));
    },
  );

  reg(
    'list_artifacts',
    {
      title: 'List services/controllers/policies/middlewares',
      description:
        'List the real refs of a project\'s services, controllers, policies and middlewares (optionally one kind). Use the exact refs returned.',
      inputSchema: {
        kind: z.enum(['service', 'controller', 'policy', 'middleware']).optional(),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json(listArtifacts(p.project, args.kind));
    },
  );

  reg(
    'get_schema',
    {
      title: 'Get a content-type / component schema',
      description:
        'Return the real attributes (fields, relations, components) of a content-type or component UID. Use this instead of guessing field names. Pass `uids` to fetch several at once.',
      inputSchema: {
        uid: z.string().optional().describe('A content-type or component UID.'),
        uids: z.array(z.string()).optional().describe('Several UIDs to fetch in one call.'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const project = p.project;
      const one = (uid: string) => getSchema(project, uid) ?? { found: false, uid };
      if (args.uids) return json({ schemas: args.uids.map(one) });
      if (args.uid) return json(one(args.uid));
      return json({ error: 'Provide `uid` or `uids`.' });
    },
  );

  reg(
    'resolve',
    {
      title: 'Resolve a reference to its file(s)',
      description:
        'Resolve a Strapi reference (UID / service / controller / policy / middleware / route handler) to its defining file(s), tagged by kind.',
      inputSchema: { ref: z.string(), ...selector },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json({ ref: args.ref, targets: resolveRef(p.project, args.ref) });
    },
  );

  reg(
    'validate_reference',
    {
      title: 'Validate a Strapi reference',
      description:
        'Check whether a Strapi reference is real in the project. Returns valid | unknown (+ didYouMean) | external (a plugin not in the workspace — cannot be verified). Call this before writing a magic string.',
      inputSchema: { ref: z.string(), ...selector },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json({ ref: args.ref, ...validateRef(p.project, args.ref) });
    },
  );

  reg(
    'find_references',
    {
      title: 'Find references to a Strapi entity',
      description:
        'List every call-site that references a UID / service / controller / handler (or `ref#method`) across the project. Returns the total first, then a page of references. Compact by default (`path:line:col [via]  snippet`, 1-based) — pass `compact: false` for full objects. Pass `refs` to query several at once.',
      inputSchema: {
        ref: z.string().optional(),
        refs: z.array(z.string()).optional().describe('Several refs to query in one call (batch).'),
        compact: z.boolean().optional().describe('Compact one-line-per-hit output (default true). false → full objects.'),
        limit: z.number().int().positive().optional().describe('Max references returned per ref (default 50).'),
        offset: z.number().int().nonnegative().optional().describe('Skip this many references (pagination).'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const one = (ref: string) => {
        const all = referencesOf(p.project, ref);
        const page = all.slice(offset, offset + limit);
        return {
          ref,
          total: all.length,
          offset,
          limit,
          truncated: offset + page.length < all.length,
          references: args.compact === false ? page : page.map(compactRef),
        };
      };
      if (args.refs) return json({ results: args.refs.map(one) });
      if (args.ref) return json(one(args.ref));
      return json({ error: 'Provide `ref` or `refs`.' });
    },
  );

  reg(
    'list_routes',
    {
      title: 'List HTTP routes',
      description:
        'List a project\'s HTTP route table (method, path, handler, policies, middlewares) — explicit routes plus the auto-CRUD routes synthesized from createCoreRouter. Statically parsed (no Strapi boot); framework/plugin-injected routes are not included.',
      inputSchema: { ...selector },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json(await listRoutes(fs, p.project));
    },
  );

  reg(
    'list_unused',
    {
      title: 'Find unused Strapi entities/methods',
      description:
        "List definitions with 0 Strapi references — service/controller methods never called via strapi.service()/route handlers, plus unused content-types, components, services, policies and middlewares. Static: counts Strapi refs only, so a method called **directly in TS** still appears — verify before deleting. Use `file` for one file (else the whole app), `kinds` to narrow.",
      inputSchema: {
        file: z.string().optional().describe('Restrict to one file; omit for the whole app.'),
        kinds: z
          .array(z.enum(['method', 'content-type', 'component', 'service', 'policy', 'middleware']))
          .optional()
          .describe('Restrict to certain kinds (default: all).'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json({ unused: listUnused(p.project, { kinds: args.kinds, file: args.file }) });
    },
  );

  reg(
    'coverage',
    {
      title: 'List indexed call forms',
      description:
        'List the Strapi call forms the engine indexes (with a `via` tag + example) and the notable ones it does NOT index yet (`indexed: false`). Use this to know whether find_references/list_unused can be trusted for a given pattern, instead of assuming completeness.',
    },
    async () => {
      await ready;
      return json({ forms: callFormCoverage() });
    },
  );

  reg(
    'list_broken_refs',
    {
      title: 'Find references that point at nothing',
      description:
        'List magic strings that resolve to no real entity — the inverse of list_unused, and the safety net after a move/rename (target: 0). Skips unverifiable external-plugin refs. Use after apply_edits to confirm nothing was left dangling.',
      inputSchema: { ...selector },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const broken = listBrokenRefs(p.project).map((b) => ({
        ref: b.ref,
        kind: b.kind,
        total: b.locations.length,
        locations: b.locations.map(compactRef),
      }));
      return json({ broken });
    },
  );

  reg(
    'find_relation_usages',
    {
      title: 'Find relation-field usages',
      description:
        "Find where a content-type's relation fields are used by name in queries (populate/filters). Pass `field` for one relation, omit it for all. Indispensable before retargeting or removing a relation. Only real relation fields are matched (top-level populate/filters; nested populate trees not yet — see coverage).",
      inputSchema: {
        uid: z.string().describe('A content-type UID, e.g. api::article.article'),
        field: z.string().optional().describe('A relation field name; omit for all relations.'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const usages = relationUsagesOf(p.project, args.uid, args.field).map((u) => ({
        field: u.field,
        total: u.locations.length,
        usages: u.locations.map(compactRef),
      }));
      return json({ uid: args.uid, relations: usages });
    },
  );

  reg(
    'list_refs',
    {
      title: 'List refs by glob',
      description:
        "List entity refs matching a glob — e.g. `plugin::billing.*` for a plugin's whole surface, `api::*` for all APIs, `*` for everything. Only `*` is special. Each result carries the kinds it resolves to.",
      inputSchema: { pattern: z.string().max(200).describe('Glob, e.g. plugin::billing.* or api::*'), ...selector },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json({ pattern: args.pattern, refs: listRefs(p.project, args.pattern) });
    },
  );

  reg(
    'dependencies',
    {
      title: 'What a ref uses (outgoing edges)',
      description:
        'List the refs that `ref` depends on — relations in its schema, services/controllers it calls, etc. Pass `transitive: true` to follow the chain. Half of the cut-analysis for modularization.',
      inputSchema: {
        ref: z.string(),
        transitive: z.boolean().optional().describe('Follow dependencies recursively (default false).'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      return 'result' in p
        ? p.result
        : json({ ref: args.ref, dependencies: dependencies(p.project, args.ref, { transitive: args.transitive }) });
    },
  );

  reg(
    'dependents',
    {
      title: 'What uses a ref (incoming edges)',
      description:
        'List the refs that depend on `ref` — what would break if it moved or changed. Pass `transitive: true` to follow the chain. The other half of cut-analysis: which edges become cross-namespace if you extract a set.',
      inputSchema: {
        ref: z.string(),
        transitive: z.boolean().optional().describe('Follow dependents recursively (default false).'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      return 'result' in p
        ? p.result
        : json({ ref: args.ref, dependents: dependents(p.project, args.ref, { transitive: args.transitive }) });
    },
  );

  reg(
    'plan_rename_method',
    {
      title: 'Plan a service/controller method rename (dry-run)',
      description:
        'Compute the exact edits to rename a service/controller METHOD — its declaration, every `strapi.service(...).method()` call-site, and (for controllers) the action segment of route handlers. Dry-run: returns a plan (text edits + `planId`), writes nothing. Review, then apply with `apply_edits` (pass the `planId`).',
      inputSchema: {
        ref: z.string().describe('The owning service/controller ref, e.g. api::page.notifier'),
        method: z.string().describe('The current method name, e.g. notify'),
        newName: z.string(),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const edit = await planRename(fs, p.project, args.ref, args.newName, args.method);
      if (!edit)
        return json({
          renamed: false,
          reason: `\`${args.method}\` is not an indexed method of \`${args.ref}\`, or \`${args.newName}\` is invalid/unchanged. ${RENAME_HINT}`,
        });
      const planned = await planEdit(fs, edit);
      rememberPlan(planned);
      return json(planned);
    },
  );

  reg(
    'plan_rename_entity',
    {
      title: 'Plan an entity rename (dry-run)',
      description:
        'Compute the exact edits to rename a content-type / service / controller / policy / middleware / component: every magic-string call-site and route handler, plus the file/folder renames. Dry-run: returns a plan (edits + `planId`), writes nothing. Review, then apply with `apply_edits` (pass the `planId`).',
      inputSchema: {
        ref: z.string().describe('The entity UID/ref, e.g. api::product.product or shared.seo'),
        newName: z.string(),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const edit = await planRename(fs, p.project, args.ref, args.newName);
      if (!edit)
        return json({
          renamed: false,
          reason: `\`${args.ref}\` is not an indexed entity in this project, or \`${args.newName}\` is invalid/unchanged. ${RENAME_HINT}`,
        });
      const planned = await planEdit(fs, edit);
      rememberPlan(planned);
      return json(planned);
    },
  );

  reg(
    'plan_move',
    {
      title: 'Plan moving an artifact or content-type to another namespace (dry-run)',
      description:
        'Compute the edits to move to another namespace (e.g. plugin::dst): a service/controller/policy/middleware, OR a content-type (its whole resource — content-type + service + controller + routes move together, relation `target`s repointed). Rewrites every call-site (full-UID forms, `strapi.plugin(...)` chains, route handlers) and relocates the files. Dry-run: returns a plan (+ `planId`, + `warnings`, incl. plugin content-type registration to verify), writes nothing. Apply with `apply_edits`. Refused all-or-nothing if unsafe.',
      inputSchema: {
        ref: z.string().describe('An artifact ref (plugin::src.helper) or a content-type UID (api::x.x)'),
        toNamespace: z.string().describe('Destination namespace: plugin::dst or api::foo'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      return moveResult(p.project, [{ ref: args.ref, toNamespace: args.toNamespace }]);
    },
  );

  reg(
    'plan_move_entities',
    {
      title: 'Plan moving a set of artifacts/content-types to one namespace (dry-run)',
      description:
        'Like plan_move but for several refs at once (artifacts and/or content-types), to the same destination — one coherent plan so the cluster\'s internal refs stay consistent in a single pass. Dry-run (+ `planId`, + `warnings`); apply with `apply_edits`. Refused all-or-nothing on any unsafe spec.',
      inputSchema: {
        refs: z.array(z.string()).describe('The artifact/content-type refs to move together.'),
        toNamespace: z.string().describe('Destination namespace for all of them: plugin::dst or api::foo'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      return moveResult(p.project, args.refs.map((ref) => ({ ref, toNamespace: args.toNamespace })));
    },
  );

  reg(
    'create_plugin',
    {
      title: 'Scaffold a new local plugin (dry-run)',
      description:
        'Plan the files for a new local Strapi plugin (`src/plugins/<name>/package.json` + `strapi-server.js`, and `config/plugins` if missing). Dry-run (+ `planId`, + `warnings` to verify the server entry for your Strapi version); apply with `apply_edits`. Use extract_to_plugin to scaffold AND move artifacts in one plan.',
      inputSchema: {
        name: z.string().describe('Plugin name, kebab-case, e.g. billing.'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const scaffold = await planCreatePlugin(fs, p.project, args.name);
      if (!scaffold.ok) return json({ created: false, errors: scaffold.errors });
      const planned = await planEdit(fs, { textEdits: [], fileRenames: [], fileCreates: scaffold.fileCreates });
      rememberPlan(planned);
      return json({ ...planned, warnings: scaffold.warnings });
    },
  );

  reg(
    'extract_to_plugin',
    {
      title: 'Extract artifacts into a new plugin (dry-run)',
      description:
        'Scaffold a new local plugin AND move a set of services/controllers/policies/middlewares into it, in ONE plan: plugin files created, every call-site rewritten, files relocated. Dry-run (+ `planId`, + `warnings`); apply with `apply_edits`. Refused all-or-nothing if scaffold or move is unsafe. The one-pass extraction primitive.',
      inputSchema: {
        refs: z.array(z.string()).describe('Artifact refs to extract together.'),
        name: z.string().describe('New plugin name, kebab-case.'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const scaffold = await planCreatePlugin(fs, p.project, args.name);
      if (!scaffold.ok) return json({ extracted: false, errors: scaffold.errors });
      const move = await planMove(
        fs,
        p.project,
        args.refs.map((ref) => ({ ref, toNamespace: `plugin::${args.name}` })),
        { allowNewNamespace: true },
      );
      const warnings = [...scaffold.warnings, ...move.warnings];
      if (!move.ok) return json({ extracted: false, errors: move.errors, warnings });
      const planned = await planEdit(fs, {
        textEdits: move.textEdits,
        fileRenames: move.fileRenames,
        fileCreates: scaffold.fileCreates,
      });
      rememberPlan(planned);
      return json({ ...planned, warnings });
    },
  );

  // Schema helpers are dry-runs (return a plan, write nothing) → `plan_` prefix so
  // the permission classifier treats them like the other planners (only apply_edits
  // writes). Old names kept as deprecated aliases for the transition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const changeRelationHandler = async (args: any): Promise<CallToolResult> => {
    await ready;
    await engine.whenReferencesReady();
    const p = pick(engine, args, roots());
    if ('result' in p) return p.result;
    return schemaResult(await planChangeRelation(fs, p.project, args.uid, args.field, args.newTarget), 'changed');
  };
  const changeRelationSchema = {
    uid: z.string().describe('The content-type UID, e.g. api::article.article'),
    field: z.string().describe('The relation attribute name, e.g. author'),
    newTarget: z.string().describe('The new target content-type UID, e.g. api::user.user'),
    ...selector,
  };
  const changeRelationDesc =
    "Change the `target` of a content-type's relation field to another content-type, editing schema.json precisely. Dry-run: returns a plan (+ `planId`), writes nothing; apply with `apply_edits`. Refused if the field isn't a relation or the new target is unknown (external plugin → warning); a bidirectional relation warns about its now-orphaned inverse field.";
  reg('plan_change_relation', { title: 'Plan retargeting a relation field (dry-run)', description: changeRelationDesc, inputSchema: changeRelationSchema }, changeRelationHandler);
  reg('change_relation', { title: '[deprecated → plan_change_relation]', description: `Deprecated alias of plan_change_relation. ${changeRelationDesc}`, inputSchema: changeRelationSchema }, changeRelationHandler);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renameAttributeHandler = async (args: any): Promise<CallToolResult> => {
    await ready;
    await engine.whenReferencesReady();
    const p = pick(engine, args, roots());
    if ('result' in p) return p.result;
    return schemaResult(await planRenameAttribute(fs, p.project, args.uid, args.oldName, args.newName), 'renamed');
  };
  const renameAttributeSchema = {
    uid: z.string().describe('The content-type UID.'),
    oldName: z.string().describe('Current attribute name.'),
    newName: z.string().describe('New attribute name.'),
    ...selector,
  };
  const renameAttributeDesc =
    'Rename an attribute in schema.json, plus (for a RELATION) its populate/filters usages by name via the relation-field index. ⚠️ Does NOT rewrite object/data-access usages (`entity.field`, `data: { field }`, destructuring, populated results) — those are untyped property access we cannot rewrite without guessing; the result always warns to review them by hand. NOT a complete field rename. Dry-run (+ `planId`); apply with `apply_edits`.';
  reg('plan_rename_attribute', { title: 'Plan a content-type attribute rename — schema + relation query-keys only (dry-run)', description: renameAttributeDesc, inputSchema: renameAttributeSchema }, renameAttributeHandler);
  reg('rename_attribute', { title: '[deprecated → plan_rename_attribute]', description: `Deprecated alias of plan_rename_attribute. ${renameAttributeDesc}`, inputSchema: renameAttributeSchema }, renameAttributeHandler);

  reg(
    'apply_edits',
    {
      title: 'Apply a reviewed plan to disk (contractual)',
      description:
        'Apply a plan returned by plan_rename_* (and future move/extract plans). Pass `planId` to apply exactly the reviewed plan, or `plan` (a full plan object) to apply one you hold. The plan is verified against disk first — if any touched file changed since it was computed, nothing is written (the changed paths are returned). ⚠️ Modifies files on disk.',
      inputSchema: {
        planId: z.string().optional().describe('The planId from a plan_* result (preferred).'),
        plan: planObjectSchema.optional().describe('A full, well-formed plan object (planId + fingerprints), if not using planId.'),
      },
    },
    async (args) =>
      withApplyLock(async () => {
        await ready;
        const planned: PlannedEdit | undefined = args.planId
          ? plans.get(args.planId)
          : (args.plan as PlannedEdit | undefined);
        if (!planned || !planned.fingerprints) {
          return json({
            applied: false,
            reason: args.planId
              ? `Unknown planId \`${args.planId}\` — it was not produced this session. Re-run a plan_* tool to get a fresh plan, or pass the full \`plan\` object.`
              : 'Provide a `planId` from a plan_* result, or a full `plan` object (with fingerprints).',
          });
        }
        const check = await verifyFingerprints(fs, planned.fingerprints);
        if (!check.ok) {
          return json({
            applied: false,
            reason: 'The plan is stale — files changed on disk since it was computed. Re-run the plan and review again.',
            changed: check.changed,
          });
        }
        let result;
        try {
          result = await applyWorkspaceEdit(planned, projectRoots());
        } catch (err) {
          // Refused (containment/collision) or a write threw mid-apply. Drop the now-suspect
          // plan, reconcile the index with whatever landed, and refuse with a structured reason.
          plans.delete(planned.planId);
          await engine.rescan();
          return json({ applied: false, reason: `Apply refused/failed: ${errText(err)} — nothing or only part was written; the index was refreshed. Re-plan before retrying.` });
        }
        plans.delete(planned.planId);
        const { changed, deleted } = applyDelta(result);
        await engine.onFilesChanged(changed, deleted); // incremental refresh — not a full workspace rescan
        return json({ applied: true, ...result, verify: await verifyAfterApply(changed) });
      }),
  );

  reg(
    'apply_rename',
    {
      title: 'Rename a Strapi entity or method (writes files)',
      description:
        'Convenience: plan + apply a rename in one call. An entity (omit `method`) or a service/controller method (pass `method`). Rewrites every call-site + route handler and renames the files/folders. ⚠️ Modifies files on disk. Prefer plan_rename_* then apply_edits when you want to review first.',
      inputSchema: {
        ref: z.string(),
        newName: z.string(),
        method: z.string().optional().describe('Pass to rename a method; omit to rename the entity.'),
        ...selector,
      },
    },
    async (args) =>
      withApplyLock(async () => {
        await ready;
        await engine.whenReferencesReady();
        const p = pick(engine, args, roots());
        if ('result' in p) return p.result;
        const edit = await planRename(fs, p.project, args.ref, args.newName, args.method);
        if (!edit)
          return json({
            applied: false,
            reason: `\`${args.ref}\`${args.method ? `#${args.method}` : ''} is not an indexed target, or \`${args.newName}\` is invalid/unchanged. ${RENAME_HINT}`,
          });
        let result;
        try {
          result = await applyWorkspaceEdit(edit, projectRoots());
        } catch (err) {
          await engine.rescan();
          return json({ applied: false, reason: `Apply refused/failed: ${errText(err)} — nothing or only part was written; the index was refreshed. Review before retrying.` });
        }
        const { changed, deleted } = applyDelta(result);
        await engine.onFilesChanged(changed, deleted); // incremental refresh — not a full workspace rescan
        return json({ applied: true, ...result, verify: await verifyAfterApply(changed) });
      }),
  );
}
