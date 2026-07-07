import { defineConfig, devices } from "playwright/test";

/**
 * Config for local-only Playwright usage (bootstrap login, manual debugging).
 * The deployed Vercel Cron function does NOT use this file — it launches
 * playwright-core + @sparticuz/chromium directly (see src/browser/launch.ts).
 */
export default defineConfig({
  timeout: 60_000,
  use: {
    headless: false,
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
