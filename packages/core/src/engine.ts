import { analyzeAt } from './analyze/callSite';
import { analyzeApiMemberAt } from './analyze/apiMember';
import { analyzeMemberAt } from './analyze/member';
import { analyzeMemberCompletionAt } from './analyze/memberCompletion';
import { complete as completeRefs, completeMembers } from './complete/completion';
import { type FileSystem, FileType } from './fs/FileSystem';
import { basename, dirname, isPathInside, join, normalize } from './fs/paths';
import { describeApiMemberHover, describeHover, describeMemberHover } from './hover/hover';
import { buildIndex, refreshCodeContentTypes, updateIndexForFile } from './index/indexer';
import type {
  CodeLensEntry,
  CompletionResult,
  DiagnosticEntry,
  HoverInfo,
  OutlineComponentUse,
  OutlineIssue,
  OutlineProject,
  OutlineRelation,
  ProjectSummary,
  ReferenceLocation,
  RouteInfo,
  StrapiProject,
  TargetLocation,
} from './model/types';
import { type ListRoutesOptions, readRoutes, type UnreadPluginRoutes } from './index/routes';
import { type GlobalMiddlewares, readGlobalMiddlewares } from './index/globalMiddlewares';
import { modelOf } from './query/model';
import { buildModelMaps, contentTypeInsights, type ModelMaps } from './reference/insights';
import {
  buildReferenceIndex,
  canonicalKey,
  definitionsInFile,
  removeReferencesForFile,
  resyncWeakLiterals,
  updateReferencesForFile,
} from './reference/references';
import { resolveDefinition, resolveMember } from './resolve/resolver';
import { findPackageDir, forgetPluginReads, readInstalledPlugins } from './plugins/installed';
import { applyRewrites, clearInstalled, installedStamp, mergeInstalled } from './plugins/merge';
import { forgetFileScans, inRewriteScope, type ProjectRewrites, rewritesKey, rewritesOfFile, scanProjectRewrites, unionRewrites } from './plugins/rewrites';
import { diffSnapshots, extendSnapshot, takeSourceSnapshot } from './workspace/sourceSnapshot';
import { matchesAnyGlob } from './util/glob';
import { withTimeout } from './util/timeout';
import { asRecord, asString, safeParse } from './util/json';
import { validateDocument } from './validate/validator';
import { discoverProjectRoots, findStrapiRootUp, isStrapiPackageJson, isStrapiPluginPackageJson } from './workspace/discovery';
import { detectVersion, unsupportedVersion } from './workspace/version';

export interface StrapiEngine {
  /**
   * Discover projects in the given workspace folders and build their indexes.
   * Installed plugins (node_modules) are read in the background; by default this
   * waits for them too — `waitForInstalled: false` returns as soon as the
   * project code is indexed (refs into plugins stay silent until they land).
   */
  init(workspaceFolders: string[], options?: { waitForInstalled?: boolean }): Promise<void>;
  /** Resolves once the installed plugins of every project have been read (see {@link init}). */
  whenInstalledReady(): Promise<void>;
  /** Re-discover and re-index everything; `cold` also drops the cached plugin reads (everything is read again). */
  rescan(options?: { cold?: boolean }): Promise<void>;
  /**
   * Register an additional search root on demand from any path (a file → walk up
   * to its Strapi project; a directory → scan down for projects) and index what
   * is found, keeping previously discovered projects. Idempotent. Returns the
   * projects now known. Lets a client locate a project with no startup config.
   */
  addRoot(path: string): Promise<ProjectSummary[]>;
  /** Glob patterns; a discovered project whose path matches any is ignored. Takes effect on the next rescan. */
  setExcludes(globs: string[]): void;
  getProjects(): ProjectSummary[];
  /** Every discovered project (full handles), for ref-keyed queries (MCP/LSP). */
  allProjects(): StrapiProject[];
  /** The Strapi project that owns a file (deepest-prefix match), if any. */
  projectForFile(filePath: string): StrapiProject | undefined;
  /** Incremental update from watcher events. */
  onFilesChanged(changed: string[], deleted: string[]): Promise<void>;
  /**
   * Whether a project, or a file the index was built from, lies under `dir`: a deleted
   * folder is reported alone, not the files it held, and is then re-read as a whole.
   */
  indexesUnder(dir: string): boolean;
  getDefinitions(filePath: string, offset: number, sourceText: string): Promise<TargetLocation[]>;
  /**
   * Source range of the whole magic string / member call under the cursor, so a
   * client can highlight it as one link instead of letting the editor split it
   * on word separators (`-`, `.`, `:`) — e.g. `api::analyse.analyse-individuel`.
   */
  getReferenceRange(
    filePath: string,
    offset: number,
    sourceText: string,
  ): { start: number; end: number } | undefined;
  getHover(filePath: string, offset: number, sourceText: string): Promise<HoverInfo | undefined>;
  getCompletions(filePath: string, offset: number, sourceText: string): Promise<CompletionResult>;
  validateFile(filePath: string, sourceText: string): Promise<DiagnosticEntry[]>;
  /** All call-sites referencing the entity under the cursor (or in the file's definition). */
  getReferences(filePath: string, offset: number, sourceText: string): Promise<ReferenceLocation[]>;
  /** "N references" lenses for the definitions declared in a file. */
  getCodeLenses(filePath: string, sourceText: string): Promise<CodeLensEntry[]>;
  /** The whole Strapi model of every discovered project (for the Model Explorer tree). */
  getModel(): OutlineProject[];
  /** Register a callback fired when the background reference index updates. */
  onReferencesChanged(listener: () => void): void;
  /** Resolves once the background reference index has finished building. */
  whenReferencesReady(): Promise<void>;
  /**
   * Re-read installed plugins of any project whose install fingerprint changed
   * (package.json, lockfiles, node_modules install markers, plugins config).
   * Throttled; called by every query, so an `npm install` is picked up without
   * a watcher on node_modules.
   */
  refreshInstalledIfStale(): Promise<void>;
  /**
   * {@link refreshInstalledIfStale}, plus — for clients without a file watcher
   * (`createEngine(fs, { trackDiskChanges: true })`) — re-index the project files
   * created, edited or deleted on disk since the last check. Throttled.
   */
  refreshIfStale(): Promise<void>;
  /**
   * Every project's HTTP routes (see `listRoutes`), for the editor's Routes view.
   * Cached per project until a route-relevant file changes (routes, content-types,
   * plugins, config) or installed plugins are re-read; the arrays are shared: read-only.
   * `unread`: the local plugins whose routes DevKit couldn't read whole.
   */
  getRoutes(opts?: ListRoutesOptions & { root?: string }): Promise<Array<{ root: string; routes: RouteInfo[]; unread: UnreadPluginRoutes[] }>>;
  /** A project's `config/middlewares` stack (cached like {@link getRoutes}). */
  getGlobalMiddlewares(root: string): Promise<GlobalMiddlewares>;
}

