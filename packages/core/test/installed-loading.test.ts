/**
 * Installed plugins load off the critical path: the editor is ready before they
 * land (their refs stay silent meanwhile, never wrongly reported), edits made
 * during the load are replayed, and a plugin whose files didn't change is not
 * re-read (cached per file system).
 */
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { readInstalledPlugins } from '../src/plugins/installed';
import { validateRef } from '../src/query/refQuery';

const ROOT = '/app';
const NM = `${ROOT}/node_modules`;
const C = `({ strapi }) => ({ async a(ctx) {} })`;

/** A file system whose plugin reads (node_modules/my-plugin) wait until `release()`. */
class GatedFs extends MemoryFileSystem {
  private gate: Promise<void> | undefined;
  private open!: () => void;
  hold(): void {
    this.gate = new Promise((res) => (this.open = res));
  }
  release(): void {
    this.open();
    this.gate = undefined;
  }
  override async readFile(path: string): Promise<string> {
    if (this.gate && path.includes('/node_modules/my-plugin/')) await this.gate;
    return super.readFile(path);
  }
}

function files(extra: Record<string, string> = {}): Record<string, string> {
  return {
    [`${ROOT}/package.json`]: JSON.stringify({ name: 'app', dependencies: { '@strapi/strapi': '5.10.0', 'my-plugin': '1.0.0' } }),
    [`${NM}/@strapi/strapi/package.json`]: JSON.stringify({ name: '@strapi/strapi', version: '5.10.0' }),
    [`${NM}/@strapi/core/package.json`]: JSON.stringify({ name: '@strapi/core', version: '5.10.0' }),
    [`${NM}/@strapi/core/dist/loaders/plugins/get-enabled-plugins.js`]: `const INTERNAL_PLUGINS = [];`,
    [`${NM}/my-plugin/package.json`]: JSON.stringify({ name: 'my-plugin', version: '1.0.0', strapi: { name: 'my-plugin', kind: 'plugin' } }),
    [`${NM}/my-plugin/strapi-server.js`]: `module.exports = { controllers: require('./controllers') };`,
    [`${NM}/my-plugin/controllers.js`]: `module.exports = { main: ${C} };`,
    [`${ROOT}/src/index.ts`]: `export default {};`,
    ...extra,
  };
}

describe('installed plugins load in the background', () => {
  it('the engine is ready before they land, and their refs stay silent until then', async () => {
    const fs = new GatedFs(files());
    fs.hold();
    const engine = createEngine(fs);
    await engine.init([ROOT], { waitForInstalled: false });
    const project = engine.allProjects()[0]!;
    expect(validateRef(project, 'plugin::my-plugin.extra').status).not.toBe('unknown');
    fs.release();
    await engine.whenInstalledReady();
    expect(validateRef(project, 'plugin::my-plugin.main').status).toBe('valid');
    expect(validateRef(project, 'plugin::my-plugin.extra').status).toBe('unknown');
  });

  it('init waits for them by default', async () => {
    const engine = createEngine(new MemoryFileSystem(files()));
    await engine.init([ROOT]);
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status).toBe('unknown');
  });

  it('an edit made while they load is replayed once they land', async () => {
    const fs = new GatedFs(files());
    fs.hold();
    const engine = createEngine(fs);
    await engine.init([ROOT], { waitForInstalled: false });
    const index = `${ROOT}/src/index.ts`;
    fs.writeFile(index, `export default { register({ strapi }) { strapi.plugin('my-plugin').controllers.extra = ${C}; } };`);
    await engine.onFilesChanged([index], []);
    fs.release();
    await engine.whenInstalledReady();
    // rewritten at boot by the project: not verifiable, so not reported
    expect(validateRef(engine.allProjects()[0]!, 'plugin::my-plugin.extra').status).not.toBe('unknown');
  });
});

describe('a plugin read is reused while its files are unchanged', () => {
  it('a changed plugin file is picked up; an unchanged one gives the same result', async () => {
    const fs = new MemoryFileSystem(files());
    const refs = async (): Promise<string[]> =>
      (await readInstalledPlugins(fs, ROOT))!.plugins.find((p) => p.name === 'my-plugin')!.artifacts.map((a) => a.ref).sort();
    expect(await refs()).toEqual(['plugin::my-plugin.main']);
    expect(await refs()).toEqual(['plugin::my-plugin.main']);
    fs.writeFile(`${NM}/my-plugin/controllers.js`, `module.exports = { main: ${C}, other: ${C} };`);
    expect(await refs()).toEqual(['plugin::my-plugin.main', 'plugin::my-plugin.other']);
  });

  it('project rewrites still apply to a reused read', async () => {
    const fs = new MemoryFileSystem(files());
    const complete = async (): Promise<boolean> => (await readInstalledPlugins(fs, ROOT))!.plugins.find((p) => p.name === 'my-plugin')!.complete;
    expect(await complete()).toBe(true);
    fs.writeFile(`${ROOT}/src/index.ts`, `export default { register({ strapi }) { strapi.plugin('my-plugin').controllers.extra = ${C}; } };`);
    expect(await complete()).toBe(false);
    fs.writeFile(`${ROOT}/src/index.ts`, `export default {};`);
    expect(await complete()).toBe(true);
  });
});
