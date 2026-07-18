import ts from 'typescript';

export function scriptKindFor(path: string): ts.ScriptKind {
  if (path.endsWith('.json')) return ts.ScriptKind.JSON;
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Files larger than this are not parsed (treated as empty) — a DoS guard: a huge
 * committed bundle or generated JSON would otherwise allocate a full TS AST (with
 * parent pointers, ~10-20× the source) and OOM the process. Strapi source/schema
 * files are KB; a few MB is a generous ceiling. (Règle d'or #3: no-op > misbehave.)
 */
export const MAX_PARSE_CHARS = 2_000_000;

/**
 * One-entry parse memo, keyed by (path, text *reference*). Within a single pass —
 * a reference walk's 5 collectors, or a provider's 3 analyzers — the SAME `text`
 * string is handed to each, so they share one AST instead of re-parsing it 2-5×.
 * Identity (`===`) comparison: the same string reference means identical source, so
 * reusing the (read-only) AST is correctness-neutral; a different buffer misses and
 * re-parses. Only the last file is retained (bounded, transient).
 */
let memo: { path: string; text: string; sf: ts.SourceFile } | undefined;

/** Parse a single source file with parent pointers set (no type-checking). */
export function parseSource(path: string, text: string): ts.SourceFile {
  if (memo !== undefined && memo.path === path && memo.text === text) return memo.sf;
  const safe = text.length > MAX_PARSE_CHARS ? '' : text;
  const sf = ts.createSourceFile(path, safe, ts.ScriptTarget.Latest, /* setParentNodes */ true, scriptKindFor(path));
  memo = { path, text, sf };
  return sf;
}

/** True if `node` is a call to `<name>(...)` or `<obj>.<name>(...)`. */
export function isCalleeNamed(node: ts.CallExpression, name: string): boolean {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text === name;
  if (ts.isPropertyAccessExpression(e)) return e.name.text === name;
  return false;
}

/** The string value of an expression if it is a plain string literal. */
export function literalText(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}
