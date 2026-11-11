import { expect, test } from "bun:test";
import { homedir } from "node:os";
import path from "node:path";
import { positiveEnvInt } from "../src/config.ts";
import { e2eEnv, schedulerOnEnv } from "./e2e-env.ts";

test("a spawned e2e muninn reads no developer triage log: DECISION_TRIAGE_DIR is set, absolute, and not under the home dir", () => {
  const dir = e2eEnv().DECISION_TRIAGE_DIR ?? "";
  // Blank means the default `~/.muninn/decision-triage` (`log.ts`), the developer's real log.
  expect(dir).not.toBe("");
  expect(path.isAbsolute(dir)).toBe(true);
  expect(dir.startsWith(path.join(homedir(), ".muninn"))).toBe(false);
});

test("a spawned e2e muninn appends no palette query to the developer's log: WIKI_FIND_LOG_DIR is set, absolute, and not under the home dir", () => {
  const dir = e2eEnv().WIKI_FIND_LOG_DIR ?? "";
  expect(dir).not.toBe("");
  expect(path.isAbsolute(dir)).toBe(true);
  expect(dir.startsWith(path.join(homedir(), ".muninn"))).toBe(false);
});

test("a scheduler-on spec server sets every configurable retention window of the hourly cleanup past any row of the shared test database", () => {
  const env = schedulerOnEnv();
  expect(env.SCHEDULER_ENABLED).toBe("true");
  // The cleanup runs whenever the scheduler is on (`startRetentionCleanup`), and the seed
  // trace `traces-waterfall` and `inspector` need keeps the date it was first seeded on.
  const names = ["TRACING_RETENTION_DAYS", "PROMPT_SNAPSHOTS_RETENTION_DAYS", "PROMPT_SNAPSHOTS_CAPTURE_RETENTION_DAYS"] as const;
  const saved = names.map((n) => process.env[n]);
  try {
    for (const n of names) {
      if (env[n] === undefined) delete process.env[n];
      else process.env[n] = env[n];
      expect(positiveEnvInt(n, 7), n).toBeGreaterThanOrEqual(36_500);
    }
  } finally {
    names.forEach((n, i) => (saved[i] === undefined ? delete process.env[n] : (process.env[n] = saved[i])));
  }
});
