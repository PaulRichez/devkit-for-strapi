import {
  type BrokenRef,
  type FileSystem,
  listBrokenRefs,
  listUnused,
  paths,
  type PipelineStep,
  type ProjectInfo,
  projectInfo,
  type ReferenceLocation,
  routePipeline,
  type StrapiEngine,
  type SyncFileEntry,
  type UnusedItem,
  validateRef,
} from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toDiagnostic } from '../conv';
import { type ConfigSyncCache, STATUS_TEXT } from './configSync';
import { CachedTree, code, LOADING_MESSAGE, markdown, orderedRoots, pluginsLoading, projectLabel, relPath, type TreeNode } from './tree';

/**
 * "Health" view: what is wrong in the whole project — not only in the open files
 * (VS Code's Problems panel): broken references, names Strapi won't find at startup,
 * refs DevKit can't check, definitions no Strapi reference uses, plugins DevKit
 * couldn't read completely. Every entry opens where to fix it.
 */

interface StartupName {
  step: PipelineStep;
  /** Where it is written (the route declaration, the config/middlewares entry). */
  at: { filePath: string; offset: number };
  routes: string[];
}

interface Report {
  root: string;
  info?: ProjectInfo;
  broken: Array<BrokenRef & { didYouMean?: string }>;
  startup: StartupName[];
  unused: UnusedItem[];
  /** Errors and warnings in the config-sync files (infos stay in the Config Sync view). */
  configSync: SyncFileEntry[];
}

type Node = TreeNode &
  (
    | { kind: 'project'; root: string }
    | { kind: 'summary'; root: string; info: ProjectInfo }
    | { kind: 'group'; root: string; group: 'broken' | 'startup' | 'configSync' | 'unverified' | 'unused' | 'plugins' }
    | { kind: 'syncFile'; root: string; file: SyncFileEntry }
    | { kind: 'broken'; root: string; ref: BrokenRef & { didYouMean?: string } }
    | { kind: 'location'; root: string; loc: ReferenceLocation; replace?: { from: string; to: string } }
    | { kind: 'startup'; root: string; name: StartupName }
    | { kind: 'unverifiedPlugin'; root: string; plugin: string; refs: number; why?: string[] }
    | { kind: 'unusedKind'; root: string; unusedKind: UnusedItem['kind']; items: UnusedItem[] }
    | { kind: 'unused'; root: string; item: UnusedItem }
    | { kind: 'plugin'; root: string; plugin: ProjectInfo['plugins'][number] }
    | { kind: 'ok'; root: string }
  );

const UNUSED_LABEL: Record<UnusedItem['kind'], string> = {
  method: 'Methods',
  'content-type': 'Content-types',
  component: 'Components',
  service: 'Services',
  policy: 'Policies',
  middleware: 'Middlewares',
};

