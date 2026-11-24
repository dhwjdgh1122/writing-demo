import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  envDir: fileURLToPath(new URL('.', import.meta.url)),
  // Browser regression servers exercise both feature settings independently.
  cacheDir: process.env.PLAYWRIGHT_TEST_SERVER === 'true' ? `node_modules/.vite-playwright-${process.env.PORT}` : undefined,
  server: process.env.PLAYWRIGHT_TEST_SERVER === 'true' ? { hmr: false, ws: false } : undefined,
  plugins: [react()],
  build: { outDir: '../dist/client', emptyOutDir: true },
});
