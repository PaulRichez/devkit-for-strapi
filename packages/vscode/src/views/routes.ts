import { paths, resolveRef, type RouteInfo, type StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';

/**
 * "Strapi Routes" view (Explorer): every HTTP route of every detected project —
 * the project's own API, then the routes local and installed plugins declare —
 * read statically by the engine (no server, no boot). Clicking a route opens
 * its declaration; the inline action jumps to the controller method.
 *
 * Freshness: refreshed on every index change (file watcher, installed-plugin
 * re-read), plus a cheap background check while the view is visible so an
 * `npm install` in a terminal shows up without touching a file.
 */

type Node =
  | { kind: 'project'; root: string; routes: RouteInfo[] }
  | { kind: 'group'; root: string; label: string; routes: RouteInfo[] }
  | { kind: 'owner'; root: string; label: string; routes: RouteInfo[] }
  | { kind: 'route'; root: string; route: RouteInfo };

const BACKGROUND_CHECK_MS = 15_000;
const ADMIN_STATE_KEY = 'strapiDevkit.routes.showAdmin';

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

export interface RoutesView {
  refresh(): void;
}

class RoutesProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private data: Array<{ root: string; routes: RouteInfo[] }> = [];
  private loading: Promise<void> | undefined;
  showAdmin: boolean;

  constructor(
    private readonly engine: StrapiEngine,
    private readonly state: vscode.Memento,
  ) {
    this.showAdmin = state.get<boolean>(ADMIN_STATE_KEY, false);
  }

  async setShowAdmin(v: boolean): Promise<void> {
    this.showAdmin = v;
    await this.state.update(ADMIN_STATE_KEY, v);
    await vscode.commands.executeCommand('setContext', 'strapiDevkit.routesShowAdmin', v);
    this.refresh();
  }

  refresh(): void {
    this.loading = undefined;
    this.emitter.fire(undefined);
  }

  private async load(): Promise<void> {
    this.loading ??= this.engine
      .getRoutes({ admin: this.showAdmin })
      .then((d) => {
        this.data = d;
      })
      .catch(() => {
        this.data = [];
      });
    return this.loading;
  }

  async getChildren(element?: Node): Promise<Node[]> {
    if (!element) {
      await this.load();
      const projects = this.data.filter((p) => p.routes.length);
      if (projects.length === 1) return this.groups(projects[0]!.root, projects[0]!.routes);
      return projects.map((p) => ({ kind: 'project', root: p.root, routes: p.routes }));
    }
    switch (element.kind) {
      case 'project':
        return this.groups(element.root, element.routes);
      case 'group':
      case 'owner': {
        if (element.kind === 'group') {
          const byOwner = groupBy(element.routes, (r) => r.owner ?? '');
          return [...byOwner.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([owner, routes]) => ({ kind: 'owner', root: element.root, label: ownerLabel(owner), routes }));
        }
        return element.routes.map((route) => ({ kind: 'route', root: element.root, route }));
      }
      default:
        return [];
    }
  }

  private groups(root: string, routes: RouteInfo[]): Node[] {
    const api = routes.filter((r) => r.origin === 'project');
    const plugins = routes.filter((r) => r.origin !== 'project');
    const out: Node[] = [];
    if (api.length) out.push({ kind: 'group', root, label: 'API', routes: api });
    if (plugins.length) out.push({ kind: 'group', root, label: 'Plugins', routes: plugins });
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'project': {
        const item = new vscode.TreeItem(paths.basename(n.root), vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${n.routes.length} routes`;
        item.tooltip = n.root;
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      }
      case 'group': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Expanded);
        item.description = `${n.routes.length}`;
        item.iconPath = new vscode.ThemeIcon(n.label === 'API' ? 'globe' : 'extensions');
        return item;
      }
      case 'owner': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.description = `${n.routes.length}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        return item;
      }
      case 'route': {
        const r = n.route;
        const path = r.fullPath ?? r.path;
        const item = new vscode.TreeItem(`${r.method.toUpperCase()} ${path}`, vscode.TreeItemCollapsibleState.None);
        item.description = r.handler;
        item.contextValue = r.handler !== '<inline>' ? 'strapiRoute.withHandler' : 'strapiRoute';
        item.iconPath = new vscode.ThemeIcon(r.public ? 'unlock' : r.type === 'admin' ? 'shield' : 'lock');
        const md = new vscode.MarkdownString(undefined, true);
        md.appendMarkdown(`**${r.method.toUpperCase()}** \`${path}\`\n\n`);
        md.appendMarkdown(`Handler: \`${r.handler}\`\n\n`);
        md.appendMarkdown(r.public ? '$(unlock) Public (`auth: false`)\n\n' : r.type === 'admin' ? '$(shield) Admin panel route\n\n' : '$(lock) Authenticated\n\n');
        if (r.policies?.length) md.appendMarkdown(`Policies: ${r.policies.map((p) => `\`${p}\``).join(', ')}\n\n`);
        if (r.middlewares?.length) md.appendMarkdown(`Middlewares: ${r.middlewares.map((m) => `\`${m}\``).join(', ')}\n\n`);
        if (r.source === 'core-router') md.appendMarkdown('_Generated by `createCoreRouter`_\n\n');
        if (r.source === 'plugin-injected') md.appendMarkdown('_Added at boot by the i18n plugin (Strapi 4)_\n\n');
        if (r.origin === 'installed-plugin') md.appendMarkdown('_Declared by an installed plugin (node_modules)_\n\n');
        if (r.filePath) md.appendMarkdown(`$(file) ${vscode.workspace.asRelativePath(r.filePath)}`);
        item.tooltip = md;
        if (r.filePath) {
          item.command = {
            command: 'strapiDevkit.routes.open',
            title: 'Open route declaration',
            arguments: [r.filePath, r.offset ?? 0],
          };
        }
        return item;
      }
    }
  }
}

async function openAt(filePath: string, offset: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const pos = doc.positionAt(offset);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
}

export function registerRoutesView(context: vscode.ExtensionContext, engine: StrapiEngine): RoutesView {
  const provider = new RoutesProvider(engine, context.workspaceState);
  const view = vscode.window.createTreeView('strapiDevkit.routes', { treeDataProvider: provider, showCollapseAll: true });
  void vscode.commands.executeCommand('setContext', 'strapiDevkit.routesShowAdmin', provider.showAdmin);

  const timer = setInterval(() => {
    // Stats only (package.json, lockfiles, install markers): a re-read fires the
    // engine's change listener, which refreshes this view.
    if (view.visible) void engine.refreshInstalledIfStale();
  }, BACKGROUND_CHECK_MS);

  context.subscriptions.push(
    view,
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand('strapiDevkit.routes.refresh', async () => {
      await engine.rescan();
      provider.refresh();
    }),
    vscode.commands.registerCommand('strapiDevkit.routes.showAdmin', () => provider.setShowAdmin(true)),
    vscode.commands.registerCommand('strapiDevkit.routes.hideAdmin', () => provider.setShowAdmin(false)),
    vscode.commands.registerCommand('strapiDevkit.routes.open', (filePath: string, offset: number) => openAt(filePath, offset)),
    vscode.commands.registerCommand('strapiDevkit.routes.goToHandler', async (node?: Node) => {
      if (!node || node.kind !== 'route') return;
      const project = engine.allProjects().find((p) => p.root === node.root);
      // Strapi qualifies a relative handler with its owner (`page.find` in api::page → api::page.page.find).
      const h = node.route.handler;
      const qualified = h.includes('::') || !node.route.owner ? h : `${node.route.owner}.${h}`;
      const target = project ? resolveRef(project, qualified)[0] : undefined;
      if (!target) {
        void vscode.window.showInformationMessage(`DevKit for Strapi: no source found for handler '${node.route.handler}'.`);
        return;
      }
      await openAt(target.filePath, target.offset ?? 0);
    }),
  );
  return provider;
}
