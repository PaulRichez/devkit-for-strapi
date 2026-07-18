import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

// Unlock Pro for the rename tests: the editor licence manager honours the dev
// override (DEVKIT_DEV=1 + key 'dev') — the same dogfood/test path as the MCP.
process.env.DEVKIT_DEV = '1';
process.env.DEVKIT_LICENSE_KEY = 'dev';

/**
 * End-to-end tests running inside a real VS Code Extension Host. They exercise
 * the client wiring (VscodeFileSystem, Uri↔POSIX, providers, debounce) that the
 * pure-core unit tests can't reach — driving the same providers VS Code calls.
 */

const ws = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
const fileUri = (rel: string): vscode.Uri => vscode.Uri.file(path.join(ws, rel));
const PLAYGROUND = 'apps/cms-a/src/playground.ts';

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Retry an async producer until `ok` holds (indexing is async on activation). */
async function until<T>(produce: () => PromiseLike<T>, ok: (v: T) => boolean, tries = 40): Promise<T> {
  let last = await produce();
  for (let i = 0; i < tries && !ok(last); i++) {
    await sleep(250);
    last = await produce();
  }
  return last;
}

async function openPlayground(): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(fileUri(PLAYGROUND));
  await vscode.window.showTextDocument(doc);
  return doc;
}

function posOf(doc: vscode.TextDocument, needle: string, inner = 2): vscode.Position {
  const idx = doc.getText().indexOf(needle);
  assert.ok(idx >= 0, `needle not found: ${needle}`);
  return doc.positionAt(idx + inner);
}

