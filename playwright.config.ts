import { defineConfig } from "@playwright/test";
import { e2eEnv } from "./e2e/e2e-env.ts";

export default defineConfig({
  testDir: "./e2e",
  // `.spec.ts` is Playwright's, `.test.ts` is `bun test`'s. Playwright's DEFAULT
  // testMatch claims both, so `e2e/ports.test.ts` — a bun test that guards this
  // directory's port registry — was loaded by the Playwright runner under node
  // and killed the whole run on `import "bun:test"` before a single spec ran.
  testMatch: "**/*.spec.ts",
  timeout: 30_000,
  retries: 0,
  // Spec FILES run in parallel, and ten of them boot a muninn of their own — 13
  // processes, since `plans-write` boots 3 and `summaries-share` 2. Each is a Bun
  // process that bundles the client with `Bun.build` and tries to start its MCP
  // adapters. On a developer's machine that fits; on a 2-core runner it
  // does not, and the way it fails is not a bind error but a CLICK LANDING BEFORE
  // THE PAGE'S INLINE SCRIPT ATTACHED ITS LISTENER — a different spec each run.
  // Measured on a deliberately loaded host: 1–2 such failures per full parallel
  // run, none of which reproduce when the spec runs alone, and none at all
  // serially. So CI trades ~1 minute of wall clock for a signal that means
  // something. `retries` stays 0 everywhere: a retry would convert exactly this
  // class into a silent pass.
  workers: process.env.CI ? 1 : undefined,
  // A `test.only` left in a spec passes locally and would silently green-light CI
  // on a fraction of the suite.
  forbidOnly: !!process.env.CI,
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
    // This server inherits the developer's `.env`, and TWO classes of value in it
    // have to be blanked — see `e2e/e2e-env.ts`. Without the token blank it opens
    // a second Telegram long-poller on the production bot's token and Telegram
    // kills the OTHER one (every e2e run knocked prod jarvis off Telegram, 409
    // getUpdates). Without the instance-profile blank it comes up in whatever
    // write/auth mode THIS host runs in, which is why the suite was green on the
    // laptop and red on the Mac mini. NB: with `reuseExistingServer`, an
    // already-running dev server on 3011 is used as-is and neither applies — that
    // server is the developer's, in the developer's mode.
    env: e2eEnv(),
  },
});
