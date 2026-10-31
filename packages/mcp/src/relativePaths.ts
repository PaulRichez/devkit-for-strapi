import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { paths } from 'devkit-for-strapi-core';

/** `p` relative to `root` (forward slashes), or as is when outside it. */
export function relativeTo(root: string, p: string): string {
  const r = paths.normalize(root);
  const f = paths.normalize(p);
  return f.length > r.length && paths.isPathInside(r, f) ? f.slice(r.length).replace(/^\/+/, '') : f;
}

/** `p` as given when absolute, else under `root` — for a path an agent copied from an answer. */
export function underRoot(root: string, p: string): string {
  return paths.isAbsolute(p) ? p : paths.join(root, p);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `root/` where a path starts: a string's start, or after a space, a quote, `(`, `=`. */
const rootAt = (root: string): RegExp => new RegExp(`(^|[\\s"'\`(=])${escapeRe(`${root}/`)}`, 'g');

/** A route's own URL (`path`, `fullPath` of an object with a `method`), or a `METHOD /url` line: never a file. */
const isUrl = (key: string | undefined, parent: unknown, value: string): boolean =>
  ((key === 'path' || key === 'fullPath') && typeof parent === 'object' && parent !== null && 'method' in parent) ||
  /^[A-Z]+(?:[|,][A-Z]+)* \//.test(value);

/** Every string of `value` (keys included) through `f`, URLs left alone. */
function mapStrings(value: unknown, f: (s: string) => string, key?: string, parent?: unknown): unknown {
  if (typeof value === 'string') return isUrl(key, parent, value) ? value : f(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f, undefined, value));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [isUrl(undefined, undefined, k) ? k : f(k), mapStrings(v, f, k, value)]));
  }
  return value;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Answers name files relative to their project: when the absolute paths in an answer
 * all lie in one project, its root is dropped where a path starts — in values, keys
 * and messages alike, in every JSON block of the answer — and the first block says
 * `root` once. A route's URL is never touched. An answer naming files of several
 * projects, or none, or not opening on a JSON object (or using `root` for something
 * else), is left as it is.
 */
export function withRelativePaths(result: CallToolResult, roots: readonly string[]): CallToolResult {
  const blocks = result.content.map((c) => (c.type === 'text' ? parse(c.text) : undefined));
  const first = blocks[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return result;
  const named = (root: string): boolean => {
    const re = rootAt(root);
    let hit = false;
    const probe = (s: string): string => {
      re.lastIndex = 0;
      if (re.test(s)) hit = true;
      return s;
    };
    for (const b of blocks) mapStrings(b, probe);
    return hit;
  };
  const found = roots.map((r) => paths.normalize(r)).filter(named);
  if (found.length !== 1) return result;
  const root = found[0]!;
  const own = (first as { root?: unknown }).root;
  if (own !== undefined && own !== root) return result;
  const re = rootAt(root);
  const strip = (s: string): string => s.replace(re, '$1');
  return {
    ...result,
    content: result.content.map((c, i) => {
      const b = blocks[i];
      if (c.type !== 'text' || b === undefined) return c;
      const data = mapStrings(b, strip);
      return { type: 'text' as const, text: JSON.stringify(i === 0 ? { root, ...(data as object) } : data, null, 2) };
    }),
  };
}
