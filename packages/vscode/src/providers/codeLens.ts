import type { ReferenceLocation, StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toReferenceLocations } from '../conv';
import { DOCUMENT_SELECTOR, docPath } from '../selector';

/** A "N references"/"N incoming relations" lens carrying its locations for lazy resolution. */
class ReferencesLens extends vscode.CodeLens {
  constructor(
    range: vscode.Range,
    readonly uri: vscode.Uri,
    readonly anchor: vscode.Position,
    readonly count: number,
    readonly kind: 'references' | 'incoming-relations',
    readonly refs: ReferenceLocation[],
  ) {
    super(range);
  }
}

export interface CodeLenses {
  /** Re-emit lenses (call after indexing changes). */
  refresh(): void;
}

export function registerCodeLensProvider(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
): CodeLenses {
  const onDidChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(onDidChange);
  // Toggling the lens on/off should take effect without a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('strapiDevkit.referencesCodeLens')) onDidChange.fire();
    }),
  );
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(DOCUMENT_SELECTOR, {
      onDidChangeCodeLenses: onDidChange.event,
      async provideCodeLenses(document) {
        const cfg = vscode.workspace.getConfiguration('strapiDevkit.referencesCodeLens');
        if (!cfg.get<boolean>('enable', true)) return [];
        const showMethods = cfg.get<boolean>('methods', true);
        try {
          const entries = await engine.getCodeLenses(docPath(document), document.getText());
          // Methods always get a lens (incl. "0 references" — a service/controller
          // method with no Strapi call-site or route handler is likely unused).
          // Entity-level lenses only when there are refs TS can't see — a
          // "0 references" there is noise next to the file (unused content-types
          // surface in the Model Explorer's Issues instead). Methods toggle separately.
          return entries
            .filter((e) => (e.method ? showMethods : e.count > 0))
            .map((e) => {
              const anchor = document.positionAt(e.offset);
              return new ReferencesLens(
                new vscode.Range(anchor, anchor),
                document.uri,
                anchor,
                e.count,
                e.kind ?? 'references',
                e.references,
              );
            });
        } catch {
          return [];
        }
      },
      resolveCodeLens(lens) {
        if (!(lens instanceof ReferencesLens)) return lens;
        // Branded so it's distinguishable from the built-in TS "N references"
        // lens. The incoming-relations title avoids the word "reference" on purpose.
        const title =
          lens.kind === 'incoming-relations'
            ? `${lens.count} incoming relation${lens.count === 1 ? '' : 's'}`
            : lens.count === 1
              ? '1 reference (Strapi)'
              : `${lens.count} references (Strapi)`;
        lens.command = {
          title,
          command: 'editor.action.showReferences',
          arguments: [lens.uri, lens.anchor, toReferenceLocations(lens.refs)],
        };
        return lens;
      },
    }),
  );
  return { refresh: () => onDidChange.fire() };
}
