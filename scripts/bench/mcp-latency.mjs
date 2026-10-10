#!/usr/bin/env node
/**
 * MCP latency bench (opt-in, like the oracle): spawn the bundled MCP server on
 * real Strapi projects over stdio — exactly as a client does — and time every
 * read-only tool. Nothing is written: no apply/rename/create tool is called and
 * the roots cache is redirected to a temp file.
 *
 *   node packages/mcp/esbuild.mjs   # builds packages/mcp/dist/cli.cjs
 *   node scripts/bench/mcp-latency.mjs [--runs 7] [--repeat 3] <strapi-app> [<strapi-app>…]
 *
 * Per project, `--repeat` fresh servers: the time to the first useful answer
 * (index + installed plugins), then per tool its first call and the median / max
 * of the following `--runs` calls. Reported: medians across the repeats (max: the
 * overall max).
 */
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mcpRequire = createRequire(join(repo, 'packages', 'mcp', 'package.json'));
const { Client } = await import(pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
const { StdioClientTransport } = await import(pathToFileURL(mcpRequire.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);

const argv = process.argv.slice(2);
let runs = 7;
let repeat = 3;
const apps = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--runs') runs = Number(argv[++i]);
  else if (argv[i] === '--repeat') repeat = Number(argv[++i]);
  else apps.push(argv[i].replace(/\\/g, '/'));
}
if (!apps.length) {
  console.error('usage: node scripts/bench/mcp-latency.mjs [--runs N] [--repeat N] <strapi-app>…');
  process.exit(2);
}
const cli = join(repo, 'packages', 'mcp', 'dist', 'cli.cjs');

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN;
};
const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)}` : '–');

async function bench(app) {
  const t0 = performance.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, app],
    env: { ...process.env, DEVKIT_ROOTS_CACHE: join(tmpdir(), `devkit-bench-roots-${process.pid}.json`) },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'devkit-bench', version: '0' });
  await client.connect(transport);
  const tConnected = performance.now() - t0;

  const call = async (name, args = {}) => {
    const t = performance.now();
    const res = await client.callTool({ name, arguments: { from: app, ...args } });
    const dt = performance.now() - t;
    const text = res.content?.[0]?.text ?? '';
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { dt, json, error: res.isError ? text.slice(0, 120) : undefined };
  };

  // The first useful answer: waits for the index and the installed plugins.
  const first = await call('validate_reference', { ref: 'plugin::users-permissions.user' });
  const tFirstAnswer = performance.now() - t0;

  // Real names from the project, to call the tools meaningfully.
  const cts = (await call('list_content_types')).json;
  const ctList = Array.isArray(cts) ? cts : (cts?.contentTypes ?? cts?.items ?? []);
  const uidOf = (x) => (typeof x === 'string' ? x : x?.uid);
  const apiCt = ctList.map(uidOf).find((u) => u?.startsWith('api::')) ?? ctList.map(uidOf)[0] ?? 'api::article.article';
  const arts = (await call('list_artifacts', { kind: 'service' })).json;
  const artList = Array.isArray(arts) ? arts : (arts?.artifacts ?? arts?.items ?? []);
  const service = artList.map((x) => (typeof x === 'string' ? x : x?.ref)).find((r) => r?.startsWith('api::')) ?? `${apiCt}`;

  const tools = [
    ['server_info', {}],
    ['list_projects', {}],
    ['project_info', {}],
    ['list_content_types', {}],
    ['list_components', {}],
    ['list_artifacts', {}],
    ['get_schema', { uid: apiCt }],
    ['resolve', { ref: apiCt }],
    ['validate_reference (valid)', { ref: apiCt }, 'validate_reference'],
    ['validate_reference (typo)', { ref: `${apiCt}x` }, 'validate_reference'],
    ['validate_reference (plugin)', { ref: 'plugin::users-permissions.role' }, 'validate_reference'],
    ['find_references', { ref: apiCt }],
    ['list_refs', { pattern: 'api::*' }],
    ['dependencies', { ref: apiCt }],
    ['dependents', { ref: apiCt }],
    ['find_relation_usages', { uid: apiCt }],
    ['list_routes', {}],
    ['list_routes (+plugins)', { plugins: true }, 'list_routes'],
    ['list_broken_refs', {}],
    ['list_unused', {}],
    ['coverage', {}],
    ['resolve (service)', { ref: service }, 'resolve'],
    ['refresh (rescan)', {}, 'refresh'],
  ];
  const rows = [];
  for (const [label, args, name] of tools) {
    const firstCall = await call(name ?? label, args);
    const times = [];
    for (let i = 0; i < runs; i++) times.push((await call(name ?? label, args)).dt);
    rows.push({ label, first: firstCall.dt, median: median(times), max: Math.max(...times), error: firstCall.error });
  }
  await client.close();
  return { app, tConnected, tFirstAnswer, firstValid: first.json, rows };
}

for (const app of apps) {
  const all = [];
  for (let i = 0; i < repeat; i++) all.push(await bench(app));
  console.log(`\n### ${app.split('/').slice(-2).join('/')}`);
  console.log(
    `- fresh server, median of ${repeat}: tools listed after ${ms(median(all.map((x) => x.tConnected)))} ms; first answer (index + installed plugins) after ${ms(median(all.map((x) => x.tFirstAnswer)))} ms`,
  );
  console.log(`\n| tool | 1st call (ms) | median (ms) | max (ms) |\n|---|---:|---:|---:|`);
  all[0].rows.forEach((row, i) => {
    const first = median(all.map((x) => x.rows[i].first));
    const med = median(all.map((x) => x.rows[i].median));
    const max = Math.max(...all.map((x) => x.rows[i].max));
    console.log(`| ${row.label}${row.error ? ' ⚠' : ''} | ${ms(first)} | ${ms(med)} | ${ms(max)} |`);
  });
  for (const row of all[0].rows) if (row.error) console.log(`  ⚠ ${row.label}: ${row.error}`);
}