/** Minimum delay between two installed-plugin freshness checks (fast / full fingerprint). */
const INSTALLED_CHECK_MS = 3_000;
const INSTALLED_FULL_CHECK_MS = 60_000;
/** Hard ceiling on one project's installed-plugin read (the reader's own budgets are lower). */
const INSTALLED_READ_TIMEOUT_MS = 30_000;
/** Hard ceiling on the project-code rewrite scan; past it, every plugin counts as rewritten. */
const REWRITE_SCAN_TIMEOUT_MS = 20_000;
/**
 * The disk check runs before every query; a slow one (a huge project) is spaced
 * out to 10× its duration, never more than this.
 */
const DISK_CHECK_MAX_INTERVAL_MS = 2_000;
const DISK_CHECK_SLOW_MS = 50;
/** A full fingerprint that never matches: the next full check re-reads the plugins. */
const UNSETTLED = 'unsettled';

/** The project's own code rewrites (src/**, local plugins) — bounded; on timeout, anything may be rewritten. */
function scanRewrites(fs: FileSystem, root: string): Promise<ProjectRewrites> {
  return withTimeout(scanProjectRewrites(fs, root), REWRITE_SCAN_TIMEOUT_MS, { files: new Map(), dirs: [join(root, 'src')], truncated: true });
}

/** Paths whose change can alter the installed-plugin picture of their project. */
/** True when editing `p` can change the project's route table or middleware stack. */
function affectsRoutes(project: StrapiProject, p: string): boolean {
  const src = normalize(project.srcDir) + '/';
  if (p.startsWith(src)) {
    const rel = p.slice(src.length);
    return /^api\/[^/]+\/(routes|content-types)\//.test(rel) || rel.startsWith('plugins/') || rel.startsWith('extensions/');
  }
  return p.startsWith(normalize(project.root) + '/config/');
}

function affectsInstalledPlugins(p: string): boolean {
  return (
    /\/config\/(plugins|api)\.[cm]?[jt]s$/.test(p) ||
    /\/config\/env\/[^/]+\/plugins\.[cm]?[jt]s$/.test(p) ||
    /\/src\/extensions\/[^/]+\/strapi-server\.[cm]?[jt]s$/.test(p) ||
    /\/(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|npm-shrinkwrap\.json)$/.test(p)
  );
}

class Engine implements StrapiEngine {
  private projects: StrapiProject[] = [];
  private folders: string[] = [];
  /** Glob patterns; discovered project roots matching any are dropped. */
  private excludes: string[] = [];
  /** Serializes mutating operations (rescan / onFilesChanged) to avoid races. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Bumped on each rescan; a background reference build aborts if superseded. */
  private rescanToken = 0;
  /** True while the reference index is being built in the background. */
  private buildingRefs = false;
  /** Files changed during a background build, re-applied once it finishes. */
  private dirtyDuringBuild = new Set<string>();
  private referencesListener?: () => void;
  /** Resolves when the in-flight background reference build finishes. */
  private refsBuild: Promise<void> = Promise.resolve();
  private lastInstalledCheck = 0;
  private lastFullCheck = Date.now();
  private installedCheck: Promise<void> | undefined;
  /** The background read of installed plugins started by the last rescan. */
  private installedLoad: Promise<void> = Promise.resolve();
  private loadingInstalled = false;
  /** Paths changed while installed plugins were loading, replayed once they land. */
  private dirtyDuringLoad = { changed: new Set<string>(), deleted: new Set<string>() };
  private lastDiskCheck = 0;
  private diskCheckInterval = 0;
  private diskCheck: Promise<void> | undefined;
  /** The token of the installed-plugin load in flight (see loadInstalledInBackground). */
  private loadToken = 0;
  /** Every route of a project (admin and plugins included), until a route-relevant change. */
  private routeCache = new WeakMap<StrapiProject, Promise<{ routes: RouteInfo[]; unread: UnreadPluginRoutes[] }>>();
  private globalMwCache = new WeakMap<StrapiProject, Promise<GlobalMiddlewares>>();

