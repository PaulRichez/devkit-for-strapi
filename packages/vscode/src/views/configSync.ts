import {
  type ConfigSyncGroup,
  configSyncLabel,
  type ConfigSyncStaticStatus,
  configSyncStatus,
  type FileSystem,
  type StrapiEngine,
  type SyncFileEntry,
} from 'devkit-for-strapi-core';
import type { ConfigSyncDbEntry, ConfigSyncDbState } from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';
import { type ConfigSyncDb, failureText, STEP_LABEL } from './configSyncDb';
import { setContext } from './panel';
import { CachedTree, code, markdown, openCommand, orderedRoots, projectLabel, relPath, type TreeNode } from './tree';

/**
 * "Config Sync" view: what DevKit reads of strapi-plugin-config-sync in the project's
 * files — its options and where they come from, and the files of the sync directory
 * with readable names and their status. Nothing here starts Strapi or reads the
 * database.
 */

/** One config-sync status per project and index generation, shared by every surface. */
export class ConfigSyncCache {
  private statuses = new Map<string, Promise<ConfigSyncStaticStatus | undefined>>();

  constructor(
    private readonly engine: StrapiEngine,
    private readonly fs: FileSystem,
  ) {}

  /** The status of the project at `root` (undefined: config-sync isn't used there). */
  get(root: string): Promise<ConfigSyncStaticStatus | undefined> {
    let s = this.statuses.get(root);
    if (!s) {
      const project = this.engine.allProjects().find((p) => p.root === root);
      s = project ? configSyncStatus(this.fs, project).catch(() => undefined) : Promise.resolve(undefined);
      this.statuses.set(root, s);
    }
    return s;
  }

  /** Every project using config-sync, with its status. */
  async all(): Promise<Array<{ root: string; status: ConfigSyncStaticStatus }>> {
    const out: Array<{ root: string; status: ConfigSyncStaticStatus }> = [];
    for (const p of this.engine.allProjects()) {
      const status = await this.get(p.root);
      if (status && !status.detection.disabled) out.push({ root: p.root, status });
    }
    return out;
  }

  clear(): void {
    this.statuses.clear();
  }
}

const GROUP_LABEL: Record<ConfigSyncGroup, string> = {
  views: 'Content-manager views',
  roles: 'Roles (Users & Permissions)',
  'admin-roles': 'Admin roles',
  locales: 'Locales',
  settings: 'Settings',
  custom: 'Custom types',
};

/** What a file's status means for config-sync. */
export const STATUS_TEXT: Record<SyncFileEntry['status'], string> = {
  ok: 'Read by config-sync.',
  excluded: 'Excluded by the config-sync options: the import and the export ignore it.',
  invalid: "Not valid JSON (or empty): config-sync can't read this file.",
  'unknown-type': 'No config type of this name is registered here (a plugin may register it when Strapi runs).',
};

type Node = TreeNode &
  (
    | { kind: 'project'; root: string }
    | { kind: 'header'; root: string }
    | { kind: 'warning'; root: string; text: string }
    | { kind: 'invalid'; root: string }
    | { kind: 'files'; root: string }
    | { kind: 'fileGroup'; root: string; group: ConfigSyncGroup; files: SyncFileEntry[] }
    | { kind: 'file'; root: string; file: SyncFileEntry }
    | { kind: 'database'; root: string }
    | { kind: 'dbNote'; root: string; text: string; icon: string }
    | { kind: 'dbGroup'; root: string; state: ConfigSyncDbState; entries: ConfigSyncDbEntry[] }
    | { kind: 'dbEntry'; root: string; entry: ConfigSyncDbEntry }
  );

