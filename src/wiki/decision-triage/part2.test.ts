/** Part (2)'s assembly, pure: what it replays, what it counts, and that a headline
 *  known before the model is known before the model. */

import { describe, expect, test } from "bun:test";
import type { LabelledAnswer } from "./history.ts";
import { part2Plan, runPart2 } from "./part2.ts";
import { replayKey, type CardLine, type RunLine } from "./schema.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-11-06T04:00:00Z");

const row = (n: number, over: Partial<LabelledAnswer> = {}, page = `p${n % 2}.mdx`): LabelledAnswer => ({
  settled: { relPath: page, id: `O${n}`, answerId: `a${n}`, author: "Eier", firstAt: T0 + n * 1000, at: T0 + n * 1000, choice: "A", body: "", questionHash: "h" },
  status: "ok",
  commit: "abcdef1",
  recommendation: "A",
  added: false,
  ...over,
});
/** A floor met exactly: 20 labelled, 10 added, on 2 pages. */
const floorMet = () => Array.from({ length: 20 }, (_, n) => row(n, { added: n < 10 }));
const run = (at: number): RunLine => ({ type: "run", runId: "r", at, wiki: "w", model: "m", promptVersion: "1", usage: { calls: 1 }, repoRoots: null, repos: [], cards: 0, floor: null, outcome: "ok" });
const night = (over: Partial<CardLine>): CardLine => ({ type: "card", runId: "r", at: T0, wiki: "w", relPath: "p0.mdx", id: "O0", questionHash: "h", recommendation: "A", verdict: "DEFAULT", ...over });

function replaying() {
  const calls: { n: number } = { n: 0 };
  return {
    calls,
    replay: async (cards: Parameters<Parameters<typeof runPart2>[0]["replay"]>[0]) => {
      calls.n++;
      return new Map(cards.map((c, i) => [replayKey(c), night({ relPath: c.relPath, id: c.id, verdict: i < 10 ? "ASK_OWNER" : "DEFAULT" })]));
    },
  };
}
const day = (n: number) => T0 + n * DAY + 1000;

describe("the plan", () => {
  test("only a commit holding the answered wording is replayed; the floor counts what has a label", () => {
    const plan = part2Plan(
      [{ wiki: "w", labelled: [row(1, { added: true }), row(2, { status: "hash-mismatch", added: true }), row(3, { status: "after-answer", commit: null }), row(4, { status: "no-history", commit: null }), row(5, { status: "unreadable", commit: null }), row(6, { added: null })] }],
      [],
      T0,
    );
    expect(plan.cards.map((c) => c.id)).toEqual(["O1", "O6"]);
    expect(plan.cards[0]).toEqual({ wiki: "w", relPath: "p1.mdx", id: "O1", answeredAt: new Date(T0 + 1000).toISOString(), commit: "abcdef1", hashMatches: true, replayable: true });
    expect(plan.floor).toMatchObject({ labelled: 1, added: 1 });
    expect(plan.dropped).toEqual({ noHistory: 1, unreadable: 1, afterAnswer: 1, hashMismatch: 1 });
  });

  test("the day counts from the earliest ok or partial line, floors, and has no run line to read as null", () => {
    const labelled = [{ wiki: "w", labelled: [] }];
    expect(part2Plan(labelled, [], T0).day).toBeNull();
    expect(part2Plan(labelled, [{ ...run(T0 - DAY), outcome: "refused" }], T0).day).toBeNull();
    expect(part2Plan(labelled, [run(T0), { ...run(T0 - 3 * DAY), outcome: "partial" }, { ...run(T0 - 9 * DAY), outcome: "failed" }], T0 + DAY - 1).day).toBe(3);
  });

  test("the floor is per wiki and page: one path in two wikis is two pages", () => {
    const one = (wiki: string, n: number) => ({ wiki, labelled: [row(n, { added: true }, "same.mdx")] });
    expect(part2Plan([one("a", 1), one("b", 2)], [], T0).floor.addedPages).toBe(2);
  });
});

describe("no model call when the headline is already known", () => {
  test.each([
    ["day 3", [run(T0)], day(3), floorMet(), "too early"],
    ["no run line", [], day(30), floorMet(), "too early"],
    ["day 14 under the floor", [run(T0)], day(14), floorMet().slice(0, 19), "too few to score"],
    ["the cap under the floor", [run(T0)], day(28), floorMet().slice(0, 19), "too few to score"],
  ] as const)("%s", async (_name, runs, nowMs, rows, result) => {
    const { calls, replay } = replaying();
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: [...rows] }], log: { runs: [...runs], cards: [] }, nowMs, hand: null, replay });
    expect(calls.n).toBe(0);
    expect(out.headline.result).toBe(result);
    expect(out.scored).toBeNull();
  });

  test("day 14 over the floor calls the model once, and scores what comes back", async () => {
    const { calls, replay } = replaying();
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards: [] }, nowMs: day(14), hand: { read: 5, wrong: 0 }, replay });
    expect(calls.n).toBe(1);
    expect(out.scored!.report.verdict).toMatchObject({ caught: 10, of: 10, cards: 20 });
    expect(out.headline.result).toBe("miss"); // the nightly medians have no verdicts to read
  });
});

describe("the assembly reaches the headline", () => {
  const nights = (extra: CardLine[] = []): CardLine[] => [night({ id: "n1", at: T0, verdict: "DEFAULT" }), ...extra];
  const passing = async (cards: CardLine[], hand: { read: number; wrong: number } | null) => {
    const { replay } = replaying();
    return runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards }, nowMs: day(14), hand, replay });
  };

  test("nothing against it, a full sample: pass", async () => {
    expect((await passing(nights(), { read: 5, wrong: 0 })).headline.result).toBe("pass");
  });

  test("one nightly SETTLED before its answer blocks the pass with no hand sample at all", async () => {
    const h = (await passing(nights([night({ id: "O3", relPath: "p1.mdx", at: T0, verdict: "SETTLED" })]), null)).headline;
    expect(h.result).toBe("miss");
    expect(h.line).toContain("1 SETTLED or VOID later answered");
  });

  test("a VOID after the answer does not count", async () => {
    const h = (await passing(nights([night({ id: "O3", relPath: "p1.mdx", at: T0 + 2 * DAY, verdict: "VOID" })]), { read: 5, wrong: 0 })).headline;
    expect(h.result).toBe("pass");
  });

  test("no sample and nothing later answered reads not judged in the headline", async () => {
    const h = (await passing(nights(), null)).headline;
    expect(h.result).toBe("pass");
    expect(h.line).toContain("not judged");
  });

  test("a wrong read in a full sample is a miss", async () => {
    expect((await passing(nights(), { read: 5, wrong: 1 })).headline.result).toBe("miss");
  });

  test("a card the replay did not return is not scored", async () => {
    const out = await runPart2({ wikis: [{ wiki: "w", labelled: floorMet() }], log: { runs: [run(T0)], cards: nights() }, nowMs: day(14), hand: { read: 5, wrong: 0 }, replay: async () => new Map() });
    expect(out.headline.result).toBe("not scored");
  });
});
