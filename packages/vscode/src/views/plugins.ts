import {
  type CodeArtifact,
  type ContentType,
  type FileSystem,
  type InstalledPlugin,
  paths,
  pluginKeyOffsets,
  type PluginInfo,
  projectInfo,
  type StrapiEngine,
  type StrapiProject,
} from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import type { RoutesView } from './routes';
import { CachedTree, code, LOADING_MESSAGE, markdown, openAt, orderedRoots, pluginsLoading, projectLabel, relPath, type TreeNode } from './tree';

/**
 * "Plugins" view: the plugins that run in each project (local and installed), what
 * each one adds (content-types, services, controllers, policies, middlewares,
 * routes), and whether DevKit verifies the refs into it — when not, why, in plain
 * words. Disabled plugins and plugins your code rewrites or extends say so.
 */

interface PluginEntry {
  name: string;
  source: 'local' | 'installed';
  info?: PluginInfo;
  installed?: InstalledPlugin;
  contentTypes: ContentType[];
  artifacts: CodeArtifact[];
  routes: number;
  /** Project files that rewrite it at runtime. */
  rewrittenBy: string[];
  /** `src/extensions/<name>` exists. */
  extensionDir?: string;
}

interface Disabled {
  name: string;
  file?: string;
}

interface ProjectPlugins {
  root: string;
  plugins: PluginEntry[];
  disabled: Disabled[];
  configFile?: string;
  keyOffsets: Map<string, number>;
}

type Node = TreeNode &
  (
    | { kind: 'project'; root: string }
    | { kind: 'section'; root: string; section: 'local' | 'installed' | 'disabled' }
    | { kind: 'plugin'; root: string; plugin: PluginEntry }
    | { kind: 'disabled'; root: string; plugin: Disabled }
    | { kind: 'group'; root: string; plugin: PluginEntry; group: 'content-types' | CodeArtifact['kind'] }
    | { kind: 'ct'; root: string; ct: ContentType }
    | { kind: 'artifact'; root: string; artifact: CodeArtifact }
    | { kind: 'action'; root: string; artifact: CodeArtifact; action: NonNullable<CodeArtifact['actions']>[number] }
    | { kind: 'routes'; root: string; plugin: PluginEntry }
    | { kind: 'note'; root: string; plugin: PluginEntry; note: 'rewritten' | 'extended'; file: string }
  );

const GROUP_LABEL: Record<string, [string, string]> = {
  'content-types': ['Content-types', 'database'],
  service: ['Services', 'symbol-class'],
  controller: ['Controllers', 'symbol-interface'],
  policy: ['Policies', 'shield'],
  middleware: ['Middlewares', 'layers'],
};

export class PluginsProvider extends CachedTree<Node> {
  private data = new Map<string, ProjectPlugins>();
  private loading: Promise<void> | undefined;
  view: vscode.TreeView<Node> | undefined;

  constructor(
    private readonly engine: StrapiEngine,
    private readonly fs: FileSystem,
  ) {
    super();
  }

