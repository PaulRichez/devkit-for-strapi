import type { StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toCompletionItem } from '../conv';
import { DOCUMENT_SELECTOR, docPath } from '../selector';

export function registerCompletionProvider(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
): void {
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      DOCUMENT_SELECTOR,
      {
        async provideCompletionItems(document, position) {
          const enabled = vscode.workspace
            .getConfiguration('strapiDevkit.completion')
            .get<boolean>('enable', true);
          if (!enabled) return undefined;

          try {
            const result = await engine.getCompletions(
              docPath(document),
              document.offsetAt(position),
              document.getText(),
            );
            if (result.items.length === 0) return undefined;

            const replace = result.replace
              ? new vscode.Range(
                  document.positionAt(result.replace.start),
                  document.positionAt(result.replace.end),
                )
              : undefined;

            return result.items.map((e) => toCompletionItem(e, replace));
          } catch {
            return undefined;
          }
        },
      },
      "'",
      '"',
      ':',
      '.',
    ),
  );
}
