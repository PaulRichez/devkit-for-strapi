import { paths } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';

/** Languages we attach Strapi DevKit providers to. */
export const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { language: 'typescript', scheme: 'file' },
  { language: 'javascript', scheme: 'file' },
  { language: 'typescriptreact', scheme: 'file' },
  { language: 'javascriptreact', scheme: 'file' },
  { language: 'json', scheme: 'file' },
];

/** Forward-slash POSIX path the core expects, from a VS Code document. */
export function docPath(document: vscode.TextDocument): string {
  return paths.normalize(document.uri.fsPath);
}
