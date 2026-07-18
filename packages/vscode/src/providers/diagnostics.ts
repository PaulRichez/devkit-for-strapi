import type { DiagnosticEntry, StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toDiagnostic } from '../conv';
import { DOCUMENT_SELECTOR, docPath } from '../selector';

export interface Diagnostics {
  /** Re-validate every open document (call after indexing changes). */
  revalidateAll(): void;
}

export function registerDiagnostics(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
): Diagnostics {
  const collection = vscode.languages.createDiagnosticCollection('strapiDevkit');
  context.subscriptions.push(collection);

  // Last validation result per document, reused by quick fixes (no re-validation).
  const lastEntries = new Map<string, DiagnosticEntry[]>();

  const enabled = (): boolean =>
    vscode.workspace.getConfiguration('strapiDevkit.diagnostics').get<boolean>('enable', true);

  /** User-configured severity for unknown/invalid references (`error`-level entries). */
  const errorSeverity = (): vscode.DiagnosticSeverity => {
    switch (
      vscode.workspace.getConfiguration('strapiDevkit.diagnostics').get<string>('unknownReferenceSeverity', 'error')
    ) {
      case 'warning':
        return vscode.DiagnosticSeverity.Warning;
      case 'information':
        return vscode.DiagnosticSeverity.Information;
      case 'hint':
        return vscode.DiagnosticSeverity.Hint;
      default:
        return vscode.DiagnosticSeverity.Error;
    }
  };

  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const run = async (document: vscode.TextDocument): Promise<void> => {
    const key = document.uri.toString();
    if (!enabled() || vscode.languages.match(DOCUMENT_SELECTOR, document) === 0) {
      collection.delete(document.uri);
      lastEntries.delete(key);
      return;
    }
    try {
      const entries = await engine.validateFile(docPath(document), document.getText());
      lastEntries.set(key, entries);
      const sev = errorSeverity();
      collection.set(
        document.uri,
        entries.map((e) => toDiagnostic(e, document, sev)),
      );
    } catch {
      /* leave previous diagnostics in place on a transient failure */
    }
  };

  const schedule = (document: vscode.TextDocument): void => {
    const key = document.uri.toString();
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void run(document);
      }, 300),
    );
  };

  const revalidateAll = (): void => {
    for (const doc of vscode.workspace.textDocuments) void run(doc);
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => void run(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      collection.delete(doc.uri);
      lastEntries.delete(doc.uri.toString());
    }),
    // Toggling diagnostics on/off or changing the severity takes effect at once.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('strapiDevkit.diagnostics')) revalidateAll();
    }),
  );
  revalidateAll();

  registerQuickFixes(context, lastEntries);
  return { revalidateAll };
}

/** Quick fixes: replace an unknown reference with the closest known one. */
function registerQuickFixes(
  context: vscode.ExtensionContext,
  lastEntries: Map<string, DiagnosticEntry[]>,
): void {
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      DOCUMENT_SELECTOR,
      {
        provideCodeActions(document, range) {
          // Reuse the latest validation result instead of re-parsing on every cursor move.
          const entries = lastEntries.get(document.uri.toString());
          if (!entries) return [];
          const actions: vscode.CodeAction[] = [];
          for (const e of entries) {
            if (!e.quickFixes?.length) continue;
            const r = new vscode.Range(document.positionAt(e.start), document.positionAt(e.end));
            if (!r.intersection(range)) continue;
            for (const fix of e.quickFixes) {
              const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
              action.edit = new vscode.WorkspaceEdit();
              action.edit.replace(document.uri, r, fix.replacement);
              actions.push(action);
            }
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );
}
