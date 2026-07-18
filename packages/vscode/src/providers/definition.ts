import type { StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toLocation } from '../conv';
import { DOCUMENT_SELECTOR, docPath } from '../selector';

export function registerDefinitionProvider(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
): void {
  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(DOCUMENT_SELECTOR, {
      async provideDefinition(document, position) {
        try {
          const path = docPath(document);
          const offset = document.offsetAt(position);
          const text = document.getText();
          const targets = await engine.getDefinitions(path, offset, text);
          if (targets.length === 0) return undefined;
          const locations = await Promise.all(targets.map(toLocation));

          // Pin the link to the WHOLE magic string so editors don't split it on
          // word separators (`-`, `.`, `:`) — e.g. `api::analyse.analyse-individuel`
          // would otherwise become two separate links ("analyse" / "individuel").
          const ref = engine.getReferenceRange(path, offset, text);
          if (!ref) return locations;
          const originSelectionRange = new vscode.Range(
            document.positionAt(ref.start),
            document.positionAt(ref.end),
          );
          return locations.map(
            (loc): vscode.LocationLink => ({
              originSelectionRange,
              targetUri: loc.uri,
              targetRange: loc.range,
            }),
          );
        } catch {
          return undefined;
        }
      },
    }),
  );
}
