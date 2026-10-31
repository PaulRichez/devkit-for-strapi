/**
 * What to do about each runtime failure, in one sentence — shared, byte for byte, with
 * the public stub: the MCP server and the extension show the same thing.
 */

import type { RuntimeErrorKind } from './types';

const HINTS: Record<RuntimeErrorKind, string> = {
  'no-strapi': 'Install the project\'s dependencies (npm install, yarn or pnpm install), then retry.',
  'unsupported-strapi': "DevKit runs config-sync through Strapi 4 and 5 only: this version isn't supported yet. Use config-sync's own CLI or admin page meanwhile.",
  'plugin-missing': 'Install strapi-plugin-config-sync and enable it in config/plugins, then retry.',
  'node-missing': 'Install Node, or set "strapiDevkit.runtime.nodePath" (DEVKIT_NODE for the MCP server) to the Node the project uses.',
  'native-module': 'Run with the Node the project was installed with ("strapiDevkit.runtime.nodePath" / DEVKIT_NODE), or reinstall the dependencies with this one.',
  'compile-failed': 'Fix the TypeScript errors (in the output), then retry.',
  'bootstrap-error': "The project's code threw while Strapi loaded: fix it (see where), then retry — `strapi develop` would fail the same way.",
  'db-unreachable': 'Start the database, and check its host and port (the DATABASE_* variables of .env).',
  'db-auth': 'Check the database user and password (DATABASE_USERNAME / DATABASE_PASSWORD in .env).',
  'db-missing': 'Create the database, or start Strapi once to create it, and check its name or file (DATABASE_NAME / DATABASE_FILENAME).',
  'db-fresh': 'Import into this database, or start Strapi on it once, before exporting from it.',
  'sqlite-cantopen': 'Check that the SQLite file and its folder exist and can be written.',
  'sqlite-busy': 'Another process holds the SQLite database (a running `strapi develop`?): retry in a moment, or stop it.',
  'migration-required': 'Run the Strapi 4 → 5 migration yourself (back the database up first): DevKit never runs it.',
  'remote-database': 'Point the project at a local development database (or allow remote databases explicitly, if you are sure).',
  production: 'Import into a development database: set the environment to development.',
  'command-failed': 'The plugin refused the operation: see the message, fix the file, and retry.',
  timeout: 'Retry (a first TypeScript compilation can be long), or raise "strapiDevkit.runtime.timeoutSeconds".',
  cancelled: 'Run it again when ready.',
  crashed: 'See the output: Strapi stopped without a result. `strapi develop` would show the same error.',
};

export function runtimeHint(kind: RuntimeErrorKind): string {
  return HINTS[kind];
}
