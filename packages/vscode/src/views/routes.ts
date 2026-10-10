import {
  type GlobalMiddlewares,
  type PipelineStep,
  qualifiedHandler,
  referencesOf,
  resolveRef,
  type RouteInfo,
  type RoutePipeline,
  routePipeline,
  type StrapiEngine,
} from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toReferenceLocations } from '../conv';
import { setContext } from './panel';
import {
  CachedTree,
  code,
  isInstalledPath,
  isProblem,
  LOADING_MESSAGE,
  markdown,
  openAt,
  orderedRoots,
  pluginsLoading,
  projectLabel,
  relPath,
  STATUS_TEXT,
  statusIcon,
  type TreeNode,
} from './tree';

/**
 * "Routes" view: every HTTP route of every detected project — the project's API,
 * then the routes local and installed plugins declare — and, under each route,
 * what a request goes through in Strapi's order (the `config/middlewares` stack,
 * auth, policies, route middlewares, handler), each step with Strapi's verdict.
 * Read statically by the engine (no server, no boot).
 *
 * Freshness: refreshed on every index change, plus a cheap background check while
 * the view is visible so an `npm install` in a terminal shows up without an edit.
 */

type Node = TreeNode &
  (
    | { kind: 'project'; root: string; routes: RouteInfo[] }
    | { kind: 'group'; root: string; label: 'API' | 'Plugins'; routes: RouteInfo[] }
    | { kind: 'owner'; root: string; label: string; owner: string; routes: RouteInfo[] }
    | { kind: 'route'; root: string; route: RouteInfo }
    | { kind: 'global'; root: string; route: RouteInfo; steps: PipelineStep[]; global: RoutePipeline['global'] }
    | { kind: 'step'; root: string; route: RouteInfo; step: PipelineStep }
  );

export interface RouteFilter {
  methods?: string[];
  /** `auth: false` routes only. */
  publicOnly?: boolean;
  /** Routes with policies or route middlewares. */
  guardedOnly?: boolean;
  /** Routes with a step Strapi won't resolve. */
  problemsOnly?: boolean;
  /** The project's own API only (no plugin routes). */
  apiOnly?: boolean;
  /** One owner (`api::x`, `plugin::y`). */
  owner?: string;
}

const BACKGROUND_CHECK_MS = 15_000;
const ADMIN_STATE_KEY = 'strapiDevkit.routes.showAdmin';
const FILTER_STATE_KEY = 'strapiDevkit.routes.filter';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const PHASE_LABEL: Record<PipelineStep['phase'], string> = {
  'global-middleware': 'global middleware',
  auth: 'auth',
  policy: 'policy',
  'route-middleware': 'route middleware',
  handler: 'handler',
};

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}

function ownerLabel(owner: string | undefined): string {
  if (!owner) return '(unknown)';
  return owner.replace(/^api::/, '').replace(/^plugin::/, '');
}

function routeKey(r: RouteInfo): string {
  return `${r.method} ${r.fullPath ?? r.path} ${r.handler} ${r.filePath ?? ''}:${r.offset ?? ''}`;
}

export class RoutesProvider extends CachedTree<Node> {
  private data: Array<{ root: string; routes: RouteInfo[] }> | undefined;
  private loading: Promise<void> | undefined;
  private pipelines = new Map<RouteInfo, RoutePipeline>();
  private globals = new Map<string, GlobalMiddlewares>();
  showAdmin: boolean;
  filter: RouteFilter;
  /** Set by the view once created (message / description). */
  view: vscode.TreeView<Node> | undefined;

  constructor(
    private readonly engine: StrapiEngine,
    private readonly state: vscode.Memento,
  ) {
    super();
    this.showAdmin = state.get<boolean>(ADMIN_STATE_KEY, false);
    this.filter = state.get<RouteFilter>(FILTER_STATE_KEY, {});
  }

  protected override reset(): void {
    this.data = undefined;
    this.loading = undefined;
    this.pipelines.clear();
    this.globals.clear();
  }

  async setShowAdmin(v: boolean): Promise<void> {
    this.showAdmin = v;
    await this.state.update(ADMIN_STATE_KEY, v);
    setContext('strapiDevkit.routesShowAdmin', v);
    this.refresh();
  }

  async setFilter(f: RouteFilter): Promise<void> {
    this.filter = f;
    await this.state.update(FILTER_STATE_KEY, f);
    this.describeFilter();
    this.refresh();
  }

