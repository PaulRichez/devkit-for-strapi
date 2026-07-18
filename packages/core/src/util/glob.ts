/**
 * Minimal POSIX glob matching for project-discovery excludes. Supports `*`
 * (within a path segment), `**` (across segments) and `?` (one non-slash char).
 * Matching is case-insensitive (Windows-safe) and unanchored, so a pattern can
 * match anywhere in the path. A bare token (no slash or wildcard) matches any
 * single path segment — e.g. `examples` excludes a project under any `examples/`.
 */
const DOUBLE_STAR = '\x00'; // placeholder while expanding `**` → `.*`

function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials (leaves * ? alone)
    .replace(/\*\*/g, DOUBLE_STAR)
    .replace(/\*/g, '[^/]*') // * → within a segment
    .split(DOUBLE_STAR)
    .join('.*') // ** → across segments
    .replace(/\?/g, '[^/]');
  return new RegExp(body, 'i');
}

/** True if the POSIX `path` matches a single glob `pattern`. */
export function matchesGlob(path: string, pattern: string): boolean {
  if (!pattern) return false;
  const p = path.toLowerCase();
  const g = pattern.toLowerCase();
  if (!/[*?/]/.test(g)) return p.split('/').includes(g);
  return globToRegExp(g).test(p);
}

/** True if `path` matches any of the `patterns`. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((g) => matchesGlob(path, g));
}
