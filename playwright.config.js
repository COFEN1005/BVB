import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser', timeout: 20000, workers: 2,
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 390, height: 844 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ['--no-sandbox'] } : {} },
  webServer: { command: 'python3 -m http.server 4173 --bind 127.0.0.1 --directory dist', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
