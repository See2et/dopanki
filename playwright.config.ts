import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  use: { baseURL: process.env.DOPANKI_URL || 'http://127.0.0.1:8787', trace: 'retain-on-failure' },
  reporter: 'list',
});
