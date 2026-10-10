import { defineConfig } from '@vscode/test-cli';

// Runs the compiled integration tests inside a real VS Code Extension Host:
// the editor features on the multi-project fixture, the DevKit panel on its own.
export default defineConfig([
  {
    label: 'editor',
    files: 'out/test/*.test.js',
    workspaceFolder: '../test-fixtures/fixtures/monorepo-two-projects',
    mocha: { ui: 'tdd', timeout: 30000 },
  },
  {
    label: 'panel',
    files: 'out/test/panel/*.test.js',
    workspaceFolder: '../test-fixtures/fixtures/panel-app',
    mocha: { ui: 'tdd', timeout: 30000 },
  },
]);
