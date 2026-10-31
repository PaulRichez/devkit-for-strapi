import { normalize } from '../fs/paths';

/**
 * Just enough of `.gitignore` to skip the folders git ignores while looking for
 * projects — a release build, a backup copy of the app — which would otherwise show
 * every project twice. Directories only: comments, `!` negation (the last match
 * wins), a leading or middle `/` anchoring the pattern to its file's folder, a
 * trailing `/`, `*`, `?`, `[…]` and `**`. Case-insensitive, as git is by default on
 * Windows and macOS (over-matching a case-only twin elsewhere is harmless here).
 */
export interface IgnoreRule {
  /** The folder of the `.gitignore` the rule comes from, normalized, lower-cased, with a trailing `/`. */
  base: string;
  negate: boolean;
  /** Matched against the path from `base`; else against the folder's name alone. */
  anchored: boolean;
  re: RegExp;
}

const escapeRe = (c: string): string => (/[.*+?^${}()|[\]\\/-]/.test(c) ? `\\${c}` : c);

const POSIX_CLASS: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  xdigit: '0-9a-fA-F',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
};

/** `[…]` at `start`: its regex and the index of its closing `]`, or undefined when unclosed. */
function bracket(glob: string, start: number): { re: string; end: number } | undefined {
  let i = start + 1;
  let out = '';
  if (glob[i] === '!' || glob[i] === '^') {
    out += '^';
    i++;
  }
  // A `]` right after the opening (or its `!`) is a literal.
  if (glob[i] === ']') {
    out += '\\]';
    i++;
  }
  for (; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === ']') return { re: `[${out}]`, end: i };
    if (c === '[' && glob[i + 1] === ':') {
      const close = glob.indexOf(':]', i + 2);
      const cls = close === -1 ? undefined : POSIX_CLASS[glob.slice(i + 2, close)];
      if (cls !== undefined) {
        out += cls;
        i = close + 1;
        continue;
      }
    }
    if (c === '\\' && i + 1 < glob.length) out += escapeRe(glob[++i]!);
    else out += c === '-' ? '-' : escapeRe(c);
  }
  return undefined;
}

function toRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      let j = i;
      while (glob[j + 1] === '*') j++;
      // `**` is special between slashes (or at an end) only; elsewhere it is a `*`.
      const atStart = i === 0 || glob[i - 1] === '/';
      if (j > i && atStart && glob[j + 1] === '/') {
        out += '(?:.*/)?';
        j++;
      } else if (j > i && atStart && j + 1 === glob.length) out += '.*';
      else out += '[^/]*';
      i = j;
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const b = bracket(glob, i);
      if (b) {
        out += b.re;
        i = b.end;
      } else out += '\\[';
    } else if (c === '\\' && i + 1 < glob.length) out += escapeRe(glob[++i]!);
    else out += escapeRe(c);
  }
  return out;
}

/** The rules of a `.gitignore` whose folder is `base`. A rule git would reject is skipped, not the file. */
export function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  const b = `${normalize(base).toLowerCase().replace(/\/+$/, '')}/`;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    // Trailing spaces go unless escaped; other whitespace stays (git trims spaces only).
    let line = raw.replace(/(?<!\\) +$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    line = line.replace(/\/+$/, '');
    if (!line) continue;
    const anchored = line.includes('/');
    const body = line.replace(/^\/+/, '');
    try {
      rules.push({ base: b, negate, anchored, re: new RegExp(`^${toRegExp(body)}$`, 'i') });
    } catch {
      // a class like `[z-a]`: git drops that pattern, the others stand
    }
  }
  return rules;
}

/** Whether the folder `dir` is ignored by `rules` (from the outermost `.gitignore` to the innermost). */
export function isIgnoredDir(rules: readonly IgnoreRule[], dir: string): boolean {
  const d = normalize(dir);
  const lower = d.toLowerCase();
  const name = d.slice(d.lastIndexOf('/') + 1);
  let ignored = false;
  for (const r of rules) {
    if (!lower.startsWith(r.base)) continue;
    if (r.re.test(r.anchored ? d.slice(r.base.length) : name)) ignored = !r.negate;
  }
  return ignored;
}
