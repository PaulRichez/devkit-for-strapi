import { analyzeAt } from './analyze/callSite';
import { analyzeApiMemberAt } from './analyze/apiMember';
import { analyzeMemberAt } from './analyze/member';
import { analyzeMemberCompletionAt } from './analyze/memberCompletion';
import { complete as completeRefs, completeMembers } from './complete/completion';
import { type FileSystem, FileType } from './fs/FileSystem';
import { basename, dirname, isPathInside, join, normalize } from './fs/paths';
import { describeApiMemberHover, describeHover, describeMemberHover } from './hover/hover';
import { buildIndex, updateIndexForFile } from './index/indexer';
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
  StrapiProject,
  TargetLocation,
} from './model/types';
import { buildModelMaps, componentInsights, contentTypeInsights, type ModelMaps } from './reference/insights';
import {
  buildReferenceIndex,
  canonicalKey,
  definitionsInFile,
  removeReferencesForFile,
  updateReferencesForFile,
} from './reference/references';
import { resolveDefinition, resolveMember } from './resolve/resolver';
import { matchesAnyGlob } from './util/glob';
import { asRecord, asString, safeParse } from './util/json';
import { validateDocument } from './validate/validator';
import { discoverProjectRoots, findStrapiRootUp } from './workspace/discovery';
import { detectVersion } from './workspace/version';

export interface StrapiEngine {
  /** Discover projects in the given workspace folders and build their indexes. */
  init(workspaceFolders: string[]): Promise<void>;
  /** Re-discover and re-index everything. */
  rescan(): Promise<void>;
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

  constructor(private readonly fs: FileSystem) {}

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

  async init(folders: string[]): Promise<void> {
    this.folders = folders.map(normalize);
    await this.rescan();
  }

  rescan(): Promise<void> {
    return this.serialize(() => this.rescanImpl());
  }

  setExcludes(globs: string[]): void {
    this.excludes = globs;
  }

  async addRoot(path: string): Promise<ProjectSummary[]> {
    const p = normalize(path);
    // Already covered by a discovered project? Idempotent no-op.
    if (this.projects.some((pr) => isPathInside(pr.root, p) || pr.root === p)) return this.getProjects();

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
    // Build the reference index off the critical path (does not block "ready").
    this.refsBuild = this.buildReferencesInBackground(token);
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
          removeReferencesForFile(project.references, f);
        }
      }
      if (this.dirtyDuringBuild.size) this.referencesListener?.();
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
    const index = await buildIndex(this.fs, srcDir);
    // Exact installed version (package.json only declares a range) — best-effort.
    let strapiVersion: string | undefined;
    try {
      const installed = asRecord(safeParse(await this.fs.readFile(join(root, 'node_modules', '@strapi', 'strapi', 'package.json'))));
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
    };
  }

  getProjects(): ProjectSummary[] {
    return this.projects.map((p) => ({
      root: p.root,
      version: p.version,
      ...(p.strapiVersion ? { strapiVersion: p.strapiVersion } : {}),
      ...(p.versionSignals.spec ? { declaredVersion: p.versionSignals.spec } : {}),
      counts: {
        contentTypes: p.index.contentTypes.size,
        components: p.index.components.size,
        services: p.index.services.size,
        controllers: p.index.controllers.size,
        policies: p.index.policies.size,
        middlewares: p.index.middlewares.size,
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

  onFilesChanged(changed: string[], deleted: string[]): Promise<void> {
    return this.serialize(() => this.onFilesChangedImpl(changed, deleted));
  }

  private async onFilesChangedImpl(changed: string[], deleted: string[]): Promise<void> {
    const changedN = changed.map(normalize);
    const deletedN = deleted.map(normalize);
    // A package.json change can add/remove a project or flip its version.
    if ([...changedN, ...deletedN].some((p) => basename(p) === 'package.json')) {
      await this.rescanImpl();
      return;
    }

    // Update the definition index incrementally — only the touched files, no
    // full src/ walk. Each file is removed (via the reverse index) + re-indexed
    // alone (1 read + 1 parse). O(1) per file instead of O(all definitions).
    for (const p of [...changedN, ...deletedN]) {
      const project = this.projectForFile(p);
      if (!project) continue;
      try {
        await updateIndexForFile(this.fs, project, p);
      } catch {
        // Keep the previous index on a transient read failure; next save retries.
      }
    }

    // Update the reference index incrementally — only the touched files, no full re-walk.
    for (const p of changedN) {
      if (this.buildingRefs) this.dirtyDuringBuild.add(p);
      const project = this.projectForFile(p);
      if (!project) continue;
      try {
        updateReferencesForFile(project, p, await this.fs.readFile(p));
      } catch {
        removeReferencesForFile(project.references, p);
      }
    }
    for (const p of deletedN) {
      if (this.buildingRefs) this.dirtyDuringBuild.add(p);
      const project = this.projectForFile(p);
      if (project) removeReferencesForFile(project.references, p);
    }
  }

  async getDefinitions(filePath: string, offset: number, sourceText: string): Promise<TargetLocation[]> {
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
    const project = this.projectForFile(filePath);
    if (!project) return [];
    return validateDocument(project, filePath, sourceText);
  }

  async getReferences(filePath: string, offset: number, sourceText: string): Promise<ReferenceLocation[]> {
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
    return this.projects.map((project) => {
      const maps = buildModelMaps(project);
      const contentTypes = [...project.index.contentTypes.values()].map((ct) => {
        const ins = contentTypeInsights(project, ct.uid, maps);
        const relations: OutlineRelation[] = [];
        const components: OutlineComponentUse[] = [];
        for (const a of Object.values(ct.attributes)) {
          if (a.type === 'relation' && a.target) {
            relations.push({ attr: a.name, targetUid: a.target, offset: a.keyOffset });
          }
          if (a.component) components.push({ attr: a.name, uid: a.component, offset: a.keyOffset });
          for (const c of a.components ?? []) components.push({ attr: a.name, uid: c, offset: a.keyOffset });
        }
        return {
          uid: ct.uid,
          displayName: ct.info.displayName ?? ct.ctName,
          kind: ct.kind,
          schemaPath: ct.schemaPath,
          defOffset: ct.defOffset ?? 0,
          refCount: ins.total,
          routeHandlers: ins.routeHandlers,
          dataUsages: ins.dataUsages,
          incomingRelations: ins.incomingRelations,
          relations,
          components,
        };
      });
      const components = [...project.index.components.values()].map((c) => ({
        uid: c.uid,
        jsonPath: c.jsonPath,
        defOffset: c.defOffset ?? 0,
        usedByCount: componentInsights(project, c.uid, maps).usedByCount,
      }));
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

export function createEngine(fs: FileSystem): StrapiEngine {
  return new Engine(fs);
}
