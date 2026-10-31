import { isPathInside, normalize } from '../fs/paths';

/**
 * Just enough of `.gitignore` to skip the folders git ignores while looking for
 * projects — a release build, a backup copy of the app — which would otherwise show
 * every project twice. Directories only: comments, `!` negation (the last match
 * wins), a leading or middle `/` anchoring the pattern to its file's folder, a
 * trailing `/`, `*`, `?`, `[…]` and `**`.
 */
export interface IgnoreRule {
  /** The folder of the `.gitignore` the rule comes from (normalized). */
  base: string;
  negate: boolean;
  /** Matched against the path from `base`; else against the folder's name alone. */
  anchored: boolean;
  re: RegExp;
}

function toRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) out += '\\[';
      else {
        const body = glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) out += `\\${glob[++i]}`;
    else out += /[.+^${}()|\]\\]/.test(c) ? `\\${c}` : c;
  }
  return out;
}

/** The rules of a `.gitignore` whose folder is `base`. */
export function parseGitignore(text: string, base: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    line = line.replace(/\/+$/, '');
    if (!line) continue;
    const anchored = line.includes('/');
    const body = line.replace(/^\/+/, '');
    rules.push({ base: normalize(base), negate, anchored, re: new RegExp(`^${toRegExp(body)}$`) });
  }
  return rules;
}

/** Whether the folder `dir` is ignored by `rules` (from the outermost `.gitignore` to the innermost). */
export function isIgnoredDir(rules: readonly IgnoreRule[], dir: string): boolean {
  const d = normalize(dir);
  const name = d.slice(d.lastIndexOf('/') + 1);
  let ignored = false;
  for (const r of rules) {
    if (!isPathInside(r.base, d) || d === r.base) continue;
    const rel = d.slice(r.base.length).replace(/^\/+/, '');
    if (r.re.test(r.anchored ? rel : name)) ignored = !r.negate;
  }
  return ignored;
}
