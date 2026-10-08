import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

/**
 * `src/index.ts` is the only boot path, and the retention sweep's wiring there
 * is invisible to every other test: a start moved into a profile branch would
 * leave the pod — the one deployment D17 exists for — keeping every answer,
 * silently. Read from the file, as `src/auth/wiring.test.ts` does, since the
 * alternative is booting the real process.
 */
const INDEX = "src/index.ts";

describe("src/index.ts: answer retention wiring", () => {
  test("the sweep starts at top level, so on every profile", async () => {
    const text = await readFile(INDEX, "utf8");
    // Unindented: a call inside any `if (profile …)` block would be indented.
    expect(text).toMatch(/^if \(startAnswerRetentionSweep\(config\.wikiAnswerRetention\)\) \{$/m);
  });

  test("the boot line's warnings are logged after logging is set up", async () => {
    const text = await readFile(INDEX, "utf8");
    const logging = text.indexOf("await setupLogging(");
    const lines = text.indexOf("answerRetentionBootLines(config.wikiAnswerRetention)");
    expect(logging).toBeGreaterThan(-1);
    expect(lines, "src/index.ts must log answerRetentionBootLines(config.wikiAnswerRetention)").toBeGreaterThan(logging);
  });

  test("each refusal warning is logged at warn, and the on line at info inside the start", async () => {
    const text = await readFile(INDEX, "utf8");
    expect(text).toMatch(/^const answerRetentionLines = answerRetentionBootLines\(config\.wikiAnswerRetention\);$/m);
    expect(text, "every refusal warning must reach log.warn").toMatch(
      /^for \(const line of answerRetentionLines\.warnings\) log\.warn\("\{line\}", \{ line \}\);$/m,
    );
    expect(text, "the on line must reach log.info when the sweep starts").toMatch(
      /^if \(startAnswerRetentionSweep\(config\.wikiAnswerRetention\)\) \{\n  log\.info\("\{line\}", \{ line: answerRetentionLines\.info \}\);\n\}$/m,
    );
  });

  test("shutdown stops the timers first and awaits the stop before closing the pool", async () => {
    const text = await readFile(INDEX, "utf8");
    const shutdown = text.indexOf("async function shutdown()");
    // Called early (no tick starts during the other drains), awaited late.
    const stop = text.indexOf("const answerRetentionStopped = stopAnswerRetentionSweep()", shutdown);
    const awaited = text.indexOf("await answerRetentionStopped;", shutdown);
    const close = text.indexOf("await closeDb(", shutdown);
    expect(shutdown).toBeGreaterThan(-1);
    expect(stop, "shutdown() must call stopAnswerRetentionSweep()").toBeGreaterThan(shutdown);
    expect(awaited, "shutdown() must await the retention stop").toBeGreaterThan(stop);
    expect(close).toBeGreaterThan(awaited);
  });
});
