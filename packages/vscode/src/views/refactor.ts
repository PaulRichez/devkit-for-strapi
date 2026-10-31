import {
  followConfigSync,
  type FileSystem,
  movedUid,
  paths,
  refKind,
  renamedUid,
  storedUidWarnings,
  type StrapiEngine,
  type StrapiProject,
  touchedPaths,
  type WorkspaceEdit,
} from 'devkit-for-strapi-core';
import { GET_PRO_URL, planChangeRelation, planCreatePlugin, planMove, planRename, planRenameAttribute } from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';
import { toVscodeWorkspaceEdit } from '../conv';
import { withOffer } from '../offer';

/**
 * Refactors from the panel (Pro): rename a content-type, a component, a field or a
 * controller action, retarget a relation, move a content-type into a plugin, scaffold
 * a plugin. Every one goes the same way: the plan is computed from the files on disk
 * (unsaved ones saved first), its caveats are shown — the database ones included —
 * then VS Code's Refactor Preview opens: nothing is written until it is applied there.
 */

/** Test hook: skip the prompts (newName / target / plugin); `dryRun` returns the planned edit (core shape) instead of opening the preview. */
export interface RefactorTestArgs {
  newName?: string;
  target?: string;
  plugin?: string;
  dryRun?: boolean;
}

interface PlanOutcome {
  edit?: WorkspaceEdit;
  errors: string[];
  warnings: string[];
}

// Structural views of the tree nodes these commands are invoked on.
interface TypeNode {
  kind: 'type';
  root: string;
  type: { kind: 'ct'; ct: { uid: string; displayName: string; origin: string; inCode?: boolean } } | { kind: 'component'; c: { uid: string; displayName: string } };
}
interface FieldNode {
  kind: 'field';
  root: string;
  type: TypeNode['type'];
  field: { name: string; type: string; target?: string };
}
interface StepNode {
  kind: 'step';
  root: string;
  step: { phase: string; status: string; name: string; ref?: string };
  route: { handler: string; owner?: string };
}
interface ActionNode {
  kind: 'action';
  root: string;
  artifact: { ref: string; kind: string; installed?: boolean };
  action: { name: string };
}

