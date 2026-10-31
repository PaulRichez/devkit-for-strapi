import { createEngine, paths, type StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { VscodeFileSystem } from './fileSystem';
import { registerDefinitionProvider } from './providers/definition';
import { registerDiagnostics } from './providers/diagnostics';
import { registerCompletionProvider } from './providers/completion';
import { registerHoverProvider } from './providers/hover';
import { registerReferenceProvider } from './providers/references';
import { registerCodeLensProvider } from './providers/codeLens';
import { registerRenameProvider } from './providers/rename';
import { registerRoutesCodeLens } from './providers/routesCodeLens';
import { registerWorkspaceSymbols } from './providers/workspaceSymbols';
import { registerDiagram } from './views/diagram';
import { registerFollow } from './views/follow';
import { RefreshBus, setContext } from './views/panel';
import { registerConfigSyncDiagnostics } from './providers/configSyncDiagnostics';
import { ConfigSyncCache, type ConfigSyncProvider, registerConfigSyncView } from './views/configSync';
import { ConfigSyncDb, type OpenEntry, registerConfigSyncDb, runtimeEnv } from './views/configSyncDb';
import { type HealthProvider, registerHealthView } from './views/health';
import { type ModelProvider, registerModelView } from './views/model';
import { type PluginsProvider, registerPluginsView } from './views/plugins';
import { registerRefactorCommands } from './views/refactor';
import { registerRoutesView, type RoutesProvider } from './views/routes';
import { openAt, pluginsLoading } from './views/tree';
import { createLicenseManager, type LicenseManager } from './license';
import { registerOfferNotice } from './offer';

/** What `activate` returns: read access to the panel's trees (integration tests). */
export interface DevkitExports {
  views: { routes: RoutesProvider; model: ModelProvider; health: HealthProvider; plugins: PluginsProvider; configSync: ConfigSyncProvider };
  /** Config Sync through the project's Strapi (Pro): its state per project, export and import without the confirmations (tests). */
  configSyncDb: ConfigSyncDb;
  /** The config-sync entry open in the active editor, which its title can export or import (tests). */
  configSyncEditorEntry: () => OpenEntry | undefined;
  /** Whether the workspace got DevKit's presence: the MCP servers it offers, how often it told the editor to ask again, the status bar item shown (tests). */
  presence: { mcpServers: () => Promise<number>; mcpRefreshes: () => number; statusShown: () => boolean; ready: Promise<void> };
}

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => paths.normalize(f.uri.fsPath));
}

/**
 * Offer the bundled MCP server (`dist/mcp.js`) to MCP clients (e.g. Copilot
 * agent mode) — same engine as the extension, exposed to agents. Spawned via
 * VS Code's own Node (Electron-as-node), so it needs no separate install; the
 * workspace folders are passed so it indexes the same projects. Only in a
 * workspace with a Strapi project: elsewhere its tool definitions would ride along
 * with every agent request for nothing. `refresh` re-offers it (the projects changed).
 */
function registerMcpServer(
  context: vscode.ExtensionContext,
  license: LicenseManager,
  hasProject: () => Promise<boolean>,
): { refresh: () => void; definitions: () => Promise<vscode.McpServerDefinition[]>; refreshes: () => number } {
  const definitions = async (): Promise<vscode.McpServerDefinition[]> => {
    if (!(await hasProject())) return [];
    // Forward the editor's licence key so the bundled MCP gates its Pro tools
    // with the same key entered here — set once, unlocks both surfaces.
    // The runtime settings too: the bundled server runs config-sync the way the editor does.
    const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1', ...runtimeEnv() };
    const key = await license.getKey();
    if (key) env.DEVKIT_LICENSE_KEY = key;
    return [new vscode.McpStdioServerDefinition('DevKit for Strapi', process.execPath, [context.asAbsolutePath('dist/mcp.js'), ...workspaceFolderPaths()], env)];
  };
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') return { refresh: () => undefined, definitions, refreshes: () => 0 };
  const didChange = new vscode.EventEmitter<void>();
  let refreshes = 0;
  const refresh = (): void => {
    refreshes++;
    didChange.fire();
  };
  context.subscriptions.push(
    didChange,
    vscode.lm.registerMcpServerDefinitionProvider('strapiDevkit.mcp', {
      onDidChangeMcpServerDefinitions: didChange.event,
      provideMcpServerDefinitions: definitions,
    }),
    // Re-offer with the new folder set, or when the licence key changes.
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    license.onDidChange(refresh),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('strapiDevkit.runtime') || e.affectsConfiguration('strapiDevkit.configSync')) refresh();
    }),
  );
  return { refresh, definitions, refreshes: () => refreshes };
}

