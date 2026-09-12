import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['server/index.ts', 'server/mcp-code-worker.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist/server',
  external: ['vite'],
  clean: true,
  // Newer builtins such as node:sqlite require their explicit node: protocol.
  removeNodeProtocol: false,
});
