import { paths, type StepStatus, type StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';

/**
 * Shared plumbing of the DevKit panel's trees: nodes are built once per index
 * generation and kept (stable ids, same objects), so expansion survives a refresh
 * and `TreeView.reveal` can find a node again.
 */

export interface TreeNode {
  /** Stable across refreshes: `<view>|<root>|<key>`. */
  id: string;
  parent?: TreeNode;
}

export abstract class CachedTree<N extends TreeNode> implements vscode.TreeDataProvider<N> {
  protected readonly emitter = new vscode.EventEmitter<N | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private children = new Map<string, Promise<N[]>>();

  /** Drop every built node: the next `getChildren` rebuilds from the engine. */
  refresh(): void {
    this.children.clear();
    this.reset();
    this.emitter.fire(undefined);
  }

  /** Subclasses drop their own per-generation data here. */
  protected reset(): void {}

  getChildren(element?: N): Promise<N[]> {
    const key = element?.id ?? '';
    let c = this.children.get(key);
    if (!c) {
      c = this.build(element).then((nodes) => {
        // Never two nodes with one id (VS Code refuses the whole tree).
        const seen = new Set<string>();
        for (const n of nodes) {
          let id = n.id;
          for (let i = 2; seen.has(id); i++) id = `${n.id}#${i}`;
          n.id = id;
          seen.add(id);
          if (element) n.parent = element;
        }
        return nodes;
      });
      c.catch(() => this.children.delete(key));
      this.children.set(key, c);
    }
    return c;
  }

  getParent(element: N): N | undefined {
    return element.parent as N | undefined;
  }

  abstract getTreeItem(element: N): vscode.TreeItem;
  protected abstract build(element?: N): Promise<N[]>;

  /** The first node (breadth-first, expanding as needed) matching `pred`, descending only where `into` allows. */
  async find(pred: (n: N) => boolean, into: (n: N) => boolean = () => true): Promise<N | undefined> {
    let level = await this.getChildren();
    while (level.length) {
      const hit = level.find(pred);
      if (hit) return hit;
      const next: N[] = [];
      for (const n of level) if (into(n)) next.push(...(await this.getChildren(n)));
      level = next;
    }
    return undefined;
  }
}

/** Inline code that can't break out of its backticks. */
export function code(s: string): string {
  return `\`${s.replace(/`/g, "'")}\``;
}

export function markdown(): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportHtml = false;
  return md;
}

export function relPath(p: string): string {
  return vscode.workspace.asRelativePath(p);
}

/** In node_modules: shown, never edited. */
export function isInstalledPath(p: string): boolean {
  return paths.normalize(p).includes('/node_modules/');
}

export async function openAt(filePath: string, offset = 0): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const pos = doc.positionAt(offset);
  await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
}

/** The command that opens `filePath` at `offset` (for a TreeItem). */
export function openCommand(filePath: string, offset = 0, title = 'Open'): vscode.Command {
  return { command: 'strapiDevkit.open', title, arguments: [filePath, offset] };
}

/** Project roots, the active editor's project first. */
export function orderedRoots(engine: StrapiEngine, roots: string[]): string[] {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const mine = active ? engine.projectForFile(paths.normalize(active))?.root : undefined;
  return [...roots].sort((a, b) => (a === mine ? -1 : b === mine ? 1 : a.localeCompare(b)));
}

export function projectLabel(root: string): string {
  return paths.basename(root);
}

const STATUS_ICON: Record<StepStatus, [string, string | undefined]> = {
  ok: ['pass', 'testing.iconPassed'],
  'not-found-by-strapi': ['warning', 'problemsErrorIcon.foreground'],
  unknown: ['error', 'problemsErrorIcon.foreground'],
  unverified: ['question', 'descriptionForeground'],
  unread: ['circle-slash', 'descriptionForeground'],
  inline: ['symbol-function', undefined],
};

export function statusIcon(s: StepStatus): vscode.ThemeIcon {
  const [icon, color] = STATUS_ICON[s];
  return new vscode.ThemeIcon(icon, color ? new vscode.ThemeColor(color) : undefined);
}

export const STATUS_TEXT: Record<StepStatus, string> = {
  ok: 'Found where Strapi looks for it.',
  'not-found-by-strapi': "Exists, but not under the name Strapi looks up: Strapi throws at startup.",
  unknown: 'Not found: Strapi throws at startup.',
  unverified: 'Not checked by DevKit.',
  unread: 'Not read statically.',
  inline: 'A function declared in place.',
};

export function isProblem(s: StepStatus): boolean {
  return s === 'unknown' || s === 'not-found-by-strapi';
}

/** True while any project's installed plugins are still being read. */
export function pluginsLoading(engine: StrapiEngine): boolean {
  return engine.getProjects().some((p) => p.freshness.pluginsLoading);
}

export const LOADING_MESSAGE = 'Reading installed plugins… their entries appear when done.';
