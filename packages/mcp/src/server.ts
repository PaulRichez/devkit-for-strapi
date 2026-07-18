import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, paths } from 'devkit-for-strapi-core';
import { fileURLToPath } from 'node:url';
import { createLicenseCheck } from './license';
import { NodeFileSystem } from './nodeFileSystem';
import { explicitRoots } from './roots';
import { loadRootsCache } from './rootsCache';
import { registerTools } from './tools';

/**
 * Start the Strapi DevKit MCP server over stdio: discover & index the workspace,
 * expose the F1→F4 read tools. Roots are resolved *agnostically*, by precedence:
 *   1. explicit path args on argv (the VS Code extension passes workspaceFolders),
 *   2. the MCP client's `roots` capability (Claude Code / Cursor advertise the
 *      folder you opened — so it just works wherever you are, no config),
 *   3. the cwd (last resort).
 * Plus any roots previously registered via `add_project` (persisted), so a manual
 * add survives respawns instead of being lost on every rebuild.
 * Indexing runs off the critical path — tool handlers `await ready` so the first
 * calls block until the index is built rather than answering empty.
 */
export async function runServer(argv: string[]): Promise<void> {
  const fs = new NodeFileSystem();
  const engine = createEngine(fs);
  const server = new McpServer({ name: 'devkit-for-strapi', version: '0.1.0' });

  const cliRoots = explicitRoots(argv);
  // The roots actually indexed — surfaced to the tools so a "no project found"
  // result can name where we looked (auto-diagnostic), and kept in sync on rescan.
  let currentRoots: string[] = cliRoots;

  /** The MCP client's workspace folders (file:// URIs → POSIX paths), if any. */
  const clientRoots = async (): Promise<string[]> => {
    if (!server.server.getClientCapabilities()?.roots) return [];
    try {
      const { roots } = await server.server.listRoots();
      return roots
        .map((r) => r.uri)
        .filter((u) => u.startsWith('file:'))
        .map((u) => paths.normalize(fileURLToPath(u)));
    } catch {
      return [];
    }
  };

  /** (argv path args → MCP client roots → cwd) ∪ persisted `add_project` roots. */
  const resolveRoots = async (): Promise<string[]> => {
    const cached = loadRootsCache().map((r) => paths.normalize(r));
    let base = cliRoots;
    if (!base.length) {
      const fromClient = await clientRoots();
      base = fromClient.length ? fromClient : [paths.normalize(process.cwd())];
    }
    return [...new Set([...base, ...cached])];
  };

  const reindex = async (): Promise<void> => {
    currentRoots = await resolveRoots();
    await engine.init(currentRoots);
  };

  // Tool handlers block on the first index; resolve it once the roots are known.
  let markReady!: () => void;
  let failReady!: (reason: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    markReady = res;
    failReady = rej;
  });

  // Pro gate: read DEVKIT_LICENSE_KEY (env), validate against Polar (cached
  // offline). Locked by default until a valid key is present (+ the org id wired).
  const isLicensed = createLicenseCheck();
  registerTools(server, engine, fs, ready, () => currentRoots, isLicensed);

  // `roots/list` can only be queried after the client has initialized. Resolve
  // and index then, and re-index when the client's workspace folders change.
  server.server.oninitialized = () => {
    if (server.server.getClientCapabilities()?.roots?.listChanged) {
      server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
        void reindex();
      });
    }
    reindex().then(markReady, failReady);
  };

  await server.connect(new StdioServerTransport());
}
