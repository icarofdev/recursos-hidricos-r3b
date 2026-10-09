import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';

process.env.HIDRA_E2E_NO_DEV_VARS = '1';
process.env.HIDRA_E2E_RUN_ID ||= randomBytes(12).toString('hex');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18888',
    // Traces may capture setup secrets, recovery codes and session cookies.
    trace: 'off',
    channel: process.env.CI ? undefined : 'chrome',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node scripts/cloudflare/dev.mjs',
    env: {
      HIDRA_E2E_NO_DEV_VARS: '1',
      HIDRA_E2E_RUN_ID: process.env.HIDRA_E2E_RUN_ID,
      TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
      PUBLIC_API_URL: 'http://127.0.0.1:18887',
      PUBLIC_APP_URL: 'http://127.0.0.1:18888',
    },
    url: 'http://127.0.0.1:18888',
    reuseExistingServer: false,
    timeout: 90000,
  },
});
