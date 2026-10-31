import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CONFIG_SYNC_PACKAGE,
  configSyncLabel,
  configSyncStatus,
  type ConfigSyncStaticStatus,
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
  unresolvedCallsOf,
  selectProject,
  type StrapiEngine,
  type StrapiProject,
  type TargetKind,
  type UnreadPluginRoutes,
  validateRef,
  type WorkspaceEdit,
} from 'devkit-for-strapi-core';
import {
  configSyncDiff,
  configSyncDirections,
  configSyncExport,
  configSyncImport,
  type ConfigSyncDbEntry,
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
  type EntryDirection,
  type MoveSpec,
  type PlannedEdit,
  type SchemaEditPlan,
} from 'devkit-for-strapi-pro';
import { z } from 'zod';
import { applyWorkspaceEdit, type ApplyResult } from './apply';
import { planView } from './planView';
import { relativeTo, underRoot, withRelativePaths } from './relativePaths';
import { saveRootsCache } from './rootsCache';
import { VERSION } from './version';

/** Render any value as the MCP text result agents read. */
const json = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/** Characters, as `json` sends it. Claude Code refuses a tool result over 25,000 tokens: answers stay well under. */
const sizeOf = (v: unknown): number => JSON.stringify(v, null, 2)?.length ?? 0;
const ANSWER_MAX = 40_000;
/** The files an unused item names (`requiredByPath`, `onlyArchivedCallers`) before only their total. */
const UNUSED_FILES_SHOWN = 3;
const DIFFERENCES_MAX = 24_000;

/** The lines that fit in `max` characters (a very long one clipped), and whether that's all of them. */
function fitLines(lines: string[], max: number): { lines: string[]; complete: boolean } {
  const out: string[] = [];
  let used = 0;
  let complete = true;
  for (const [i, l] of lines.entries()) {
    const line = l.length > 4000 ? `${l.slice(0, 3999)}…` : l;
    if (line !== l) complete = false;
    if (used + line.length > max) {
      out.push(`… ${lines.length - i} more, not shown: too long for one answer`);
      return { lines: out, complete: false };
    }
    out.push(line);
    used += line.length + 4;
  }
  return { lines: out, complete };
}

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

/** A result, with the local plugins whose routes DevKit couldn't read whole (`unreadRoutes`) in a block of its own. */
const withUnreadRoutes = (res: CallToolResult, unread: readonly UnreadPluginRoutes[]): CallToolResult =>
  unread.length
    ? {
        ...res,
        content: [
          ...res.content,
          {
            type: 'text' as const,
            text: JSON.stringify({
              unreadRoutes: unread,
              note: "These local plugins build their routes with code DevKit can't read: the table is missing them, or some of them — read the file named.",
            }),
          },
        ],
      }
    : res;

/** One reference as a compact, token-cheap line: `path:line:col [via]  snippet` (1-based). */
const compactRef = (r: ReferenceLocation): string =>
  `${r.filePath}:${r.start.line + 1}:${r.start.character + 1}${r.via ? ` [${r.via}]` : ''}${r.archived ? ' (archived migration, never run)' : ''}${r.snippet ? `  ${r.snippet}` : ''}`;

/**
 * The Strapi calls whose UID DevKit can't read that could reach `kinds` (one of
 * `refs`, when the start of the UID they read rules it out) — said with a result
 * they may complete (a few of them, and how many in all).
 */
const unresolvedNote = (project: StrapiProject, kinds: Array<TargetKind | 'method'>, refs: string[]): { total: number; note: string; sample: string[] } | undefined => {
  const calls = unresolvedCallsOf(project, kinds, refs);
  if (!calls.length) return undefined;
  return {
    total: calls.length,
    note: 'Strapi calls whose UID DevKit cannot read (a parameter, a let, a template, an import): they may reach this too — check them.',
    sample: calls.slice(0, 5).map(compactRef),
  };
};

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
  from: z.string().optional().describe('A path inside the project (the file you are editing; relative to its root with `project`), in a multi-project workspace.'),
  project: z.string().optional().describe('A project name or root, when no path is at hand.'),
};