const NAME = /^[a-z][a-z0-9-]*$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METHOD = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function registerRefactorCommands(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
  fs: FileSystem,
  isLicensed: () => Promise<boolean>,
): void {
  const projectOf = (root: string): StrapiProject | undefined => engine.allProjects().find((p) => p.root === root);

  const upsell = async (): Promise<void> => {
    const pick = await vscode.window.showInformationMessage(
      withOffer('Refactoring from the DevKit panel is a DevKit for Strapi Pro feature (the views stay free).'),
      'Enter License Key',
      'Get Pro',
    );
    if (pick === 'Enter License Key') await vscode.commands.executeCommand('strapiDevkit.enterLicenseKey');
    if (pick === 'Get Pro') await vscode.env.openExternal(vscode.Uri.parse(GET_PRO_URL));
  };

  /** The plan reads the disk: save this project's modified files first (and re-index them). */
  const saveDirty = async (root: string, test: boolean): Promise<boolean> => {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && engine.projectForFile(paths.normalize(d.uri.fsPath))?.root === root);
    if (!dirty.length) return true;
    if (!test) {
      const ok = await vscode.window.showWarningMessage(
        `${dirty.length} file${dirty.length === 1 ? ' has' : 's have'} unsaved changes. The refactor is computed from the files on disk: save ${dirty.length === 1 ? 'it' : 'them'} first?`,
        { modal: true },
        'Save and Continue',
      );
      if (ok !== 'Save and Continue') return false;
    }
    for (const d of dirty) await d.save();
    await engine.onFilesChanged(dirty.map((d) => paths.normalize(d.uri.fsPath)), []);
    return true;
  };

  /** The common path: license, save, plan, caveats, Refactor Preview. */
  const run = async (
    root: string,
    label: string,
    plan: (project: StrapiProject) => Promise<PlanOutcome>,
    dbWarnings: (project: StrapiProject) => string[],
    test?: RefactorTestArgs,
  ): Promise<vscode.WorkspaceEdit | WorkspaceEdit | string | undefined> => {
    if (!(await isLicensed())) {
      if (!test) await upsell();
      return 'pro-required';
    }
    if (!(await saveDirty(root, !!test))) return undefined;
    await engine.whenReferencesReady();
    const project = projectOf(root);
    if (!project) return 'no-project';
    let outcome: PlanOutcome;
    try {
      outcome = await plan(project);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!test) void vscode.window.showErrorMessage(`DevKit for Strapi: ${msg}`);
      return msg;
    }
    if (!outcome.edit || outcome.errors.length) {
      const msg = outcome.errors.join('\n') || 'Nothing to change (the name is invalid or unchanged).';
      if (!test) void vscode.window.showErrorMessage(`DevKit for Strapi — ${label}: ${msg}`);
      return msg;
    }
    if (touchedPaths(outcome.edit).some((p) => p.split('/').includes('node_modules'))) {
      const msg = 'DevKit for Strapi does not edit code in node_modules (an installed plugin). Extend it under src/extensions instead.';
      if (!test) void vscode.window.showErrorMessage(msg);
      return msg;
    }
    // config/sync follows the refactor unless the project says otherwise (its files may come from elsewhere).
    const follow = vscode.workspace.getConfiguration('strapiDevkit.configSync', vscode.Uri.file(root)).get<boolean>('followRefactors', true);
    const sync = await followConfigSync(fs, project, outcome.edit, follow);
    if (test?.dryRun) return sync.edit;
    const caveats = [...outcome.warnings, ...dbWarnings(project), ...(sync.note ? [sync.note] : [])];
    const edit = toVscodeWorkspaceEdit(sync.edit, { label, description: 'DevKit for Strapi' });
    if (caveats.length) {
      const go = await vscode.window.showWarningMessage(`${label}: read before applying`, { modal: true, detail: caveats.join('\n\n') }, 'Preview Changes');
      if (go !== 'Preview Changes') return undefined;
    }
    // needsConfirmation on every entry → VS Code opens the Refactor Preview; nothing is written before "Apply".
    await vscode.workspace.applyEdit(edit, { isRefactoring: true });
    return edit;
  };

  const ask = async (prompt: string, value: string, valid: RegExp, hint: string): Promise<string | undefined> => {
    const v = await vscode.window.showInputBox({
      prompt,
      value,
      valueSelection: [0, value.length],
      validateInput: (s) => (s === value ? 'Unchanged' : valid.test(s) ? undefined : hint),
    });
    return v?.trim() || undefined;
  };

  const editOf = (e: WorkspaceEdit | undefined, fallback: string): PlanOutcome =>
    e ? { edit: e, errors: [], warnings: e.warnings ?? [] } : { errors: [fallback], warnings: [] };

  const schemaOutcome = (p: { ok: boolean; errors: string[]; warnings: string[]; textEdits: WorkspaceEdit['textEdits']; fileRenames: WorkspaceEdit['fileRenames'] }): PlanOutcome =>
    p.ok ? { edit: { textEdits: p.textEdits, fileRenames: p.fileRenames }, errors: [], warnings: p.warnings } : { errors: p.errors, warnings: p.warnings };

  context.subscriptions.push(
    vscode.commands.registerCommand('strapiDevkit.refactor.renameType', async (node?: TypeNode, test?: RefactorTestArgs) => {
      if (node?.kind !== 'type') return undefined;
      const uid = node.type.kind === 'ct' ? node.type.ct.uid : node.type.c.uid;
      const current = uid.slice(uid.lastIndexOf('.') + 1);
      const newName = test?.newName ?? (await ask(`Rename ${uid} to…`, current, NAME, 'kebab-case: lowercase letters, digits and dashes'));
      if (!newName) return undefined;
      return run(
        node.root,
        `Rename ${uid}`,
        async (project) => editOf(await planRename(fs, project, uid, newName), `${uid} cannot be renamed to '${newName}'.`),
        (project) => {
          const kind = refKind(project.index, uid);
          return kind ? storedUidWarnings({ uids: [{ kind, from: uid, to: renamedUid(uid, newName) }] }) : [];
        },
        test,
      );
    }),

    vscode.commands.registerCommand('strapiDevkit.refactor.renameField', async (node?: FieldNode, test?: RefactorTestArgs) => {
      if (node?.kind !== 'field' || node.type.kind !== 'ct') return undefined;
      const uid = node.type.ct.uid;
      const field = node.field.name;
      const newName = test?.newName ?? (await ask(`Rename the field ${field} of ${uid} to…`, field, FIELD, 'letters, digits and underscores'));
      if (!newName) return undefined;
      return run(node.root, `Rename ${uid}.${field}`, async (project) => schemaOutcome(await planRenameAttribute(fs, project, uid, field, newName)), () => [
        "Database: Strapi creates the field under its new name — existing entries' values are not carried over unless a migration renames the column before the next start.",
      ], test);
    }),

    vscode.commands.registerCommand('strapiDevkit.refactor.changeRelation', async (node?: FieldNode, test?: RefactorTestArgs) => {
      if (node?.kind !== 'field' || node.type.kind !== 'ct' || node.field.type !== 'relation') return undefined;
      const uid = node.type.ct.uid;
      const field = node.field.name;
      let target = test?.target;
      if (!target) {
        const project = projectOf(node.root);
        const types = project ? [...project.index.contentTypes.values()].filter((c) => c.uid !== node.field.target) : [];
        const pick = await vscode.window.showQuickPick(
          types.map((c) => ({ label: c.info.displayName ?? c.ctName, description: c.uid, uid: c.uid })),
          { title: `New target of ${uid}.${field}`, placeHolder: node.field.target ? `currently ${node.field.target}` : undefined, matchOnDescription: true },
        );
        target = pick?.uid;
      }
      if (!target) return undefined;
      const newTarget = target;
      return run(node.root, `Retarget ${uid}.${field}`, async (project) => schemaOutcome(await planChangeRelation(fs, project, uid, field, newTarget)), () => [
        'Database: the existing links of this field were made to entries of the old target; they are not converted — migrate or clear them.',
      ], test);
    }),

    vscode.commands.registerCommand('strapiDevkit.refactor.moveToPlugin', async (node?: TypeNode, test?: RefactorTestArgs) => {
      if (node?.kind !== 'type' || node.type.kind !== 'ct') return undefined;
      const uid = node.type.ct.uid;
      const project = projectOf(node.root);
      let plugin = test?.plugin;
      let create = false;
      if (!plugin) {
        const NEW = '$(add) New plugin…';
        const pick = await vscode.window.showQuickPick(
          [...[...(project?.index.pluginNames ?? [])].sort().map((label) => ({ label, description: 'local plugin' })), { label: NEW, description: 'scaffold it in src/plugins' }],
          { title: `Move ${uid} (content-type, service, controller, routes) into a plugin` },
        );
        if (!pick) return undefined;
        if (pick.label === NEW) {
          plugin = await ask('Name of the new plugin', 'my-plugin', NAME, 'kebab-case: lowercase letters, digits and dashes');
          create = true;
        } else plugin = pick.label;
      } else create = !project?.index.pluginNames.has(plugin);
      if (!plugin) return undefined;
      const ns = `plugin::${plugin}`;
      const name = plugin;
      return run(
        node.root,
        `Move ${uid} to ${ns}`,
        async (p) => {
          const scaffold = create ? await planCreatePlugin(fs, p, name) : undefined;
          if (scaffold && !scaffold.ok) return { errors: scaffold.errors, warnings: scaffold.warnings };
          const move = await planMove(fs, p, [{ ref: uid, toNamespace: ns }], create ? { allowNewNamespace: true, destinationLoadsFolders: true } : undefined);
          const warnings = [...(scaffold?.warnings ?? []), ...move.warnings];
          if (!move.ok) return { errors: move.errors, warnings };
          return { edit: { textEdits: [...(scaffold?.textEdits ?? []), ...move.textEdits], fileRenames: move.fileRenames, ...(scaffold ? { fileCreates: scaffold.fileCreates } : {}) }, errors: [], warnings };
        },
        () => storedUidWarnings({ uids: [{ kind: 'content-type', from: uid, to: movedUid(uid, ns) }] }),
        test,
      );
    }),

    vscode.commands.registerCommand('strapiDevkit.refactor.renameMethod', async (node?: StepNode | ActionNode, test?: RefactorTestArgs) => {
      let controllerRef: string | undefined;
      let action: string | undefined;
      if (node?.kind === 'step' && node.step.phase === 'handler') {
        const h = node.step.ref ?? node.step.name;
        controllerRef = h.slice(0, h.lastIndexOf('.'));
        action = h.slice(h.lastIndexOf('.') + 1);
      } else if (node?.kind === 'action' && !node.artifact.installed) {
        controllerRef = node.artifact.ref;
        action = node.action.name;
      }
      if (!node || !controllerRef || !action) return undefined;
      const ref = controllerRef;
      const method = action;
      const newName = test?.newName ?? (await ask(`Rename ${ref}.${method} to…`, method, METHOD, 'a JavaScript identifier'));
      if (!newName) return undefined;
      return run(
        node.root,
        `Rename ${ref}.${method}`,
        // Route handlers and plugin actions are controller actions (a service often shares the ref).
        async (project) => editOf(await planRename(fs, project, ref, newName, method, 'controller'),`${ref}.${method} cannot be renamed (not an indexed method, or '${newName}' is invalid).`),
        (project) => (project.index.controllers.has(ref) ? storedUidWarnings({ actions: [{ from: `${ref}.${method}`, to: `${ref}.${newName}` }] }) : []),
        test,
      );
    }),

    vscode.commands.registerCommand('strapiDevkit.refactor.createPlugin', async (root?: string, test?: RefactorTestArgs) => {
      let target = typeof root === 'string' ? root : undefined;
      if (!target) {
        const roots = engine.getProjects().map((p) => p.root);
        target = roots.length === 1 ? roots[0] : (await vscode.window.showQuickPick(roots, { title: 'Create the plugin in which project?' }));
      }
      if (!target) return undefined;
      const name = test?.newName ?? (await ask('Name of the new plugin', 'my-plugin', NAME, 'kebab-case: lowercase letters, digits and dashes'));
      if (!name) return undefined;
      return run(
        target,
        `Create plugin ${name}`,
        async (project) => {
          const s = await planCreatePlugin(fs, project, name);
          return s.ok ? { edit: { textEdits: s.textEdits, fileRenames: [], fileCreates: s.fileCreates }, errors: [], warnings: s.warnings } : { errors: s.errors, warnings: s.warnings };
        },
        () => [],
        test,
      );
    }),
  );
}
