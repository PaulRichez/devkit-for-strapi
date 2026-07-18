import type { StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { DOCUMENT_SELECTOR, docPath } from '../selector';

export function registerHoverProvider(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
): void {
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(DOCUMENT_SELECTOR, {
      async provideHover(document, position) {
        if (!vscode.workspace.getConfiguration('strapiDevkit.hover').get<boolean>('enable', true)) {
          return undefined;
        }
        try {
          const info = await engine.getHover(
            docPath(document),
            document.offsetAt(position),
            document.getText(),
          );
          if (!info) return undefined;
          const md = new vscode.MarkdownString(info.markdown);
          md.supportHtml = false;
          const range = info.range
            ? new vscode.Range(
                document.positionAt(info.range.start),
                document.positionAt(info.range.end),
              )
            : undefined;
          return new vscode.Hover(md, range);
        } catch {
          return undefined;
        }
      },
    }),
  );
}
