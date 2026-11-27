import { defineConfig } from '@playwright/test'

const baseURL = 'http://127.0.0.1:1421'

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.pw.ts',
  workers: 1,
  timeout: 45_000,
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'studio-browser', use: { viewport: { width: 740, height: 650 } } },
    { name: 'studio-minimum', use: { viewport: { width: 900, height: 650 } } },
    { name: 'studio-default', use: { viewport: { width: 1200, height: 690 } } },
  ],
  webServer: {
    command: 'npm run dev:web -- --host 127.0.0.1 --port 1421',
    url: baseURL + '/sub.html',
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
})
