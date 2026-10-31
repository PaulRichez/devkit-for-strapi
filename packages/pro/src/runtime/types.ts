/**
 * What the config-sync runtime returns — shared, byte for byte, with the public stub
 * (packages/pro/src/runtime/types.ts): the extension and the MCP server compile against it.
 */

/** Where the runner is: compiling, reading the config, registering, checking the database, bootstrapping, running the command. */
export type RuntimeStep = 'start' | 'compile' | 'config' | 'register' | 'check' | 'bootstrap' | 'command';

export type RuntimeErrorKind =
  /** @strapi/strapi is not installed (no node_modules). */
  | 'no-strapi'
  /** An installed Strapi other than 4 or 5 (Strapi 6…): not loaded. */
  | 'unsupported-strapi'
  /** strapi-plugin-config-sync is not installed, or not enabled. */
  | 'plugin-missing'
  /** No Node to run the project with (the `nodePath` setting, or `node` on the PATH). */
  | 'node-missing'
  /** A native module (better-sqlite3…) built for another Node: run with the project's Node. */
  | 'native-module'
  /** The TypeScript compilation failed (the errors are in `output`). */
  | 'compile-failed'
  /** The project's code threw while Strapi loaded (`detail.frame`: where, when in the project). */
  | 'bootstrap-error'
  | 'db-unreachable'
  | 'db-auth'
  /** The database does not exist (a SQLite file is never created by DevKit). */
  | 'db-missing'
  /** No Strapi table yet: an export would replace config/sync with a fresh install's defaults. */
  | 'db-fresh'
  | 'sqlite-cantopen'
  /** Still locked after retries (another process writes to it). */
  | 'sqlite-busy'
  /** A Strapi 4 database under Strapi 5 code: DevKit never runs the 4 → 5 migration. */
  | 'migration-required'
  /** The database is not local: refused unless remote databases are allowed. */
  | 'remote-database'
  /** An import with NODE_ENV=production. */
  | 'production'
  /** The plugin's export or import threw (`detail.done`: what was done before). */
  | 'command-failed'
  | 'timeout'
  | 'cancelled'
  /** The runner stopped without a result (`output` holds its last lines). */
  | 'crashed';

/** The database a run used, without its password. */
export interface DatabaseTarget {
  /** NODE_ENV of the run. */
  env: string;
  client: string;
  filename?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  socket?: string;
  /** On this machine (localhost, a socket, a SQLite file in the project). */
  local: boolean;
}

export interface RuntimeOptions {
  /** The Node to run the project with (default: this process's when it isn't Electron, else `node` on the PATH). */
  nodePath?: string;
  /** NODE_ENV for the run (default `development`). */
  env?: string;
  /** ENV_PATH: the .env file Strapi loads (default: the project's .env). */
  envPath?: string;
  /** Default 180 s: a first TypeScript compilation can take over a minute. */
  timeoutMs?: number;
  /** Load Strapi even on a database that is not local. */
  allowRemoteDatabase?: boolean;
  onProgress?: (step: RuntimeStep) => void;
  signal?: AbortSignal;
}

export interface RuntimeTimings {
  [step: string]: number;
}

export interface RuntimeSuccess<T> {
  ok: true;
  data: T;
  target: DatabaseTarget;
  versions: { strapi: string; configSync: string; node: string };
  timings: RuntimeTimings;
  warnings: string[];
}

export interface RuntimeFailure {
  ok: false;
  kind: RuntimeErrorKind;
  message: string;
  /** The step it stopped at. */
  step: RuntimeStep;
  target?: DatabaseTarget;
  detail?: { stack?: string; frame?: { file: string; line: number; column: number }; done?: string[] };
  /** The runner's last output lines (Strapi's logs, compiler errors). */
  output?: string;
  timings?: RuntimeTimings;
  warnings: string[];
}

export type RuntimeResult<T> = RuntimeSuccess<T> | RuntimeFailure;
