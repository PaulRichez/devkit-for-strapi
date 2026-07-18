import { runServer } from './server';

// Entry point for both the npm bin and the VS Code-bundled server. The shebang
// is added by esbuild at build time (banner), so it isn't in this source. Root
// resolution (argv → MCP client roots → cwd) lives in runServer.
runServer(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`devkit-for-strapi-mcp failed to start: ${String(err)}\n`);
  process.exit(1);
});