export function activate(context: vscode.ExtensionContext): DevkitExports | undefined {
  try {
    return activateImpl(context);
  } catch (err) {
    // Surface any synchronous activation failure instead of dying silently.
    void vscode.window.showErrorMessage(`DevKit for Strapi failed to activate: ${String(err)}`);
    throw err;
  }
}

function activateImpl(context: vscode.ExtensionContext): DevkitExports | undefined {
  if (!vscode.workspace.getConfiguration('strapiDevkit').get<boolean>('enable', true)) {
    void vscode.window.showWarningMessage('DevKit for Strapi is disabled (strapiDevkit.enable = false).');
    return undefined;
  }

  const output = vscode.window.createOutputChannel('DevKit for Strapi');
  const status = vscode.window.createStatusBarItem('strapiDevkit.status', vscode.StatusBarAlignment.Left, 50);
  status.name = 'DevKit for Strapi';
  status.command = 'workbench.view.extension.strapiDevkit';
  context.subscriptions.push(output, status);

  const fs = new VscodeFileSystem();
  const engine = createEngine(fs);
  const license = createLicenseManager(context);
  const bus = new RefreshBus();
  context.subscriptions.push(bus);

  // Register language features synchronously — they work as soon as init resolves.
  registerDefinitionProvider(context, engine);
  registerHoverProvider(context, engine);
  registerReferenceProvider(context, engine);
  registerRenameProvider(context, engine, fs, license.isLicensed);
  const codeLenses = registerCodeLensProvider(context, engine);
  const routeLenses = registerRoutesCodeLens(context, engine);
  // config-sync's files, read once per index generation for every surface showing them.
  const configSync = new ConfigSyncCache(engine, fs);
  const routesView = registerRoutesView(context, engine, configSync);
  const modelView = registerModelView(context, engine, routesView, configSync);
  const healthView = registerHealthView(context, engine, fs, configSync);
  const configSyncDb = new ConfigSyncDb(context, license.isLicensed);
  const configSyncView = registerConfigSyncView(context, engine, configSync, configSyncDb);
  const configSyncEditorEntry = registerConfigSyncDb(context, configSyncDb, async (node) => {
    const root = typeof node === 'string' ? node : (node as { root?: string } | undefined)?.root;
    if (root) return root;
    // From the palette (or a view button with nothing selected): a project that uses config-sync —
    // the active editor's when it does, the only one, else ask. Never another project's code.
    const roots = (await configSync.all()).map((x) => paths.normalize(x.root));
    if (!roots.length) {
      void vscode.window.showInformationMessage('DevKit for Strapi: no project in this workspace uses strapi-plugin-config-sync.');
      return undefined;
    }
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const mine = active ? engine.projectForFile(paths.normalize(active))?.root : undefined;
    if (mine && roots.includes(paths.normalize(mine))) return mine;
    if (roots.length === 1) return roots[0];
    const pick = await vscode.window.showQuickPick(
      roots.map((r) => ({ label: paths.basename(r), description: r, root: r })),
      { title: 'Config Sync: which project?' },
    );
    return pick?.root;
  });
  const configSyncDiagnostics = registerConfigSyncDiagnostics(context, configSync);
  const pluginsView = registerPluginsView(context, engine, fs, routesView);
  registerRefactorCommands(context, engine, fs, license.isLicensed);
  registerFollow(context, engine, modelView, routesView);
  const diagram = registerDiagram(context, engine, modelView, license.isLicensed);
  registerWorkspaceSymbols(context, engine);
  // Shown only in a workspace with a Strapi project (or while re-reading one, or on a failure).
  let statusShown = false;
  context.subscriptions.push(
    healthView.provider.onDidCount((n) => {
      statusShown = updateStatus(engine, status, n);
    }),
  );
  const diagnostics = registerDiagnostics(context, engine);
  registerCompletionProvider(context, engine);

  // Every surface showing index data refreshes on one debounced signal.
  bus.event(() => {
    configSync.clear(); // before the views read it again
    codeLenses.refresh();
    routeLenses.refresh();
    routesView.refresh();
    modelView.refresh();
    healthView.refresh();
    pluginsView.refresh();
    configSyncView.refresh();
    void configSyncDiagnostics.refresh();
    // The view is hidden until a project uses config-sync: the key can't wait for it to load.
    void configSync.all().then((all) => setContext('strapiDevkit.configSync', all.length > 0));
    diagram.refresh();
    diagnostics.revalidateAll(); // the index changed → refresh open files
    statusShown = updateStatus(engine, status, healthView.provider.count); // counts include installed plugins once they land
    setContext('strapiDevkit.hasProject', engine.getProjects().length > 0);
    setContext('strapiDevkit.pluginsLoading', pluginsLoading(engine));
  });
  // The reference index landing, installed plugins re-read.
  engine.onReferencesChanged(() => bus.fire());
  registerFileWatcher(context, engine, bus);

  // Pro entries stay visible; this key lets menus mark them (and future Pro views appear).
  const updatePro = async (): Promise<void> => setContext('strapiDevkit.pro', await license.isLicensed());
  void updatePro();
  context.subscriptions.push(
    license.onDidChange(() => {
      void updatePro();
      void configSyncView.updateLicence();
    }),
    vscode.commands.registerCommand('strapiDevkit.open', (filePath: string, offset?: number) => openAt(filePath, offset ?? 0)),
  );

  registerOfferNotice(
    context,
    license.isLicensed,
    async () => (await license.getKey()) !== undefined,
    () => engine.getProjects().length > 0,
  );

  // Re-index when the workspace folders actually change. Guarded by a signature
  // so a spurious folder event at startup doesn't trigger a second scan/log.
  let lastSig = '';
  const applyFolders = async (): Promise<void> => {
    const folders = workspaceFolderPaths();
    const sig = folders.join('|');
    if (sig === lastSig) return;
    lastSig = sig;

    output.appendLine(`[init] scanning ${folders.length} workspace folder(s):`);
    for (const f of folders) output.appendLine(`  - ${f}`);
    // A workspace not known to hold a Strapi project gets no status bar item while it is scanned.
    if (engine.getProjects().length) {
      status.text = '$(sync~spin) DevKit for Strapi';
      status.tooltip = 'DevKit for Strapi is scanning the workspace…';
      status.show();
      statusShown = true;
    }

    try {
      engine.setExcludes(vscode.workspace.getConfiguration('strapiDevkit').get<string[]>('exclude', []));
      // Installed plugins (node_modules) are read in the background: refs into them stay
      // silent until they land, then onReferencesChanged revalidates.
      await engine.init(folders, { waitForInstalled: false });
      logProjects(engine, output);
      bus.fireNow(); // open files were indexed-empty during init
    } catch (err) {
      output.appendLine(`[init] FAILED: ${String(err)}`);
      output.show(true);
      status.text = '$(error) DevKit for Strapi';
      status.tooltip = 'DevKit for Strapi failed to initialize — click for details.';
      status.show();
      statusShown = true;
      void vscode.window.showErrorMessage(`DevKit for Strapi init failed: ${String(err)}`);
    }
  };

  const ready = applyFolders();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void applyFolders()));

  // The MCP server only where there is a Strapi project — decided once the scan is done,
  // and offered again when a project appears or the last one goes.
  const mcp = registerMcpServer(context, license, async () => {
    await ready;
    return engine.getProjects().length > 0;
  });
  let hadProject = false;
  context.subscriptions.push(
    bus.event(() => {
      const has = engine.getProjects().length > 0;
      if (has !== hadProject) mcp.refresh();
      hadProject = has;
    }),
  );

  // Editing the exclude list re-discovers projects without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('strapiDevkit.exclude')) return;
      engine.setExcludes(vscode.workspace.getConfiguration('strapiDevkit').get<string[]>('exclude', []));
      try {
        await engine.rescan();
        bus.fireNow();
      } catch (err) {
        output.appendLine(`[exclude] rescan FAILED: ${String(err)}`);
      }
    }),
  );

  registerCommands(context, engine, output, ready, bus);

  context.subscriptions.push(
    vscode.commands.registerCommand('strapiDevkit.enterLicenseKey', () => license.enterKey()),
    vscode.commands.registerCommand('strapiDevkit.clearLicenseKey', () => license.clearKey()),
  );
  return {
    views: { routes: routesView.provider, model: modelView.provider, health: healthView.provider, plugins: pluginsView.provider, configSync: configSyncView.provider },
    configSyncDb,
    configSyncEditorEntry,
    presence: { mcpServers: async () => (await mcp.definitions()).length, mcpRefreshes: mcp.refreshes, statusShown: () => statusShown, ready },
  };
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}