  protected override reset(): void {
    this.data.clear();
    this.loading = undefined;
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      const summaries = this.engine.getProjects();
      for (const project of this.engine.allProjects()) {
        try {
          this.data.set(project.root, await this.read(project, summaries.find((s) => s.root === project.root)));
        } catch {
          /* a project whose plugins can't be listed shows nothing */
        }
      }
      if (this.view) this.view.message = pluginsLoading(this.engine) ? LOADING_MESSAGE : undefined;
    })();
    return this.loading;
  }

  private async read(project: StrapiProject, summary: ReturnType<StrapiEngine['getProjects']>[number] | undefined): Promise<ProjectPlugins> {
    const routes = (await this.engine.getRoutes({ admin: true, root: project.root }))[0]?.routes ?? [];
    const info = summary ? await projectInfo(this.fs, project, summary, { routes: routes.filter((r) => r.type !== 'admin') }) : undefined;
    const idx = project.index;
    const routeCount = (name: string): number => routes.filter((r) => r.owner === `plugin::${name}`).length;
    const rewrittenBy = (name: string): string[] =>
      [...(project.rewrites?.files.entries() ?? [])].filter(([, r]) => r.plugins.has(name) || r.plugins.has('*')).map(([f]) => f);
    const extensionDir = async (name: string): Promise<string | undefined> => {
      const d = paths.join(project.srcDir, 'extensions', name);
      return (await this.fs.stat(d)) ? d : undefined;
    };
    const plugins: PluginEntry[] = [];
    for (const name of [...idx.pluginNames].sort()) {
      plugins.push({
        name,
        source: 'local',
        info: info?.plugins.find((p) => p.name === name && p.source === 'local'),
        contentTypes: [...idx.contentTypes.values(), ...(idx.codeContentTypes?.values() ?? [])].filter((c) => !c.installed && c.pluginName === name && c.source === 'plugin'),
        artifacts: [...idx.services.values(), ...idx.controllers.values(), ...idx.policies.values(), ...idx.middlewares.values()].filter((a) => !a.installed && a.scope === 'plugin' && a.pluginName === name),
        routes: routeCount(name),
        rewrittenBy: rewrittenBy(name),
        extensionDir: await extensionDir(name),
      });
    }
    for (const p of [...(project.installed?.plugins ?? [])].sort((a, b) => a.name.localeCompare(b.name))) {
      if (idx.pluginNames.has(p.name)) continue; // a local plugin of that name wins
      plugins.push({
        name: p.name,
        source: 'installed',
        info: info?.plugins.find((x) => x.name === p.name && x.source === 'installed'),
        installed: p,
        contentTypes: p.contentTypes,
        artifacts: p.artifacts,
        routes: routeCount(p.name),
        rewrittenBy: rewrittenBy(p.name),
        extensionDir: await extensionDir(p.name),
      });
    }
    const config = project.installed?.config;
    const disabled: Disabled[] = [];
    for (const [name, d] of config?.declarations ?? []) if (d.enabled === false) disabled.push({ name, file: config?.file });
    let keyOffsets = new Map<string, number>();
    if (config?.file) {
      try {
        keyOffsets = pluginKeyOffsets(config.file, await this.fs.readFile(config.file));
      } catch {
        /* open at the top */
      }
    }
    return { root: project.root, plugins, disabled, configFile: config?.file, keyOffsets };
  }

  configLocation(root: string, name: string): { file: string; offset: number } | undefined {
    const d = this.data.get(root);
    return d?.configFile ? { file: d.configFile, offset: d.keyOffsets.get(name) ?? 0 } : undefined;
  }

  protected async build(element?: Node): Promise<Node[]> {
    if (!element) {
      await this.load();
      const roots = orderedRoots(this.engine, [...this.data.keys()]);
      if (roots.length === 1) return this.sections(roots[0]!);
      return roots.map((root) => ({ kind: 'project', id: `plugins|${root}`, root }));
    }
    const d = this.data.get(element.root);
    if (!d) return [];
    switch (element.kind) {
      case 'project':
        return this.sections(element.root);
      case 'section':
        if (element.section === 'disabled') return d.disabled.map((plugin) => ({ kind: 'disabled', id: `${element.id}|${plugin.name}`, root: d.root, plugin }));
        return d.plugins.filter((p) => p.source === element.section).map((plugin) => ({ kind: 'plugin', id: `${element.id}|${plugin.name}`, root: d.root, plugin }));
      case 'plugin': {
        const p = element.plugin;
        const out: Node[] = [];
        if (p.contentTypes.length) out.push({ kind: 'group', id: `${element.id}|content-types`, root: d.root, plugin: p, group: 'content-types' });
        for (const k of ['service', 'controller', 'policy', 'middleware'] as const) {
          if (p.artifacts.some((a) => a.kind === k)) out.push({ kind: 'group', id: `${element.id}|${k}`, root: d.root, plugin: p, group: k });
        }
        if (p.routes) out.push({ kind: 'routes', id: `${element.id}|routes`, root: d.root, plugin: p });
        for (const f of p.rewrittenBy) out.push({ kind: 'note', id: `${element.id}|rw|${f}`, root: d.root, plugin: p, note: 'rewritten', file: f });
        if (p.extensionDir) out.push({ kind: 'note', id: `${element.id}|ext`, root: d.root, plugin: p, note: 'extended', file: p.extensionDir });
        return out;
      }
      case 'group': {
        const p = element.plugin;
        if (element.group === 'content-types') return p.contentTypes.map((ct) => ({ kind: 'ct', id: `${element.id}|${ct.uid}`, root: d.root, ct }));
        return p.artifacts.filter((a) => a.kind === element.group).map((artifact) => ({ kind: 'artifact', id: `${element.id}|${artifact.ref}`, root: d.root, artifact }));
      }
      case 'artifact':
        return (element.artifact.actions ?? []).map((action) => ({ kind: 'action', id: `${element.id}|${action.name}`, root: d.root, artifact: element.artifact, action }));
      default:
        return [];
    }
  }

  private sections(root: string): Node[] {
    const d = this.data.get(root);
    if (!d) return [];
    const out: Node[] = [];
    if (d.plugins.some((p) => p.source === 'local')) out.push({ kind: 'section', id: `plugins|${root}|local`, root, section: 'local' });
    if (d.plugins.some((p) => p.source === 'installed')) out.push({ kind: 'section', id: `plugins|${root}|installed`, root, section: 'installed' });
    if (d.disabled.length) out.push({ kind: 'section', id: `plugins|${root}|disabled`, root, section: 'disabled' });
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    switch (n.kind) {
      case 'project': {
        const item = new vscode.TreeItem(projectLabel(n.root), vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        item.tooltip = n.root;
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      }
      case 'section': {
        const d = this.data.get(n.root);
        const label = n.section === 'local' ? 'Local' : n.section === 'installed' ? 'Installed' : 'Disabled in config/plugins';
        const item = new vscode.TreeItem(label, n.section === 'disabled' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        const list = n.section === 'disabled' ? d?.disabled ?? [] : (d?.plugins ?? []).filter((p) => p.source === n.section);
        const unverified = n.section === 'disabled' ? 0 : (list as PluginEntry[]).filter((p) => p.info && p.info.verified !== true).length;
        item.description = unverified ? `${list.length} · ${unverified} not verified` : `${list.length}`;
        item.iconPath = new vscode.ThemeIcon(n.section === 'local' ? 'folder-library' : n.section === 'installed' ? 'package' : 'circle-slash');
        item.tooltip = n.section === 'local' ? 'Plugins in src/plugins (or resolved from config/plugins).' : n.section === 'installed' ? 'Plugins read from node_modules the way Strapi loads them, without running their code.' : 'Declared with `enabled: false`.';
        return item;
      }
      case 'plugin':
        return this.pluginItem(n.id, n.root, n.plugin);
      case 'disabled': {
        const item = new vscode.TreeItem(n.plugin.name, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = 'enabled: false';
        item.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('disabledForeground'));
        const at = this.configLocation(n.root, n.plugin.name);
        if (at) item.command = { command: 'strapiDevkit.open', title: 'Open in config/plugins', arguments: [at.file, at.offset] };
        return item;
      }
      case 'group': {
        const [label, icon] = GROUP_LABEL[n.group]!;
        const count = n.group === 'content-types' ? n.plugin.contentTypes.length : n.plugin.artifacts.filter((a) => a.kind === n.group).length;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = n.id;
        item.description = `${count}`;
        item.iconPath = new vscode.ThemeIcon(icon);
        return item;
      }
      case 'ct': {
        const ct = n.ct;
        const item = new vscode.TreeItem(ct.info.displayName ?? ct.ctName, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = ct.uid + (ct.partialAttributes ? ' · partial' : '');
        item.iconPath = new vscode.ThemeIcon(ct.kind === 'singleType' ? 'file' : 'files');
        item.command = { command: 'strapiDevkit.model.reveal', title: 'Show in Model', arguments: [n.root, ct.uid] };
        item.tooltip = 'Show in the Model view (its fields and who points at it)';
        return item;
      }
      case 'artifact': {
        const a = n.artifact;
        const actions = a.actions?.length ?? 0;
        const item = new vscode.TreeItem(a.name, actions ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = [a.ref, actions ? `${actions} action${actions === 1 ? '' : 's'}${a.hasSpread ? '+' : ''}` : ''].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(GROUP_LABEL[a.kind]![1]);
        item.tooltip = `${a.ref}\n${relPath(a.filePath)}${a.hasSpread ? '\nIts action list is partial (spread object).' : ''}`;
        item.command = { command: 'strapiDevkit.open', title: 'Open', arguments: [a.filePath, a.defOffset ?? 0] };
        return item;
      }
      case 'action': {
        const item = new vscode.TreeItem(n.action.name, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = n.action.signature;
        item.iconPath = new vscode.ThemeIcon('symbol-method');
        item.command = { command: 'strapiDevkit.open', title: 'Open', arguments: [n.action.filePath ?? n.artifact.filePath, n.action.offset] };
        item.contextValue = n.artifact.installed ? 'strapiPlugin.action.readonly' : 'strapiPlugin.action';
        return item;
      }
      case 'routes': {
        const item = new vscode.TreeItem('Routes', vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = `${n.plugin.routes}`;
        item.iconPath = new vscode.ThemeIcon('globe');
        item.tooltip = 'Show these routes in the Routes view';
        item.command = { command: 'strapiDevkit.routes.showOwner', title: 'Show routes', arguments: [`plugin::${n.plugin.name}`] };
        return item;
      }
      case 'note': {
        const rewritten = n.note === 'rewritten';
        const item = new vscode.TreeItem(rewritten ? 'Rewritten by your code' : 'Extended in src/extensions', vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = relPath(n.file);
        item.iconPath = new vscode.ThemeIcon(rewritten ? 'edit' : 'extensions');
        item.tooltip = rewritten
          ? 'This file changes the plugin at runtime (assigns or replaces part of it): DevKit cannot verify refs into it.'
          : 'Strapi merges this folder over the plugin (schemas, `strapi-server`): what the plugin registers may differ from its package.';
        item.command = rewritten ? { command: 'strapiDevkit.open', title: 'Open', arguments: [n.file, 0] } : { command: 'revealInExplorer', title: 'Reveal', arguments: [vscode.Uri.file(n.file)] };
        return item;
      }
    }
  }

  private pluginItem(id: string, root: string, p: PluginEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(p.name, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = id;
    const verified = p.info?.verified;
    const version = p.installed?.version ?? p.info?.version;
    item.description = [version, verified === undefined ? '' : verified === 'partial' ? 'verified in part' : verified ? 'verified' : 'not verified'].filter(Boolean).join(' · ');
    item.iconPath =
      verified === false
        ? new vscode.ThemeIcon('question', new vscode.ThemeColor('descriptionForeground'))
        : new vscode.ThemeIcon(p.source === 'local' ? 'folder-library' : 'package', verified === true ? new vscode.ThemeColor('testing.iconPassed') : undefined);
    const md = markdown();
    md.appendMarkdown(`**${p.name}**${p.installed ? ` — ${code(p.installed.packageName)}${version ? ` ${version}` : ''}` : ' — local plugin'}\n\n`);
    if (p.installed) md.appendMarkdown(`${p.installed.origin === 'internal' ? "Strapi's own plugin" : 'A dependency declaring itself a Strapi plugin'}\n\n`);
    if (p.installed?.enabled === 'uncertain') md.appendMarkdown('$(info) Enabled unless a config DevKit cannot read (env-specific or computed) turns it off.\n\n');
    md.appendMarkdown(
      verified === 'partial'
        ? '$(info) Checked in part: some of its collections are built by code DevKit cannot read — a name it does not see there is not checked.\n\n'
        : verified
          ? '$(pass) DevKit read it completely: refs into it are checked like your own.\n\n'
          : '$(question) Refs into it are **not** checked (never reported as broken).\n\n',
    );
    if (verified !== true && p.info?.why?.length) md.appendMarkdown(`Why: ${p.info.why.join('; ')}\n\n`);
    md.appendMarkdown(`${p.contentTypes.length} content-types · ${p.artifacts.length} services/controllers/policies/middlewares · ${p.routes} routes`);
    item.tooltip = md;
    item.contextValue = `strapiPlugin.${p.source}`;
    return item;
  }
}

export interface PluginsView {
  refresh(): void;
  provider: PluginsProvider;
}

export function registerPluginsView(context: vscode.ExtensionContext, engine: StrapiEngine, fs: FileSystem, routes: RoutesView): PluginsView {
  const provider = new PluginsProvider(engine, fs);
  const view = vscode.window.createTreeView('strapiDevkit.plugins', { treeDataProvider: provider, showCollapseAll: true });
  provider.view = view;
  const pluginOf = (node?: Node): PluginEntry | undefined => (node?.kind === 'plugin' ? node.plugin : undefined);

  context.subscriptions.push(
    view,
    vscode.commands.registerCommand('strapiDevkit.routes.showOwner', (owner: string) => routes.showOwner(owner)),
    vscode.commands.registerCommand('strapiDevkit.plugins.reveal', async (root: string, name: string) => {
      const into = (n: Node): boolean => n.kind === 'project' || n.kind === 'section';
      const node = await provider.find((n) => n.kind === 'plugin' && n.root === root && n.plugin.name === name, into);
      if (node) await view.reveal(node, { select: true, focus: true, expand: true });
    }),
    vscode.commands.registerCommand('strapiDevkit.plugins.openConfig', async (node?: Node) => {
      const p = pluginOf(node);
      const at = node && p ? provider.configLocation(node.root, p.name) : undefined;
      if (at) await openAt(at.file, at.offset);
      else void vscode.window.showInformationMessage('DevKit for Strapi: this project has no config/plugins file.');
    }),
    vscode.commands.registerCommand('strapiDevkit.plugins.openEntry', async (node?: Node) => {
      const p = pluginOf(node);
      const file = p?.installed?.entry ?? p?.artifacts[0]?.filePath;
      if (file) await openAt(file, 0);
    }),
    vscode.commands.registerCommand('strapiDevkit.plugins.openPackage', async (node?: Node) => {
      const p = pluginOf(node);
      if (p?.installed) await openAt(paths.join(p.installed.dir, 'package.json'), 0);
    }),
  );
  return { refresh: () => provider.refresh(), provider };
}
