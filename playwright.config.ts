import { defineConfig } from "@playwright/test";
import { blankBotTokens } from "./e2e/blank-bot-tokens.ts";

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
    // This server inherits the developer's `.env`, so without the blank it opens a
    // second Telegram long-poller on the production bot's token and Telegram kills
    // the OTHER one — every e2e run knocked prod jarvis off Telegram (409
    // getUpdates). See `e2e/blank-bot-tokens.ts`. NB: with `reuseExistingServer`,
    // an already-running dev server on 3011 is used as-is and this never applies.
    env: blankBotTokens(),
  },
});
