/**
 * The retention sweep's scheduling wrapper: no timer when both windows are
 * unset, and the one log line carries counts and nothing else.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { runAnswerRetentionSweep, startAnswerRetentionSweep, stopAnswerRetentionSweep } from "./answer-retention.ts";

afterEach(async () => {
  stopAnswerRetentionSweep();
  await reset();
});

async function capture(): Promise<LogRecord[]> {
  const records: LogRecord[] = [];
  await configure({
    sinks: { capture: (r: LogRecord) => records.push(r) },
    loggers: [{ category: ["muninn"], sinks: ["capture"], lowestLevel: "debug" }],
    reset: true,
  });
  return records;
}

describe("answer retention sweep wrapper", () => {
  test("both windows unset ⇒ no timer starts", () => {
    expect(startAnswerRetentionSweep({ exportedDays: null, unexportedDays: null })).toBe(false);
    expect(startAnswerRetentionSweep({ exportedDays: 30, unexportedDays: null })).toBe(true);
  });

  test("a sweep that deleted something logs one info line with counts per rule only", async () => {
    const records = await capture();
    const counts = { exported: 2, unexported: 1, redacted: 0 };
    await runAnswerRetentionSweep({ exportedDays: 30, unexportedDays: 90 }, async () => counts);
    const lines = records.filter((r) => r.category.includes("answer-retention"));
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.properties).toEqual(counts);
  });

  test("a sweep that deleted nothing logs nothing", async () => {
    const records = await capture();
    await runAnswerRetentionSweep({ exportedDays: 30, unexportedDays: 90 }, async () => ({
      exported: 0,
      unexported: 0,
      redacted: 0,
    }));
    expect(records.filter((r) => r.category.includes("answer-retention"))).toEqual([]);
  });
});
