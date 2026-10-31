import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { escapeName, paths } from 'devkit-for-strapi-core';
import {
  configSyncDiff,
  configSyncExport,
  configSyncImport,
  type ConfigSyncDbEntry,
  type ConfigSyncWriteData,
  GET_PRO_URL,
  type RuntimeFailure,
  type RuntimeOptions,
  type RuntimeResult,
  type RuntimeStep,
  type RuntimeSuccess,
  runtimeHint,
} from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';
import { withOffer } from '../offer';
import { setContext } from './panel';

/**
 * config-sync against the database (Pro): the project's own Strapi, loaded the way the
 * plugin's CLI does, and the plugin's own diff, export and import. One state per project:
 * the last diff (or why it failed), shown in the Config Sync view; a click opens VS Code's
 * diff editor, the database on the left.
 */

export type DbState =
  | { kind: 'running'; step: RuntimeStep; label: string }
  | { kind: 'done'; result: RuntimeSuccess<{ entries: ConfigSyncDbEntry[] }>; at: Date }
  | { kind: 'failed'; failure: RuntimeFailure | { message: string; kind?: undefined }; at: Date };

export const DB_SCHEME = 'strapidevkit-configsync';

export const STEP_LABEL: Record<RuntimeStep, string> = {
  start: 'starting',
  compile: 'compiling TypeScript',
  config: 'reading the configuration',
  register: 'loading the code and plugins',
  check: 'checking the database',
  bootstrap: 'starting Strapi',
  command: 'asking config-sync',
};

/** The settings a run uses. */
export function runtimeSettings(): RuntimeOptions {
  const rt = vscode.workspace.getConfiguration('strapiDevkit.runtime');
  const cs = vscode.workspace.getConfiguration('strapiDevkit.configSync');
  const nodePath = rt.get<string>('nodePath', '').trim();
  const envPath = cs.get<string>('envPath', '').trim();
  return {
    ...(nodePath ? { nodePath } : {}),
    env: cs.get<string>('environment', 'development') || 'development',
    ...(envPath ? { envPath } : {}),
    timeoutMs: Math.max(30, rt.get<number>('timeoutSeconds', 180)) * 1000,
    ...(cs.get<boolean>('allowRemoteDatabase', false) ? { allowRemoteDatabase: true } : {}),
  };
}

/** The same settings, for the bundled MCP server (it reads them from its environment). */
export function runtimeEnv(): Record<string, string> {
  const o = runtimeSettings();
  // followRefactors is per folder (multi-root): the server gets the folders that turned it off.
  const off = (vscode.workspace.workspaceFolders ?? [])
    .filter((f) => !vscode.workspace.getConfiguration('strapiDevkit.configSync', f.uri).get<boolean>('followRefactors', true))
    .map((f) => paths.normalize(f.uri.fsPath));
  return {
    ...(off.length ? { DEVKIT_CONFIG_SYNC_FOLLOW_REFACTORS_OFF: JSON.stringify(off) } : {}),
    ...(o.nodePath ? { DEVKIT_NODE: o.nodePath } : {}),
    ...(o.env ? { DEVKIT_CONFIG_SYNC_ENV: o.env } : {}),
    ...(o.envPath ? { DEVKIT_CONFIG_SYNC_ENV_PATH: o.envPath } : {}),
    ...(o.allowRemoteDatabase ? { DEVKIT_ALLOW_REMOTE_DATABASE: '1' } : {}),
    ...(o.timeoutMs ? { DEVKIT_RUNTIME_TIMEOUT_S: String(Math.round(o.timeoutMs / 1000)) } : {}),
  };
}

/** Where the database side of an entry is served (read-only) for the diff editor; `file`: its sync file. */
export function dbUri(root: string, key: string, file?: string): vscode.Uri {
  const id = createHash('sha1').update(root).digest('hex').slice(0, 10);
  return vscode.Uri.from({ scheme: DB_SCHEME, path: `/${id}/${encodeURIComponent(key)}.json`, query: root, ...(file ? { fragment: file } : {}) });
}

