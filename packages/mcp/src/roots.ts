import { paths } from 'devkit-for-strapi-core';

/**
 * The explicit path arguments passed on argv (flags dropped), normalized to
 * POSIX. Empty when none were given — the VS Code extension passes its
 * `workspaceFolders` here, so these win over everything else. When empty, the
 * server falls back to the MCP client's `roots` capability, then the cwd (see
 * `runServer`). *Agnostic by design*: nothing project-specific is hardcoded.
 */
export function explicitRoots(argv: string[]): string[] {
  return argv.filter((a) => !a.startsWith('-')).map((r) => paths.normalize(r));
}
