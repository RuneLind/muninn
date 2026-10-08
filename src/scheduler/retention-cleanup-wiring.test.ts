import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * The retention cleanup's wiring in `src/index.ts` is invisible to every other
 * test: a start moved back under the Telegram scheduler would leave a nais pod
 * keeping every trace and prompt snapshot, silently. Read from the file, as
 * `src/wiki/answer-retention-wiring.test.ts` does.
 */
const INDEX = "src/index.ts";

describe("src/index.ts: retention cleanup wiring", () => {
  test("the cleanup starts at top level, so on every profile and without a Telegram bot", async () => {
    const text = await readFile(INDEX, "utf8");
    // Unindented: a call inside any `if (…)` block or the scheduler's setTimeout would be indented.
    expect(text).toMatch(/^if \(startRetentionCleanup\(config\)\) \{$/m);
    expect(text.indexOf("startRetentionCleanup(config)")).toBeGreaterThan(text.indexOf("await setupLogging("));
  });

  test("shutdown stops the timers first and awaits the stop before closing the pool", async () => {
    const text = await readFile(INDEX, "utf8");
    const shutdown = text.indexOf("async function shutdown()");
    const stop = text.indexOf("const retentionCleanupStopped = stopRetentionCleanup()", shutdown);
    const awaited = text.indexOf("await retentionCleanupStopped;", shutdown);
    const close = text.indexOf("await closeDb()", shutdown);
    expect(shutdown).toBeGreaterThan(-1);
    expect(stop, "shutdown() must call stopRetentionCleanup()").toBeGreaterThan(shutdown);
    expect(awaited, "shutdown() must await the retention cleanup stop").toBeGreaterThan(stop);
    expect(close).toBeGreaterThan(awaited);
  });

  test("the per-bot scheduler tick no longer runs the cleanup, so it runs once per hour process-wide", async () => {
    const text = await readFile("src/scheduler/runner.ts", "utf8");
    for (const fn of [
      "harvestSearchSignals",
      "cleanupOldTraces",
      "cleanupOldSnapshots",
      "cleanupThreadCitations",
      "runRetentionCleanup",
      "retention-cleanup",
    ]) {
      expect(text, `src/scheduler/runner.ts must not call ${fn}`).not.toContain(fn);
    }
  });
});
