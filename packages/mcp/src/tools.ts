import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CONFIG_SYNC_PACKAGE,
  configSyncLabel,
  configSyncStatus,
  followConfigSync,
  type PipelineStep,
  routeAccessForRoute,
  callFormCoverage,
  dependencies,
  dependents,
  diagramOf,
  toMermaid,
  type FileSystem,
  getSchema,
  listArtifacts,
  listBrokenRefs,
  movedUid,
  projectInfo,
  refKind,
  renamedUid,
  storedUidWarnings,
  listComponents,
  listContentTypes,
  listRefs,
  listUnused,
  pathMatches,
  qualifiedHandler,
  routePipeline,
  type RouteInfo,
  paths,
  type ReferenceLocation,
  referencesOf,
  relationUsagesOf,
  resolveRef,
  selectProject,
  type StrapiEngine,
  type StrapiProject,
  validateRef,
  type WorkspaceEdit,
} from 'devkit-for-strapi-core';
import {
  configSyncDiff,
  configSyncExport,
  configSyncImport,
  type ConfigSyncWriteData,
  type RuntimeFailure,
  type RuntimeOptions,
  type RuntimeResult,
  type RuntimeSuccess,
  runtimeHint,
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
import { VERSION } from './version';

/** Render any value as the MCP text result agents read. */
const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/** Human-readable text for a thrown value (for structured apply-failure reasons). */
/** Most routes `list_routes` explains at once (`pipeline: true`). */
const PIPELINE_MAX = 20;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Every answer carries how current it is in `_meta` (machine-readable, no format
 * change); a visible line is added only when the answer may NOT reflect the disk.
 */
export function withFreshness(engine: StrapiEngine, res: CallToolResult): CallToolResult {
  const projects = engine.getProjects();
  const caveats: string[] = [];
  for (const p of projects) {
    const name = paths.basename(p.root);
    if (p.freshness.diskTracking === 'off') caveats.push(`${name} has too many files to compare with the disk on each call: call refresh after editing files outside this session`);
    if (p.freshness.pluginsLoading) caveats.push(`${name}'s installed plugins are still being read: plugin refs come back external for a few seconds`);
  }
  return {
    ...res,
    _meta: {
      ...res._meta,
      'devkit-for-strapi/freshness': { answeredAt: new Date().toISOString(), projects: projects.map((p) => ({ name: paths.basename(p.root), ...p.freshness })) },
    },
    ...(caveats.length ? { content: [...res.content, { type: 'text' as const, text: `Freshness: ${caveats.join('; ')}.` }] } : {}),
  };
}

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

/** The refactor tools: whether the plan also updates the config/sync files the refactor concerns. */
const configSyncArg = {
  configSync: z
    .boolean()
    .optional()
    .describe(
      "With strapi-plugin-config-sync: also update the config/sync files this refactor concerns (roles' permissions, content-manager views) to the new names. Default: true (the strapiDevkit.configSync.followRefactors setting; DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS=0 for a standalone server). Pass false when config/sync is not yours to change here (exported from another environment). The plan's warnings say which sync files it updates, or leaves with the old names.",
    ),
};

/**
 * Whether refactors in the project at `root` follow config/sync when a call doesn't say:
 * DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS=0 turns it off everywhere; VS Code passes the
 * folders whose strapiDevkit.configSync.followRefactors is off (a per-folder setting).
 */
const followRefactorsByDefault = (root: string): boolean => {
  if (/^(0|false|no|off)$/i.test((process.env.DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS ?? '').trim())) return false;
  let off: unknown = [];
  try {
    off = JSON.parse(process.env.DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS_OFF ?? '[]');
  } catch {
    off = [];
  }
  const r = paths.normalize(root);
  return !(Array.isArray(off) ? off : []).some((d) => typeof d === 'string' && (r === paths.normalize(d) || r.startsWith(`${paths.normalize(d)}/`)));
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

  /**
   * The plan with its config/sync files, or without them (the call's `configSync`, else the
   * default), and its warnings with the note saying which — so the agent knows either way.
   */
  const syncPlan = async <E extends Pick<WorkspaceEdit, 'textEdits' | 'fileRenames'>>(project: StrapiProject, edit: E, warnings: string[], configSync: boolean | undefined): Promise<{ edit: E; warnings: string[] }> => {
    const r = await followConfigSync(fs, project, edit, configSync ?? followRefactorsByDefault(project.root));
    return { edit: r.edit, warnings: r.note ? [...warnings, r.note] : warnings };
  };

  /** A schema-edit plan → a contractual plan result, or refusal. */
  const schemaResult = async (project: StrapiProject, plan: SchemaEditPlan, verb: string, configSync?: boolean): Promise<CallToolResult> => {
    if (!plan.ok) return json({ [verb]: false, errors: plan.errors, warnings: plan.warnings });
    const s = await syncPlan(project, { textEdits: plan.textEdits, fileRenames: [] as WorkspaceEdit['fileRenames'] }, plan.warnings, configSync);
    const planned = await planEdit(fs, s.edit);
    rememberPlan(planned);
    return json({ ...planned, warnings: s.warnings });
  };

  /** Plan a move (single or grouped) → a contractual plan result, or refusal. */
  const moveResult = async (project: StrapiProject, specs: MoveSpec[], configSync?: boolean): Promise<CallToolResult> => {
    const move = await planMove(fs, project, specs);
    if (!move.ok) return json({ moved: false, errors: move.errors, warnings: move.warnings });
    const s = await syncPlan(project, { textEdits: move.textEdits, fileRenames: move.fileRenames }, [...move.warnings, ...movedWarnings(project, specs)], configSync);
    const planned = await planEdit(fs, s.edit);
    rememberPlan(planned);
    return json({ ...planned, warnings: s.warnings });
  };
  /** The database caveats of moving these refs (UIDs Strapi stores as strings). */
  const movedWarnings = (project: StrapiProject, specs: MoveSpec[]): string[] =>
    storedUidWarnings({
      uids: specs.flatMap((s) => {
        const kind = refKind(project.index, s.ref);
        return kind && s.toNamespace ? [{ kind, from: s.ref, to: movedUid(s.ref, s.toNamespace) }] : [];
      }),
    });
  /** The database caveats of a rename (entity: its last segment; method: a controller action). */
  const renameWarnings = (project: StrapiProject, ref: string, newName: string, method?: string): string[] => {
    if (method) return project.index.controllers.has(ref) ? storedUidWarnings({ actions: [{ from: `${ref}.${method}`, to: `${ref}.${newName}` }] }) : [];
    const kind = refKind(project.index, ref);
    return kind ? storedUidWarnings({ uids: [{ kind, from: ref, to: renamedUid(ref, newName) }] }) : [];
  };

  // Auto-gate the Pro tools (writes/refactors, and the data-model diagram): without a
  // licence they return the upsell instead of running, so an agent learns the
  // capability exists and how to unlock it. The other read/analyse tools are never
  // gated; plan_* is gated as well as apply_* so an agent can't apply a free plan with
  // its own edit tools.
  const GATED = new Set<string>(proToolNames());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gate = (cb: (...a: any[]) => unknown, name: string) =>
    async (...a: unknown[]): Promise<unknown> => ((await isLicensed()) ? cb(...a) : json(proRequired(name)));
  // Counted as they register, so `server_info` reports the real total instead of
  // a hard-coded one that drifts on the next tool added.
  let registered = 0;
  const reg: typeof server.registerTool = (name, config, cb) => {
    registered++;
    const inner = (GATED.has(name) ? gate(cb as never, name) : cb) as (...a: unknown[]) => unknown;
    // No file watcher in the MCP server: before answering, pick up what changed on disk since
    // the last call (edits, a git checkout, an `npm install`) — a few ms.
    const fresh = (async (...a: unknown[]) => {
      await engine.refreshIfStale();
      return withFreshness(engine, (await inner(...a)) as CallToolResult);
    }) as unknown as typeof cb;
    return server['registerTool'](name, config, fresh);
  };

  /** What a `ref` may be (shared by every tool taking one). */
  const REF_HELP =
    'A Strapi reference: a content-type or component UID (api::article.article, shared.seo), a service / controller / policy / middleware ref (api::article.article, plugin::users-permissions.user, global::is-owner), or a route handler (api::article.article.find). `ref#method` targets one method.';

  reg(
    'server_info',
    {
      title: 'DevKit version, licence tier and which tools actually run',
      description:
        'Identify the running DevKit server: its version, whether a Pro licence is active, how many tools are genuinely callable, the roots being indexed, and how current the index is (`freshness`). `tools/list` advertises the Pro tools too, but without a licence they return an upsell instead of running — this reports which ones will really work, so an agent stops guessing. Also the only way to name a version in a bug report: the version lives in the MCP handshake, which the client consumes and does not always display.',
    },
    async () => {
      const licensed = await isLicensed();
      const proTools = proToolNames();
      return json({
        version: VERSION,
        tier: licensed ? 'pro' : 'free',
        tools: {
          total: registered,
          available: licensed ? registered : registered - proTools.length,
          proOnly: proTools.length,
        },
        // Named so an agent can avoid a pointless call, or tell the user exactly
        // what a licence would unlock.
        proTools,
        roots: [...roots()],
        // How current every answer is: what changed on disk is re-indexed before each call.
        freshness: {
          policy:
            "Before each call, project files created, edited or deleted on disk are re-indexed and installed plugins are re-read after an install (`diskTracking: 'off'` on a project too large to compare: call refresh after external edits); refresh({ cold: true }) reads everything again without cache.",
          projects: engine.getProjects().map((p) => ({ name: paths.basename(p.root), ...p.freshness })),
        },
      });
    },
  );

  reg(
    'list_projects',
    {
      title: 'List Strapi projects',
      description:
        'List the Strapi projects discovered in the workspace (name, root, Strapi version, counts, `freshness`). Call this first in a multi-project workspace, then pass `from`/`project` to the other tools; project_info gives one project in full.',
    },
    async () => {
      await ready;
      return json(engine.getProjects().map((p) => tagFixture({ name: paths.basename(p.root), ...p })));
    },
  );

  reg(
    'project_info',
    {
      title: 'Describe one Strapi project (and why a plugin ref may be unverified)',
      description:
        "Everything about one project before acting on it: Strapi version (installed / declared), TypeScript or JavaScript, package manager, API prefix, counts (APIs, content-types by kind, components, services, controllers, policies, middlewares, routes), every local and installed plugin with whether DevKit verifies refs into it and, if not, why (no node_modules, rewritten at boot by a project file, a src/extensions override, Enterprise-only code…), health (broken refs, refs into unverified plugins) and freshness. Call it to orient yourself in an unknown project, or when a plugin ref comes back `external`.",
      inputSchema: { ...selector },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const summary = engine.getProjects().find((s) => s.root === p.project.root);
      if (!summary) return json({ error: 'The project was re-indexed meanwhile: call project_info again.' });
      const routes = (await engine.getRoutes({ root: p.project.root }))[0]?.routes;
      return json(await projectInfo(fs, p.project, summary, { routes }));
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
      title: 'Re-index projects from disk (full rescan)',
      description:
        "Re-scan every discovered Strapi project from disk and rebuild the index from scratch. Rarely needed: before every call the server already compares the project files with the disk and re-indexes what was created, edited or deleted outside this session (manual edits, git checkout/pull, another tool), and re-reads installed plugins after an install. Use it to discover a project added since startup, after external edits on a project whose `freshness.diskTracking` is 'off' (too many files), or with `cold: true` to also drop the cached plugin reads and read every installed plugin from node_modules again (slower). Returns the projects with their `freshness`.",
      inputSchema: {
        cold: z.boolean().optional().describe('Also drop the cached plugin reads: every installed plugin is read again from node_modules (default false).'),
      },
    },
    async (args) => {
      await ready;
      await engine.rescan({ cold: args.cold === true });
      await engine.whenInstalledReady();
      await engine.whenReferencesReady();
      return json({ refreshed: true, cold: args.cold === true, projects: engine.getProjects().map((p) => tagFixture({ name: paths.basename(p.root), ...p })) });
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
        kind: z.enum(['service', 'controller', 'policy', 'middleware']).optional().describe('Only this kind (default: all four).'),
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
    'get_model_diagram',
    {
      title: 'Data model diagram (Mermaid)',
      description:
        "The project's data model as a Mermaid `erDiagram`: content-types (and, optionally, components) with their fields, one line per association (a bidirectional relation's two fields as one) with its cardinalities, media fields linked to the upload plugin's File, and the plugin types they link to. Read from the schemas, not from a running Strapi. Paste it in a README, a doc or an issue; `focus` narrows it to some types and their neighbours. With `strapiFields`, adds what Strapi gives every content-type (createdAt, updatedAt, publishedAt, createdBy/updatedBy → admin::user).",
      inputSchema: {
        ...selector,
        components: z.boolean().optional().describe('Include components (default false).'),
        allPlugins: z.boolean().optional().describe('Every installed plugin type, not only those the project links to (default false).'),
        media: z.boolean().optional().describe("Media fields → the upload plugin's File (default true)."),
        strapiFields: z.boolean().optional().describe('The fields Strapi adds to every content-type (default false).'),
        focus: z.array(z.string()).optional().describe('Only these UIDs and the types they link to.'),
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const opts = {
        ...(args.components !== undefined ? { components: args.components } : {}),
        ...(args.allPlugins !== undefined ? { allPlugins: args.allPlugins } : {}),
        ...(args.media !== undefined ? { media: args.media } : {}),
        ...(args.strapiFields !== undefined ? { strapiFields: args.strapiFields } : {}),
        ...(args.focus?.length ? { focus: args.focus } : {}),
      };
      const d = toMermaid(diagramOf(p.project), opts);
      return json({ format: 'mermaid', entities: d.entities, links: d.links, mermaid: d.mermaid });
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
        'Resolve a Strapi reference (UID / service / controller / policy / middleware / route handler) to its defining file(s), tagged by kind — installed plugins included (their files in node_modules).',
      inputSchema: { ref: z.string().describe(REF_HELP), ...selector },
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
        'Check whether a Strapi reference is real in the project. Returns valid | unknown (+ didYouMean) | external: a plugin DevKit cannot verify — not installed, not read completely (code that only runs in Strapi), rewritten at boot by the project, or still being read just after startup; project_info says which and why. Installed plugins DevKit reads completely are checked like your own code. Call this before writing a magic string.',
      inputSchema: { ref: z.string().describe(REF_HELP), ...selector },
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
        'List every call-site that references a UID / service / controller / handler (or `ref#method`) in the project\'s own code (src/ and config/; node_modules and build output are not searched). Returns the total first, then a page of references. Compact by default (`path:line:col [via]  snippet`, 1-based) — pass `compact: false` for full objects. Pass `refs` to query several at once. See coverage for the call forms indexed.',
      inputSchema: {
        ref: z.string().optional().describe(REF_HELP),
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
        'List a project\'s HTTP route table: method, path, mounted `fullPath` (API prefix included), handler, policies, middlewares, `public` (auth: false), `auth` when customized, and where each route is declared (`filePath`/`offset`). Covers the project\'s explicit routes, the auto-CRUD routes synthesized from createCoreRouter, and the routes local and installed plugins declare (`origin`), read from node_modules without booting Strapi. Admin-panel routes are left out unless `admin: true`. Filter with `method`, `path` (a pattern, a part of it, or a concrete URL such as `/api/articles/12`) and `handler`. With `pipeline: true` (needs a filter, at most ' +
        PIPELINE_MAX +
        ' routes), each route also gets what a request goes through, in Strapi\'s order — the `config/middlewares` stack (once, in `globalMiddlewares`), auth, policies, route middlewares, handler — each step with a status: `ok`, `not-found-by-strapi` (it exists under another name Strapi won\'t try: Strapi throws at startup), `unknown`, `unverified`, `unread` or `inline`. Use it to explain a 401/403, or a startup error about a policy or middleware.',
      inputSchema: {
        ...selector,
        plugins: z.boolean().optional().describe('Include routes declared by local and installed plugins (default true).'),
        admin: z.boolean().optional().describe('Include admin-panel (`type: "admin"`) routes (default false).'),
        method: z.string().optional().describe('Only routes of this HTTP method (e.g. `GET`).'),
        path: z.string().optional().describe('Only routes whose path matches: the pattern (`/api/articles/:id`), a part of it, or a concrete URL it serves (`/api/articles/12`).'),
        handler: z.string().optional().describe('Only routes whose handler (qualified, e.g. `api::article.article.find`) contains this.'),
        pipeline: z.boolean().optional().describe(`Add each route's pipeline (needs method, path or handler; at most ${PIPELINE_MAX} routes).`),
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const all = (await engine.getRoutes({ ...(args.plugins !== undefined ? { plugins: args.plugins } : {}), admin: args.admin ?? false, root: p.project.root }))[0]?.routes ?? [];
      const routes = all.filter(
        (r: RouteInfo) =>
          (!args.method || r.method.toUpperCase().split(/[|,]/).includes(args.method.toUpperCase())) &&
          (!args.path || pathMatches(r.fullPath ?? r.path, args.path) || pathMatches(r.path, args.path)) &&
          (!args.handler || qualifiedHandler(r).includes(args.handler)),
      );
      if (!args.pipeline) return json(routes);
      if (!args.method && !args.path && !args.handler) {
        return json({ error: 'pipeline needs a filter: pass `method`, `path` or `handler` to narrow the routes first.', routes: routes.length });
      }
      if (routes.length > PIPELINE_MAX) {
        return json({ error: `${routes.length} routes match: narrow the filter to at most ${PIPELINE_MAX} for the pipeline.`, routes: routes.map((r) => `${r.method} ${r.fullPath ?? r.path}`) });
      }
      const global = await engine.getGlobalMiddlewares(p.project.root);
      // The users-permissions roles in config/sync: who may call each route once they are imported.
      const synced = (await configSyncStatus(fs, p.project))?.files ?? [];
      const withAccess = (r: RouteInfo, s: PipelineStep): PipelineStep & { syncedRoles?: unknown } => {
        const access = s.phase === 'auth' ? routeAccessForRoute(r, synced) : undefined;
        return access ? { ...s, syncedRoles: { action: access.action, allowed: access.allowed, denied: access.denied, note: 'According to the config/sync role files: the database may differ until they are imported.' } } : s;
      };
      const piped = routes.map((r) => ({ ...r, pipeline: routePipeline(p.project, r, global).steps.filter((s) => s.phase !== 'global-middleware').map((s) => withAccess(r, s)) }));
      const stack = routes[0] ? routePipeline(p.project, routes[0], global).steps.filter((s) => s.phase === 'global-middleware') : [];
      return json({ globalMiddlewares: { status: global.status, file: global.file, envFiles: global.envFiles, steps: stack }, routes: piped });
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
    'config_sync_status',
    {
      title: 'config-sync: its options and the files of its sync directory',
      description:
        "For a project using strapi-plugin-config-sync, read from the files (Strapi is not started, the database is not read): the plugin's version, its options and where each comes from (a short `excludedConfig` is merged index by index with the plugin's defaults, as Strapi does: the warnings say which defaults are no longer excluded), the sync directory, and its files by status — `ok`, `excluded` by the options, `invalid` (not valid JSON: config-sync can't read it), or of a type not registered here. `files: true` lists them with readable names (\"View — Article\", \"Role Public\"); `key` returns one file's content. What the database holds is not known here.",
      inputSchema: {
        key: z.string().max(400).optional().describe('One entry, `<type>.<name>`: user-role.public, core-store.plugin_content_manager_configuration_content_types::api::article.article.'),
        files: z.boolean().optional().describe('List every file (key, readable label, status). Default: counts by status.'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const st = await configSyncStatus(fs, p.project);
      if (!st) return json({ detected: false, message: `${CONFIG_SYNC_PACKAGE} is neither in package.json nor installed in this project.` });
      const d = st.detection;
      const label = (key: string): string => {
        const dot = key.indexOf('.');
        return configSyncLabel(p.project, key.slice(0, dot), key.slice(dot + 1)).label;
      };
      const partial = st.partial ? { partial: 'The installed plugins are not known (still loading, or not installed): user-role and i18n-locale files are assumed registered.' } : {};

      if (args.key) {
        const entry = st.files.find((f) => f.key === args.key);
        if (!entry) {
          const near = st.files.map((f) => f.key).filter((k) => k.includes(args.key!.split('.').pop()!)).slice(0, 5);
          return json({ key: args.key, found: false, message: `No file for ${args.key} in ${d.syncDirPath}.`, ...(near.length ? { didYouMean: near } : {}) });
        }
        return json({
          key: entry.key,
          label: label(entry.key),
          file: entry.path,
          status: entry.status,
          ...(entry.content !== undefined ? { content: entry.content } : {}),
          ...partial,
        });
      }

      const byStatus: Record<string, number> = {};
      for (const f of st.files) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1;
      const invalid = st.files.filter((f) => f.status === 'invalid').map((f) => f.key);
      const { sources, ...options } = d.options;
      return json({
        detected: true,
        plugin: {
          package: CONFIG_SYNC_PACKAGE,
          ...(d.declaredRange ? { declared: d.declaredRange } : {}),
          ...(d.installedVersion ? { installed: d.installedVersion } : {}),
          ...(d.targetsStrapi ? { forStrapi: d.targetsStrapi } : {}),
          ...(d.versionMismatch ? { versionMismatch: true } : {}),
          ...(d.disabled ? { disabled: true } : {}),
          ...(d.configFile ? { configFile: d.configFile } : {}),
        },
        options,
        optionSources: sources,
        ...(d.envOverrides.length ? { envOverrides: d.envOverrides } : {}),
        syncDir: { path: d.syncDirPath, exists: d.syncDirExists },
        files: { total: st.files.length, byStatus, ...(args.files ? { list: st.files.map((f) => ({ key: f.key, label: label(f.key), status: f.status })) } : {}) },
        ...(invalid.length ? { invalid } : {}),
        ...(d.warnings.length ? { warnings: d.warnings } : {}),
        ...partial,
      });
    },
  );

  /** How this server runs a project (VS Code passes its settings through the environment). */
  const runtimeOptions = (args: { env?: string }): RuntimeOptions => ({
    ...(process.env.DEVKIT_NODE ? { nodePath: process.env.DEVKIT_NODE } : {}),
    env: args.env ?? process.env.DEVKIT_CONFIG_SYNC_ENV ?? 'development',
    ...(process.env.DEVKIT_CONFIG_SYNC_ENV_PATH ? { envPath: process.env.DEVKIT_CONFIG_SYNC_ENV_PATH } : {}),
    ...(process.env.DEVKIT_ALLOW_REMOTE_DATABASE === '1' ? { allowRemoteDatabase: true } : {}),
    // A timeout that isn't a positive number of seconds is ignored (NaN or 0 would stop every run at once).
    ...(Number(process.env.DEVKIT_RUNTIME_TIMEOUT_S) > 0 ? { timeoutMs: Math.max(30, Number(process.env.DEVKIT_RUNTIME_TIMEOUT_S)) * 1000 } : {}),
  });
  /** A failed run, said plainly, with what to do. */
  const runtimeFailure = (r: RuntimeFailure): CallToolResult =>
    json({
      ok: false,
      kind: r.kind,
      message: r.message,
      todo: runtimeHint(r.kind),
      step: r.step,
      ...(r.target ? { target: r.target } : {}),
      ...(r.detail?.frame ? { where: r.detail.frame } : {}),
      ...(r.output && (r.kind === 'crashed' || r.kind === 'compile-failed' || r.kind === 'bootstrap-error') ? { output: r.output.slice(-3000) } : {}),
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    });
  /** Run a config-sync command on a project using the plugin (the stub build throws: said plainly). */
  const runConfigSync = async <T>(args: { from?: string; project?: string }, run: (root: string) => Promise<RuntimeResult<T>>, ok: (r: RuntimeSuccess<T>, project: StrapiProject) => CallToolResult): Promise<CallToolResult> => {
    await ready;
    const p = pick(engine, args, roots());
    if ('result' in p) return p.result;
    const status = await configSyncStatus(fs, p.project);
    if (!status) return json({ detected: false, message: `${CONFIG_SYNC_PACKAGE} is neither in package.json nor installed in this project.` });
    // Said without loading Strapi: nothing to ask a disabled plugin.
    if (status.detection.disabled) return json({ detected: true, disabled: true, message: `${CONFIG_SYNC_PACKAGE} is disabled in config/plugins (enabled: false): enable it to compare, export or import.` });
    let r: RuntimeResult<T>;
    try {
      r = await run(p.project.root);
    } catch (e) {
      return json({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
    return r.ok ? ok(r, p.project) : runtimeFailure(r);
  };
  const entryLabel = (project: StrapiProject, key: string): string => {
    const dot = key.indexOf('.');
    return configSyncLabel(project, key.slice(0, dot), key.slice(dot + 1)).label;
  };
  const RUNS_PROJECT =
    "It runs the project's code: Strapi is loaded the way config-sync's own CLI does (no server, no port, no admin account), and a load does what a start of `strapi develop` does to the database (schema sync, pending migrations) — so only on a local development database: a remote one, a Strapi 4 database under Strapi 5 code, or a missing SQLite file are refused before Strapi's bootstrap (where it writes to the database).";
  const envArg = z.string().max(40).optional().describe('NODE_ENV for the run (default development).');

  reg(
    'config_sync_diff',
    {
      title: 'config-sync: the real diff between config/sync and the database',
      description: `The diff config-sync's admin page shows, from the real plugin: each entry that differs between config/sync and the database — \`different\`, \`only-in-db\`, \`only-in-sync-dir\` — with what differs in a few words. It includes what a start of Strapi changes on its own (a new field in a content-manager view, the super-admin's permissions…): after changing a schema, a controller or a route, these are the entries to export and commit with the code. With \`key\`, one entry with both sides in full. ${RUNS_PROJECT} Takes a few seconds.`,
      inputSchema: { key: z.string().max(400).optional().describe('One entry, `<type>.<name>`, for both sides in full.'), env: envArg, ...selector },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) =>
      runConfigSync(
        args,
        (root) => configSyncDiff(root, runtimeOptions(args)),
        (r, project) => {
          if (args.key) {
            const e = r.data.entries.find((x) => x.key === args.key);
            return json(e ? { key: e.key, label: entryLabel(project, e.key), state: e.state, summary: e.summary, file: e.file, db: e.db, target: r.target } : { key: args.key, state: 'same', message: 'config/sync and the database agree on this entry (or it exists in neither).', target: r.target });
          }
          return json({
            target: r.target,
            versions: r.versions,
            ms: r.timings.total,
            differences: r.data.entries.length,
            entries: r.data.entries.map((e) => ({ key: e.key, label: entryLabel(project, e.key), state: e.state, summary: e.summary })),
            ...(r.warnings.length ? { warnings: r.warnings } : {}),
          });
        },
      ),
  );

  const writeResult = (r: RuntimeSuccess<ConfigSyncWriteData>, project: StrapiProject): CallToolResult =>
    json({
      done: r.data.done,
      ...(r.data.skipped.length ? { skipped: r.data.skipped, skippedWhy: 'not different: nothing to do' } : {}),
      ...(r.data.reexported.length ? { reexported: r.data.reexported, reexportedWhy: "imported, then written back in the database's own form (a generated documentId…)" } : {}),
      stillDifferent: r.data.entries.map((e) => ({ key: e.key, label: entryLabel(project, e.key), state: e.state, summary: e.summary })),
      target: r.target,
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    });

  reg(
    'config_sync_export',
    {
      title: 'config-sync: export entries from the database into config/sync',
      description: `Write entries from the database into config/sync with the plugin's own export — the exact form config-sync compares, so the files stop showing as different. Only entries that differ are exported; \`keys\` narrows it (default: every difference). An entry only in config/sync has its file deleted. Commit the files with the code that caused them. ${RUNS_PROJECT}`,
      inputSchema: { keys: z.array(z.string().max(400)).max(500).optional().describe('The entries to export (default: every difference).'), env: envArg, ...selector },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => runConfigSync(args, (root) => configSyncExport(root, args.keys, runtimeOptions(args)), writeResult),
  );

  reg(
    'config_sync_import',
    {
      title: 'config-sync: import entries from config/sync into the database',
      description: `Apply entries of config/sync to the database with the plugin's own import — a role's permissions, a content-manager view, a setting. \`keys\` is required: never everything at once. An entry only in the database is deleted from it. Afterwards, the entries still different are exported back (\`reexport\`, default true): the database's own form of what was just imported (a generated documentId…), so the diff converges. Refused with NODE_ENV=production. ${RUNS_PROJECT}`,
      inputSchema: {
        keys: z.array(z.string().max(400)).min(1).max(500).describe('The entries to import, `<type>.<name>`.'),
        reexport: z.boolean().optional().describe('Export back the entries still different afterwards (default true).'),
        env: envArg,
        ...selector,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => runConfigSync(args, (root) => configSyncImport(root, args.keys, { ...runtimeOptions(args), ...(args.reexport === false ? { reexport: false } : {}) }), writeResult),
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
        ref: z.string().describe(REF_HELP),
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
        ref: z.string().describe(REF_HELP),
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
        'Compute the exact edits to rename a service/controller METHOD — its declaration, every `strapi.service(...).method()` call-site, and (for controllers) the action segment of route handlers. Dry-run: returns a plan (text edits + `planId`, + `warnings` when route permissions stored in the database are affected), writes nothing. Review, then apply with `apply_edits` (pass the `planId`).',
      inputSchema: {
        ref: z.string().describe('The owning service/controller ref, e.g. api::page.notifier'),
        method: z.string().describe('The current method name, e.g. notify'),
        newName: z.string().describe('The new method name, e.g. announce'),
        ...configSyncArg,
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
      const s = await syncPlan(p.project, edit, [...renameWarnings(p.project, args.ref, args.newName, args.method), ...(edit.warnings ?? [])], args.configSync);
      const planned = await planEdit(fs, s.edit);
      rememberPlan(planned);
      return json(s.warnings.length ? { ...planned, warnings: s.warnings } : planned);
    },
  );

  reg(
    'plan_rename_entity',
    {
      title: 'Plan an entity rename (dry-run)',
      description:
        'Compute the exact edits to rename a content-type / service / controller / policy / middleware / component: every magic-string call-site and route handler, plus the file/folder renames. Dry-run: returns a plan (edits + `planId`, + `warnings` listing the UIDs Strapi also stores in the database — permissions, media links, components — which the plan does not migrate; with config-sync, the plan also updates the sync files of those permissions and views unless `configSync: false`, and says which), writes nothing. Review, then apply with `apply_edits` (pass the `planId`).',
      inputSchema: {
        ref: z.string().describe('The entity UID/ref, e.g. api::product.product or shared.seo'),
        newName: z.string().describe("The UID's new last segment, e.g. item (api::product.product → api::product.item, shared.seo → shared.item)"),
        ...configSyncArg,
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
      const s = await syncPlan(p.project, edit, [...renameWarnings(p.project, args.ref, args.newName), ...(edit.warnings ?? [])], args.configSync);
      const planned = await planEdit(fs, s.edit);
      rememberPlan(planned);
      return json(s.warnings.length ? { ...planned, warnings: s.warnings } : planned);
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
        ...configSyncArg,
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      return moveResult(p.project, [{ ref: args.ref, toNamespace: args.toNamespace }], args.configSync);
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
        ...configSyncArg,
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      return moveResult(p.project, args.refs.map((ref) => ({ ref, toNamespace: args.toNamespace })), args.configSync);
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
        ...configSyncArg,
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
      const warnings = [
        ...scaffold.warnings,
        ...move.warnings,
        ...(move.ok ? movedWarnings(p.project, args.refs.map((ref) => ({ ref, toNamespace: `plugin::${args.name}` }))) : []),
      ];
      if (!move.ok) return json({ extracted: false, errors: move.errors, warnings });
      const s = await syncPlan(p.project, { textEdits: move.textEdits, fileRenames: move.fileRenames, fileCreates: scaffold.fileCreates }, warnings, args.configSync);
      const planned = await planEdit(fs, s.edit);
      rememberPlan(planned);
      return json({ ...planned, warnings: s.warnings });
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
    return schemaResult(p.project, await planChangeRelation(fs, p.project, args.uid, args.field, args.newTarget), 'changed');
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
    return schemaResult(p.project, await planRenameAttribute(fs, p.project, args.uid, args.oldName, args.newName), 'renamed', args.configSync);
  };
  const renameAttributeSchema = {
    uid: z.string().describe('The content-type UID.'),
    oldName: z.string().describe('Current attribute name.'),
    newName: z.string().describe('New attribute name.'),
    ...configSyncArg,
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
        'Apply a plan returned by any plan_* tool, create_plugin or extract_to_plugin. Pass `planId` to apply exactly the reviewed plan, or `plan` (a full plan object) to apply one you hold. The plan is verified against disk first — if any touched file changed since it was computed, nothing is written (the changed paths are returned). ⚠️ Modifies files on disk.',
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
        ref: z.string().describe(REF_HELP),
        newName: z.string().describe("The new method name (with `method`), else the UID's new last segment (api::product.product + item → api::product.item)."),
        method: z.string().optional().describe('Pass to rename a method; omit to rename the entity.'),
        ...configSyncArg,
        ...selector,
      },
    },
    async (args) =>
      withApplyLock(async () => {
        await ready;
        await engine.whenReferencesReady();
        const p = pick(engine, args, roots());
        if ('result' in p) return p.result;
        const planned = await planRename(fs, p.project, args.ref, args.newName, args.method);
        const s = planned ? await syncPlan(p.project, planned, [...renameWarnings(p.project, args.ref, args.newName, args.method), ...(planned.warnings ?? [])], args.configSync) : undefined;
        const edit = s?.edit;
        const dbWarnings = s?.warnings ?? [];
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
        return json({ applied: true, ...result, verify: await verifyAfterApply(changed), ...(dbWarnings.length ? { warnings: dbWarnings } : {}) });
      }),
  );
}
