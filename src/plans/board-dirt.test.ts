import { describe, expect, test } from "bun:test";
import { pendingBoardWriteMessage } from "./board-dirt.ts";

// F36 (arch review 2026-11-16): Done's refusal names only the committers this
// instance runs for the wiki. The route's DB test drives the loop and the
// nobody cases end to end; the sweeper ones are a bot wiki, which that fixture
// does not register.
describe("pendingBoardWriteMessage", () => {
  const head = "plans/p.mdx carries a priority or status change from the plans board that is not committed yet.";
  const healthy = { kind: "healthy" } as const;
  const never = { kind: "never-run" } as const;
  const idle = { kind: "idle", lastRunHoursAgo: 5 } as const;
  const paused = { kind: "stopped", state: "paused", reason: "off default branch (feature)", stopsSweeper: true } as const;
  const failing = { kind: "stopped", state: "error", reason: "git fetch failed: offline", stopsSweeper: false } as const;
  test.each([
    [{ syncLoop: healthy, sweeper: true }, "The repo-sync loop commits it after its quiet period (or the daily wiki sweep does), or commit it by hand."],
    [{ syncLoop: healthy, sweeper: false }, "The repo-sync loop commits it after its quiet period, or commit it by hand."],
    [{ syncLoop: never, sweeper: false }, "The repo-sync loop commits it after its quiet period if it is running (it has not run since muninn started), or commit it by hand."],
    [{ syncLoop: idle, sweeper: true }, "The repo-sync loop commits it after its quiet period if it is still running (its last run was 5 h ago) (or the daily wiki sweep does), or commit it by hand."],
    [{ syncLoop: paused, sweeper: true }, "The repo-sync loop is paused and will not commit it until that is cleared: off default branch (feature). Clear that, or commit it by hand."],
    [{ syncLoop: failing, sweeper: true }, "The repo-sync loop is failing and will not commit it until that is cleared: git fetch failed: offline. The daily wiki sweep commits it, or commit it by hand."],
    [{ syncLoop: failing, sweeper: false }, "The repo-sync loop is failing and will not commit it until that is cleared: git fetch failed: offline. Clear that, or commit it by hand."],
    [{ syncLoop: null, sweeper: true }, "The daily wiki sweep commits it, or commit it by hand."],
    [{ syncLoop: null, sweeper: false }, "Nothing on this instance commits it automatically: commit it by hand."],
  ])("%o", (committers, who) => {
    expect(pendingBoardWriteMessage("plans/p.mdx", committers)).toBe(`${head} ${who} Then try again.`);
  });
});
