import type { FileSystem, TextEditOp, WorkspaceEdit } from 'devkit-for-strapi-core';
import { relativeTo } from './relativePaths';

/**
 * What a plan_* tool answers: the plan as an agent reviews it before `apply_edits` —
 * each text edit on one line with the text it replaces, paths relative to the project
 * root. The exact edits and the files' fingerprints stay with the server, under the
 * planId: `apply_edits` applies exactly what was reviewed.
 */
export interface PlanView {
  planId: string;
  /** The project root the paths below are relative to. */
  root: string;
  /** `12 edits in 5 files, 1 rename`. */
  summary: string;
  /** Per file, one line per edit: `25: "old" → "new"` (1-based lines). */
  edits: Record<string, string[]>;
  /** `from → to`. */
  renames?: string[];
  /** New files and their content. */
  creates?: Record<string, string>;
  deletes?: string[];
  warnings?: string[];
  /** Set when the answer leaves part of the plan out (the planId still applies all of it). */
  shortened?: string;
}

/** Characters of an old or new text shown on its line. */
const TEXT_SHOWN = 240;

/** A text quoted for its edit line — clipped, and saying so, when long. */
function quote(text: string): string {
  if (text.length <= TEXT_SHOWN) return JSON.stringify(text);
  return `${JSON.stringify(text.slice(0, TEXT_SHOWN)).slice(0, -1)}…" (${text.length} chars)`;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/** One file's edits as review lines, in file order — exact duplicates once, as the applier does. */
function editLines(content: string | undefined, edits: TextEditOp[]): string[] {
  const starts = content === undefined ? [] : lineStarts(content);
  const offset = (p: TextEditOp['start']): number => (starts[p.line] ?? content?.length ?? 0) + p.character;
  const seen = new Set<string>();
  return [...edits]
    .sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character)
    .filter((e) => {
      const key = `${e.start.line}:${e.start.character}:${e.end.line}:${e.end.character}:${e.newText}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((e) => {
      const lines = e.end.line > e.start.line ? `${e.start.line + 1}-${e.end.line + 1}` : `${e.start.line + 1}`;
      const old = content === undefined ? '(file unreadable)' : quote(content.slice(offset(e.start), offset(e.end)));
      return `${lines}: ${old} → ${quote(e.newText)}`;
    });
}

/** The review view of a plan, within `max` characters (files past it are counted, not listed). */
export async function planView(
  fs: FileSystem,
  root: string,
  plan: WorkspaceEdit & { planId: string },
  warnings: string[] | undefined,
  max: number,
): Promise<PlanView> {
  const byFile = new Map<string, TextEditOp[]>();
  for (const e of plan.textEdits) byFile.set(e.filePath, [...(byFile.get(e.filePath) ?? []), e]);

  const edits: Record<string, string[]> = {};
  let editCount = 0;
  for (const [file, list] of byFile) {
    const content = await fs.readFile(file).catch(() => undefined);
    const lines = editLines(content, list);
    editCount += lines.length;
    edits[relativeTo(root, file)] = lines;
  }

  const renames = plan.fileRenames.map((r) => `${relativeTo(root, r.from)} → ${relativeTo(root, r.to)}`);
  const creates = Object.fromEntries((plan.fileCreates ?? []).map((c) => [relativeTo(root, c.path), c.content]));
  const deletes = (plan.fileDeletes ?? []).map((d) => relativeTo(root, d));
  const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
  const summary = [
    `${count(editCount, 'edit')} in ${count(byFile.size, 'file')}`,
    ...(renames.length ? [count(renames.length, 'rename')] : []),
    ...(deletes.length ? [count(deletes.length, 'delete')] : []),
    ...(Object.keys(creates).length ? [count(Object.keys(creates).length, 'new file')] : []),
  ].join(', ');

  const view: PlanView = {
    planId: plan.planId,
    root,
    summary,
    edits,
    ...(renames.length ? { renames } : {}),
    ...(Object.keys(creates).length ? { creates } : {}),
    ...(deletes.length ? { deletes } : {}),
    ...(warnings?.length ? { warnings } : {}),
  };

  // Too long for one answer: whole files while they fit, then the rest as counts,
  // with room left for the note that says so.
  let size = JSON.stringify(view, null, 2).length;
  if (size <= max) return view;
  const room = max - 300;
  const files = Object.keys(edits);
  let counted = 0;
  for (let i = files.length - 1; i >= 0 && size > room; i--) {
    const f = files[i]!;
    const n = edits[f]!.length;
    size -= JSON.stringify(edits[f], null, 2).length;
    edits[f] = [`${count(n, 'edit')}, not shown: too long for one answer`];
    size += JSON.stringify(edits[f], null, 2).length;
    counted++;
  }
  view.shortened = `${count(counted, 'file')} shown as a count only: the answer would be too long. apply_edits applies the whole plan, those files included (git diff shows their edits once applied).`;
  return view;
}