suite('Strapi DevKit — integration (Extension Host)', () => {
  suiteSetup(async () => {
    await vscode.extensions.getExtension('paul-richez.devkit-for-strapi')?.activate();
  });

  test('go-to-definition: service UID → service file (whole UID is one link)', async () => {
    const doc = await openPlayground();
    const pos = posOf(doc, 'api::page.notifier');
    const links = await until(
      () =>
        vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
          'vscode.executeDefinitionProvider',
          doc.uri,
          pos,
        ),
      (l) => Array.isArray(l) && l.length > 0,
    );
    assert.ok(links.length > 0, 'expected a definition');
    assert.ok(
      defTargetPath(links[0]!).endsWith(path.join('services', 'notifier.ts')),
      `unexpected target: ${defTargetPath(links[0]!)}`,
    );
    // The link spans the whole UID — not a fragment split on `.`/`:`/`-`.
    const link = links[0]!;
    if ('originSelectionRange' in link && link.originSelectionRange) {
      assert.strictEqual(doc.getText(link.originSelectionRange), 'api::page.notifier');
    }
  });

  test('go-to-definition: documents() UID → schema.json', async () => {
    const doc = await openPlayground();
    const idx = doc.getText().indexOf("documents('api::page.page')");
    const pos = doc.positionAt(doc.getText().indexOf('api::page.page', idx) + 2);
    const locs = await until(
      () =>
        vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(
          'vscode.executeDefinitionProvider',
          doc.uri,
          pos,
        ),
      (l) => Array.isArray(l) && l.length > 0,
    );
    assert.ok(defTargetPath(locs[0]!).endsWith(path.join('content-types', 'page', 'schema.json')));
  });

  test('hover: content-type shows a Strapi DevKit bubble', async () => {
    const doc = await openPlayground();
    const idx = doc.getText().indexOf("documents('api::page.page')");
    const pos = doc.positionAt(doc.getText().indexOf('api::page.page', idx) + 2);
    const hovers = await until(
      () =>
        vscode.commands.executeCommand<vscode.Hover[]>(
          'vscode.executeHoverProvider',
          doc.uri,
          pos,
        ),
      (h) => Array.isArray(h) && h.some((x) => markdown(x).includes('Content type')),
    );
    assert.ok(hovers.some((h) => markdown(h).includes('api::page.page')));
  });

  test('completion: inside documents("") suggests real UIDs', async () => {
    const doc = await openPlayground();
    // Position inside the documents('api::page.page') string is enough to trigger.
    const idx = doc.getText().indexOf("documents('api::page.page')");
    const pos = doc.positionAt(doc.getText().indexOf('api::page.page', idx) + 2);
    const list = await until(
      () =>
        vscode.commands.executeCommand<vscode.CompletionList>(
          'vscode.executeCompletionItemProvider',
          doc.uri,
          pos,
        ),
      (l) => !!l && l.items.some((i) => label(i) === 'api::page.page'),
    );
    assert.ok(list.items.some((i) => label(i) === 'api::page.section'));
  });

  test('diagnostics: the playground typos are reported', async () => {
    const doc = await openPlayground();
    const diags = await until(
      async () => vscode.languages.getDiagnostics(doc.uri),
      (d) => d.some((x) => String(x.code).startsWith('devkit-for-strapi.')),
    );
    const codes = diags.map((d) => String(d.code));
    assert.ok(codes.includes('devkit-for-strapi.unknown-content-type'), `codes: ${codes.join(', ')}`);
    assert.ok(codes.includes('devkit-for-strapi.v4-in-v5'));
  });

  test('find references: a content-type UID lists all call-sites', async () => {
    const doc = await openPlayground();
    const idx = doc.getText().indexOf("documents('api::page.page')");
    const pos = doc.positionAt(doc.getText().indexOf('api::page.page', idx) + 2);
    const locs = await until(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          doc.uri,
          pos,
        ),
      (l) => Array.isArray(l) && l.length >= 3,
    );
    assert.ok(locs.length >= 3, `expected ≥3 references, got ${locs.length}`);
  });

  test('codelens: a "N references" lens on a content-type schema', async () => {
    const uri = fileUri('apps/cms-a/src/api/page/content-types/page/schema.json');
    const isRefLens = (l: vscode.CodeLens): boolean => !!l.command && /reference/.test(l.command.title);
    const lenses = await until(
      () =>
        vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          uri,
          20,
        ),
      (l) => Array.isArray(l) && l.some(isRefLens),
    );
    const lens = lenses.find(isRefLens);
    assert.ok(lens, 'expected a references lens');
    assert.strictEqual(lens!.command!.command, 'editor.action.showReferences');
  });

  test('find references: a service method lists its call-sites (function-level)', async () => {
    const uri = fileUri('apps/cms-a/src/api/page/services/notifier.ts');
    const doc = await vscode.workspace.openTextDocument(uri);
    const pos = doc.positionAt(doc.getText().indexOf('notify(') + 1);
    const locs = await until(
      () =>
        vscode.commands.executeCommand<vscode.Location[]>(
          'vscode.executeReferenceProvider',
          doc.uri,
          pos,
        ),
      (l) => Array.isArray(l) && l.length >= 1,
    );
    assert.ok(
      locs.some((l) => l.uri.fsPath.endsWith(path.join('src', 'playground.ts'))),
      'expected the playground call-site of the notify() method',
    );
  });

  test('codelens: a per-method "N references" lens on a service method', async () => {
    const uri = fileUri('apps/cms-a/src/api/page/services/notifier.ts');
    const doc = await vscode.workspace.openTextDocument(uri);
    const methodLine = doc.positionAt(doc.getText().indexOf('async notify')).line;
    const isRefLens = (l: vscode.CodeLens): boolean => !!l.command && /reference/.test(l.command.title);
    const lenses = await until(
      () =>
        vscode.commands.executeCommand<vscode.CodeLens[]>(
          'vscode.executeCodeLensProvider',
          uri,
          20,
        ),
      (l) => Array.isArray(l) && l.some((x) => isRefLens(x) && x.range.start.line === methodLine),
    );
    assert.ok(
      lenses.some((l) => isRefLens(l) && l.range.start.line === methodLine),
      'expected a reference lens anchored on the notify method line',
    );
  });

  test('license commands are registered (Pro gate)', async () => {
    const cmds = await vscode.commands.getCommands(true);
    assert.ok(cmds.includes('strapiDevkit.enterLicenseKey'), 'enterLicenseKey not registered');
    assert.ok(cmds.includes('strapiDevkit.clearLicenseKey'), 'clearLicenseKey not registered');
  });

  test('rename: returns a workspace edit for a content-type (not applied)', async () => {
    const doc = await openPlayground();
    const idx = doc.getText().indexOf("documents('api::page.page')");
    const pos = doc.positionAt(doc.getText().indexOf('api::page.page', idx) + 2);
    const wsEdit = await until(
      () =>
        vscode.commands.executeCommand<vscode.WorkspaceEdit>(
          'vscode.executeDocumentRenameProvider',
          doc.uri,
          pos,
          'article',
        ),
      (e) => !!e && e.size > 0,
    );
    assert.ok(wsEdit.size > 0, 'expected rename text edits across files');
  });

  test('rename: a service method propagates from a call-site to its definition', async () => {
    const doc = await openPlayground();
    // The `.notify('hi')` call (not the `api::page.notifier` UID before it).
    const pos = doc.positionAt(doc.getText().indexOf('.notify(') + 2);
    const wsEdit = await until(
      () =>
        vscode.commands.executeCommand<vscode.WorkspaceEdit>(
          'vscode.executeDocumentRenameProvider',
          doc.uri,
          pos,
          'announce',
        ),
      (e) => !!e && e.entries().some(([u]) => u.fsPath.endsWith(path.join('services', 'notifier.ts'))),
    );
    const touched = wsEdit.entries().map(([u]) => u.fsPath);
    assert.ok(
      touched.some((u) => u.endsWith(path.join('services', 'notifier.ts'))),
      `expected an edit in the method definition file; got: ${touched.join(', ')}`,
    );
  });
});

/** The target file path of a definition result, whether Location or LocationLink. */
function defTargetPath(l: vscode.Location | vscode.LocationLink): string {
  return 'targetUri' in l ? l.targetUri.fsPath : l.uri.fsPath;
}

function markdown(h: vscode.Hover): string {
  return h.contents
    .map((c) => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value))
    .join('\n');
}

function label(i: vscode.CompletionItem): string {
  return typeof i.label === 'string' ? i.label : i.label.label;
}
