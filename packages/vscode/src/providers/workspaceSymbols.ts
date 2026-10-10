import { paths, type StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';

/**
 * Ctrl+T (Go to Symbol in Workspace) finds Strapi's own names: content-type and
 * component UIDs, services, controllers and their actions, policies, middlewares,
 * and routes (`GET /api/articles`) — none of which TypeScript knows as symbols.
 * Locations are resolved lazily (the file is read only when one is picked).
 */

const MAX_RESULTS = 500;

class StrapiSymbol extends vscode.SymbolInformation {
  constructor(
    name: string,
    kind: vscode.SymbolKind,
    container: string,
    readonly filePath: string,
    readonly offset: number,
  ) {
    super(name, kind, container, new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0)));
  }
}

/** Every character of `q` in order (VS Code ranks the results itself). */
function matches(name: string, q: string): boolean {
  if (!q) return true;
  const n = name.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = n.indexOf(ch, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

export function registerWorkspaceSymbols(context: vscode.ExtensionContext, engine: StrapiEngine): void {
  context.subscriptions.push(
    vscode.languages.registerWorkspaceSymbolProvider({
      async provideWorkspaceSymbols(query, token) {
        const out: StrapiSymbol[] = [];
        const push = (s: StrapiSymbol): boolean => {
          if (matches(s.name, query)) out.push(s);
          return out.length < MAX_RESULTS && !token.isCancellationRequested;
        };
        const multi = engine.allProjects().length > 1;
        for (const project of engine.allProjects()) {
          const where = (installed?: boolean): string => [multi ? paths.basename(project.root) : '', installed ? 'installed plugin' : 'Strapi'].filter(Boolean).join(' · ');
          const idx = project.index;
          for (const ct of [...idx.contentTypes.values(), ...(idx.codeContentTypes?.values() ?? [])]) {
            if (!push(new StrapiSymbol(ct.uid, vscode.SymbolKind.Class, `${ct.info.displayName ?? ct.ctName} · content-type · ${where(ct.installed)}`, ct.schemaPath, ct.defOffset ?? 0))) return out;
          }
          for (const c of idx.components.values()) {
            if (!push(new StrapiSymbol(c.uid, vscode.SymbolKind.Struct, `${c.info.displayName ?? c.name} · component · ${where()}`, c.jsonPath, c.defOffset ?? 0))) return out;
          }
          const kinds: Array<[Map<string, import('devkit-for-strapi-core').CodeArtifact>, vscode.SymbolKind, string]> = [
            [idx.services, vscode.SymbolKind.Module, 'service'],
            [idx.controllers, vscode.SymbolKind.Interface, 'controller'],
            [idx.policies, vscode.SymbolKind.Function, 'policy'],
            [idx.middlewares, vscode.SymbolKind.Function, 'middleware'],
          ];
          for (const [map, kind, label] of kinds) {
            for (const a of map.values()) {
              if (!push(new StrapiSymbol(a.ref, kind, `${label} · ${where(a.installed)}`, a.filePath, a.defOffset ?? 0))) return out;
              for (const act of a.actions ?? []) {
                if (!push(new StrapiSymbol(`${a.ref}.${act.name}`, vscode.SymbolKind.Method, `action · ${where(a.installed)}`, act.filePath ?? a.filePath, act.offset))) return out;
              }
            }
          }
          const routes = (await engine.getRoutes({ admin: false, root: project.root }))[0]?.routes ?? [];
          for (const r of routes) {
            if (!r.filePath) continue;
            if (!push(new StrapiSymbol(`${r.method.toUpperCase()} ${r.fullPath ?? r.path}`, vscode.SymbolKind.Event, `route → ${r.handler} · ${where(r.origin === 'installed-plugin')}`, r.filePath, r.offset ?? 0))) return out;
          }
        }
        return out;
      },
      async resolveWorkspaceSymbol(symbol) {
        if (!(symbol instanceof StrapiSymbol)) return symbol;
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(symbol.filePath));
          const pos = doc.positionAt(symbol.offset);
          symbol.location = new vscode.Location(doc.uri, new vscode.Range(pos, pos));
        } catch {
          /* keep the file's start */
        }
        return symbol;
      },
    }),
  );
}
