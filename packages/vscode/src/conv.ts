import type {
  CompletionEntry,
  DiagnosticEntry,
  ReferenceLocation,
  TargetLocation,
} from 'devkit-for-strapi-core';
import * as vscode from 'vscode';

/**
 * Convert core reference locations to VS Code Locations. Positions are
 * precomputed (line/character) in the core, so this needs no document I/O —
 * avoiding an openTextDocument storm for heavily-referenced entities.
 */
export function toReferenceLocations(refs: ReferenceLocation[]): vscode.Location[] {
  return refs.map(
    (r) =>
      new vscode.Location(
        vscode.Uri.file(r.filePath),
        new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character),
      ),
  );
}

/** Convert a core target (file + char offset) to a VS Code Location. */
export async function toLocation(t: TargetLocation): Promise<vscode.Location> {
  const uri = vscode.Uri.file(t.filePath);
  const offset = t.offset ?? 0;
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = doc.positionAt(offset);
    const end = doc.positionAt(offset + (t.length ?? 0));
    return new vscode.Location(uri, new vscode.Range(start, end));
  } catch {
    return new vscode.Location(uri, new vscode.Position(0, 0));
  }
}

const SEVERITY: Record<DiagnosticEntry['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export function toDiagnostic(
  d: DiagnosticEntry,
  document: vscode.TextDocument,
  /** Severity to apply to `error`-level entries (unknown references), user-configurable. */
  errorSeverity: vscode.DiagnosticSeverity = vscode.DiagnosticSeverity.Error,
): vscode.Diagnostic {
  const range = new vscode.Range(document.positionAt(d.start), document.positionAt(d.end));
  const severity = d.severity === 'error' ? errorSeverity : SEVERITY[d.severity];
  const diag = new vscode.Diagnostic(range, d.message, severity);
  diag.code = d.code;
  diag.source = 'DevKit for Strapi';
  return diag;
}

const COMPLETION_KIND: Record<NonNullable<CompletionEntry['kind']>, vscode.CompletionItemKind> = {
  value: vscode.CompletionItemKind.Value,
  reference: vscode.CompletionItemKind.Reference,
  method: vscode.CompletionItemKind.Method,
  class: vscode.CompletionItemKind.Class,
  module: vscode.CompletionItemKind.Module,
};

export function toCompletionItem(
  e: CompletionEntry,
  replace?: vscode.Range,
): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    e.label,
    e.kind ? COMPLETION_KIND[e.kind] : vscode.CompletionItemKind.Value,
  );
  if (e.detail) item.detail = e.detail;
  if (e.documentation) item.documentation = new vscode.MarkdownString(e.documentation);
  if (e.insertText) item.insertText = e.insertText;
  if (replace) item.range = replace;
  return item;
}
