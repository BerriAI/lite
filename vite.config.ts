import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'client', plugins: [react()],
  optimizeDeps: { include: ['@xterm/xterm', '@xterm/addon-fit'] },
  build: { outDir: '../dist/client', emptyOutDir: true },
  server: { fs: { allow: ['..'] } },
});