/**
 * `$(database) Strapi 5.48 · ⚠ 2` — the project, its problems, and how current DevKit's
 * view of it is; nothing in a workspace without a Strapi project. Whether it is shown.
 */
function updateStatus(engine: StrapiEngine, status: vscode.StatusBarItem, problems = 0): boolean {
  const projects = engine.getProjects();
  const loading = projects.some((p) => p.freshness.pluginsLoading);
  const icon = loading ? '$(sync~spin)' : '$(database)';
  const version = (p: (typeof projects)[number]): string => p.strapiVersion ?? p.declaredVersion?.replace(/^[\^~>=<\s]+/, '') ?? `v${p.version}`;
  if (!projects.length) {
    status.hide();
    return false;
  }
  const label = projects.length === 1 ? `Strapi ${version(projects[0]!)}` : `DevKit: ${projects.length} projects`;
  status.text = `${icon} ${label}${problems ? ` · $(warning) ${problems}` : ''}`;
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ['workbench.view.extension.strapiDevkit', 'strapiDevkit.showProjects', 'strapiDevkit.rescan', 'strapiDevkit.health.validateAll'] };
  md.appendMarkdown('**DevKit for Strapi**\n\n');
  for (const p of projects) {
    const c = p.counts;
    md.appendMarkdown(`$(folder) **${paths.basename(p.root)}** — Strapi ${version(p)} · ${c.contentTypes} content-types · ${c.components} components${p.freshness.pluginsLoading ? ' · reading installed plugins…' : ''}\n\n`);
    if (p.unsupportedVersion) md.appendMarkdown(`$(warning) ${p.unsupportedVersion}\n\n`);
  }
  md.appendMarkdown(problems ? `$(warning) ${problems} problem${problems === 1 ? '' : 's'} Strapi would hit (broken references, names it won't find)\n\n` : '$(pass) No broken reference found\n\n');
  md.appendMarkdown('[Open the panel](command:workbench.view.extension.strapiDevkit) · [Check the whole project](command:strapiDevkit.health.validateAll) · [Projects](command:strapiDevkit.showProjects) · [Rescan](command:strapiDevkit.rescan)');
  status.tooltip = md;
  status.show();
  return true;
}

