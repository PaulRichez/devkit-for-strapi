/**
 * Pure POSIX path utilities. The core works exclusively with forward-slash
 * paths (including a `c:/...` drive prefix on Windows); the VS Code client
 * converts to/from `Uri` at the boundary.
 */

export function normalize(p: string): string {
  let s = p.replace(/\\/g, '/');
  // collapse repeated slashes (but keep a leading `//` only as single)
  s = s.replace(/\/{2,}/g, '/');
  // drop trailing slash except for root
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  // Windows drive letters are case-insensitive: canonicalize to lowercase so the
  // same project reached via `C:/…` (rootsCache, CLI args) and `c:/…` (client
  // roots) maps to ONE key everywhere — otherwise it's discovered/indexed twice.
  if (/^[A-Z]:(\/|$)/.test(s)) s = s[0]!.toLowerCase() + s.slice(1);
  return s;
}

export function join(...segments: string[]): string {
  const parts = segments.filter((s) => s.length > 0);
  return normalize(parts.join('/'));
}

export function dirname(p: string): string {
  const s = normalize(p);
  const idx = s.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return s.slice(0, idx);
}

export function basename(p: string, ext?: string): string {
  const s = normalize(p);
  const idx = s.lastIndexOf('/');
  let base = idx < 0 ? s : s.slice(idx + 1);
  if (ext && base.length > ext.length && base.endsWith(ext)) {
    base = base.slice(0, base.length - ext.length);
  }
  return base;
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}

/** Strip the file extension from a base name. */
export function stripExt(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx <= 0 ? name : name.slice(0, idx);
}

export function isAbsolute(p: string): boolean {
  const s = normalize(p);
  return s.startsWith('/') || /^[a-zA-Z]:\//.test(s);
}

/**
 * True if `child` is `parent` itself or nested under it. Case-insensitive to be
 * safe on Windows/macOS (over-matching across two case-only-different roots is
 * not a real-world concern for project ownership).
 */
export function isPathInside(parent: string, child: string): boolean {
  const p = normalize(parent).toLowerCase();
  const c = normalize(child).toLowerCase();
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}
