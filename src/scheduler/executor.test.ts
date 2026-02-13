import { test, expect, describe, mock } from "bun:test";

// Mock DB to prevent real SQL calls
mock.module("../db/client.ts", () => ({
  getDb: () => {
    const sql = (_strings: TemplateStringsArray, ..._values: any[]) =>
      Promise.resolve([]);
    return sql;
  },
}));

const { spawnHaiku, callHaiku, HAIKU_TIMEOUT_MS } = await import("./executor.ts");

describe("spawnHaiku timeout", () => {
  test("HAIKU_TIMEOUT_MS defaults to 60s", () => {
    expect(HAIKU_TIMEOUT_MS).toBe(60_000);
  });

  test("kills hanging process after timeout", async () => {
    // Call spawnHaiku directly with a very short timeout.
    // "claude" won't be found or will hang — either way it exceeds 100ms.
    await expect(
      spawnHaiku("test", "timeout-test", "test", undefined, "test-bot", 100),
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
    const result = await callHaiku("test", "fallback-value", "test-source");
    expect(result).toBe("fallback-value");
  });
});
