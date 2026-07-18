import { defineConfig } from '@vscode/test-cli';

// Runs the compiled integration tests inside a real VS Code Extension Host,
// with the multi-project fixture opened as the workspace.
export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: '../test-fixtures/fixtures/monorepo-two-projects',
  mocha: {
    ui: 'tdd',
    timeout: 30000,
  },
});
