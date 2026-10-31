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
  /** Set when the answer leaves part of the plan out, saying what (the planId still applies all of it). */
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

const span = (from: number, to: number): string => (to > from ? `${from}-${to}` : `${from}`);

/**
 * A multi-line edit (a whole sync file rewritten, a block inserted) as the lines it
 * really changes — not its first characters — and a line saying when it changes the
 * line endings. `first`: the 1-based line the old text starts on.
 */
function changedLines(first: number, old: string, next: string): string[] {
  const a = old.split(/\r?\n/);
  const b = next.split(/\r?\n/);
  const crlf = (s: string): boolean => s.includes('\r\n');
  const eol = crlf(old) !== crlf(next) && old.includes('\n') && next.includes('\n') ? [`${span(first, first + a.length - 1)}: line endings ${crlf(old) ? 'CRLF → LF' : 'LF → CRLF'}`] : [];
  if (a.length === b.length) {
    const out: string[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(`${first + i}: ${quote(a[i]!)} → ${quote(b[i]!)}`);
    return out.length || eol.length ? [...out, ...eol] : [`${span(first, first + a.length - 1)}: unchanged`];
  }
  // Lines added or removed: the block between the first and the last lines both keep.
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldBlock = a.slice(p, a.length - s).join('\n');
  const newBlock = b.slice(p, b.length - s).join('\n');
  return [`${span(first + p, Math.max(first + p, first + a.length - 1 - s))}: ${quote(oldBlock)} → ${quote(newBlock)}`, ...eol];
}

/** One file's edits as review lines, in file order — exact duplicates once, as the applier does — and how many edits. */
function editLines(content: string | undefined, edits: TextEditOp[]): { lines: string[]; count: number } {
  const starts = content === undefined ? [] : lineStarts(content);
  const offset = (p: TextEditOp['start']): number => (starts[p.line] ?? content?.length ?? 0) + p.character;
  const seen = new Set<string>();
  const unique = [...edits]
    .sort((a, b) => a.start.line - b.start.line || a.start.character - b.start.character)
    .filter((e) => {
      const key = `${e.start.line}:${e.start.character}:${e.end.line}:${e.end.character}:${e.newText}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const lines = unique.flatMap((e) => {
    if (content === undefined) return [`${span(e.start.line + 1, e.end.line + 1)}: (file unreadable) → ${quote(e.newText)}`];
    const old = content.slice(offset(e.start), offset(e.end));
    if (old.includes('\n') || e.newText.includes('\n')) return changedLines(e.start.line + 1, old, e.newText);
    return [`${e.start.line + 1}: ${quote(old)} → ${quote(e.newText)}`];
  });
  return { lines, count: unique.length };
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
  const editsIn = new Map<string, number>();
  let editCount = 0;
  for (const [file, list] of byFile) {
    const content = await fs.readFile(file).catch(() => undefined);
    const { lines, count } = editLines(content, list);
    editCount += count;
    edits[relativeTo(root, file)] = lines;
    editsIn.set(relativeTo(root, file), count);
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

  // Too long for one answer: left out step by step, each step said, with room kept for
  // the note — the last files' edits become counts, then new files lose their content,
  // then renames past what fits, then the counted files themselves.
  // Sizes are tracked as parts are cut (a part alone is printed less indented than in
  // the view, so what is subtracted is a little less than what goes: the estimate errs
  // high) and measured again between steps.
  const sizeOf = (): number => JSON.stringify(view, null, 2).length;
  const part = (v: unknown): number => JSON.stringify(v, null, 2).length;
  let size = sizeOf();
  if (size <= max) return view;
  const room = max - 600;
  const left: string[] = [];
  const files = Object.keys(edits);
  let counted = 0;
  for (let i = files.length - 1; i >= 0 && size > room; i--) {
    const f = files[i]!;
    size -= part(edits[f]);
    edits[f] = [`${count(editsIn.get(f) ?? 0, 'edit')}, not shown`];
    size += part(edits[f]);
    counted++;
  }
  if (counted) left.push(`the edits of ${count(counted, 'file')} (counted only)`);
  size = sizeOf();
  if (size > room && view.creates) {
    view.creates = Object.fromEntries(Object.entries(view.creates).map(([p, c]) => [p, `(${c.length} chars, not shown)`]));
    left.push("the new files' content");
    size = sizeOf();
  }
  if (size > room && view.renames) {
    const all = view.renames;
    let kept = all.length;
    while (kept > 0 && size > room) size -= part(all[--kept]) + 6;
    view.renames = [...all.slice(0, kept), `… ${all.length - kept} more`];
    left.push(count(all.length - kept, 'rename'));
    size = sizeOf();
  }
  let dropped = 0;
  for (let i = files.length - 1; i >= 0 && size > room; i--) {
    size -= part(files[i]) + part(edits[files[i]!]) + 4;
    delete edits[files[i]!];
    dropped++;
  }
  if (dropped) left.push(`${count(dropped, 'file')} not even named`);
  if (left.length) view.shortened = `Too long for one answer, so left out: ${left.join('; ')}. apply_edits applies the whole plan (git diff shows all of it once applied).`;
  return view;
}
