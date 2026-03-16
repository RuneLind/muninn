import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:3011",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  webServer: {
    command: "SCHEDULER_ENABLED=false DASHBOARD_PORT=3011 bun run src/index.ts",
    port: 3011,
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