export class ConfigSyncDb implements vscode.TextDocumentContentProvider {
  private states = new Map<string, DbState>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fired with the project root whose state changed. */
  readonly onDidChangeState = this.changed.event;
  private readonly docChanged = new vscode.EventEmitter<vscode.Uri>();
  /** What each database document showed last: kept while a run fails or nothing is known. */
  private readonly served = new Map<string, string>();
  /** The database side of an open diff changed (a new diff, an export, an import). */
  readonly onDidChange = this.docChanged.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly isLicensed: () => Promise<boolean>,
  ) {}

  state(root: string): DbState | undefined {
    return this.states.get(paths.normalize(root));
  }

  private set(root: string, s: DbState): void {
    this.states.set(paths.normalize(root), s);
    this.changed.fire(paths.normalize(root));
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    const root = uri.query;
    const key = decodeURIComponent(paths.basename(uri.path, '.json'));
    const s = this.state(root);
    let text = this.served.get(uri.toString());
    if (s?.kind === 'done') {
      const entry = s.result.data.entries.find((e) => e.key === key);
      if (entry) text = entry.db === null || entry.db === undefined ? '' : `${JSON.stringify(entry.db, null, 2)}\n`;
      else {
        // No longer different (an export, an import): the database holds what the file says.
        try {
          text = uri.fragment ? readFileSync(uri.fragment, 'utf8') : '';
        } catch {
          text = '';
        }
      }
    }
    this.served.set(uri.toString(), text ?? '');
    return text ?? '';
  }

  /** Licence, workspace trust and the project's consent; false (said why) when one is missing. */
  async allowed(root: string, noPrompt = false): Promise<boolean> {
    if (!(await this.isLicensed())) {
      if (!noPrompt) {
        const pick = await vscode.window.showInformationMessage(
          withOffer('Comparing config/sync with the database, and exporting or importing, is a DevKit for Strapi Pro feature: it runs the real config-sync through your project\'s Strapi. Reading the files stays free.'),
          'Enter License Key',
          'Get Pro',
        );
        if (pick === 'Enter License Key') await vscode.commands.executeCommand('strapiDevkit.enterLicenseKey');
        if (pick === 'Get Pro') await vscode.env.openExternal(vscode.Uri.parse(GET_PRO_URL));
      }
      return false;
    }
    if (!vscode.workspace.isTrusted) {
      if (!noPrompt) void vscode.window.showWarningMessage('DevKit for Strapi runs your project\'s code to reach the database: trust this workspace first (Manage Workspace Trust).');
      return false;
    }
    const consentKey = `strapiDevkit.configSync.consent:${paths.normalize(root)}`;
    if (noPrompt || this.context.workspaceState.get<boolean>(consentKey)) return true;
    const env = runtimeSettings().env ?? 'development';
    const ok = await vscode.window.showWarningMessage(
      `Load ${paths.basename(root)} with its own Strapi?`,
      {
        modal: true,
        detail: `DevKit loads the project the way config-sync's own CLI does (no server, no port, no admin account) and asks config-sync. This runs the project's code, and does to the database what a start of \`strapi develop\` does: the schema follows the code, pending migrations run.\n\nEnvironment: ${env}. Only a local development database is accepted; a Strapi 4 database under Strapi 5 code is refused.`,
      },
      'Load It',
    );
    if (ok !== 'Load It') return false;
    await this.context.workspaceState.update(consentKey, true);
    return true;
  }

  /** Run with progress in the view and a cancellable notification. */
  private async run<T>(root: string, title: string, go: (opts: RuntimeOptions) => Promise<RuntimeResult<T>>): Promise<RuntimeResult<T> | undefined> {
    const label = title;
    this.set(root, { kind: 'running', step: 'start', label });
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `DevKit for Strapi: ${title}`, cancellable: true }, async (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      const opts: RuntimeOptions = {
        ...runtimeSettings(),
        signal: abort.signal,
        onProgress: (step) => {
          progress.report({ message: STEP_LABEL[step] });
          this.set(root, { kind: 'running', step, label });
        },
      };
      try {
        return await go(opts);
      } catch (e) {
        // The open-source build: the engine isn't there.
        this.set(root, { kind: 'failed', failure: { message: e instanceof Error ? e.message : String(e) }, at: new Date() });
        return undefined;
      }
    });
  }

  private settle(root: string, r: RuntimeResult<{ entries: ConfigSyncDbEntry[] }> | undefined): void {
    if (!r) return;
    if (r.ok) this.set(root, { kind: 'done', result: r, at: new Date() });
    else this.set(root, { kind: 'failed', failure: r, at: new Date() });
    for (const doc of vscode.workspace.textDocuments) if (doc.uri.scheme === DB_SCHEME && paths.normalize(doc.uri.query) === paths.normalize(root)) this.docChanged.fire(doc.uri);
  }

  /** A failure said in a notification too: the Config Sync view may not be on screen. */
  private sayFailure(root: string, what: string): void {
    const s = this.state(root);
    if (s?.kind !== 'failed') return;
    const t = failureText(s.failure);
    const done = 'detail' in s.failure ? s.failure.detail?.done : undefined;
    const partial = done?.length ? ` Already done before it stopped: ${done.join(', ')}.` : '';
    void vscode.window.showErrorMessage(`DevKit for Strapi — ${what} failed: ${t.title}${partial}${t.todo ? ` ${t.todo}` : ''}`);
  }

  async compare(root: string, noPrompt = false): Promise<void> {
    if (!(await this.allowed(root, noPrompt))) return;
    this.settle(root, await this.run(root, `comparing config/sync with the database (${paths.basename(root)})`, (o) => configSyncDiff(root, o)));
    if (!noPrompt) this.sayFailure(root, 'Comparing with the database');
  }

  async export(root: string, entries: ConfigSyncDbEntry[] | undefined, noPrompt = false): Promise<RuntimeResult<ConfigSyncWriteData> | undefined> {
    if (!(await this.allowed(root, noPrompt))) return undefined;
    const list = entries ?? (this.state(root)?.kind === 'done' ? (this.state(root) as Extract<DbState, { kind: 'done' }>).result.data.entries : []);
    if (!list.length) return undefined;
    if (!noPrompt) {
      const lines = list.map((e) => `${e.key} — ${e.state === 'only-in-sync-dir' ? 'file deleted (not in the database)' : e.state === 'only-in-db' ? 'file created' : 'file rewritten'}`);
      const dirty = unsavedSyncFiles(root, list.map((e) => e.key));
      const kept = dirty.length ? `\n\nUnsaved changes in ${names(dirty)} aren't saved: the export changes the file on disk, and the editor keeps them unsaved.` : '';
      const ok = await vscode.window.showWarningMessage(`Export ${list.length} entr${list.length === 1 ? 'y' : 'ies'} from the database into config/sync?`, { modal: true, detail: `${lines.join('\n')}${kept}` }, 'Export');
      if (ok !== 'Export') return undefined;
    }
    // With the states confirmed: an entry that changed since the comparison is left alone.
    const expected = Object.fromEntries(list.map((e) => [e.key, e.state]));
    const r = await this.run(root, `exporting ${list.length} entr${list.length === 1 ? 'y' : 'ies'}`, (o) => configSyncExport(root, list.map((e) => e.key), { ...o, expected }));
    this.settle(root, r);
    if (r?.ok && !noPrompt) say(`DevKit for Strapi: ${r.data.done.length} exported into the sync directory. Commit them with the code that caused them.`, r.warnings);
    if (!noPrompt) this.sayFailure(root, 'Exporting');
    return r;
  }

  async import(root: string, entries: ConfigSyncDbEntry[], noPrompt = false): Promise<RuntimeResult<ConfigSyncWriteData> | undefined> {
    if (!entries.length || !(await this.allowed(root, noPrompt))) return undefined;
    // The import reads the files on disk: what the editor holds unsaved is saved first.
    const dirty = unsavedSyncFiles(root, entries.map((e) => e.key));
    if (!noPrompt) {
      const env = runtimeSettings().env ?? 'development';
      const lines = entries.map((e) => `${e.key} — ${e.state === 'only-in-db' ? 'DELETED from the database (no file)' : e.state === 'only-in-sync-dir' ? 'created in the database' : 'updated in the database'}`);
      const saved = dirty.length ? `\n\nUnsaved changes in ${names(dirty)} are saved first.` : '';
      const ok = await vscode.window.showWarningMessage(`Import ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} into the ${env} database?`, { modal: true, detail: `${lines.join('\n')}${saved}\n\nAfterwards, the entries still different are exported back in the database's own form.` }, 'Import');
      if (ok !== 'Import') return undefined;
    }
    for (const doc of dirty) {
      if (!(await doc.save())) {
        if (!noPrompt) void vscode.window.showErrorMessage(`DevKit for Strapi: ${paths.basename(doc.uri.fsPath)} couldn't be saved — nothing imported.`);
        return undefined;
      }
    }
    // With the states confirmed: an entry that changed since the comparison (its file deleted by a
    // checkout: the same import would delete it from the database) is left alone.
    const expected = Object.fromEntries(entries.map((e) => [e.key, e.state]));
    const r = await this.run(root, `importing ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, (o) => configSyncImport(root, entries.map((e) => e.key), { ...o, expected }));
    this.settle(root, r);
    if (!noPrompt) this.sayFailure(root, 'Importing');
    if (r?.ok && !noPrompt) {
      const re = r.data.reexported.length ? ` ${r.data.reexported.length} written back in the database's form.` : '';
      say(`DevKit for Strapi: ${r.data.done.length} imported.${re}`, r.warnings);
    }
    return r;
  }

  /** The entries of the last diff, to pick from. */
  entries(root: string): ConfigSyncDbEntry[] {
    const s = this.state(root);
    return s?.kind === 'done' ? s.result.data.entries : [];
  }
}

