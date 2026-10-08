/**
 * The retention sweep's scheduling wrapper: no timer when both windows are
 * unset, one sweep at a time, a stop that waits for it, the boot line's text,
 * and the one log line per sweep carries counts and nothing else.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import {
  ANSWER_RETENTION_STOP_WAIT_MS,
  answerRetentionBootLines,
  runAnswerRetentionSweep,
  startAnswerRetentionSweep,
  stopAnswerRetentionSweep,
} from "./answer-retention.ts";

afterEach(async () => {
  await stopAnswerRetentionSweep();
  await reset();
});

const E = "WIKI_ANSWER_RETENTION_DAYS";
const U = "WIKI_ANSWER_UNEXPORTED_DAYS";
const ZERO = { exported: 0, unexported: 0, redacted: 0, failed: 0 };

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
    const counts = { exported: 2, unexported: 1, redacted: 0, failed: 0 };
    await runAnswerRetentionSweep({ exportedDays: 30, unexportedDays: 90 }, async () => counts);
    const lines = records.filter((r) => r.category.includes("answer-retention"));
    expect(lines.length).toBe(1);
    expect(lines[0]!.level).toBe("info");
    expect(lines[0]!.properties).toEqual(counts);
  });

  test("a sweep that deleted nothing logs nothing", async () => {
    const records = await capture();
    await runAnswerRetentionSweep({ exportedDays: 30, unexportedDays: 90 }, async () => ZERO);
    expect(records.filter((r) => r.category.includes("answer-retention"))).toEqual([]);
  });

  test("a sweep with failed answers logs one warning line: the counts and the first failure's class and code, nothing else", async () => {
    const records = await capture();
    const counts = { exported: 0, unexported: 1, redacted: 0, failed: 2 };
    await runAnswerRetentionSweep({ exportedDays: 30, unexportedDays: 90 }, async () => ({
      ...counts,
      firstFailure: { errorClass: "PostgresError", code: "55P03" },
    }));
    const lines = records.filter((r) => r.category.includes("answer-retention"));
    expect(lines.map((l) => ({ level: l.level, properties: l.properties }))).toEqual([
      { level: "warning", properties: { ...counts, errorClass: "PostgresError", code: "55P03" } },
    ]);
  });

  test("stop asks the sweep in flight to end at its next answer", async () => {
    let shouldStop: (() => boolean) | undefined;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sweep = async (_w: unknown, _now?: number, hooks?: { shouldStop?: () => boolean }) => {
      shouldStop = hooks?.shouldStop;
      await gate;
      return ZERO;
    };
    startAnswerRetentionSweep({ exportedDays: 30, unexportedDays: null }, { sweep, firstDelayMs: 0, intervalMs: 60_000 });
    try {
      await Bun.sleep(30);
      expect(shouldStop).toBeDefined();
      expect(shouldStop!()).toBe(false);
      const stop = stopAnswerRetentionSweep();
      expect(shouldStop!()).toBe(true);
      release();
      await stop;
    } finally {
      release();
    }
  });

  test("a sweep that never finishes: stop returns after its bound, not with the sweep", async () => {
    const records = await capture();
    let release!: () => void;
    const never = new Promise<void>((r) => (release = r));
    const sweep = async () => {
      await never;
      return ZERO;
    };
    startAnswerRetentionSweep({ exportedDays: 30, unexportedDays: null }, { sweep, firstDelayMs: 0, intervalMs: 60_000 });
    try {
      await Bun.sleep(30);
      const t0 = performance.now();
      await stopAnswerRetentionSweep(100);
      const waited = performance.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(90);
      expect(waited).toBeLessThan(1_000);
      expect(records.some((r) => r.level === "warning" && String(r.message.join("")).includes("timed out"))).toBe(true);
    } finally {
      release(); // let the hung sweep settle, so `running` clears for the next test
      await Bun.sleep(10);
    }
  });

  test("the default stop bound is at most 10 s", () => {
    expect(ANSWER_RETENTION_STOP_WAIT_MS).toBeLessThanOrEqual(10_000);
    expect(ANSWER_RETENTION_STOP_WAIT_MS).toBeGreaterThan(0);
  });

  test("a tick while a sweep runs is skipped, and stop waits for the running sweep", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sweep = async () => {
      calls++;
      await gate;
      return ZERO;
    };
    expect(startAnswerRetentionSweep({ exportedDays: 30, unexportedDays: null }, { sweep, firstDelayMs: 0, intervalMs: 5 })).toBe(true);
    try {
      await Bun.sleep(80);
      // Some fifteen ticks fired while the first sweep held its gate: none started a second.
      expect(calls).toBe(1);

      let stopped = false;
      const stop = stopAnswerRetentionSweep().then(() => (stopped = true));
      await Bun.sleep(30);
      expect(stopped).toBe(false);
      release();
      await stop;
      expect(stopped).toBe(true);
      await Bun.sleep(30);
      expect(calls).toBe(1);
    } finally {
      release(); // a failed assertion must not leave afterEach's stop waiting on the gate
    }
  });
});

describe("answer retention boot line", () => {
  test("both windows set: one info line naming both, no warnings", () => {
    expect(answerRetentionBootLines({ exportedDays: 30, unexportedDays: 90, refused: [] })).toEqual({
      info:
        "Answer retention sweep on (hourly): exported answers deleted 30 day(s) after export; " +
        "unexported answers deleted 90 day(s) after their latest version; redacted answers deleted at the next sweep",
      warnings: [],
    });
  });

  test("one window unset: that rule reads off, never 'off day(s)'", () => {
    const { info } = answerRetentionBootLines({ exportedDays: 30, unexportedDays: null, refused: [] });
    expect(info).toBe(
      "Answer retention sweep on (hourly): exported answers deleted 30 day(s) after export; " +
        "unexported rule off; redacted answers deleted at the next sweep",
    );
  });

  test("both windows refused at 0: two warnings naming variable and value, and no info line", () => {
    expect(
      answerRetentionBootLines({
        exportedDays: null,
        unexportedDays: null,
        refused: [
          { name: E, value: "0" },
          { name: U, value: "0" },
        ],
      }),
    ).toEqual({
      info: null,
      warnings: [
        `${E} is 0, which would delete every answer on the next sweep — refused, the rule is off`,
        `${U} is 0, which would delete every answer on the next sweep — refused, the rule is off`,
      ],
    });
  });

  test("both unset: nothing at all", () => {
    expect(answerRetentionBootLines({ exportedDays: null, unexportedDays: null, refused: [] })).toEqual({ info: null, warnings: [] });
  });
});