function ago(iso: string | undefined): string {
  if (!iso) return 'not indexed yet';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

export class HealthProvider extends CachedTree<Node> {
  private reports = new Map<string, Report>();
  private loading: Promise<void> | undefined;
  private readonly counted = new vscode.EventEmitter<number>();
  /** Fired with the problem count (badge) each time it is recomputed. */
  readonly onDidCount = this.counted.event;
  /** The last problem count (broken refs + names Strapi won't find). */
  count = 0;
  view: vscode.TreeView<Node> | undefined;

  constructor(
    private readonly engine: StrapiEngine,
    private readonly fs: FileSystem,
    private readonly configSync?: ConfigSyncCache,
  ) {
    super();
  }

  protected override reset(): void {
    this.reports.clear();
    this.loading = undefined;
  }

  /** Broken refs + names Strapi won't find, every project (the badge). */
  problemCount(): number {
    let n = 0;
    for (const r of this.reports.values()) n += r.broken.length + r.startup.length;
    return n;
  }

  /** The badge alone, while the view is hidden (no full report). */
  async updateBadge(): Promise<void> {
    let n = 0;
    for (const project of this.engine.allProjects()) {
      n += listBrokenRefs(project).length;
      n += (await this.startupNames(project)).length;
    }
    this.setBadge(n);
  }

  private setBadge(n: number): void {
    this.count = n;
    if (this.view) this.view.badge = n ? { value: n, tooltip: `${n} problem${n === 1 ? '' : 's'} Strapi would hit` } : undefined;
    this.counted.fire(n);
  }

  /** Names Strapi won't find at startup: in the project's own routes and middleware stack (one entry per declaration). */
  private async startupNames(project: ReturnType<StrapiEngine['allProjects']>[number]): Promise<StartupName[]> {
    const routes = (await this.engine.getRoutes({ admin: true, root: project.root }))[0]?.routes ?? [];
    const global = await this.engine.getGlobalMiddlewares(project.root);
    const seen = new Map<string, StartupName>();
    for (const r of routes) {
      if (r.origin === 'installed-plugin') continue;
      for (const step of routePipeline(project, r, global).steps) {
        if (step.status !== 'not-found-by-strapi' || !step.declaredAt) continue;
        const key = `${step.declaredAt.filePath}:${step.phase === 'global-middleware' ? step.declaredAt.offset : ''}:${step.phase}:${step.name}`;
        const label = `${r.method.toUpperCase()} ${r.fullPath ?? r.path}`;
        const hit = seen.get(key);
        if (hit) {
          if (step.phase !== 'global-middleware') hit.routes.push(label);
        } else {
          seen.set(key, { step, at: { filePath: step.declaredAt.filePath, offset: step.declaredAt.offset ?? 0 }, routes: step.phase === 'global-middleware' ? [] : [label] });
        }
      }
    }
    return [...seen.values()];
  }

  report(root: string): Report | undefined {
    return this.reports.get(root);
  }

  async load(): Promise<void> {
    this.loading ??= (async () => {
      const summaries = this.engine.getProjects();
      for (const project of this.engine.allProjects()) {
        const summary = summaries.find((s) => s.root === project.root);
        const routes = (await this.engine.getRoutes({ admin: true, root: project.root }))[0]?.routes ?? [];
        const report: Report = { root: project.root, broken: [], startup: [], unused: [], configSync: [] };
        try {
          const configSync = this.configSync ? ((await this.configSync.get(project.root)) ?? null) : undefined;
          if (summary) report.info = await projectInfo(this.fs, project, summary, { routes: routes.filter((r) => r.type !== 'admin'), configSync });
        } catch {
          /* the summary line is a bonus */
        }
        report.broken = listBrokenRefs(project).map((b) => {
          const v = validateRef(project, b.ref);
          return v.didYouMean ? { ...b, didYouMean: v.didYouMean } : b;
        });
        report.unused = listUnused(project);
        report.startup = await this.startupNames(project);
        report.configSync = ((await this.configSync?.get(project.root))?.files ?? []).filter((f) => f.status === 'invalid');
        this.reports.set(project.root, report);
      }
      this.setBadge(this.problemCount());
      if (this.view) this.view.message = pluginsLoading(this.engine) ? LOADING_MESSAGE : undefined;
    })();
    return this.loading;
  }

  protected async build(element?: Node): Promise<Node[]> {
    if (!element) {
      await this.load();
      const roots = orderedRoots(this.engine, [...this.reports.keys()]);
      if (roots.length === 1) return this.groups(roots[0]!);
      return roots.map((root) => ({ kind: 'project', id: `health|${root}`, root }));
    }
    const r = this.reports.get(element.root);
    if (!r) return [];
    switch (element.kind) {
      case 'project':
        return this.groups(element.root);
      case 'group':
        switch (element.group) {
          case 'broken':
            return r.broken.map((ref) => ({ kind: 'broken', id: `${element.id}|${ref.ref}`, root: r.root, ref }));
          case 'startup':
            return r.startup.map((name, i) => ({ kind: 'startup', id: `${element.id}|${i}|${name.step.name}`, root: r.root, name }));
          case 'unverified':
            return Object.entries(r.info?.health.unverifiedByPlugin ?? {})
              .sort(([, a], [, b]) => b - a)
              .map(([plugin, refs]) => ({ kind: 'unverifiedPlugin', id: `${element.id}|${plugin}`, root: r.root, plugin, refs, why: r.info?.plugins.find((p) => p.name === plugin)?.why }));
          case 'unused': {
            const kinds = [...new Set(r.unused.map((u) => u.kind))];
            return kinds.map((unusedKind) => ({ kind: 'unusedKind', id: `${element.id}|${unusedKind}`, root: r.root, unusedKind, items: r.unused.filter((u) => u.kind === unusedKind) }));
          }
          case 'plugins':
            return (r.info?.plugins ?? []).filter((p) => !p.verified).map((plugin) => ({ kind: 'plugin', id: `${element.id}|${plugin.name}`, root: r.root, plugin }));
          case 'configSync':
            return r.configSync.map((file) => ({ kind: 'syncFile', id: `${element.id}|${file.key}`, root: r.root, file }));
        }
        return [];
      case 'broken':
        return element.ref.locations.map((loc, i) => ({
          kind: 'location',
          id: `${element.id}|${i}`,
          root: r.root,
          loc,
          ...(element.ref.didYouMean ? { replace: { from: element.ref.ref, to: element.ref.didYouMean } } : {}),
        }));
      case 'unusedKind':
        return element.items.map((item) => ({ kind: 'unused', id: `${element.id}|${item.ref}`, root: r.root, item }));
      default:
        return [];
    }
  }

  private groups(root: string): Node[] {
    const r = this.reports.get(root);
    if (!r) return [];
    const out: Node[] = [];
    if (r.info) out.push({ kind: 'summary', id: `health|${root}|summary`, root, info: r.info });
    if (r.broken.length) out.push({ kind: 'group', id: `health|${root}|broken`, root, group: 'broken' });
    if (r.startup.length) out.push({ kind: 'group', id: `health|${root}|startup`, root, group: 'startup' });
    if (!r.broken.length && !r.startup.length) out.push({ kind: 'ok', id: `health|${root}|ok`, root });
    if (r.configSync.length) out.push({ kind: 'group', id: `health|${root}|configSync`, root, group: 'configSync' });
    if (r.info?.health.unverifiedPluginRefs) out.push({ kind: 'group', id: `health|${root}|unverified`, root, group: 'unverified' });
    if (r.unused.length) out.push({ kind: 'group', id: `health|${root}|unused`, root, group: 'unused' });
    if (r.info?.plugins.some((p) => !p.verified)) out.push({ kind: 'group', id: `health|${root}|plugins`, root, group: 'plugins' });
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const r = this.reports.get(n.root);
    switch (n.kind) {
      case 'project': {
        const item = new vscode.TreeItem(projectLabel(n.root), vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        const count = r ? r.broken.length + r.startup.length : 0;
        item.description = count ? `${count} problem${count === 1 ? '' : 's'}` : 'no problem found';
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      }
      case 'summary':
        return this.summaryItem(n.id, n.info);
      case 'ok': {
        const item = new vscode.TreeItem('No broken reference found', vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
        item.tooltip = 'Every Strapi reference DevKit can check resolves, and every route policy and middleware is found where Strapi looks for it. Saved files only.';
        return item;
      }
      case 'group': {
        const [label, count, icon, color, tip] = this.groupMeta(n.group, r);
        const item = new vscode.TreeItem(label, n.group === 'broken' || n.group === 'startup' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = n.id;
        item.description = `${count}`;
        item.iconPath = new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
        item.tooltip = tip;
        return item;
      }
      case 'broken': {
        const b = n.ref;
        const item = new vscode.TreeItem(b.ref, vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        item.description = [`${b.locations.length}×`, b.didYouMean ? `did you mean ${b.didYouMean}?` : ''].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
        item.tooltip = `${b.kind} ${b.ref} resolves to nothing in this project.${b.didYouMean ? ` Did you mean ${b.didYouMean}?` : ''}`;
        return item;
      }
      case 'location': {
        const l = n.loc;
        const item = new vscode.TreeItem(l.snippet?.trim() || relPath(l.filePath), vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = `${relPath(l.filePath)}:${l.start.line + 1}`;
        item.iconPath = new vscode.ThemeIcon('location');
        item.command = { command: 'vscode.open', title: 'Open', arguments: [vscode.Uri.file(l.filePath), { selection: new vscode.Range(l.start.line, l.start.character, l.end.line, l.end.character) }] };
        item.contextValue = n.replace ? 'strapiHealth.location.fixable' : 'strapiHealth.location';
        return item;
      }
      case 'startup': {
        const s = n.name.step;
        const item = new vscode.TreeItem(s.name, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = `${s.phase === 'policy' ? 'policy' : 'middleware'} → use ${s.ref} · ${relPath(n.name.at.filePath)}`;
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsErrorIcon.foreground'));
        const md = markdown();
        md.appendMarkdown(`${code(s.name)} — ${s.note ?? ''}\n\n`);
        if (n.name.routes.length) md.appendMarkdown(`Routes: ${n.name.routes.slice(0, 8).map(code).join(', ')}${n.name.routes.length > 8 ? ', …' : ''}\n\n`);
        md.appendMarkdown('The diagnostic in the file has the quick fix.');
        item.tooltip = md;
        item.command = { command: 'strapiDevkit.open', title: 'Open', arguments: [n.name.at.filePath, n.name.at.offset] };
        return item;
      }
      case 'syncFile': {
        const item = new vscode.TreeItem(paths.basename(n.file.path), vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = 'not valid JSON';
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
        item.tooltip = STATUS_TEXT.invalid;
        item.command = { command: 'strapiDevkit.open', title: 'Open', arguments: [n.file.path, 0] };
        return item;
      }
      case 'unverifiedPlugin': {
        const item = new vscode.TreeItem(n.plugin, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = `${n.refs} ref${n.refs === 1 ? '' : 's'} not checked`;
        item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('descriptionForeground'));
        item.tooltip = `Refs into ${n.plugin} are not checked: DevKit could not read it completely.${n.why?.length ? `\n\nWhy: ${n.why.join('; ')}` : ''}`;
        item.command = { command: 'strapiDevkit.plugins.reveal', title: 'Show plugin', arguments: [n.root, n.plugin] };
        return item;
      }
      case 'unusedKind': {
        const item = new vscode.TreeItem(UNUSED_LABEL[n.unusedKind], vscode.TreeItemCollapsibleState.Collapsed);
        item.id = n.id;
        item.description = `${n.items.length}`;
        item.iconPath = new vscode.ThemeIcon('circle-slash');
        return item;
      }
      case 'unused': {
        const u = n.item;
        const item = new vscode.TreeItem(u.ref, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = relPath(u.filePath);
        item.iconPath = new vscode.ThemeIcon(u.kind === 'method' ? 'symbol-method' : 'symbol-class', new vscode.ThemeColor('descriptionForeground'));
        item.tooltip = 'No Strapi reference found. A direct TypeScript call or a dynamic access (computed name) can still use it: check before deleting.';
        item.command = { command: 'strapiDevkit.open', title: 'Open', arguments: [u.filePath, u.offset] };
        return item;
      }
      case 'plugin': {
        const p = n.plugin;
        const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = p.why?.[0] ?? 'not read completely';
        item.iconPath = new vscode.ThemeIcon('question', new vscode.ThemeColor('descriptionForeground'));
        item.tooltip = `${p.package ?? p.name}${p.version ? ` ${p.version}` : ''} — refs into it are not checked.${p.why?.length ? `\n\nWhy: ${p.why.join('; ')}` : ''}`;
        item.command = { command: 'strapiDevkit.plugins.reveal', title: 'Show plugin', arguments: [n.root, p.name] };
        return item;
      }
    }
  }

  private groupMeta(g: Extract<Node, { kind: 'group' }>['group'], r: Report | undefined): [string, number, string, string | undefined, string] {
    switch (g) {
      case 'broken':
        return ['Broken references', r?.broken.length ?? 0, 'error', 'problemsErrorIcon.foreground', 'Strapi references that resolve to nothing (UIDs, services, controllers, policies, …), across the whole project.'];
      case 'startup':
        return ["Names Strapi won't find at startup", r?.startup.length ?? 0, 'warning', 'problemsErrorIcon.foreground', 'Policies and middlewares that exist, but not under the name Strapi looks up: Strapi throws at startup.'];
      case 'configSync':
        return ['Unreadable config-sync files', r?.configSync.length ?? 0, 'sync', 'problemsErrorIcon.foreground', "Not valid JSON (or empty): config-sync can't read them. See the Config Sync view."];
      case 'unverified':
        return ['Refs DevKit cannot check', r?.info?.health.unverifiedPluginRefs ?? 0, 'question', 'descriptionForeground', 'Refs into plugins DevKit could not read completely: never reported as broken, never checked either.'];
      case 'unused':
        return ['No Strapi reference', r?.unused.length ?? 0, 'circle-slash', 'descriptionForeground', 'Definitions no Strapi magic string or route uses. A direct call or a dynamic access can still use them.'];
      case 'plugins':
        return ['Plugins not read completely', r?.info?.plugins.filter((p) => !p.verified).length ?? 0, 'extensions', 'descriptionForeground', 'Their refs are not checked; each says why.'];
    }
  }

  private summaryItem(id: string, i: ProjectInfo): vscode.TreeItem {
    const strapi = i.strapi.installed ?? i.strapi.declared ?? `v${i.strapi.major}`;
    const parts = [`Strapi ${strapi}`, i.language === 'typescript' ? 'TypeScript' : 'JavaScript', i.packageManager, i.apiPrefix].filter(Boolean);
    const item = new vscode.TreeItem(parts.join(' · '), vscode.TreeItemCollapsibleState.None);
    item.id = id;
    const verified = i.plugins.filter((p) => p.verified).length;
    item.description = `indexed ${ago(i.freshness.indexedAt)} · plugins ${verified}/${i.plugins.length} verified${i.freshness.pluginsLoading ? ' (reading…)' : ''}`;
    item.iconPath = new vscode.ThemeIcon('info');
    const md = markdown();
    md.appendMarkdown(`**${i.name}** — ${code(i.root)}\n\n`);
    md.appendMarkdown(`Strapi ${i.strapi.installed ? `${i.strapi.installed} installed` : 'not installed'}${i.strapi.declared ? ` · ${code(i.strapi.declared)} declared` : ''}\n\n`);
    const c = i.counts;
    md.appendMarkdown(`${c.contentTypes.collectionTypes + c.contentTypes.singleTypes} content-types · ${c.components} components · ${c.services} services · ${c.controllers} controllers · ${c.routes.api + c.routes.plugins} routes\n\n`);
    for (const note of i.notes) md.appendMarkdown(`$(info) ${note}\n\n`);
    md.appendMarkdown('_Reflects the saved files._');
    item.tooltip = md;
    return item;
  }
}

export interface HealthView {
  refresh(): void;
  provider: HealthProvider;
}

/** Validate every source file of every project into the Problems panel (cancellable). */
async function validateWholeProject(engine: StrapiEngine, fs: FileSystem, collection: vscode.DiagnosticCollection): Promise<void> {
  const projects = engine.allProjects();
  if (!projects.length) {
    void vscode.window.showInformationMessage('DevKit for Strapi: no Strapi project in this workspace.');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'DevKit for Strapi: checking the whole project', cancellable: true },
    async (progress, token) => {
      const files: vscode.Uri[] = [];
      for (const p of projects) {
        files.push(...(await vscode.workspace.findFiles(new vscode.RelativePattern(vscode.Uri.file(p.root), '{src,config}/**/*.{ts,tsx,js,jsx,mjs,cjs,json}'), '**/node_modules/**')));
      }
      const severity = unknownRefSeverity();
      collection.clear();
      const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.toString()));
      let done = 0;
      let problems = 0;
      for (const uri of files) {
        if (token.isCancellationRequested) break;
        if (++done % 25 === 0) {
          progress.report({ message: `${done}/${files.length} files`, increment: (25 / files.length) * 100 });
          await new Promise((r) => setImmediate(r));
        }
        if (open.has(uri.toString())) continue; // the live diagnostics cover open files
        const file = paths.normalize(uri.fsPath);
        if (file.endsWith('.d.ts')) continue;
        let text: string;
        try {
          text = await fs.readFile(file);
        } catch {
          continue;
        }
        const entries = await engine.validateFile(file, text);
        if (!entries.length) continue;
        const doc = { positionAt: (o: number) => positionAt(text, o) } as unknown as vscode.TextDocument;
        collection.set(uri, entries.map((e) => toDiagnostic(e, doc, severity)));
        problems += entries.length;
      }
      void vscode.window.showInformationMessage(
        token.isCancellationRequested
          ? `DevKit for Strapi: check stopped after ${done} files (${problems} problems so far).`
          : `DevKit for Strapi: ${files.length} files checked, ${problems} problem${problems === 1 ? '' : 's'} in files not open (see the Problems panel).`,
      );
    },
  );
}

/** The user's severity for unknown references (same setting as the live diagnostics). */
function unknownRefSeverity(): vscode.DiagnosticSeverity {
  switch (vscode.workspace.getConfiguration('strapiDevkit.diagnostics').get<string>('unknownReferenceSeverity', 'error')) {
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'information':
      return vscode.DiagnosticSeverity.Information;
    case 'hint':
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

/** Line/character of an offset in `text` (for files not open in an editor). */
function positionAt(text: string, offset: number): vscode.Position {
  let line = 0;
  let last = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return new vscode.Position(line, offset - last);
}

export function registerHealthView(context: vscode.ExtensionContext, engine: StrapiEngine, fs: FileSystem, configSync?: ConfigSyncCache): HealthView {
  const provider = new HealthProvider(engine, fs, configSync);
  const view = vscode.window.createTreeView('strapiDevkit.health', { treeDataProvider: provider, showCollapseAll: true });
  provider.view = view;
  // The badge shows on the panel even before the view is opened.
  void provider.updateBadge();
  // The whole-project pass; an opened file switches to the live diagnostics.
  const projectDiagnostics = vscode.languages.createDiagnosticCollection('strapiDevkit-project');

  context.subscriptions.push(
    view,
    projectDiagnostics,
    vscode.workspace.onDidOpenTextDocument((d) => projectDiagnostics.delete(d.uri)),
    vscode.commands.registerCommand('strapiDevkit.health.validateAll', () => validateWholeProject(engine, fs, projectDiagnostics)),
    vscode.commands.registerCommand('strapiDevkit.health.replace', async (node?: Node) => {
      if (node?.kind !== 'location' || !node.replace) return;
      const l = node.loc;
      const edit = new vscode.WorkspaceEdit();
      const uri = vscode.Uri.file(l.filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const range = new vscode.Range(l.start.line, l.start.character, l.end.line, l.end.character);
      // Only when the text is still what was indexed (the file may have changed since).
      if (doc.getText(range) !== node.replace.from) {
        void vscode.window.showWarningMessage('DevKit for Strapi: this file changed since it was checked — open it and use the quick fix.');
        return;
      }
      edit.replace(uri, range, node.replace.to);
      await vscode.workspace.applyEdit(edit);
    }),
  );
  return {
    refresh: () => {
      provider.refresh(); // a visible view rebuilds (and sets the badge) at once
      if (!view.visible) void provider.updateBadge();
    },
    provider,
  };
}