/** Open editors holding unsaved changes to these entries' sync files (a run reads and writes the files on disk). */
export function unsavedSyncFiles(root: string, keys: readonly string[]): vscode.TextDocument[] {
  const files = new Set(keys.map((k) => `${escapeName(k)}.json`));
  return vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file' && files.has(paths.basename(paths.normalize(d.uri.fsPath))) && paths.isPathInside(root, d.uri.fsPath));
}

const names = (docs: vscode.TextDocument[]): string => docs.map((d) => paths.basename(paths.normalize(d.uri.fsPath))).join(', ');

/** The outcome of an export or an import, with what the plugin or DevKit warned about. */
function say(message: string, warnings: string[]): void {
  // A notification shows no detail: the warnings go in the message.
  if (warnings.length) void vscode.window.showWarningMessage(`${message} ${warnings.join(' ')}`);
  else void vscode.window.showInformationMessage(message);
}

/** One line for a failure: what happened and what to do. */
export function failureText(f: RuntimeFailure | { message: string; kind?: undefined }): { title: string; todo?: string } {
  if (!f.kind) return { title: f.message };
  return { title: f.message, todo: runtimeHint(f.kind) };
}

/** An entry open in an editor: its project and key. */
export interface OpenEntry {
  root: string;
  key: string;
}

