import { afterEach, describe, expect, test } from "bun:test";
import type { WikiIndex } from "../store.ts";
import type { WorkSessionsMemo } from "../work-sessions.ts";
import { __resetWorkedLedgerForTest, refreshWorkedLedger, workedLedgerStartedAfter, type WorkedLedgerDeps } from "../worked-ledger.ts";
import { gatherWarmInputs, WORK_MAP_INPUT_TIMEOUT_MS, type WarmInputDeps } from "./inputs.ts";

const START = 1_000_000;

const memo = (asOfMs: number) => ({ asOfMs, sinceMs: asOfMs - 8 * 86_400_000 }) as WorkSessionsMemo;
const index = (over: Partial<WikiIndex> = {}) =>
  ({
    work: { asOfMs: START + 5, sinceMs: 0, threads: [] },
    workedCoverage: { matched: 1, total: 1, returned: 1, asOfMs: START + 3 },
    gitTouches: new Map(),
    ...over,
  }) as WikiIndex;

function deps(over: Partial<WarmInputDeps> = {}, calls: string[] = []): WarmInputDeps {
  return {
    urlConfigured: true,
    ledger: async (_root, timeoutMs) => {
      calls.push(`ledger:${timeoutMs}`);
      return { ok: true, memo: {} as never };
    },
    sessions: async (_root, timeoutMs) => {
      calls.push(`sessions:${timeoutMs}`);
      return { memo: memo(START + 2), timedOut: false };
    },
    rebuildIndex: async () => {
      calls.push("index");
      return index();
    },
    ...over,
  };
}

describe("gatherWarmInputs", () => {
  test("ledger, then sessions, then the index rebuild — each claude-usage wait at 15 s", async () => {
    const calls: string[] = [];
    const out = await gatherWarmInputs("/w", START, deps({}, calls));
    expect(out.ok).toBe(true);
    expect(calls).toEqual([`ledger:${WORK_MAP_INPUT_TIMEOUT_MS}`, `sessions:${WORK_MAP_INPUT_TIMEOUT_MS}`, "index"]);
    expect(WORK_MAP_INPUT_TIMEOUT_MS).toBe(15_000);
  });

  test("an unset CLAUDE_USAGE_URL refuses before any call", async () => {
    const calls: string[] = [];
    const out = await gatherWarmInputs("/w", START, deps({ urlConfigured: false }, calls));
    expect(out).toEqual({ ok: false, reason: "claude-usage not configured (CLAUDE_USAGE_URL is unset)" });
    expect(calls).toEqual([]);
  });

  test("a ledger miss refuses before the sessions are asked", async () => {
    const calls: string[] = [];
    const out = await gatherWarmInputs("/w", START, deps({ ledger: async () => ({ ok: false, reason: "the worked ledger refresh failed" }) }, calls));
    expect(out).toEqual({ ok: false, reason: "the worked ledger refresh failed" });
    expect(calls).toEqual([]);
  });

  test("a cold sessions memo refuses: older than the run, absent, or timed out", async () => {
    const older = await gatherWarmInputs("/w", START, deps({ sessions: async () => ({ memo: memo(START - 1), timedOut: false }) }));
    expect(older.ok === false && older.reason).toContain("predates the run");
    const none = await gatherWarmInputs("/w", START, deps({ sessions: async () => ({ memo: null, timedOut: false }) }));
    expect(none.ok).toBe(false);
    const late = await gatherWarmInputs("/w", START, deps({ sessions: async () => ({ memo: memo(START - 1), timedOut: true }) }));
    expect(late.ok === false && late.reason).toContain("did not answer in time");
  });

  test("a rebuilt index missing its warm folds refuses", async () => {
    const cases: [Partial<WikiIndex>, string][] = [
      [{ work: undefined }, "no work threads"],
      [{ work: { asOfMs: START - 1, sinceMs: 0, threads: [] } }, "older sessions answer"],
      [{ workedCoverage: undefined }, "older worked ledger"],
      [{ gitTouches: undefined }, "no git history"],
    ];
    for (const [over, reason] of cases) {
      const out = await gatherWarmInputs("/w", START, deps({ rebuildIndex: async () => index(over) }));
      expect(out.ok === false && out.reason).toContain(reason);
    }
    const missing = await gatherWarmInputs("/w", START, deps({ rebuildIndex: async () => null }));
    expect(missing.ok).toBe(false);
  });
});

describe("workedLedgerStartedAfter (the real ledger module)", () => {
  afterEach(() => __resetWorkedLedgerForTest());

  function ledgerDeps(answers: (() => Promise<unknown>)[], seen: number[] = []): WorkedLedgerDeps {
    let n = 0;
    return {
      urlConfigured: true,
      baseUrl: "http://usage.test",
      fetchPages: () => {
        seen.push(++n);
        return answers[Math.min(n - 1, answers.length - 1)]!();
      },
    };
  }
  const rows = (count: number) => ({ pages: Array.from({ length: count }, (_, i) => ({ p: `/w/p${i}.md`, w: 1 })), limit: 1000 });

  test("a refresh already in flight is waited out, then a new one answers", async () => {
    let release!: () => void;
    const slow = new Promise<unknown>((r) => (release = () => r(rows(1))));
    const seen: number[] = [];
    const d = ledgerDeps([() => slow, async () => rows(2)], seen);
    const inFlight = refreshWorkedLedger("/w", d);
    const after = workedLedgerStartedAfter("/w", { deps: d, timeoutMs: 2_000 });
    release();
    await inFlight;
    const out = await after;
    expect(seen).toEqual([1, 2]);
    expect(out.ok && out.memo.pages.size).toBe(2);
  });

  test("an unset URL, a failed refresh, a held empty answer and a timeout refuse", async () => {
    expect(await workedLedgerStartedAfter("/w", { deps: { ...ledgerDeps([async () => rows(1)]), urlConfigured: false } })).toEqual({
      ok: false,
      reason: "claude-usage not configured (CLAUDE_USAGE_URL is unset)",
    });
    const failed = await workedLedgerStartedAfter("/w", { deps: ledgerDeps([async () => Promise.reject(new Error("down"))]) });
    expect(failed).toEqual({ ok: false, reason: "the worked ledger refresh failed" });
    // A good answer, then an empty one: the memo keeps its pages and the old answeredAt.
    await refreshWorkedLedger("/w", ledgerDeps([async () => rows(3)]));
    const empty = await workedLedgerStartedAfter("/w", { deps: ledgerDeps([async () => rows(0)]) });
    expect(empty.ok).toBe(false);
    const hung = await workedLedgerStartedAfter("/x", { deps: ledgerDeps([() => new Promise(() => {})]), timeoutMs: 20 });
    expect(hung).toEqual({ ok: false, reason: "the worked ledger did not answer in time" });
  });
});
