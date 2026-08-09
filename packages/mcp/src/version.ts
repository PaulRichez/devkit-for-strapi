/**
 * The running package version, injected at build time by esbuild from
 * `package.json` (see esbuild.mjs). Kept in its own module so both the MCP
 * handshake (server.ts) and the `server_info` tool (tools.ts) read one value —
 * a second hard-coded copy is exactly how the handshake ended up reporting
 * 0.1.0 while 0.1.3 shipped.
 *
 * Guarded with `typeof` so an unbundled run (vitest, where the define never
 * applies) cannot throw on the undeclared identifier.
 */
declare const __DEVKIT_MCP_VERSION__: string | undefined;

export const VERSION: string =
  typeof __DEVKIT_MCP_VERSION__ === 'string' ? __DEVKIT_MCP_VERSION__ : '0.0.0-dev';
