import { createEngine, paths, type StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { VscodeFileSystem } from './fileSystem';
import { registerDefinitionProvider } from './providers/definition';
import { type Diagnostics, registerDiagnostics } from './providers/diagnostics';
import { registerCompletionProvider } from './providers/completion';
import { registerHoverProvider } from './providers/hover';
import { registerReferenceProvider } from './providers/references';
import { type CodeLenses, registerCodeLensProvider } from './providers/codeLens';
import { registerRenameProvider } from './providers/rename';
import { createLicenseManager, type LicenseManager } from './license';

function workspaceFolderPaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => paths.normalize(f.uri.fsPath));
}

/**
 * Offer the bundled MCP server (`dist/mcp.js`) to MCP clients (e.g. Copilot
 * agent mode) — same engine as the extension, exposed to agents. Spawned via
 * VS Code's own Node (Electron-as-node), so it needs no separate install; the
 * workspace folders are passed so it indexes the same projects.
 */
function registerMcpServer(context: vscode.ExtensionContext, license: LicenseManager): void {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') return;
  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    didChange,
    vscode.lm.registerMcpServerDefinitionProvider('strapiDevkit.mcp', {
      onDidChangeMcpServerDefinitions: didChange.event,
      provideMcpServerDefinitions: async () => {
        // Forward the editor's licence key so the bundled MCP gates its Pro tools
        // with the same key entered here — set once, unlocks both surfaces.
        const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: '1' };
        const key = await license.getKey();
        if (key) env.DEVKIT_LICENSE_KEY = key;
        return [
          new vscode.McpStdioServerDefinition(
            'DevKit for Strapi',
            process.execPath,
            [context.asAbsolutePath('dist/mcp.js'), ...workspaceFolderPaths()],
            env,
          ),
        ];
      },
    }),
    // Re-offer with the new folder set, or when the licence key changes.
    vscode.workspace.onDidChangeWorkspaceFolders(() => didChange.fire()),
    license.onDidChange(() => didChange.fire()),
  );
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    activateImpl(context);
  } catch (err) {
    // Surface any synchronous activation failure instead of dying silently.
    void vscode.window.showErrorMessage(`DevKit for Strapi failed to activate: ${String(err)}`);
    throw err;
  }
}

function activateImpl(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.getConfiguration('strapiDevkit').get<boolean>('enable', true)) {
    void vscode.window.showWarningMessage('DevKit for Strapi is disabled (strapiDevkit.enable = false).');
    return;
  }

  const output = vscode.window.createOutputChannel('DevKit for Strapi');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'strapiDevkit.showProjects';
  context.subscriptions.push(output, status);

  const fs = new VscodeFileSystem();
  const engine = createEngine(fs);
  const license = createLicenseManager(context);

  // Register language features synchronously — they work as soon as init resolves.
  registerDefinitionProvider(context, engine);
  registerHoverProvider(context, engine);
  registerReferenceProvider(context, engine);
  registerRenameProvider(context, engine, fs, license.isLicensed);
  const codeLenses = registerCodeLensProvider(context, engine);
  // The reference index builds in the background → refresh lenses when it lands.
  engine.onReferencesChanged(() => codeLenses.refresh());
  const diagnostics = registerDiagnostics(context, engine);
  registerCompletionProvider(context, engine);
  registerFileWatcher(context, engine, status, diagnostics, codeLenses);

  registerMcpServer(context, license);

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
    status.text = '$(sync~spin) DevKit for Strapi';
    status.tooltip = 'DevKit for Strapi is scanning the workspace…';
    status.show();

    try {
      engine.setExcludes(vscode.workspace.getConfiguration('strapiDevkit').get<string[]>('exclude', []));
      await engine.init(folders);
      logProjects(engine, output);
      updateStatus(engine, status);
      diagnostics.revalidateAll(); // open files were indexed-empty during init
      codeLenses.refresh();
    } catch (err) {
      output.appendLine(`[init] FAILED: ${String(err)}`);
      output.show(true);
      status.text = '$(error) DevKit for Strapi';
      status.tooltip = 'DevKit for Strapi failed to initialize — click for details.';
      void vscode.window.showErrorMessage(`DevKit for Strapi init failed: ${String(err)}`);
    }
  };

  const ready = applyFolders();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => void applyFolders()));

  // Editing the exclude list re-discovers projects without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('strapiDevkit.exclude')) return;
      engine.setExcludes(vscode.workspace.getConfiguration('strapiDevkit').get<string[]>('exclude', []));
      try {
        await engine.rescan();
        updateStatus(engine, status);
        diagnostics.revalidateAll();
        codeLenses.refresh();
      } catch (err) {
        output.appendLine(`[exclude] rescan FAILED: ${String(err)}`);
      }
    }),
  );

  registerCommands(context, engine, output, status, ready, diagnostics, codeLenses);

  context.subscriptions.push(
    vscode.commands.registerCommand('strapiDevkit.enterLicenseKey', () => license.enterKey()),
    vscode.commands.registerCommand('strapiDevkit.clearLicenseKey', () => license.clearKey()),
  );
}

export function deactivate(): void {
  /* nothing to clean up beyond context.subscriptions */
}

function updateStatus(engine: StrapiEngine, status: vscode.StatusBarItem): void {
  const n = engine.getProjects().length;
  status.text = n > 0 ? `$(database) DevKit for Strapi: ${n}` : '$(database) DevKit for Strapi: 0';
  status.tooltip =
    n > 0
      ? `DevKit for Strapi active — ${n} Strapi project(s) detected. Click for details.`
      : 'DevKit for Strapi active — no Strapi project found in this workspace.';
  status.show();
}

/** Batch + debounce watcher events into a single incremental engine update. */
function registerFileWatcher(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
  status: vscode.StatusBarItem,
  diagnostics: Diagnostics,
  codeLenses: CodeLenses,
): void {
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
    if (c.length || d.length) {
      void engine.onFilesChanged(c, d).then(() => {
        updateStatus(engine, status);
        diagnostics.revalidateAll(); // the index changed → refresh open files
        codeLenses.refresh();
      });
    }
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
  context.subscriptions.push(watcher);
}

function registerCommands(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
  output: vscode.OutputChannel,
  status: vscode.StatusBarItem,
  ready: Promise<void>,
  diagnostics: Diagnostics,
  codeLenses: CodeLenses,
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
        updateStatus(engine, status);
        diagnostics.revalidateAll();
        codeLenses.refresh();
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
