import * as vscode from 'vscode';
import { type ConfigSyncCache, invalidSyncFiles, STATUS_TEXT } from '../views/configSync';

/**
 * The config-sync files config-sync can't read (not valid JSON, or empty), whether they
 * are open or not: a problem there shows in no other file.
 */

const SOURCE = 'DevKit config-sync';

export interface ConfigSyncDiagnostics {
  /** Recompute from the (refreshed) cache. */
  refresh(): Promise<void>;
}

export function registerConfigSyncDiagnostics(context: vscode.ExtensionContext, cache: ConfigSyncCache): ConfigSyncDiagnostics {
  const collection = vscode.languages.createDiagnosticCollection('strapiDevkit-configSync');
  let generation = 0;

  const refresh = async (): Promise<void> => {
    const mine = ++generation;
    const files = await invalidSyncFiles(cache);
    if (mine !== generation) return; // a newer refresh is on its way
    collection.clear();
    for (const f of files) {
      const d = new vscode.Diagnostic(new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER), STATUS_TEXT.invalid, vscode.DiagnosticSeverity.Error);
      d.source = SOURCE;
      d.code = 'invalid-json';
      collection.set(vscode.Uri.file(f.path), [d]);
    }
  };

  context.subscriptions.push(collection);
  return { refresh };
}
