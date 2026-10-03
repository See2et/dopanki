import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://localhost:8787', '/media': 'http://localhost:8787' } },
});
