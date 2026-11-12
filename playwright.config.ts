import { defineConfig } from '@playwright/test';
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  testDir: './tests/browser', fullyParallel: false, workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', channel: 'msedge', headless: true, trace: 'retain-on-failure' },
  // Isolate tests from the user's live API key and running demo.
  webServer: { command: 'node --import tsx server/dev.ts', url: 'http://127.0.0.1:5174/api/health', reuseExistingServer: false, timeout: 120_000,
    env: { PORT: '5174', LLM_PROVIDER: 'gemini', GEMINI_API_KEY: ' ' } },
});