/** The refactor tools: whether the plan also updates the config/sync files the refactor concerns. */
const configSyncArg = {
  configSync: z
    .boolean()
    .optional()
    .describe(
      "With config-sync: also update the config/sync files this refactor concerns (roles' permissions, content-manager views). Default: the user's setting, true unless turned off. false when config/sync isn't yours to change here. The warnings say which files.",
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
  const projects = engine.allProjects();
  // A relative `from` (copied from an answer, relative to its `root`): under the project
  // `project` names, or the only one — never a guess between several.
  if (sel.from && !paths.isAbsolute(sel.from) && projects.length > 0) {
    const base = sel.project ? selectProject(projects, { project: sel.project }) : projects.length === 1 ? { project: projects[0]! } : undefined;
    if (!base || !('project' in base)) {
      return {
        result: json({
          ambiguous: true,
          message: '`from` is relative and several projects are indexed: pass it absolute (joined to the `root` of the answer it came from), or add `project` (a name below).',
          candidates: (base && 'candidates' in base ? base.candidates : projects.map((p) => ({ name: paths.basename(p.root), root: p.root }))).map(tagFixture),
        }),
      };
    }
    sel = { from: underRoot(base.project.root, sel.from) };
  }
  const s = selectProject(projects, sel);
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
  // apply exactly the reviewed plan (no recompute → no TOCTOU window). Only these:
  // an agent can't hand in a plan of its own.
  const plans = new Map<string, { planned: PlannedEdit; root: string }>();
  const PLAN_CAP = 50;
  /**
   * Store a plan (capping the Map oldest-first so a long planning session can't grow
   * it unbounded) and answer with its review view.
   */
  const planAnswer = async (project: StrapiProject, planned: PlannedEdit, warnings?: string[]): Promise<CallToolResult> => {
    plans.set(planned.planId, { planned, root: project.root });
    if (plans.size > PLAN_CAP) {
      const oldest = plans.keys().next().value;
      if (oldest !== undefined) plans.delete(oldest);
    }
    return json(await planView(fs, project.root, planned, warnings, ANSWER_MAX));
  };
  /** An apply's files, relative to the project root. */
  const relativeApply = (root: string, r: ApplyResult): ApplyResult => ({
    filesChanged: r.filesChanged.map((f) => relativeTo(root, f)),
    filesCreated: r.filesCreated.map((f) => relativeTo(root, f)),
    filesRenamed: r.filesRenamed.map((x) => ({ from: relativeTo(root, x.from), to: relativeTo(root, x.to) })),
    filesDeleted: r.filesDeleted.map((f) => relativeTo(root, f)),
  });

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
    return planAnswer(project, await planEdit(fs, s.edit), s.warnings);
  };

  /** Plan a move (single or grouped) → a contractual plan result, or refusal. */
  const moveResult = async (project: StrapiProject, specs: MoveSpec[], configSync?: boolean): Promise<CallToolResult> => {
    const move = await planMove(fs, project, specs);
    if (!move.ok) return json({ moved: false, errors: move.errors, warnings: move.warnings });
    const s = await syncPlan(project, { textEdits: move.textEdits, fileRenames: move.fileRenames }, [...move.warnings, ...movedWarnings(project, specs)], configSync);
    return planAnswer(project, await planEdit(fs, s.edit), s.warnings);
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
      return withFreshness(engine, withRelativePaths((await inner(...a)) as CallToolResult, projectRoots()));
    }) as unknown as typeof cb;
    return server['registerTool'](name, config, fresh);
  };

  /** What a `ref` may be (shared by every tool taking one). */
  const REF_HELP =
    'A Strapi ref: a content-type or component UID (api::article.article, shared.seo), a service/controller/policy/middleware ref (plugin::users-permissions.user, global::is-owner) or a route handler (api::article.article.find); `ref#method` for one method.';

  reg(
    'server_info',
    {
      title: 'DevKit version, licence tier and which tools actually run',
      description:
        'The running DevKit server: its version (the one to name in a bug report), the licence tier, which tools really run (without a licence the Pro tools answer an upsell), the indexed roots and how current the index is (`freshness`).',
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
        "One project in full: Strapi version, TS or JS, package manager, API prefix, counts, every local and installed plugin with whether DevKit verifies refs into it (and if not, why), health and freshness. Call it to orient yourself, or when a plugin ref comes back `external`.",
      inputSchema: { ...selector },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const summary = engine.getProjects().find((s) => s.root === p.project.root);
      if (!summary) return json({ error: 'The project was re-indexed meanwhile: call project_info again.' });
      const read = (await engine.getRoutes({ root: p.project.root }))[0];
      return json(await projectInfo(fs, p.project, summary, { routes: read?.routes, unreadRoutes: read?.unread }));
    },
  );

  reg(
    'add_project',
    {
      title: 'Register a Strapi project by path',
      description:
        'Index a Strapi project from an ABSOLUTE path: its root or any file/folder inside it (a folder is also scanned downward, for monorepos). Use it when a tool returns `noProject`. Idempotent; returns the projects now known.',
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
        "Rescan every project from disk and rebuild the index. Rarely needed: each call already re-indexes what changed on disk. For a project added since startup, or edits made outside on a project whose `freshness.diskTracking` is 'off'.",
      inputSchema: {
        cold: z.boolean().optional().describe('Also read every installed plugin again, ignoring the cache (slower; default false).'),
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
      return 'result' in p ? p.result : json({ contentTypes: listContentTypes(p.project) });
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
      return 'result' in p ? p.result : json({ components: listComponents(p.project) });
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
      return 'result' in p ? p.result : json({ artifacts: listArtifacts(p.project, args.kind) });
    },
  );

  reg(
    'get_model_diagram',
    {
      title: 'Data model diagram (Mermaid)',
      description:
        "The data model as a Mermaid `erDiagram`, read from the schemas: content-types (optionally components) with their fields, one line per association with its cardinalities, media and the plugin types they link to. For a README, a doc or an issue.",
      inputSchema: {
        ...selector,
        components: z.boolean().optional().describe('Include components (default false).'),
        allPlugins: z.boolean().optional().describe('Every installed plugin type, not only those linked to (default false).'),
        media: z.boolean().optional().describe("Media fields → the upload plugin's File (default true)."),
        strapiFields: z.boolean().optional().describe('The fields Strapi adds: createdAt, updatedAt, publishedAt, createdBy/updatedBy (default false).'),
        focus: z.array(z.string()).optional().describe('Only these UIDs and the types they link to.'),
        hideCustomFields: z
          .union([z.boolean(), z.array(z.string())])
          .optional()
          .describe('Leave out custom fields: true for all, or their names (listed under `customFields` in the answer). Default: none.'),
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
        ...(args.hideCustomFields !== undefined ? { hideCustomFields: args.hideCustomFields } : {}),
      };
      const data = diagramOf(p.project);
      const d = toMermaid(data, opts);
      // The custom fields the diagram can leave out, by name (how many fields use each).
      const customFields: Record<string, number> = {};
      for (const n of data.nodes) for (const a of n.attrs) if (a.customField) customFields[a.customField] = (customFields[a.customField] ?? 0) + 1;
      return json({ format: 'mermaid', entities: d.entities, links: d.links, ...(Object.keys(customFields).length ? { customFields } : {}), mermaid: d.mermaid });
    },
  );

  reg(
    'get_schema',
    {
      title: 'Get a content-type / component schema',
      description:
        'The real attributes (fields, relations, components) of a content-type or component: use it instead of guessing field names.',
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
        'The file(s) defining a Strapi ref, tagged by kind — installed plugins included (in node_modules).',
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
        'Call this before writing a magic string: is this Strapi ref real in the project, as Strapi registers names (an API file `hasAccess.js` is `has-access`)? valid | unknown (+ didYouMean) | external: in a plugin DevKit cannot verify (project_info says why).',
      inputSchema: {
        ref: z.string().describe(REF_HELP),
        kind: z
          .enum(['content-type', 'component', 'service', 'controller', 'policy', 'middleware', 'method'])
          .optional()
          .describe('Check it as this kind only (`method`: the service/controller a handler or method call goes through).'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      return 'result' in p ? p.result : json({ ref: args.ref, ...validateRef(p.project, args.ref, args.kind) });
    },
  );

  reg(
    'find_references',
    {
      title: 'Find references to a Strapi entity',
      description:
        'Every call-site of a ref (or `ref#method`) in the project\'s own code (src/, config/, database/migrations): the total, then a page of `path:line:col [via]  snippet` lines (1-based). A UID written as a plain value counts as `[literal]`; `unresolvedCalls` are the Strapi calls whose UID DevKit cannot read, which may reach it too.',
      inputSchema: {
        ref: z.string().optional().describe(REF_HELP),
        refs: z.array(z.string()).optional().describe('Several refs at once.'),
        compact: z.boolean().optional().describe('One line per hit (default true); false for full objects.'),
        limit: z.number().int().positive().optional().describe('Max references per ref (default 50).'),
        offset: z.number().int().nonnegative().optional().describe('Skip this many (pagination).'),
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
        const kinds: Array<TargetKind | 'method'> = ref.includes('#') ? ['method'] : resolveRef(p.project, ref).map((t) => t.kind);
        const unresolved = unresolvedNote(p.project, kinds, [ref]);
        return {
          ref,
          total: all.length,
          offset,
          limit,
          truncated: offset + page.length < all.length,
          references: args.compact === false ? page : page.map(compactRef),
          ...(unresolved ? { unresolvedCalls: unresolved } : {}),
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
        "The HTTP route table — the project's routes, createCoreRouter's auto-CRUD and the plugins' (`origin`) — with method, mounted `fullPath`, handler, policies, middlewares, auth and where each is declared. With `pipeline: true`: what a request goes through, in Strapi's order, each step's status (`not-found-by-strapi`: Strapi throws at startup). Use it to explain a 401/403 or a startup error about a policy or middleware.",
      inputSchema: {
        ...selector,
        plugins: z.boolean().optional().describe("Include the plugins' routes (default true)."),
        admin: z.boolean().optional().describe('Include admin-panel routes (default false).'),
        method: z.string().optional().describe('Only this HTTP method.'),
        path: z.string().optional().describe('Only routes matching this pattern, a part of it, or a concrete URL (`/api/articles/12`).'),
        handler: z.string().optional().describe('Only handlers containing this (`api::article.article.find`).'),
        pipeline: z.boolean().optional().describe(`Add each route's pipeline (needs method, path or handler; at most ${PIPELINE_MAX} routes).`),
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const read = (await engine.getRoutes({ ...(args.plugins !== undefined ? { plugins: args.plugins } : {}), admin: args.admin ?? false, root: p.project.root }))[0];
      const all = read?.routes ?? [];
      // Local plugins whose routes DevKit couldn't read: said apart, the table keeps its shape.
      const answer = (data: unknown): CallToolResult => withUnreadRoutes(json(data), read?.unread ?? []);
      const routes = all.filter(
        (r: RouteInfo) =>
          (!args.method || r.method.toUpperCase().split(/[|,]/).includes(args.method.toUpperCase())) &&
          (!args.path || pathMatches(r.fullPath ?? r.path, args.path) || pathMatches(r.path, args.path)) &&
          (!args.handler || qualifiedHandler(r).includes(args.handler)),
      );
      if (!args.pipeline) return answer({ routes });
      if (!args.method && !args.path && !args.handler) {
        return answer({ error: 'pipeline needs a filter: pass `method`, `path` or `handler` to narrow the routes first.', routes: routes.length });
      }
      if (routes.length > PIPELINE_MAX) {
        return answer({ error: `${routes.length} routes match: narrow the filter to at most ${PIPELINE_MAX} for the pipeline.`, routes: routes.map((r) => `${r.method} ${r.fullPath ?? r.path}`) });
      }
      const global = await engine.getGlobalMiddlewares(p.project.root);
      // The users-permissions roles in config/sync: who may call each route once they are imported.
      const synced = (await configSyncStatus(fs, p.project))?.files ?? [];
      const withAccess = (r: RouteInfo, s: PipelineStep): PipelineStep & { syncedRoles?: unknown } => {
        const access = s.phase === 'auth' ? routeAccessForRoute(r, synced) : undefined;
        return access ? { ...s, syncedRoles: { action: access.action, allowed: access.allowed, denied: access.denied, note: 'According to the config/sync role files: the database may differ until they are imported.' } } : s;
      };
      /** A step as answered: no `phase` in the global stack, no `declaredAt` when it is the route's own declaration. */
      const detail = (s: PipelineStep & { syncedRoles?: unknown }, r?: RouteInfo): Record<string, unknown> => {
        const out: Record<string, unknown> = { ...s };
        if (!r) delete out.phase;
        if (r && s.declaredAt?.filePath === r.filePath && s.declaredAt?.offset === r.offset) delete out.declaredAt;
        return out;
      };
      const piped = routes.map((r) => ({ ...r, pipeline: routePipeline(p.project, r, global).steps.filter((s) => s.phase !== 'global-middleware').map((s) => detail(withAccess(r, s), r)) }));
      // The global stack in Strapi's order: a middleware Strapi finds is its name (`file` says
      // where the stack is written); any other comes with its detail.
      const stack = routes[0]
        ? routePipeline(p.project, routes[0], global)
            .steps.filter((s) => s.phase === 'global-middleware')
            .map((s) => (s.status === 'ok' ? s.name : detail(s)))
        : [];
      return answer({ globalMiddlewares: { status: global.status, file: global.file, envFiles: global.envFiles, steps: stack }, routes: piped });
    },
  );

  reg(
    'list_unused',
    {
      title: 'Find unused Strapi entities/methods',
      description:
        "Definitions no Strapi ref reaches: methods, content-types, components, services, policies, middlewares. Only Strapi refs count, so a method called directly in TS still appears — verify before deleting. `onlyArchivedCallers`: only called by migrations Strapi never runs; `requiredByPath`: its file is loaded by path, so the module is used.",
      inputSchema: {
        file: z.string().optional().describe('Only this file, absolute or relative to the project root (default: the whole app).'),
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
      if ('result' in p) return p.result;
      const all = listUnused(p.project, { kinds: args.kinds, file: args.file === undefined ? undefined : underRoot(p.project.root, args.file) });
      const unresolved = all.length ? unresolvedNote(p.project, [...new Set(all.map((u) => (u.kind === 'method' ? 'method' : u.kind)))], all.map((u) => u.ref)) : undefined;
      // Within one answer: each item names a few files (and how many), and when the list
      // still doesn't fit, the first items — said, with how to narrow it.
      const brief = all.map((u) => {
        const out: Record<string, unknown> = { ...u };
        for (const k of ['onlyArchivedCallers', 'requiredByPath'] as const) {
          const files = u[k];
          if (files && files.length > UNUSED_FILES_SHOWN) {
            out[k] = files.slice(0, UNUSED_FILES_SHOWN);
            out[`${k}Total`] = files.length;
          }
        }
        return out;
      });
      const unused: unknown[] = [];
      let used = sizeOf(unresolved ?? {}) + 400;
      for (const u of brief) {
        used += sizeOf(u);
        if (used > ANSWER_MAX) break;
        unused.push(u);
      }
      const shortened = unused.length < brief.length ? { shortened: `${unused.length} of ${brief.length} listed, to fit one answer: pass \`file\` or \`kinds\` to narrow.` } : {};
      return json({ unused, ...shortened, ...(unresolved ? { unresolvedCalls: unresolved } : {}) });
    },
  );

  reg(
    'coverage',
    {
      title: 'List indexed call forms',
      description:
        'The Strapi call forms DevKit indexes (`via` tag + example) and those it does not (`indexed: false`): whether find_references/list_unused can be trusted for a pattern.',
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
        'Magic strings that point at nothing (refs into plugins DevKit cannot verify are skipped). After apply_edits, it should return none.',
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
        ...(b.methods ? { methods: b.methods.map((m) => ({ name: m.name, locations: m.locations.map(compactRef) })) } : {}),
      }));
      return json({ broken });
    },
  );

  reg(
    'config_sync_status',
    {
      title: 'config-sync: its options and the files of its sync directory',
      description:
        "strapi-plugin-config-sync, from the files only (no database): its version, its options and where each comes from (the warnings say which default exclusions a short `excludedConfig` drops), the sync directory and its files by status — `ok`, `excluded`, `invalid` (not JSON), or of a type not registered here.",
      inputSchema: {
        key: z.string().max(400).optional().describe('One file\'s content, by `<type>.<name>` (user-role.public).'),
        files: z.boolean().optional().describe('List every file with a readable name and status (default: counts).'),
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
          ...(entry.content === undefined ? {} : sizeOf(entry.content) <= ANSWER_MAX ? { content: entry.content } : { content: `Not included: ${sizeOf(entry.content)} characters, too many for one answer — read the file itself.` }),
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
  const runConfigSync = async <T>(
    args: { from?: string; project?: string },
    run: (root: string) => Promise<RuntimeResult<T>>,
    ok: (r: RuntimeSuccess<T>, project: StrapiProject, status: ConfigSyncStaticStatus) => CallToolResult | Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
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
    return r.ok ? ok(r, p.project, status) : runtimeFailure(r);
  };
  const entryLabel = (project: StrapiProject, key: string): string => {
    const dot = key.indexOf('.');
    return configSyncLabel(project, key.slice(0, dot), key.slice(dot + 1)).label;
  };
  /**
   * The entries that differ, within one answer's size (a first diff on an empty database can
   * be hundreds): when they don't fit, the first ones with one line of summary, and how many
   * of each type there are — said so.
   */
  const entryList = (
    project: StrapiProject,
    entries: ConfigSyncDbEntry[],
    directions?: Map<string, EntryDirection>,
  ): { entries: unknown[]; shortened?: string; byType?: Record<string, number> } => {
    const full = entries.map((e) => {
      const d = directions?.get(e.key);
      return { key: e.key, label: entryLabel(project, e.key), state: e.state, ...(d ? { likelyDirection: d.likelyDirection, why: d.why } : {}), summary: e.summary };
    });
    if (sizeOf(full) <= ANSWER_MAX) return { entries: full };
    const byType: Record<string, number> = {};
    for (const e of entries) {
      const type = e.key.slice(0, e.key.indexOf('.'));
      byType[type] = (byType[type] ?? 0) + 1;
    }
    const out: unknown[] = [];
    let used = sizeOf(byType) + 400;
    for (const e of full) {
      const short = { ...e, summary: e.summary.slice(0, 1) };
      used += sizeOf(short);
      if (used > ANSWER_MAX) break;
      out.push(short);
    }
    return {
      entries: out,
      shortened: `${out.length} of ${entries.length} listed, with the first line of their summary, to fit one answer: config_sync_diff with \`type\` lists one type, with \`key\` one entry and every difference.`,
      byType,
    };
  };
  const RUNS_PROJECT =
    "It loads the project's Strapi the way config-sync's CLI does, which writes to the database as a `strapi develop` start does (schema sync, migrations): a local development database only — a remote one, or a Strapi 4 database under Strapi 5 code, is refused first.";
  const envArg = z.string().max(40).optional().describe('NODE_ENV for the run (default development).');

  reg(
    'config_sync_diff',
    {
      title: 'config-sync: the real diff between config/sync and the database',
      description: `The diff config-sync's admin page shows, from the real plugin: each entry that differs between config/sync and the database (\`different\`, \`only-in-db\`, \`only-in-sync-dir\`), what differs in a few words, and its \`likelyDirection\` (import | export | unknown) from the file's git history. It includes what a Strapi start changes by itself: after changing a schema, a controller or a route, export those entries and commit them with the code. ${RUNS_PROJECT} A few seconds.`,
      inputSchema: {
        key: z.string().max(400).optional().describe('One entry, `<type>.<name>`: every difference, and both sides when they fit.'),
        type: z.string().max(200).optional().describe('Only one type (`admin-role`, `user-role`, `core-store`…).'),
        env: envArg,
        ...selector,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) =>
      runConfigSync(
        args,
        (root) => configSyncDiff(root, runtimeOptions(args)),
        async (r, project, status) => {
          // Which way each difference goes, from the files' git history (never fails the diff).
          const directions = await Promise.resolve()
            .then(() => configSyncDirections(project.root, status.detection.syncDirPath, args.key ? r.data.entries.filter((e) => e.key === args.key) : r.data.entries))
            .catch(() => undefined);
          if (args.key) {
            const e = r.data.entries.find((x) => x.key === args.key);
            // The warnings too: a once-per-session one (the Node version) would be lost otherwise.
            const warned = r.warnings.length ? { warnings: r.warnings } : {};
            if (!e) return json({ key: args.key, state: 'same', message: 'config/sync and the database agree on this entry (or it exists in neither).', target: r.target, ...warned });
            // An admin role's permissions can be thousands of lines: every difference fits
            // (or says it doesn't), the two sides only when they fit too.
            const fit = fitLines(e.differences ?? e.summary, DIFFERENCES_MAX);
            const path = status.files.find((f) => f.key === e.key)?.path;
            const sides = sizeOf({ file: e.file, db: e.db });
            const direction = directions?.get(e.key);
            return json({
              key: e.key,
              label: entryLabel(project, e.key),
              state: e.state,
              ...(direction ?? {}),
              differences: fit.lines,
              ...(path ? { path } : {}),
              ...(sides + sizeOf(fit.lines) <= ANSWER_MAX
                ? { file: e.file, db: e.db }
                : { sides: `Not included: the two sides are ${sides} characters, too many for one answer. ${fit.complete ? 'The differences above are all of them' : 'The differences above are the first ones'}${path ? `; the file side is ${path}` : ''}.` }),
              target: r.target,
              ...warned,
            });
          }
          return json({
            target: r.target,
            versions: r.versions,
            ms: r.timings.total,
            ...((entries) => ({ differences: entries.length, ...entryList(project, entries, directions) }))(args.type ? r.data.entries.filter((e) => e.key.startsWith(`${args.type}.`)) : r.data.entries),
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
      ...(({ entries, ...rest }) => ({ stillDifferent: entries, ...rest }))(entryList(project, r.data.entries)),
      target: r.target,
      ...(r.warnings.length ? { warnings: r.warnings } : {}),
    });

  reg(
    'config_sync_export',
    {
      title: 'config-sync: export entries from the database into config/sync',
      description: `Write entries from the database into config/sync with the plugin's own export, in the exact form config-sync compares. Only entries that differ; one only in config/sync has its file deleted. Commit the files with the code that caused them. ${RUNS_PROJECT}`,
      inputSchema: { keys: z.array(z.string().max(400)).max(500).optional().describe('The entries to export (default: every difference).'), env: envArg, ...selector },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async (args) => runConfigSync(args, (root) => configSyncExport(root, args.keys, runtimeOptions(args)), writeResult),
  );

  reg(
    'config_sync_import',
    {
      title: 'config-sync: import entries from config/sync into the database',
      description: `Apply config/sync entries to the database with the plugin's own import (a role, a content-manager view, a setting). \`keys\` is required, never everything; an entry only in the database is deleted from it. The entries still different afterwards are exported back (\`reexport\`), so the diff converges. Refused with NODE_ENV=production. ${RUNS_PROJECT}`,
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
        "Where a content-type's relation fields are used by name in queries (populate, filters, where), nested levels included. Before retargeting or removing a relation.",
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
        'Refs matching a glob (`plugin::billing.*`, `api::*`, `*`; only `*` is special), each with the kinds it resolves to.',
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
        'The refs `ref` uses: relations in its schema, services/controllers it calls…',
      inputSchema: {
        ref: z.string().describe(REF_HELP),
        transitive: z.boolean().optional().describe('Follow the chain (default false).'),
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
        'The refs that use `ref`: what would break if it moved or changed.',
      inputSchema: {
        ref: z.string().describe(REF_HELP),
        transitive: z.boolean().optional().describe('Follow the chain (default false).'),
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
        'Plan renaming a service/controller method: its declaration, every call-site and, for a controller, the route handlers. Writes nothing: review the plan, then `apply_edits` its `planId`.',
      inputSchema: {
        ref: z.string().describe('The service/controller ref (api::page.notifier).'),
        method: z.string().describe('The current method name.'),
        newName: z.string().describe('The new method name.'),
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
      return planAnswer(p.project, await planEdit(fs, s.edit), s.warnings);
    },
  );

  reg(
    'plan_rename_entity',
    {
      title: 'Plan an entity rename (dry-run)',
      description:
        'Plan renaming a content-type, component, service, controller, policy or middleware: every call-site and route handler, and the files. The `warnings` list the UIDs Strapi also stores in the database, which the plan does not migrate. Writes nothing: review, then `apply_edits` its `planId`.',
      inputSchema: {
        ref: z.string().describe('The UID or ref (api::product.product, shared.seo).'),
        newName: z.string().describe("The new last segment: item makes api::product.product api::product.item."),
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
      return planAnswer(p.project, await planEdit(fs, s.edit), s.warnings);
    },
  );

  reg(
    'plan_move',
    {
      title: 'Plan moving an artifact or content-type to another namespace (dry-run)',
      description:
        'Plan moving a service/controller/policy/middleware, or a content-type with its whole resource (service, controller, routes; relation targets repointed), to another namespace: every call-site rewritten, the files relocated. Refused whole if unsafe. Writes nothing: review, then `apply_edits`.',
      inputSchema: {
        ref: z.string().describe('An artifact ref (plugin::src.helper) or a content-type UID.'),
        toNamespace: z.string().describe('plugin::dst or api::foo.'),
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
        'plan_move for several refs to one namespace, in one plan, so the refs between them stay right. Refused whole if any is unsafe.',
      inputSchema: {
        refs: z.array(z.string()).describe('The refs to move together.'),
        toNamespace: z.string().describe('plugin::dst or api::foo.'),
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
        'Plan a new local plugin (package.json and a strapi-server.js that registers its folders) and its entry in `config/plugins` (else a warning says what to add). Writes nothing: review, then `apply_edits`.',
      inputSchema: {
        name: z.string().describe('Plugin name, kebab-case.'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      const scaffold = await planCreatePlugin(fs, p.project, args.name);
      if (!scaffold.ok) return json({ created: false, errors: scaffold.errors });
      return planAnswer(p.project, await planEdit(fs, { textEdits: scaffold.textEdits, fileRenames: [], fileCreates: scaffold.fileCreates }), scaffold.warnings);
    },
  );

  reg(
    'extract_to_plugin',
    {
      title: 'Extract artifacts into a new plugin (dry-run)',
      description:
        'create_plugin and plan_move in one plan: a new local plugin, and these services/controllers/policies/middlewares moved into it. Refused whole if unsafe.',
      inputSchema: {
        refs: z.array(z.string()).describe('The refs to move into it.'),
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
        // The scaffolded loader registers content-types and routes by folder.
        { allowNewNamespace: true, destinationLoadsFolders: true },
      );
      const warnings = [
        ...scaffold.warnings,
        ...move.warnings,
        ...(move.ok ? movedWarnings(p.project, args.refs.map((ref) => ({ ref, toNamespace: `plugin::${args.name}` }))) : []),
      ];
      if (!move.ok) return json({ extracted: false, errors: move.errors, warnings });
      const s = await syncPlan(p.project, { textEdits: [...scaffold.textEdits, ...move.textEdits], fileRenames: move.fileRenames, fileCreates: scaffold.fileCreates }, warnings, args.configSync);
      return planAnswer(p.project, await planEdit(fs, s.edit), s.warnings);
    },
  );

  // Schema helpers are dry-runs (return a plan, write nothing) → `plan_` prefix so
  // the permission classifier treats them like the other planners (only apply_edits writes).
  reg(
    'plan_change_relation',
    {
      title: 'Plan retargeting a relation field (dry-run)',
      description:
        "Plan changing the `target` of a content-type's relation field in schema.json. Refused if the field isn't a relation or the target is unknown; warns about a bidirectional relation's orphaned inverse. Writes nothing: review, then `apply_edits`.",
      inputSchema: {
        uid: z.string().describe('The content-type UID.'),
        field: z.string().describe('The relation field.'),
        newTarget: z.string().describe('The new target content-type UID.'),
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      return schemaResult(p.project, await planChangeRelation(fs, p.project, args.uid, args.field, args.newTarget), 'changed');
    },
  );

  reg(
    'plan_rename_attribute',
    {
      title: 'Plan a content-type attribute rename — schema + relation query-keys only (dry-run)',
      description:
        'Plan renaming an attribute in schema.json and, for a relation, its populate/filters usages. NOT a complete field rename: object access (`entity.field`, `data: { field }`, destructuring) is not rewritten — the warnings say to review it by hand. Writes nothing: review, then `apply_edits`.',
      inputSchema: {
        uid: z.string().describe('The content-type UID.'),
        oldName: z.string().describe('Current attribute name.'),
        newName: z.string().describe('New attribute name.'),
        ...configSyncArg,
        ...selector,
      },
    },
    async (args) => {
      await ready;
      await engine.whenReferencesReady();
      const p = pick(engine, args, roots());
      if ('result' in p) return p.result;
      return schemaResult(p.project, await planRenameAttribute(fs, p.project, args.uid, args.oldName, args.newName), 'renamed', args.configSync);
    },
  );

  reg(
    'apply_edits',
    {
      title: 'Apply a reviewed plan to disk (contractual)',
      description:
        '⚠️ Writes files: applies exactly the reviewed plan (plan_*, create_plugin, extract_to_plugin) by its `planId`. If a file it touches changed since, nothing is written.',
      inputSchema: {
        planId: z.string().describe('The planId from a plan_* result.'),
      },
    },
    async (args) =>
      withApplyLock(async () => {
        await ready;
        const held = plans.get(args.planId);
        if (!held) {
          return json({
            applied: false,
            reason: `Unknown planId \`${args.planId}\` — it was not produced this session (or was already applied). Re-run a plan_* tool to get a fresh plan.`,
          });
        }
        const { planned, root } = held;
        const check = await verifyFingerprints(fs, planned.fingerprints);
        if (!check.ok) {
          return json({
            applied: false,
            reason: 'The plan is stale — files changed on disk since it was computed. Re-run the plan and review again.',
            root,
            changed: check.changed.map((f) => relativeTo(root, f)),
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
        return json({ applied: true, root, ...relativeApply(root, result), verify: await verifyAfterApply(changed) });
      }),
  );

  reg(
    'apply_rename',
    {
      title: 'Rename a Strapi entity or method (writes files)',
      description:
        '⚠️ Writes files: plan_rename_* and apply_edits in one call, without review. Prefer those two to review first.',
      inputSchema: {
        ref: z.string().describe(REF_HELP),
        newName: z.string().describe("The new method name, or the UID's new last segment."),
        method: z.string().optional().describe('The method to rename; omit to rename the entity.'),
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
        return json({ applied: true, root: p.project.root, ...relativeApply(p.project.root, result), verify: await verifyAfterApply(changed), ...(dbWarnings.length ? { warnings: dbWarnings } : {}) });
      }),
  );
}