/**
 * The commands, and the entry open in the editor — a database ↔ config/sync diff, the
 * database side alone, or the file alone opened from the Database list — so the
 * editor's title can export or import it (`strapiDevkit.configSyncEntryOpen`).
 * Returns what the active editor holds (tests).
 */
export function registerConfigSyncDb(context: vscode.ExtensionContext, db: ConfigSyncDb, rootOf: (node?: unknown) => Promise<string | undefined>): () => OpenEntry | undefined {
  type EntryNode = { kind: 'dbEntry'; root: string; entry: ConfigSyncDbEntry };
  /** Sync files opened alone from the Database list (an entry only in config/sync). */
  const openedFiles = new Map<string, OpenEntry>();
  const fromDbUri = (u: vscode.Uri): OpenEntry => ({ root: paths.normalize(u.query), key: decodeURIComponent(paths.basename(u.path, '.json')) });
  const openEntry = (uri: vscode.Uri | undefined): OpenEntry | undefined => {
    if (!uri) return undefined;
    if (uri.scheme === DB_SCHEME) return fromDbUri(uri);
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.original.scheme === DB_SCHEME && input.modified.toString() === uri.toString()) return fromDbUri(input.original);
      }
    }
    return uri.scheme === 'file' ? openedFiles.get(paths.normalize(uri.fsPath)) : undefined;
  };
  /** The active editor's entry: only one DevKit opened (a plain editor or a Git diff of the same file isn't one). */
  const active = (): OpenEntry | undefined => {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputTextDiff) return input.original.scheme === DB_SCHEME ? fromDbUri(input.original) : undefined;
    if (!(input instanceof vscode.TabInputText)) return undefined;
    return input.uri.scheme === DB_SCHEME ? fromDbUri(input.uri) : input.uri.scheme === 'file' ? openedFiles.get(paths.normalize(input.uri.fsPath)) : undefined;
  };
  const updateKey = (): void => {
    // A file opened from the Database list counts while it stays open.
    const open = new Set(vscode.window.tabGroups.all.flatMap((g) => g.tabs.flatMap((t) => (t.input instanceof vscode.TabInputText ? [paths.normalize(t.input.uri.fsPath)] : []))));
    for (const file of openedFiles.keys()) if (!open.has(file)) openedFiles.delete(file);
    setContext('strapiDevkit.configSyncEntryOpen', active() !== undefined);
  };

  /** The entries a command acts on: tree nodes, or the entry of the editor whose title it was run from. */
  const asEntries = async (node: unknown, nodes?: unknown[]): Promise<{ root: string; entries: ConfigSyncDbEntry[] } | undefined> => {
    if (node instanceof vscode.Uri) {
      const open = openEntry(node);
      if (!open) {
        void vscode.window.showInformationMessage('DevKit for Strapi: this editor holds no entry opened from the Config Sync view\'s Database list.');
        return undefined;
      }
      const s = db.state(open.root);
      if (s?.kind !== 'done') {
        // A diff restored with the window, or a comparison running or failed: no state to act on.
        if (!(await db.isLicensed())) await db.allowed(open.root);
        else if (s?.kind === 'running') void vscode.window.showInformationMessage(`DevKit for Strapi: ${paths.basename(open.root)} — a run is in progress. Try again once it ends.`);
        else if ((await vscode.window.showInformationMessage(`DevKit for Strapi: ${open.key} — compare config/sync with the database first: what to export or import comes from a comparison.`, 'Compare')) === 'Compare') await db.compare(open.root);
        return undefined;
      }
      const entry = s.result.data.entries.find((e) => e.key === open.key);
      if (!entry) void vscode.window.showInformationMessage(`DevKit for Strapi: ${open.key} — config/sync and the database agreed at the last comparison. Compare again if it changed since.`);
      return entry ? { root: open.root, entries: [entry] } : undefined;
    }
    const all = (nodes?.length ? nodes : [node]).filter((n): n is EntryNode => (n as EntryNode)?.kind === 'dbEntry');
    if (!all.length) return undefined;
    return { root: all[0]!.root, entries: all.filter((n) => n.root === all[0]!.root).map((n) => n.entry) };
  };
  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs(updateKey),
    vscode.window.tabGroups.onDidChangeTabGroups(updateKey),
    vscode.workspace.registerTextDocumentContentProvider(DB_SCHEME, db),
    vscode.commands.registerCommand('strapiDevkit.configSync.compare', async (node?: unknown, opts?: { noPrompt?: boolean }) => {
      const found = await rootOf(node);
      const root = found ? paths.normalize(found) : undefined;
      if (root) await db.compare(root, opts?.noPrompt);
    }),
    vscode.commands.registerCommand('strapiDevkit.configSync.openDiff', async (root: string, entry: ConfigSyncDbEntry, syncDir?: string) => {
      const file = vscode.Uri.file(paths.join(syncDir ?? paths.join(root, 'config/sync'), `${escapeName(entry.key)}.json`));
      const left = dbUri(root, entry.key, file.fsPath);
      if (entry.state === 'only-in-db') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(left), { preview: true });
      else if (entry.state === 'only-in-sync-dir') {
        await vscode.window.showTextDocument(file, { preview: true });
        // Once its tab is there: a tab change before it would drop it as closed.
        openedFiles.set(paths.normalize(file.fsPath), { root: paths.normalize(root), key: entry.key });
      } else await vscode.commands.executeCommand('vscode.diff', left, file, `${entry.key}: database ↔ config/sync`, { preview: true });
      updateKey();
    }),
    vscode.commands.registerCommand('strapiDevkit.configSync.export', async (node?: unknown, nodes?: unknown[]) => {
      const sel = await asEntries(node, nodes);
      if (sel) await db.export(sel.root, sel.entries);
    }),
    vscode.commands.registerCommand('strapiDevkit.configSync.exportAll', async (node?: unknown) => {
      const root = await rootOf(node);
      if (root) await db.export(root, undefined);
    }),
    vscode.commands.registerCommand('strapiDevkit.configSync.import', async (node?: unknown, nodes?: unknown[]) => {
      const sel = await asEntries(node, nodes);
      if (sel) await db.import(sel.root, sel.entries);
    }),
    vscode.commands.registerCommand('strapiDevkit.configSync.importPick', async (node?: unknown) => {
      const root = await rootOf(node);
      if (!root) return;
      const items = db.entries(root).map((entry) => ({ label: entry.key, description: entry.state, detail: entry.summary.join(' · '), entry }));
      if (!items.length) {
        void vscode.window.showInformationMessage('DevKit for Strapi: compare with the database first — nothing to import yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Import into the database', placeHolder: 'Pick the entries to import (never everything blindly)' });
      if (picked?.length) await db.import(root, picked.map((p) => p.entry));
    }),
  );
  updateKey();
  return active;
}