/** Batch + debounce watcher events into a single incremental engine update. */
function registerFileWatcher(context: vscode.ExtensionContext, engine: StrapiEngine, bus: RefreshBus): void {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{ts,tsx,js,jsx,mjs,cjs,json}');
  const changed = new Set<string>();
  const deleted = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    timer = undefined;
    const c = [...changed];
    const d = [...deleted];
    changed.clear();
    deleted.clear();
    if (c.length || d.length) void engine.onFilesChanged(c, d).then(() => bus.fireNow());
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };

  const onChange = (uri: vscode.Uri): void => {
    const p = paths.normalize(uri.fsPath);
    if (p.includes('/node_modules/')) return;
    deleted.delete(p);
    changed.add(p);
    schedule();
  };
  const onDelete = (uri: vscode.Uri): void => {
    const p = paths.normalize(uri.fsPath);
    if (p.includes('/node_modules/')) return;
    changed.delete(p);
    deleted.add(p);
    schedule();
  };

  watcher.onDidCreate(onChange);
  watcher.onDidChange(onChange);
  watcher.onDidDelete(onDelete);
  // A deleted folder is reported alone, not the files it held: passed on when it held a
  // project or indexed files (not every deletion: Strapi's own temporary files come and go).
  const folders = vscode.workspace.createFileSystemWatcher('**/*', true, true, false);
  folders.onDidDelete((uri) => {
    if (engine.indexesUnder(paths.normalize(uri.fsPath))) onDelete(uri);
  });
  context.subscriptions.push(watcher, folders);
}

function registerCommands(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
  output: vscode.OutputChannel,
  ready: Promise<void>,
  bus: RefreshBus,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('strapiDevkit.showProjects', async () => {
      await ready;
      logProjects(engine, output);
      output.show(true);
    }),
    vscode.commands.registerCommand('strapiDevkit.rescan', async () => {
      try {
        await engine.rescan();
        logProjects(engine, output);
        bus.fireNow();
        output.show(true);
        void vscode.window.showInformationMessage('DevKit for Strapi: workspace rescanned.');
      } catch (err) {
        output.appendLine(`[rescan] FAILED: ${String(err)}`);
        output.show(true);
        void vscode.window.showErrorMessage(`DevKit for Strapi rescan failed: ${String(err)}`);
      }
    }),
  );
}

function logProjects(engine: StrapiEngine, output: vscode.OutputChannel): void {
  const projects = engine.getProjects();
  output.appendLine('');
  output.appendLine(`Detected ${projects.length} Strapi project(s):`);
  for (const p of projects) {
    const c = p.counts;
    output.appendLine(
      `  • ${p.root}  [v${p.version}]  ` +
        `content-types: ${c.contentTypes}, components: ${c.components}, ` +
        `services: ${c.services}, controllers: ${c.controllers}, ` +
        `policies: ${c.policies}, middlewares: ${c.middlewares}`,
    );
  }
}