const DB_GROUP: Record<ConfigSyncDbState, string> = {
  different: 'Different',
  'only-in-db': 'Only in the database',
  'only-in-sync-dir': 'Only in config/sync',
};

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export class ConfigSyncProvider extends CachedTree<Node> {
  private data: Map<string, ConfigSyncStaticStatus> | undefined;
  /** The last statuses shown: an item asked for between a refresh and the next load still renders. */
  private shown = new Map<string, ConfigSyncStaticStatus>();
  view: vscode.TreeView<Node> | undefined;

  /** Pro: a licence is active (the Database entry offers the comparison, else the upsell). */
  licensed = false;

  constructor(
    private readonly engine: StrapiEngine,
    private readonly cache: ConfigSyncCache,
    private readonly db?: ConfigSyncDb,
  ) {
    super();
  }

  protected override reset(): void {
    this.data = undefined;
  }

  private async load(): Promise<Map<string, ConfigSyncStaticStatus>> {
    if (!this.data) {
      const all = await this.cache.all();
      this.data = new Map(all.map((x) => [x.root, x.status]));
      this.shown = this.data;
      setContext('strapiDevkit.configSync', this.data.size > 0);
      const invalid = [...this.data.values()].reduce((n, s) => n + s.files.filter((f) => f.status === 'invalid').length, 0);
      if (this.view) this.view.badge = invalid ? { value: invalid, tooltip: `${plural(invalid, 'sync file')} config-sync can't read` } : undefined;
    }
    return this.data;
  }

  private status(root: string): ConfigSyncStaticStatus | undefined {
    return (this.data ?? this.shown).get(root);
  }

  private label(root: string, key: string): string {
    const dot = key.indexOf('.');
    return configSyncLabel(this.engine.allProjects().find((p) => p.root === root), key.slice(0, dot), key.slice(dot + 1)).label;
  }

  protected async build(element?: Node): Promise<Node[]> {
    if (!element) {
      const data = await this.load();
      const roots = orderedRoots(this.engine, [...data.keys()]);
      if (roots.length === 1) return this.projectChildren(roots[0]!);
      return roots.map((root): Node => ({ kind: 'project', id: `cs|${root}`, root }));
    }
    const st = this.status(element.root);
    if (!st) return [];
    const base = `cs|${element.root}`;
    switch (element.kind) {
      case 'project':
        return this.projectChildren(element.root);
      case 'invalid':
        return st.files.filter((f) => f.status === 'invalid').map((file): Node => ({ kind: 'file', id: `${base}|invalid|${file.key}`, root: element.root, file }));
      case 'files': {
        const groups = new Map<ConfigSyncGroup, SyncFileEntry[]>();
        const project = this.engine.allProjects().find((p) => p.root === element.root);
        for (const f of st.files) {
          const g = configSyncLabel(project, f.type, f.name).group;
          groups.set(g, [...(groups.get(g) ?? []), f]);
        }
        return (Object.keys(GROUP_LABEL) as ConfigSyncGroup[])
          .filter((g) => groups.has(g))
          .map((group): Node => ({ kind: 'fileGroup', id: `${base}|files|${group}`, root: element.root, group, files: groups.get(group)! }));
      }
      case 'database': {
        const s = this.db?.state(element.root);
        if (s?.kind === 'failed') {
          const t = failureText(s.failure);
          return [
            ...(t.todo ? [{ kind: 'dbNote' as const, id: `${base}|db|todo`, root: element.root, text: t.todo, icon: 'lightbulb' }] : []),
            { kind: 'dbNote' as const, id: `${base}|db|message`, root: element.root, text: t.title, icon: 'info' },
          ];
        }
        if (s?.kind !== 'done') return [];
        const entries = s.result.data.entries;
        if (!entries.length) return [{ kind: 'dbNote', id: `${base}|db|same`, root: element.root, text: 'config/sync and the database agree', icon: 'pass' }];
        return (Object.keys(DB_GROUP) as ConfigSyncDbState[])
          .filter((state) => entries.some((e) => e.state === state))
          .map((state): Node => ({ kind: 'dbGroup', id: `${base}|db|${state}`, root: element.root, state, entries: entries.filter((e) => e.state === state) }));
      }
      case 'dbGroup':
        return [...element.entries]
          .sort((a, b) => this.label(element.root, a.key).localeCompare(this.label(element.root, b.key)))
          .map((entry): Node => ({ kind: 'dbEntry', id: `${base}|db|entry|${entry.key}`, root: element.root, entry }));
      case 'fileGroup':
        return [...element.files]
          .sort((a, b) => this.label(element.root, a.key).localeCompare(this.label(element.root, b.key)))
          .map((file): Node => ({ kind: 'file', id: `${base}|file|${file.key}`, root: element.root, file }));
      default:
        return [];
    }
  }

  private projectChildren(root: string): Node[] {
    const st = this.status(root);
    if (!st) return [];
    const base = `cs|${root}`;
    const out: Node[] = [{ kind: 'header', id: `${base}|header`, root }];
    st.detection.warnings.forEach((text, i) => out.push({ kind: 'warning', id: `${base}|warning|${i}`, root, text }));
    if (st.files.some((f) => f.status === 'invalid')) out.push({ kind: 'invalid', id: `${base}|invalid`, root });
    if (this.db) out.push({ kind: 'database', id: `${base}|database`, root });
    out.push({ kind: 'files', id: `${base}|files`, root });
    return out;
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const st = this.status(n.root);
    if (!st) return new vscode.TreeItem('…', vscode.TreeItemCollapsibleState.None);
    const collapsed = vscode.TreeItemCollapsibleState.Collapsed;
    const none = vscode.TreeItemCollapsibleState.None;
    switch (n.kind) {
      case 'project': {
        const item = new vscode.TreeItem(projectLabel(n.root), vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon('folder');
        item.tooltip = n.root;
        return item;
      }
      case 'header':
        return this.headerItem(st);
      case 'warning': {
        const item = new vscode.TreeItem(n.text, none);
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
        item.tooltip = n.text;
        return item;
      }
      case 'invalid': {
        const count = st.files.filter((f) => f.status === 'invalid').length;
        const item = new vscode.TreeItem('Unreadable files', vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(count);
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
        item.tooltip = STATUS_TEXT.invalid;
        return item;
      }
      case 'files': {
        const item = new vscode.TreeItem('Files', st.files.length ? collapsed : none);
        const counts = new Map<string, number>();
        for (const f of st.files) counts.set(f.status, (counts.get(f.status) ?? 0) + 1);
        item.description = st.files.length ? `${st.files.length} · ${[...counts].map(([s, c]) => `${s} ${c}`).join(' · ')}` : st.detection.syncDirExists ? 'none' : 'no sync directory yet';
        item.iconPath = new vscode.ThemeIcon('files');
        item.tooltip = st.detection.syncDirExists ? `The files of ${relPath(st.detection.syncDirPath)}.` : `${relPath(st.detection.syncDirPath)} does not exist yet: the first export creates it.`;
        return item;
      }
      case 'fileGroup': {
        const item = new vscode.TreeItem(GROUP_LABEL[n.group], collapsed);
        item.description = String(n.files.length);
        item.iconPath = new vscode.ThemeIcon(n.group === 'views' ? 'layout' : n.group === 'roles' || n.group === 'admin-roles' ? 'person' : n.group === 'locales' ? 'globe' : 'settings-gear');
        return item;
      }
      case 'file':
        return this.fileItem(n.root, n.file);
      case 'database':
        return this.databaseItem(n.root);
      case 'dbNote': {
        const item = new vscode.TreeItem(n.text, none);
        item.iconPath = new vscode.ThemeIcon(n.icon, n.icon === 'pass' ? new vscode.ThemeColor('testing.iconPassed') : undefined);
        item.tooltip = n.text;
        return item;
      }
      case 'dbGroup': {
        const item = new vscode.TreeItem(DB_GROUP[n.state], vscode.TreeItemCollapsibleState.Expanded);
        item.description = String(n.entries.length);
        item.iconPath = new vscode.ThemeIcon(n.state === 'different' ? 'diff-modified' : n.state === 'only-in-db' ? 'diff-added' : 'diff-removed');
        return item;
      }
      case 'dbEntry': {
        const e = n.entry;
        const item = new vscode.TreeItem(this.label(n.root, e.key), none);
        item.description = e.summary[0];
        item.iconPath = new vscode.ThemeIcon(e.state === 'different' ? 'diff-modified' : e.state === 'only-in-db' ? 'diff-added' : 'diff-removed');
        const md = markdown();
        md.appendMarkdown(`${code(e.key)}\n\n`);
        for (const line of e.summary) md.appendMarkdown(`- ${line}\n`);
        md.appendMarkdown('\n_Click to compare: the database on the left, config/sync on the right._');
        item.tooltip = md;
        item.command = { command: 'strapiDevkit.configSync.openDiff', title: 'Compare', arguments: [n.root, e, st.detection.syncDirPath] };
        item.contextValue = 'strapiConfigSyncDb.entry';
        return item;
      }
    }
  }

  private databaseItem(root: string): vscode.TreeItem {
    const s = this.db?.state(root);
    const item = new vscode.TreeItem('Database', s && s.kind !== 'running' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    const md = markdown();
    if (!this.licensed) {
      item.description = 'compare with the database — Pro';
      item.iconPath = new vscode.ThemeIcon('database');
      md.appendMarkdown("**Pro**: the real diff between config/sync and the database, from config-sync itself (your project's Strapi, loaded the way the plugin's CLI does), and export or import entry by entry.");
      item.command = { command: 'strapiDevkit.configSync.compare', title: 'Compare with the database', arguments: [root] };
    } else if (!s) {
      item.description = 'not compared yet';
      item.iconPath = new vscode.ThemeIcon('database');
      md.appendMarkdown("Load the project's Strapi (the way config-sync's CLI does) and ask config-sync what differs. It runs the project's code; a load does to the database what a start of `strapi develop` does.");
      item.command = { command: 'strapiDevkit.configSync.compare', title: 'Compare with the database', arguments: [root] };
      item.contextValue = 'strapiConfigSyncDb.idle';
    } else if (s.kind === 'running') {
      item.description = `${STEP_LABEL[s.step]}…`;
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      md.appendMarkdown(s.label);
    } else if (s.kind === 'failed') {
      item.description = s.failure.kind ?? 'not available';
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'));
      md.appendMarkdown(failureText(s.failure).title);
      item.contextValue = 'strapiConfigSyncDb.failed';
    } else {
      const r = s.result;
      const n = r.data.entries.length;
      const t = r.target;
      const where = t.filename ? relPath(t.filename) : [t.host, t.port].filter(Boolean).join(':') + (t.database ? `/${t.database}` : '');
      item.description = `${n} difference${n === 1 ? '' : 's'} · ${t.env} · ${where} · ${s.at.toLocaleTimeString()}`;
      item.iconPath = new vscode.ThemeIcon(n ? 'database' : 'pass', n ? undefined : new vscode.ThemeColor('testing.iconPassed'));
      md.appendMarkdown(`**${t.client}** ${code(where)} · NODE_ENV ${code(t.env)}\n\nStrapi ${r.versions.strapi} · config-sync ${r.versions.configSync} · ${Math.round((r.timings.total ?? 0) / 100) / 10} s\n\n`);
      for (const w of r.warnings) md.appendMarkdown(`$(warning) ${w}\n\n`);
      md.appendMarkdown('_What a start of Strapi changes on its own is included: export these entries with the code that caused them._');
      item.contextValue = n ? 'strapiConfigSyncDb.done' : 'strapiConfigSyncDb.same';
    }
    item.tooltip = md;
    return item;
  }

  private headerItem(st: ConfigSyncStaticStatus): vscode.TreeItem {
    const d = st.detection;
    const item = new vscode.TreeItem(`config-sync ${d.installedVersion ?? d.declaredRange ?? ''}`.trim(), vscode.TreeItemCollapsibleState.None);
    item.description = relPath(d.syncDirPath);
    item.iconPath = new vscode.ThemeIcon(d.versionMismatch ? 'warning' : 'sync');
    const md = markdown();
    md.appendMarkdown(`**strapi-plugin-config-sync** ${d.installedVersion ? `${d.installedVersion} installed` : 'not installed'}${d.declaredRange ? ` (package.json: ${code(d.declaredRange)})` : ''}\n\n`);
    const o = d.options;
    const src = (k: keyof typeof o.sources): string => (o.sources[k] === 'config' ? '' : o.sources[k] === 'default' ? ' _(default)_' : ' _(not read: default assumed)_');
    md.appendMarkdown(`- syncDir ${code(o.syncDir)}${src('syncDir')}\n`);
    md.appendMarkdown(`- excludedConfig ${o.excludedConfig.length ? o.excludedConfig.map(code).join(', ') : '—'}${src('excludedConfig')}\n`);
    md.appendMarkdown(`- excludedTypes ${o.excludedTypes.length ? o.excludedTypes.map(code).join(', ') : '—'}${src('excludedTypes')}\n`);
    if (o.customTypes.length) md.appendMarkdown(`- customTypes ${o.customTypes.map(code).join(', ')}${src('customTypes')}\n`);
    md.appendMarkdown(`- importOnBootstrap ${code(String(o.importOnBootstrap))}${src('importOnBootstrap')} · soft ${code(String(o.soft))}${src('soft')} · minify ${code(String(o.minify))}${src('minify')}\n\n`);
    if (d.envOverrides.length) md.appendMarkdown(`$(info) ${d.envOverrides.map((f) => code(relPath(f))).join(', ')} may change these options for that environment (not merged here).\n\n`);
    if (st.partial) md.appendMarkdown('$(info) The installed plugins are not known yet: user-role and i18n-locale files are assumed registered.\n\n');
    md.appendMarkdown('_Read from the files: Strapi is not started and the database is not read._');
    item.tooltip = md;
    if (d.configFile) item.command = openCommand(d.configFile, d.configOffset ?? 0, 'Open the config-sync options');
    return item;
  }

  private fileItem(root: string, f: SyncFileEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label(root, f.key), vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(f.path);
    item.description = f.status !== 'ok' ? f.status : undefined;
    item.iconPath =
      f.status === 'invalid'
        ? new vscode.ThemeIcon('error', new vscode.ThemeColor('problemsErrorIcon.foreground'))
        : f.status === 'ok'
          ? new vscode.ThemeIcon('json')
          : new vscode.ThemeIcon('circle-slash');
    const md = markdown();
    md.appendMarkdown(`${code(f.key)}\n\n${code(relPath(f.path))}`);
    if (f.status !== 'ok') md.appendMarkdown(`\n\n${STATUS_TEXT[f.status]}`);
    item.tooltip = md;
    item.command = openCommand(f.path, 0, 'Open the sync file');
    return item;
  }
}

export interface ConfigSyncView {
  refresh(): void;
  provider: ConfigSyncProvider;
  /** Re-read the licence (the Database entry: the comparison, or the upsell). */
  updateLicence(): Promise<void>;
}

export function registerConfigSyncView(context: vscode.ExtensionContext, engine: StrapiEngine, cache: ConfigSyncCache, db?: ConfigSyncDb): ConfigSyncView {
  const provider = new ConfigSyncProvider(engine, cache, db);
  const updateLicence = async (): Promise<void> => {
    provider.licensed = db ? await db.isLicensed() : false;
    provider.refresh();
  };
  if (db) {
    void updateLicence();
    context.subscriptions.push(db.onDidChangeState(() => provider.refresh()));
  }
  const view = vscode.window.createTreeView('strapiDevkit.configSync', { treeDataProvider: provider, showCollapseAll: true });
  provider.view = view;
  context.subscriptions.push(view, vscode.commands.registerCommand('strapiDevkit.configSync.refresh', () => provider.refresh()));
  return { refresh: () => provider.refresh(), provider, updateLicence };
}

/** The sync files config-sync can't read, every project (for diagnostics and Health). */
export async function invalidSyncFiles(cache: ConfigSyncCache): Promise<SyncFileEntry[]> {
  return (await cache.all()).flatMap((x) => x.status.files.filter((f) => f.status === 'invalid'));
}