  constructor(
    private readonly fs: FileSystem,
    /** No file watcher: compare the project files with the disk on queries (see refreshIfStale). */
    private readonly trackDiskChanges = false,
  ) {}

  onReferencesChanged(listener: () => void): void {
    this.referencesListener = listener;
  }

  whenReferencesReady(): Promise<void> {
    return this.refsBuild;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async init(folders: string[], options?: { waitForInstalled?: boolean }): Promise<void> {
    this.folders = folders.map(normalize);
    await this.rescan();
    if (options?.waitForInstalled !== false) await this.installedLoad;
  }

  whenInstalledReady(): Promise<void> {
    return this.installedLoad;
  }

  rescan(options?: { cold?: boolean }): Promise<void> {
    if (options?.cold) {
      forgetPluginReads(this.fs);
      forgetFileScans(this.fs);
    }
    return this.serialize(() => this.rescanImpl());
  }

  setExcludes(globs: string[]): void {
    this.excludes = globs;
  }

  async addRoot(path: string): Promise<ProjectSummary[]> {
    const p = normalize(path);
    // Already covered by a discovered project? Idempotent no-op — unless it is an app of its
    // own the discovery passed over (in a folder git ignores, inside a plugin's repository).
    if (this.projects.some((pr) => isPathInside(pr.root, p)) && !(await this.isUndiscoveredApp(p))) return this.getProjects();

    const stat = await this.fs.stat(p);
    const startDir = stat?.type === FileType.Directory ? p : dirname(p);
    const folders = new Set(this.folders);
    // A file (or a path inside a project) → climb to the project root.
    const up = await findStrapiRootUp(this.fs, startDir);
    if (up) folders.add(up);
    // A directory may itself be (or contain) project(s) → also scan down from it.
    if (stat?.type === FileType.Directory) folders.add(p);

    if (folders.size !== this.folders.length) {
      this.folders = [...folders];
      await this.rescan();
    }
    return this.getProjects();
  }

  private async rescanImpl(): Promise<void> {
    const token = ++this.rescanToken;
    const discovered = await discoverProjectRoots(this.fs, this.folders);
    const roots = this.excludes.length
      ? discovered.filter((r) => !matchesAnyGlob(r, this.excludes))
      : discovered;
    const projects: StrapiProject[] = [];
    for (const root of roots) {
      const project = await this.loadProject(root);
      if (project) projects.push(project);
    }
    // Longest root first so projectForFile() finds the deepest owner.
    projects.sort((a, b) => b.root.length - a.root.length);
    this.projects = projects;
    // Installed plugins and the reference index are read off the critical path (do not block "ready").
    this.installedLoad = this.loadInstalledInBackground(token);
    this.refsBuild = this.buildReferencesInBackground(token);
  }

  /**
   * Read every project's installed plugins (and the project code that rewrites
   * plugins), swapping each into its index as it lands. Until then the project's
   * plugin refs are unverifiable (silent), never wrongly reported.
   */
  private async loadInstalledInBackground(token: number): Promise<void> {
    this.loadToken = token;
    this.loadingInstalled = true;
    this.dirtyDuringLoad = { changed: new Set(), deleted: new Set() };
    try {
      for (const project of this.projects) {
        if (token !== this.rescanToken) return;
        try {
          await this.reloadInstalled(project);
          // Edited while it was being read (a rewrite in src, a config, an extension, a lockfile)?
          // Read it again (unchanged plugins come from the cache) before anyone is told.
          const dirty = [...this.dirtyDuringLoad.changed, ...this.dirtyDuringLoad.deleted];
          const affects = (p: string): boolean =>
            (affectsInstalledPlugins(p) && this.projectForFile(p) === project) || (!!project.rewrites && inRewriteScope(project.rewrites, p));
          if (dirty.some(affects)) await this.reloadInstalled(project);
        } catch {
          /* stays unverifiable */
        }
        if (token !== this.rescanToken) return;
        this.referencesListener?.();
      }
    } finally {
      // The latest load resets the flag even when a newer rescan failed before starting its own.
      if (token === this.loadToken) {
        this.loadingInstalled = false;
        const { changed, deleted } = this.dirtyDuringLoad;
        this.dirtyDuringLoad = { changed: new Set(), deleted: new Set() };
        // Edits made while loading: re-apply them on the loaded state, then tell the client.
        if (token === this.rescanToken && (changed.size || deleted.size)) {
          await this.onFilesChanged([...changed], [...deleted]);
          this.referencesListener?.();
        }
      }
    }
  }

  private async buildReferencesInBackground(token: number): Promise<void> {
    this.buildingRefs = true;
    this.dirtyDuringBuild.clear();
    try {
      for (const project of this.projects) {
        if (token !== this.rescanToken) return; // superseded by a newer rescan
        try {
          project.references = await buildReferenceIndex(this.fs, project);
        } catch {
          /* keep empty references for this project */
        }
        if (token !== this.rescanToken) return;
        this.referencesListener?.();
      }
      // Re-apply files that changed while the build was running.
      for (const f of this.dirtyDuringBuild) {
        if (token !== this.rescanToken) return;
        const project = this.projectForFile(f);
        if (!project) continue;
        try {
          updateReferencesForFile(project, f, await this.fs.readFile(f));
        } catch {
          removeReferencesForFile(project.references, f, project);
        }
      }
      if (this.dirtyDuringBuild.size) {
        for (const project of this.projects) resyncWeakLiterals(project);
        this.referencesListener?.();
      }
    } finally {
      if (token === this.rescanToken) this.buildingRefs = false;
    }
  }

  private async loadProject(root: string): Promise<StrapiProject | undefined> {
    let pkg: unknown;
    try {
      pkg = safeParse(await this.fs.readFile(join(root, 'package.json')));
    } catch {
      return undefined;
    }
    if (!asRecord(pkg)) return undefined;
    const { version, signals } = detectVersion(pkg);
    const srcDir = join(root, 'src');
    // Taken BEFORE indexing: a file edited meanwhile shows up as changed at the next check.
    const snapshot = this.trackDiskChanges ? await takeSourceSnapshot(this.fs, this.snapshotDirs({ srcDir, root }), [join(root, 'package.json')]) : undefined;
    const index = await buildIndex(this.fs, srcDir);
    // Installed plugins and plugin rewrites are read in the background (loadInstalledInBackground):
    // until then, no plugin is verifiable.
    index.rewrittenPlugins = new Set(['*']);
    // Exact installed version (package.json only declares a range), found as Node finds it
    // (hoisted to a monorepo's root, say) — best-effort.
    let strapiVersion: string | undefined;
    try {
      const dir = await findPackageDir(this.fs, root, '@strapi/strapi');
      const installed = dir ? asRecord(safeParse(await this.fs.readFile(join(dir, 'package.json')))) : undefined;
      strapiVersion = installed ? asString(installed.version) : undefined;
    } catch {
      /* not installed / unreadable — the major from the declared range still stands */
    }
    // The (bounded) definition index makes def/hover/complete/diagnostics ready
    // immediately; the (full-walk) reference index is built in the background.
    return {
      root,
      srcDir,
      version,
      versionSignals: signals,
      ...(strapiVersion ? { strapiVersion } : {}),
      index,
      references: new Map(),
      indexedAt: Date.now(),
      ...(snapshot ? { snapshot } : {}),
    };
  }

  /** `dir` holds a Strapi app (not a plugin) that isn't one of the projects. */
  private async isUndiscoveredApp(dir: string): Promise<boolean> {
    if (this.projects.some((pr) => pr.root === dir)) return false;
    try {
      const raw = await this.fs.readFile(join(dir, 'package.json'));
      return isStrapiPackageJson(raw) && !isStrapiPluginPackageJson(raw);
    } catch {
      return false;
    }
  }

  getProjects(): ProjectSummary[] {
    return this.projects.map((p) => ({
      root: p.root,
      version: p.version,
      ...(p.strapiVersion ? { strapiVersion: p.strapiVersion } : {}),
      ...(p.versionSignals.spec ? { declaredVersion: p.versionSignals.spec } : {}),
      ...((u) => (u ? { unsupportedVersion: u } : {}))(unsupportedVersion(p.strapiVersion, p.versionSignals.packageMajor, p.version)),
      counts: {
        contentTypes: p.index.contentTypes.size,
        components: p.index.components.size,
        services: p.index.services.size,
        controllers: p.index.controllers.size,
        policies: p.index.policies.size,
        middlewares: p.index.middlewares.size,
      },
      freshness: {
        ...(p.indexedAt ? { indexedAt: new Date(p.indexedAt).toISOString() } : {}),
        ...(p.snapshot && !p.snapshot.truncated ? { diskCheckedAt: new Date(p.snapshot.takenAt).toISOString() } : {}),
        ...(this.trackDiskChanges ? { diskTracking: p.snapshot && !p.snapshot.truncated ? ('on' as const) : ('off' as const) } : {}),
        ...(p.installedAt ? { pluginsReadAt: new Date(p.installedAt).toISOString() } : {}),
        ...(!p.installedAt && this.loadingInstalled ? { pluginsLoading: true } : {}),
        ...(p.pluginReads ? { pluginReads: { read: p.pluginReads.read, fromCache: p.pluginReads.reused } } : {}),
      },
    }));
  }

  allProjects(): StrapiProject[] {
    return this.projects;
  }

  projectForFile(filePath: string): StrapiProject | undefined {
    const f = normalize(filePath);
    return this.projects.find((p) => isPathInside(p.root, f));
  }

  async getRoutes(opts?: ListRoutesOptions & { root?: string }): Promise<Array<{ root: string; routes: RouteInfo[]; unread: UnreadPluginRoutes[] }>> {
    await this.refreshInstalledIfStale();
    const out: Array<{ root: string; routes: RouteInfo[]; unread: UnreadPluginRoutes[] }> = [];
    const only = opts?.root !== undefined ? normalize(opts.root) : undefined;
    for (const project of [...this.projects].sort((a, b) => a.root.localeCompare(b.root))) {
      if (only !== undefined && project.root !== only) continue;
      const all = await this.routesOf(project);
      const routes = all.routes.filter((r) => (opts?.admin || r.type !== 'admin') && (opts?.plugins !== false || r.origin === 'project'));
      out.push({ root: project.root, routes, unread: opts?.plugins === false ? [] : all.unread });
    }
    return out;
  }

  private routesOf(project: StrapiProject): Promise<{ routes: RouteInfo[]; unread: UnreadPluginRoutes[] }> {
    let p = this.routeCache.get(project);
    if (!p) {
      const read: Promise<{ routes: RouteInfo[]; unread: UnreadPluginRoutes[] }> = readRoutes(this.fs, project, { admin: true, plugins: true }).catch(() => {
        if (this.routeCache.get(project) === read) this.routeCache.delete(project);
        return { routes: [], unread: [] };
      });
      this.routeCache.set(project, (p = read));
    }
    return p;
  }

  async getGlobalMiddlewares(root: string): Promise<GlobalMiddlewares> {
    const project = this.projects.find((p) => p.root === normalize(root));
    if (!project) return { status: 'missing', entries: [], envFiles: [] };
    let p = this.globalMwCache.get(project);
    if (!p) {
      const read: Promise<GlobalMiddlewares> = readGlobalMiddlewares(this.fs, project.root).catch(() => {
        if (this.globalMwCache.get(project) === read) this.globalMwCache.delete(project);
        return { status: 'not-literal' as const, entries: [], envFiles: [] };
      });
      this.globalMwCache.set(project, (p = read));
    }
    return p;
  }

  /** Drop a project's cached routes and middleware stack (a route-relevant file changed). */
  private forgetRoutes(project: StrapiProject): void {
    this.routeCache.delete(project);
    this.globalMwCache.delete(project);
  }

  async refreshIfStale(): Promise<void> {
    await this.refreshInstalledIfStale();
    await this.refreshDiskIfStale();
    // A change on disk can re-read the plugins (a config edit) or rescan (a package.json): wait for it.
    if (this.loadingInstalled) await this.installedLoad;
  }

  private refreshDiskIfStale(): Promise<void> {
    if (!this.trackDiskChanges) return Promise.resolve();
    if (this.diskCheck) return this.diskCheck;
    if (Date.now() - this.lastDiskCheck < this.diskCheckInterval) return Promise.resolve();
    const startedAt = Date.now();
    this.lastDiskCheck = startedAt;
    this.diskCheck = this.checkDisk().finally(() => {
      const took = Date.now() - startedAt;
      this.diskCheckInterval = took > DISK_CHECK_SLOW_MS ? Math.min(10 * took, DISK_CHECK_MAX_INTERVAL_MS) : 0;
      this.diskCheck = undefined;
    });
    return this.diskCheck;
  }

  /** What a project's disk snapshot covers: src/, config/, database/migrations, local plugins resolved elsewhere, package.json. */
  private snapshotDirs(project: { srcDir: string; root: string; rewrites?: ProjectRewrites }): string[] {
    const others = (project.rewrites?.dirs ?? []).filter((d) => d !== project.srcDir && !isPathInside(project.srcDir, d));
    return [project.srcDir, join(project.root, 'config'), join(project.root, 'database', 'migrations'), ...others];
  }

  /** Re-index what changed on disk since each project's last snapshot (git checkout, manual edits…). */
  private async checkDisk(): Promise<void> {
    const changed: string[] = [];
    const deleted: string[] = [];
    for (const project of [...this.projects]) {
      const before = project.snapshot;
      const after = await takeSourceSnapshot(this.fs, this.snapshotDirs(project), [join(project.root, 'package.json')]);
      project.snapshot = after;
      if (!before || before.truncated || after.truncated) continue;
      const diff = diffSnapshots(before, after);
      changed.push(...diff.changed);
      deleted.push(...diff.deleted);
    }
    if (changed.length || deleted.length) await this.onFilesChanged(changed, deleted);
  }

  refreshInstalledIfStale(): Promise<void> {
    if (this.loadingInstalled) return this.installedLoad;
    if (this.installedCheck) return this.installedCheck;
    const now = Date.now();
    if (now - this.lastInstalledCheck < INSTALLED_CHECK_MS) return Promise.resolve();
    this.lastInstalledCheck = now;
    this.installedCheck = this.checkInstalled().finally(() => {
      this.installedCheck = undefined;
    });
    return this.installedCheck;
  }

  private async checkInstalled(): Promise<void> {
    let changed = false;
    // The full fingerprint (every file each plugin was read from) is costlier: once a minute.
    const full = Date.now() - this.lastFullCheck >= INSTALLED_FULL_CHECK_MS;
    if (full) this.lastFullCheck = Date.now();
    for (const project of [...this.projects]) {
      let stamp: string | undefined;
      let fullStamp: string | undefined;
      try {
        stamp = await installedStamp(this.fs, project.root, project.installed?.strapiDir, project.installed);
        if (full) fullStamp = await installedStamp(this.fs, project.root, project.installed?.strapiDir, project.installed, true);
      } catch {
        continue;
      }
      const fullChanged = full && project.installedFullStamp !== undefined && fullStamp !== project.installedFullStamp;
      if (full && fullStamp !== undefined && project.installedFullStamp === undefined) project.installedFullStamp = fullStamp;
      if (stamp === project.installedStamp && !fullChanged) continue;
      await this.reloadInstalled(project, stamp);
      changed = true;
    }
    if (changed) this.referencesListener?.();
  }

  /** Re-read one project's installed plugins and swap them into its index (synchronous swap). */
  private async reloadInstalled(project: StrapiProject, stamp?: string): Promise<void> {
    // Fingerprinted BEFORE reading: a change during the read shows up at the next check.
    let next = stamp;
    if (next === undefined) {
      try {
        next = await installedStamp(this.fs, project.root, project.installed?.strapiDir, project.installed);
      } catch {
        next = undefined;
      }
    }
    const rewrites = await scanRewrites(this.fs, project.root);
    const installed = await withTimeout(readInstalledPlugins(this.fs, project.root, unionRewrites(rewrites)), INSTALLED_READ_TIMEOUT_MS, undefined);
    this.forgetRoutes(project);
    clearInstalled(project.index);
    mergeInstalled(project.index, installed);
    project.installedAt = Date.now();
    if (installed) project.pluginReads = installed.reads;
    else delete project.pluginReads;
    project.rewrites = rewrites;
    applyRewrites(project.index, installed, unionRewrites(rewrites));
    // Local plugins resolved outside src/ are known now: the disk snapshot covers them from here on.
    if (project.snapshot) project.snapshot = await extendSnapshot(this.fs, project.snapshot, this.snapshotDirs(project));
    if (installed) project.installed = installed;
    else delete project.installed;
    if (next !== undefined) project.installedStamp = next;
    else delete project.installedStamp;
    try {
      // A plugin that changed while being read: its read wasn't cached; make the next full check read it again.
      project.installedFullStamp = installed?.unsettled ? UNSETTLED : await installedStamp(this.fs, project.root, installed?.strapiDir, installed, true);
    } catch {
      delete project.installedFullStamp;
    }
  }

  onFilesChanged(changed: string[], deleted: string[]): Promise<void> {
    return this.serialize(() => this.onFilesChangedImpl(changed, deleted));
  }

  indexesUnder(dir: string): boolean {
    const d = normalize(dir);
    const under = `${d}/`;
    return this.projects.some((pr) => pr.root === d || pr.root.startsWith(under) || [...pr.index.fileDefs.keys()].some((f) => f.startsWith(under)));
  }

  private async onFilesChangedImpl(changed: string[], deleted: string[]): Promise<void> {
    const changedN = changed.map(normalize);
    const deletedN = deleted.map(normalize);
    // A package.json change can add/remove a project or flip its version; a deleted
    // folder that held a project or indexed files is re-read as a whole.
    if ([...changedN, ...deletedN].some((p) => basename(p) === 'package.json') || deletedN.some((d) => this.indexesUnder(d))) {
      await this.rescanImpl();
      return;
    }

    // Update the definition index incrementally — only the touched files, no
    // full src/ walk. Each file is removed (via the reverse index) + re-indexed
    // alone (1 read + 1 parse). O(1) per file instead of O(all definitions).
    const pluginsDone = new Map<StrapiProject, Set<string>>();
    for (const p of [...changedN, ...deletedN]) {
      const project = this.projectForFile(p);
      if (!project) continue;
      if (affectsRoutes(project, p)) this.forgetRoutes(project);
      let done = pluginsDone.get(project);
      if (!done) pluginsDone.set(project, (done = new Set()));
      try {
        await updateIndexForFile(this.fs, project, p, done);
      } catch {
        // Keep the previous index on a transient read failure; next save retries.
      }
    }

    // Installed plugins: a plugins/api config, an extension entry point or a lockfile
    // change re-reads them; any other edit only re-fills entries an incremental
    // update may have dropped (e.g. a deleted `src/extensions` schema).
    const touched = new Set<StrapiProject>();
    const reload = new Set<StrapiProject>();
    if (this.loadingInstalled) {
      for (const p of changedN) this.dirtyDuringLoad.changed.add(p);
      for (const p of deletedN) this.dirtyDuringLoad.deleted.add(p);
    }
    for (const p of [...changedN, ...deletedN]) {
      const project = this.projectForFile(p);
      if (!project) continue;
      touched.add(project);
      if (affectsInstalledPlugins(p) && !this.loadingInstalled) reload.add(project);
    }
    // Project code rewriting plugins (src/**, local plugins): re-scan the edited files only.
    const deletedSet = new Set(deletedN);
    for (const p of [...changedN, ...deletedN]) {
      const owners = this.projects.filter((pr) => pr.rewrites && inRewriteScope(pr.rewrites, p));
      for (const project of owners) {
        const rw = project.rewrites!;
        const before = rewritesKey(unionRewrites(rw));
        const r = deletedSet.has(p) ? undefined : await rewritesOfFile(this.fs, p);
        if (r) rw.files.set(p, r);
        else rw.files.delete(p);
        touched.add(project);
        // Installed plugins' completeness depends on it: re-read them (cheap next to a boot).
        if (rewritesKey(unionRewrites(rw)) !== before && project.installed) reload.add(project);
      }
    }
    for (const project of reload) await this.reloadInstalled(project);
    for (const project of touched) {
      if (reload.has(project)) continue;
      mergeInstalled(project.index, project.installed);
      // Not loaded yet: every plugin stays unverifiable.
      if (project.rewrites) applyRewrites(project.index, project.installed, unionRewrites(project.rewrites));
      else project.index.rewrittenPlugins = new Set(['*']);
    }
    // Local plugins declaring content-types in code: re-read on any edit under their content-types dir.
    for (const p of [...changedN, ...deletedN]) {
      const project = this.projectForFile(p);
      const src = project ? normalize(project.srcDir) : '';
      const m = project && p.startsWith(src + '/') && p.slice(src.length).match(/^\/plugins\/([^/]+)\/(?:.*\/)?content-types\//);
      if (project && m) await refreshCodeContentTypes(this.fs, project, m[1]!);
    }

    // Update the reference index incrementally — only the touched files, no full re-walk.
    for (const p of changedN) {
      if (this.buildingRefs) this.dirtyDuringBuild.add(p);
      const project = this.projectForFile(p);
      if (!project) continue;
      try {
        updateReferencesForFile(project, p, await this.fs.readFile(p));
      } catch {
        removeReferencesForFile(project.references, p, project);
      }
    }
    for (const p of deletedN) {
      if (this.buildingRefs) this.dirtyDuringBuild.add(p);
      const project = this.projectForFile(p);
      if (project) removeReferencesForFile(project.references, p, project);
    }
    // A definition added or removed doesn't re-read the files that name it as a plain value.
    const refreshed = new Set<StrapiProject>();
    for (const p of [...changedN, ...deletedN]) {
      const project = this.projectForFile(p);
      if (project && !refreshed.has(project)) {
        refreshed.add(project);
        resyncWeakLiterals(project);
      }
    }
  }

  async getDefinitions(filePath: string, offset: number, sourceText: string): Promise<TargetLocation[]> {
    // Never block an editor query on a re-read: it runs in the background and the
    // change listener refreshes the editor when it lands.
    void this.refreshInstalledIfStale();
    const project = this.projectForFile(filePath);
    if (!project) return [];
    const ctx = analyzeAt(filePath, sourceText, offset);
    if (ctx && ctx.isLiteral) return resolveDefinition(project, ctx, normalize(filePath));
    // Fall back to method navigation on a resolved service/controller.
    const member = analyzeMemberAt(filePath, sourceText, offset);
    return member ? resolveMember(project, member) : [];
  }

  getReferenceRange(
    filePath: string,
    offset: number,
    sourceText: string,
  ): { start: number; end: number } | undefined {
    if (!this.projectForFile(filePath)) return undefined;
    const ctx = analyzeAt(filePath, sourceText, offset);
    if (ctx && ctx.isLiteral) return ctx.range;
    const member = analyzeMemberAt(filePath, sourceText, offset);
    return member ? member.range : undefined;
  }

  async getHover(filePath: string, offset: number, sourceText: string): Promise<HoverInfo | undefined> {
    // Never block an editor query on a re-read: it runs in the background and the
    // change listener refreshes the editor when it lands.
    void this.refreshInstalledIfStale();
    const project = this.projectForFile(filePath);
    if (!project) return undefined;
    const ctx = analyzeAt(filePath, sourceText, offset);
    if (ctx && ctx.isLiteral) return describeHover(project, ctx, normalize(filePath));
    const member = analyzeMemberAt(filePath, sourceText, offset);
    if (member) return describeMemberHover(project, member);
    // Built-in Strapi data API methods (findMany, create, …) that TS sees as `any`.
    const apiMember = analyzeApiMemberAt(filePath, sourceText, offset);
    return apiMember ? describeApiMemberHover(apiMember) : undefined;
  }

  async getCompletions(filePath: string, offset: number, sourceText: string): Promise<CompletionResult> {
    // Never block an editor query on a re-read: it runs in the background and the
    // change listener refreshes the editor when it lands.
    void this.refreshInstalledIfStale();
    const project = this.projectForFile(filePath);
    if (!project) return { items: [] };
    const ctx = analyzeAt(filePath, sourceText, offset);
    if (ctx && ctx.isLiteral) {
      return { replace: ctx.range, items: completeRefs(project, ctx, normalize(filePath)) };
    }
    // Methods of a resolved service/controller/API, after a `.`.
    const mc = analyzeMemberCompletionAt(filePath, sourceText, offset);
    if (mc) return { replace: mc.replace, items: completeMembers(project, mc) };
    return { items: [] };
  }

  async validateFile(filePath: string, sourceText: string): Promise<DiagnosticEntry[]> {
    // Never block an editor query on a re-read: it runs in the background and the
    // change listener refreshes the editor when it lands.
    void this.refreshInstalledIfStale();
    const project = this.projectForFile(filePath);
    if (!project) return [];
    return validateDocument(project, filePath, sourceText);
  }

  async getReferences(filePath: string, offset: number, sourceText: string): Promise<ReferenceLocation[]> {
    // Never block an editor query on a re-read: it runs in the background and the
    // change listener refreshes the editor when it lands.
    void this.refreshInstalledIfStale();
    const project = this.projectForFile(filePath);
    if (!project) return [];
    const norm = normalize(filePath);

    // 1. On a magic string (UID / service / handler / …).
    const ctx = analyzeAt(filePath, sourceText, offset);
    if (ctx && ctx.isLiteral) {
      const key = canonicalKey(project, ctx, norm);
      if (key) return project.references.get(key) ?? [];
    }
    // 2. On a method call `strapi.service('x').method()`.
    const member = analyzeMemberAt(filePath, sourceText, offset);
    if (member) {
      const base =
        member.kind === 'plugin-service-member' && member.pluginName
          ? `plugin::${member.pluginName}.${member.ref}`
          : member.ref;
      const refs = project.references.get(`method:${base}.${member.method}`);
      if (refs) return refs;
    }
    // 3. Inside a definition file → the definition/method nearest above the cursor.
    const defs = definitionsInFile(project, norm);
    if (defs.length === 0) return [];
    let chosen = defs[0]!;
    for (const d of defs) if (d.offset <= offset && d.offset >= chosen.offset) chosen = d;
    return project.references.get(chosen.key) ?? [];
  }

  async getCodeLenses(filePath: string, _sourceText: string): Promise<CodeLensEntry[]> {
    // Never block an editor query on a re-read: it runs in the background and the
    // change listener refreshes the editor when it lands.
    void this.refreshInstalledIfStale();
    // Avoid flashing wrong "0 references" while the reference index is building.
    if (this.buildingRefs) return [];
    const project = this.projectForFile(filePath);
    if (!project) return [];
    const out: CodeLensEntry[] = [];
    let maps: ModelMaps | undefined;
    for (const d of definitionsInFile(project, normalize(filePath))) {
      const references = project.references.get(d.key) ?? [];
      out.push({
        offset: d.offset,
        count: references.length,
        method: d.key.startsWith('method:'),
        kind: 'references',
        references,
      });
      // For a content-type, add a second "N incoming relations" lens (the
      // content-types that target it) — info no other tool surfaces.
      if (d.key.startsWith('ct:')) {
        maps ??= buildModelMaps(project);
        const incoming = contentTypeInsights(project, d.key.slice('ct:'.length), maps).incomingRelations;
        if (incoming.length) {
          out.push({
            offset: d.offset,
            count: incoming.length,
            method: false,
            kind: 'incoming-relations',
            references: incoming.map((r) => ({
              filePath: r.filePath,
              start: { line: r.line, character: 0 },
              end: { line: r.line, character: 0 },
            })),
          });
        }
      }
    }
    return out;
  }

  getModel(): OutlineProject[] {
    // The outline is the project's own part of `modelOf` (one source of truth).
    return this.projects.map((project) => {
      const model = modelOf(project);
      const order = [...project.index.contentTypes.keys()];
      const contentTypes = model.contentTypes
        .filter((ct) => ct.origin !== 'installed-plugin' && !ct.inCode)
        .sort((a, b) => order.indexOf(a.uid) - order.indexOf(b.uid))
        .map((ct) => {
          const relations: OutlineRelation[] = [];
          const components: OutlineComponentUse[] = [];
          for (const f of ct.fields) {
            if (f.type === 'relation' && f.target) relations.push({ attr: f.name, targetUid: f.target, offset: f.offset });
            if (f.component) components.push({ attr: f.name, uid: f.component, offset: f.offset });
            for (const c of f.components ?? []) components.push({ attr: f.name, uid: c, offset: f.offset });
          }
          return {
            uid: ct.uid,
            displayName: ct.displayName,
            kind: ct.kind,
            schemaPath: ct.schemaPath,
            defOffset: ct.defOffset,
            refCount: ct.usage.total,
            routeHandlers: ct.usage.routeHandlers,
            dataUsages: ct.usage.dataUsages,
            incomingRelations: ct.usage.incomingRelations,
            relations,
            components,
          };
        });
      const corder = [...project.index.components.keys()];
      const components = [...model.components]
        .sort((a, b) => corder.indexOf(a.uid) - corder.indexOf(b.uid))
        .map((c) => ({ uid: c.uid, jsonPath: c.jsonPath, defOffset: c.defOffset, usedByCount: c.usage.usedByCount }));
      const issues: OutlineIssue[] = [];
      for (const ct of contentTypes) {
        if (ct.refCount === 0) issues.push({ kind: 'unused-content-type', uid: ct.uid, label: ct.displayName });
      }
      for (const c of components) {
        if (c.usedByCount === 0) issues.push({ kind: 'orphan-component', uid: c.uid, label: c.uid });
      }
      return { root: project.root, version: project.version, contentTypes, components, issues };
    });
  }
}

export function createEngine(fs: FileSystem, options?: { trackDiskChanges?: boolean }): StrapiEngine {
  return new Engine(fs, options?.trackDiskChanges ?? false);
}
