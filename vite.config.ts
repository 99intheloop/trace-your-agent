import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * UI build config. The Vite root is src/ui; the build output goes to
 * dist/ui (outside the root, so emptyOutDir must be enabled), where the
 * hono server serves it as the SPA (see docs/api.md "静态托管").
 */
export default defineConfig({
  root: fileURLToPath(new URL('./src/ui', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4777',
    },
  },
});