  describeFilter(): void {
    const f = this.filter;
    const parts = [
      f.methods?.length ? f.methods.join(' ') : '',
      f.publicOnly ? 'public' : '',
      f.guardedOnly ? 'guarded' : '',
      f.problemsOnly ? 'problems' : '',
      f.apiOnly ? 'API only' : '',
      f.owner ? ownerLabel(f.owner) : '',
    ].filter(Boolean);
    setContext('strapiDevkit.routesFiltered', parts.length > 0);
    if (this.view) this.view.description = parts.length ? `filter: ${parts.join(', ')}` : undefined;
  }

  /** The pipeline of a route (computed once per generation). */
  pipelineOf(root: string, route: RouteInfo): RoutePipeline | undefined {
    let p = this.pipelines.get(route);
    if (!p) {
      const project = this.engine.allProjects().find((x) => x.root === root);
      const global = this.globals.get(root);
      if (!project || !global) return undefined;
      p = routePipeline(project, route, global);
      this.pipelines.set(route, p);
    }
    return p;
  }

  /** The steps of a route that Strapi won't resolve (global stack excluded: it is shared). */
  problemsOf(root: string, route: RouteInfo): PipelineStep[] {
    return (this.pipelineOf(root, route)?.steps ?? []).filter((s) => s.phase !== 'global-middleware' && isProblem(s.status));
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const data = await this.engine.getRoutes({ admin: this.showAdmin });
        for (const p of data) this.globals.set(p.root, await this.engine.getGlobalMiddlewares(p.root));
        this.data = data;
      } catch {
        this.data = [];
      }
      if (this.view) this.view.message = pluginsLoading(this.engine) ? LOADING_MESSAGE : undefined;
    })();
    return this.loading;
  }

  private matches(root: string, r: RouteInfo): boolean {
    const f = this.filter;
    if (f.methods?.length && !r.method.toUpperCase().split(/[|,]/).some((m) => f.methods!.includes(m))) return false;
    if (f.publicOnly && !(r.public || r.auth?.mode === 'public')) return false;
    if (f.guardedOnly && !(r.policies?.length || r.middlewares?.length)) return false;
    if (f.apiOnly && r.origin !== 'project') return false;
    if (f.owner && r.owner !== f.owner) return false;
    if (f.problemsOnly && !this.problemsOf(root, r).length) return false;
    return true;
  }

  protected async build(element?: Node): Promise<Node[]> {
    if (!element) {
      await this.load();
      const projects = (this.data ?? [])
        .map((p) => ({ root: p.root, routes: p.routes.filter((r) => this.matches(p.root, r)) }))
        .filter((p) => p.routes.length);
      const roots = orderedRoots(this.engine, projects.map((p) => p.root));
      const ordered = roots.map((r) => projects.find((p) => p.root === r)!);
      if (ordered.length === 1) return this.groups(ordered[0]!.root, ordered[0]!.routes);
      return ordered.map((p) => ({ kind: 'project', id: `routes|${p.root}`, root: p.root, routes: p.routes }));
    }
    switch (element.kind) {
      case 'project':
        return this.groups(element.root, element.routes);
      case 'group': {
        const byOwner = groupBy(element.routes, (r) => r.owner ?? '');
        return [...byOwner.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([owner, routes]) => ({ kind: 'owner', id: `${element.id}|${owner}`, root: element.root, label: ownerLabel(owner), owner, routes }));
      }
      case 'owner':
        return element.routes.map((route) => ({ kind: 'route', id: `${element.id}|${routeKey(route)}`, root: element.root, route }));
      case 'route': {
        const p = this.pipelineOf(element.root, element.route);
        if (!p) return [];
        const global = p.steps.filter((s) => s.phase === 'global-middleware');
        const own = p.steps.filter((s) => s.phase !== 'global-middleware');
        const out: Node[] = [{ kind: 'global', id: `${element.id}|global`, root: element.root, route: element.route, steps: global, global: p.global }];
        own.forEach((step, i) => out.push({ kind: 'step', id: `${element.id}|${i}`, root: element.root, route: element.route, step }));
        return out;
      }
      case 'global':
        return element.steps.map((step, i) => ({ kind: 'step', id: `${element.id}|${i}`, root: element.root, route: element.route, step }));
      default:
        return [];
    }
  }

  private groups(root: string, routes: RouteInfo[]): Node[] {
    const api = routes.filter((r) => r.origin === 'project');
    const plugins = routes.filter((r) => r.origin !== 'project');
    const out: Node[] = [];
    if (api.length) out.push({ kind: 'group', id: `routes|${root}|API`, root, label: 'API', routes: api });
    if (plugins.length) out.push({ kind: 'group', id: `routes|${root}|Plugins`, root, label: 'Plugins', routes: plugins });
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'project': {
        const item = new vscode.TreeItem(projectLabel(n.root), vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        item.description = `${n.routes.length} routes`;
        item.tooltip = n.root;
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        item.description = `${n.routes.length}`;
        item.iconPath = new vscode.ThemeIcon(n.label === 'API' ? 'globe' : 'extensions');
        return item;
      }
      case 'owner': {
        const item = new vscode.TreeItem(n.label, this.filter.owner ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.id = n.id;
        const problems = n.routes.filter((r) => this.problemsOf(n.root, r).length).length;
        item.description = problems ? `${n.routes.length} · ${problems} ⚠` : `${n.routes.length}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return item;
      }
      case 'route':
        return this.routeItem(n.id, n.root, n.route);
      case 'global':
        return this.globalItem(n);
      case 'step':
        return this.stepItem(n.id, n.step);
    }
  }

  private routeItem(id: string, root: string, r: RouteInfo): vscode.TreeItem {
    const path = r.fullPath ?? r.path;
    const item = new vscode.TreeItem(`${r.method.toUpperCase()} ${path}`, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = id;
    item.description = r.handler;
    item.contextValue = r.handler !== '<inline>' ? 'strapiRoute.withHandler' : 'strapiRoute';
    const problems = this.problemsOf(root, r);
    const auth = r.auth?.mode ?? (r.public ? 'public' : 'default');
    item.iconPath = problems.length
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsErrorIcon.foreground'))
      : new vscode.ThemeIcon(auth === 'public' ? 'unlock' : r.type === 'admin' ? 'shield' : auth === 'custom' ? 'key' : auth === 'unread' ? 'question' : 'lock');
    const md = markdown();
    md.appendMarkdown(`**${r.method.toUpperCase().replace(/[^A-Z|,]/g, '')}** ${code(path)}\n\n`);
    md.appendMarkdown(`Handler: ${code(r.handler)}${qualifiedHandler(r) !== r.handler ? ` → ${code(qualifiedHandler(r))}` : ''}\n\n`);
    const authStep = this.pipelineOf(root, r)?.steps.find((s) => s.phase === 'auth');
    if (authStep?.note) md.appendMarkdown(`${auth === 'public' ? '$(unlock)' : r.type === 'admin' ? '$(shield)' : '$(lock)'} ${authStep.note}\n\n`);
    if (r.policies?.length) md.appendMarkdown(`Policies: ${r.policies.map(code).join(', ')}\n\n`);
    if (r.middlewares?.length) md.appendMarkdown(`Middlewares: ${r.middlewares.map(code).join(', ')}\n\n`);
    for (const s of problems) md.appendMarkdown(`$(warning) ${PHASE_LABEL[s.phase]} ${code(s.name)}: ${s.note ?? STATUS_TEXT[s.status]}\n\n`);
    if (r.source === 'core-router') md.appendMarkdown('_Generated by `createCoreRouter`_\n\n');
    if (r.source === 'plugin-injected') md.appendMarkdown('_Added at boot by the i18n plugin (Strapi 4)_\n\n');
    if (r.origin === 'installed-plugin') md.appendMarkdown('_Declared by an installed plugin (node_modules)_\n\n');
    if (r.filePath) md.appendMarkdown(`$(file) ${code(relPath(r.filePath))}`);
    item.tooltip = md;
    if (r.filePath) item.command = { command: 'strapiDevkit.routes.open', title: 'Open route declaration', arguments: [r.filePath, r.offset ?? 0] };
    return item;
  }

  private globalItem(n: Extract<Node, { kind: 'global' }>): vscode.TreeItem {
    const item = new vscode.TreeItem('Global middlewares', n.steps.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    const problems = n.steps.filter((s) => isProblem(s.status)).length;
    item.description =
      n.global.status === 'missing'
        ? "Strapi's default stack (no config/middlewares)"
        : n.global.status === 'not-literal'
          ? 'not read statically'
          : `${n.steps.length}${problems ? ` · ${problems} ⚠` : ''}`;
    item.iconPath = problems ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsErrorIcon.foreground')) : new vscode.ThemeIcon('layers');
    const md = markdown();
    md.appendMarkdown('The `config/middlewares` stack: every request goes through it, in this order, before the router.\n\n');
    if (n.global.status === 'not-literal') md.appendMarkdown('The stack is built at runtime (or JSON): DevKit does not list it rather than guess.\n\n');
    if (n.global.envFiles.length) md.appendMarkdown(`$(info) Replaced for some environments by ${n.global.envFiles.map((f) => code(relPath(f))).join(', ')} (depends on NODE_ENV, not merged here).\n\n`);
    if (n.global.file) md.appendMarkdown(`$(file) ${code(relPath(n.global.file))}`);
    item.tooltip = md;
    if (n.global.file) item.command = { command: 'strapiDevkit.routes.open', title: 'Open config/middlewares', arguments: [n.global.file, 0] };
    return item;
  }

  private stepItem(id: string, s: PipelineStep): vscode.TreeItem {
    const label = s.phase === 'auth' ? `Auth: ${s.name}` : s.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = id;
    const resolved = s.ref && s.ref !== s.name ? ` → ${s.ref}` : '';
    item.description = s.phase === 'auth' ? undefined : `${PHASE_LABEL[s.phase]}${resolved}`;
    item.iconPath = s.status === 'ok' ? new vscode.ThemeIcon(phaseIcon(s)) : statusIcon(s.status);
    const md = markdown();
    md.appendMarkdown(`**${PHASE_LABEL[s.phase]}** ${s.phase === 'auth' ? s.name : code(s.name)}\n\n`);
    if (s.phase !== 'auth') md.appendMarkdown(`${STATUS_TEXT[s.status]}\n\n`);
    if (s.note) md.appendMarkdown(`${s.note}\n\n`);
    if (s.target) md.appendMarkdown(`$(go-to-file) Defined in ${code(relPath(s.target.filePath))}\n\n`);
    if (s.declaredAt && s.phase !== 'auth') md.appendMarkdown(`$(file) Declared in ${code(relPath(s.declaredAt.filePath))}`);
    item.tooltip = md;
    const at = s.target ?? s.declaredAt;
    if (at) item.command = { command: 'strapiDevkit.routes.open', title: 'Open', arguments: [at.filePath, at.offset ?? 0] };
    const renamable = s.phase === 'handler' && s.status === 'ok' && !!s.target && !isInstalledPath(s.target.filePath) && !s.note;
    item.contextValue = `strapiStep${renamable ? '.handler' : ''}${s.declaredAt ? '.declared' : ''}`;
    return item;
  }
}

function phaseIcon(s: PipelineStep): string {
  switch (s.phase) {
    case 'auth':
      return s.name === 'Public' ? 'unlock' : 'key';
    case 'policy':
      return 'shield';
    case 'handler':
      return 'symbol-method';
    default:
      return 'layers';
  }
}

export interface RoutesView {
  refresh(): void;
  provider: RoutesProvider;
  /** Reveal the first route matching `pred` (clearing a filter that hides it). */
  revealRoute(root: string, pred: (r: RouteInfo) => boolean, focus?: boolean): Promise<boolean>;
  /** Show only the routes of one owner (`api::x`, `plugin::y`). */
  showOwner(owner: string): Promise<void>;
}

async function pickFilter(current: RouteFilter): Promise<RouteFilter | undefined> {
  type Item = vscode.QuickPickItem & { key: string };
  const items: Item[] = [
    ...METHODS.map((m) => ({ label: m, key: `m:${m}`, picked: current.methods?.includes(m) ?? false })),
    { label: '', key: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(unlock) Public only', description: 'auth: false', key: 'public', picked: !!current.publicOnly },
    { label: '$(shield) With policies or middlewares', key: 'guarded', picked: !!current.guardedOnly },
    { label: '$(warning) With problems', description: "a step Strapi won't resolve", key: 'problems', picked: !!current.problemsOnly },
    { label: '$(globe) Project API only', description: 'hide plugin routes', key: 'api', picked: !!current.apiOnly },
  ];
  const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Filter routes', placeHolder: 'Pick what to show (none: everything)' });
  if (!picked) return undefined;
  const keys = new Set(picked.map((p) => p.key));
  const methods = METHODS.filter((m) => keys.has(`m:${m}`));
  return {
    ...(methods.length ? { methods } : {}),
    ...(keys.has('public') ? { publicOnly: true } : {}),
    ...(keys.has('guarded') ? { guardedOnly: true } : {}),
    ...(keys.has('problems') ? { problemsOnly: true } : {}),
    ...(keys.has('api') ? { apiOnly: true } : {}),
    ...(current.owner ? { owner: current.owner } : {}),
  };
}

export function registerRoutesView(context: vscode.ExtensionContext, engine: StrapiEngine): RoutesView {
  const provider = new RoutesProvider(engine, context.workspaceState);
  const view = vscode.window.createTreeView('strapiDevkit.routes', { treeDataProvider: provider, showCollapseAll: true });
  provider.view = view;
  provider.describeFilter();
  setContext('strapiDevkit.routesShowAdmin', provider.showAdmin);

  const timer = setInterval(() => {
    // Stats only (package.json, lockfiles, install markers): a re-read fires the
    // engine's change listener, which refreshes this view.
    if (view.visible) void engine.refreshInstalledIfStale();
  }, BACKGROUND_CHECK_MS);

  const nodeRoute = (node?: Node): { root: string; route: RouteInfo } | undefined =>
    node && (node.kind === 'route' || node.kind === 'step' || node.kind === 'global') ? { root: node.root, route: node.route } : undefined;

  const routesView: RoutesView = {
    refresh: () => provider.refresh(),
    provider,
    async revealRoute(root, pred, focus = true) {
      const into = (n: Node): boolean => n.kind === 'project' || n.kind === 'group' || n.kind === 'owner';
      const find = (): Promise<Node | undefined> => provider.find((n) => n.kind === 'route' && n.root === root && pred(n.route), into);
      let node = await find();
      if (!node && Object.keys(provider.filter).length) {
        await provider.setFilter({});
        node = await find();
      }
      if (!node) return false;
      await view.reveal(node, { select: true, focus, expand: true });
      return true;
    },
    async showOwner(owner) {
      await provider.setFilter({ owner });
      await vscode.commands.executeCommand('strapiDevkit.routes.focus');
    },
  };

  context.subscriptions.push(
    view,
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand('strapiDevkit.routes.refresh', async () => {
      await engine.rescan();
      provider.refresh();
    }),
    vscode.commands.registerCommand('strapiDevkit.routes.showAdmin', () => provider.setShowAdmin(true)),
    vscode.commands.registerCommand('strapiDevkit.routes.hideAdmin', () => provider.setShowAdmin(false)),
    vscode.commands.registerCommand('strapiDevkit.routes.filter', async () => {
      const f = await pickFilter(provider.filter);
      if (f) await provider.setFilter(f);
    }),
    vscode.commands.registerCommand('strapiDevkit.routes.clearFilter', () => provider.setFilter({})),
    vscode.commands.registerCommand('strapiDevkit.routes.reveal', (root: string, route: RouteInfo, focus?: boolean) =>
      routesView.revealRoute(root, (r) => routeKey(r) === routeKey(route), focus ?? true),
    ),
    vscode.commands.registerCommand('strapiDevkit.routes.open', (filePath: string, offset: number) => openAt(filePath, offset)),
    vscode.commands.registerCommand('strapiDevkit.routes.copyPath', async (node?: Node) => {
      const r = nodeRoute(node);
      if (!r) return;
      await vscode.env.clipboard.writeText(r.route.fullPath ?? r.route.path);
      void vscode.window.setStatusBarMessage(`Copied ${r.route.fullPath ?? r.route.path}`, 2000);
    }),
    vscode.commands.registerCommand('strapiDevkit.routes.openDeclared', async (node?: Node) => {
      const at = node?.kind === 'step' ? node.step.declaredAt : undefined;
      if (at) await openAt(at.filePath, at.offset ?? 0);
    }),
    vscode.commands.registerCommand('strapiDevkit.routes.goToHandler', async (node?: Node) => {
      const r = nodeRoute(node);
      if (!r) return;
      const project = engine.allProjects().find((p) => p.root === r.root);
      // Strapi qualifies a relative handler with its owner (`page.find` in api::page → api::page.page.find).
      const target = project ? resolveRef(project, qualifiedHandler(r.route))[0] : undefined;
      if (!target) {
        void vscode.window.showInformationMessage(`DevKit for Strapi: no source found for handler '${r.route.handler}'.`);
        return;
      }
      await openAt(target.filePath, target.offset ?? 0);
    }),
    vscode.commands.registerCommand('strapiDevkit.routes.handlerReferences', async (node?: Node) => {
      const r = nodeRoute(node);
      const project = r && engine.allProjects().find((p) => p.root === r.root);
      if (!r || !project) return;
      const handler = qualifiedHandler(r.route);
      const target = resolveRef(project, handler)[0];
      const refs = referencesOf(project, handler);
      if (!target || !refs.length) {
        void vscode.window.showInformationMessage(`DevKit for Strapi: no Strapi reference to '${handler}' found.`);
        return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target.filePath));
      await vscode.commands.executeCommand('editor.action.showReferences', doc.uri, doc.positionAt(target.offset ?? 0), toReferenceLocations(refs));
    }),
  );
  return routesView;
}
