import type { StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toLocation, toReferenceLocations } from '../conv';
import { DOCUMENT_SELECTOR, docPath } from '../selector';

export function registerReferenceProvider(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
): void {
  context.subscriptions.push(
    vscode.languages.registerReferenceProvider(DOCUMENT_SELECTOR, {
      async provideReferences(document, position, refContext) {
        try {
          const path = docPath(document);
          const offset = document.offsetAt(position);
          const text = document.getText();
          const locations = toReferenceLocations(await engine.getReferences(path, offset, text));
          if (refContext.includeDeclaration) {
            const defs = await engine.getDefinitions(path, offset, text);
            for (const d of defs) locations.push(await toLocation(d));
          }
          return locations;
        } catch {
          return [];
        }
      },
    }),
  );
}
