import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { paths } from 'devkit-for-strapi-core';

/** `p` relative to `root` (forward slashes), or as is when outside it. */
export function relativeTo(root: string, p: string): string {
  const r = paths.normalize(root);
  const f = paths.normalize(p);
  return f.length > r.length && paths.isPathInside(r, f) ? f.slice(r.length).replace(/^\/+/, '') : f;
}

/** `s` as it appears inside a JSON string. */
const inJson = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * Answers name files relative to their project: when the absolute paths in an answer
 * all lie in one project, its root prefix is dropped — in values, keys and messages
 * alike, in every block of the answer — and its first block says `root` once. An
 * answer naming files of several projects, or none, or not opening on an object (or
 * using `root` for something else), is left as it is.
 */
export function withRelativePaths(result: CallToolResult, roots: readonly string[]): CallToolResult {
  const first = result.content[0];
  if (first?.type !== 'text' || !first.text.startsWith('{')) return result;
  const all = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  const found = roots.map((r) => paths.normalize(r)).filter((r) => all.includes(inJson(`${r}/`)));
  if (found.length !== 1) return result;
  const root = found[0]!;
  const strip = (text: string): string => text.split(inJson(`${root}/`)).join('');
  let data: unknown;
  try {
    data = JSON.parse(strip(first.text));
  } catch {
    return result;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return result;
  const own = (data as { root?: unknown }).root;
  if (own !== undefined && own !== root) return result;
  return {
    ...result,
    content: result.content.map((c, i) =>
      i === 0 ? { type: 'text' as const, text: JSON.stringify({ root, ...data }, null, 2) } : c.type === 'text' ? { ...c, text: strip(c.text) } : c,
    ),
  };
}
