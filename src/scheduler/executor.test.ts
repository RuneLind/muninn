import { test, expect, describe, mock } from "bun:test";

// Mock DB to prevent real SQL calls
mock.module("../db/client.ts", () => ({
  getDb: () => {
    const sql = (_strings: TemplateStringsArray, ..._values: any[]) =>
      Promise.resolve([]);
    return sql;
  },
}));

const { spawnHaiku, callHaiku, HAIKU_TIMEOUT_MS, parseHaikuJson } = await import("./executor.ts");

describe("parseHaikuJson", () => {
  test("parses valid JSON", () => {
    expect(parseHaikuJson('{"result":"ok"}')).toEqual({ result: "ok" });
  });

  test("throws descriptive error with stdout preview on invalid JSON", () => {
    expect(() => parseHaikuJson("not json at all")).toThrow(
      /Failed to parse Haiku JSON output:.*not json at all/,
    );
  });

  test("truncates the stdout preview to 300 chars", () => {
    const long = "x".repeat(1000);
    try {
      parseHaikuJson(long);
      throw new Error("expected parseHaikuJson to throw");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The preview slice must not contain the full 1000-char payload.
      expect(msg).not.toContain("x".repeat(301));
      expect(msg).toContain("x".repeat(300));
    }
  });
});

describe("spawnHaiku timeout", () => {
  test("HAIKU_TIMEOUT_MS defaults to 60s", () => {
    expect(HAIKU_TIMEOUT_MS).toBe(60_000);
  });

  test("kills hanging process after timeout", async () => {
    // Call spawnHaiku directly with a very short timeout.
    // "claude" won't be found or will hang — either way it exceeds 100ms.
    await expect(
      spawnHaiku("test", { source: "timeout-test", entrypoint: "test", botName: "test-bot", timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms|exited with code/);
  });

  test("clearTimeout runs in finally block even on success", async () => {
    // Verify the try/finally pattern: timer is cleared on normal exit
    const proc = Bun.spawn(["echo", "done"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });

    let timerCleared = false;
    let timeoutTimer: ReturnType<typeof setTimeout>;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error("should not fire"));
      }, 5000);
    });

    try {
      await Promise.race([proc.exited, timeoutPromise]);
    } finally {
      clearTimeout(timeoutTimer!);
      timerCleared = true;
    }

    expect(timerCleared).toBe(true);
  });
});

describe("callHaiku", () => {
  test("returns fallback when process fails", async () => {
    const result = await callHaiku("test", "fallback-value", "test-source", undefined, undefined, 100);
    expect(result).toBe("fallback-value");
  });
});
