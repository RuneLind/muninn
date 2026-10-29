import { describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { workMapDue } from "./loop.ts";
import { fileStateStore } from "./state.ts";

const HOUR = 3_600_000;
/** 2026-10-20 07:00 Europe/Oslo — past the default 05:00. */
const MORNING = Date.parse("2026-10-20T05:00:00Z");

describe("fileStateStore", () => {
  test("refusals do not evict the day's failures: the retry gate still holds after ten of them", async () => {
    const store = fileStateStore(testTempDirSync(path.join(tmpdir(), "work-map-state-")));
    await store.record("mimir", { at: MORNING, outcome: "failed", error: "timeout" });
    for (let i = 1; i <= 12; i++) await store.record("mimir", { at: MORNING + i * 60_000, outcome: "refused" });
    await store.record("mimir", { at: MORNING + HOUR, outcome: "failed", error: "timeout" });
    const st = await store.read("mimir");
    expect(st?.attempts.filter((a) => a.outcome === "failed")).toHaveLength(2);
    expect(workMapDue(st, MORNING + 2 * HOUR, 5)).toEqual({ due: false, why: "failed twice after the model call today" });
  });

  test("the list stays bounded and newest first", async () => {
    const store = fileStateStore(testTempDirSync(path.join(tmpdir(), "work-map-state-")));
    for (let i = 0; i < 5; i++) await store.record("mimir", { at: MORNING + i, outcome: "failed" });
    for (let i = 5; i < 30; i++) await store.record("mimir", { at: MORNING + i, outcome: "refused" });
    const ats = (await store.read("mimir"))?.attempts.map((a) => a.at) ?? [];
    expect(ats).toHaveLength(12);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    expect(ats.slice(-2)).toEqual([MORNING + 4, MORNING + 3]);
  });

  test("a failed write answers from memory, not the older state file", async () => {
    const dir = testTempDirSync(path.join(tmpdir(), "work-map-state-"));
    const store = fileStateStore(dir);
    await store.record("mimir", { at: MORNING, outcome: "ok" });
    chmodSync(dir, 0o500);
    try {
      await expect(store.record("mimir", { at: MORNING + HOUR, outcome: "ok" })).rejects.toThrow();
      expect((await store.read("mimir"))?.lastSuccessAt).toBe(MORNING + HOUR);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
