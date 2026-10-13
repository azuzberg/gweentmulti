const { defineConfig } = require('@playwright/test');
const fs = require('node:fs');

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (process.platform === 'linux' && fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

module.exports = defineConfig({
  testDir: './test',
  testMatch: '**/*.spec.cjs',
  timeout: 60_000,
  expect: { timeout: 8_000 },
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    headless: true,
    launchOptions: { executablePath },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
