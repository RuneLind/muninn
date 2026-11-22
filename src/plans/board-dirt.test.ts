import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pendingBoardWriteMessage } from "./board-dirt.ts";

// F36 (arch review 2026-11-16): Done's refusal names only the committers this
// instance runs for the wiki. The route's DB test drives the loop and the
// nobody cases end to end; the sweeper ones are a bot wiki, which that fixture
// does not register. The sweep is named only where the sweeper both commits
// the root (`sweeper`) and the loop's ledger says the sweeper would commit (`sweeper`).
describe("pendingBoardWriteMessage", () => {
  const head = "plans/p.mdx carries a priority or status change from the plans board that is not committed yet.";
  const healthy = { kind: "healthy", sweeper: "commits" } as const;
  const healthyDown = { kind: "healthy", sweeper: "stands-down" } as const;
  const never = { kind: "never-run", sweeper: "commits" } as const;
  const idle = { kind: "idle", lastRunHoursAgo: 5, sweeper: "commits" } as const;
  const paused = { kind: "stopped", state: "paused", reason: "off default branch (feature)", sweeper: "no-op" } as const;
  const failing = { kind: "stopped", state: "error", reason: "git fetch failed: offline", sweeper: "commits" } as const;
  const failingDown = { kind: "stopped", state: "error", reason: "git fetch failed: offline", sweeper: "stands-down" } as const;
  const conflict = { kind: "unpushed", state: "blocked", reason: "rebase conflict in plans/p.mdx", sweeper: "stands-down" } as const;
  test.each([
    [{ syncLoop: healthy, sweeper: true }, "The repo-sync loop commits it after its quiet period (or the daily wiki sweep does), or commit it by hand."],
    [{ syncLoop: healthyDown, sweeper: true }, "The repo-sync loop commits it after its quiet period, or commit it by hand."],
    [{ syncLoop: healthy, sweeper: false }, "The repo-sync loop commits it after its quiet period, or commit it by hand."],
    [{ syncLoop: never, sweeper: false }, "The repo-sync loop commits it after its quiet period if it is running (it has not run since muninn started), or commit it by hand."],
    [{ syncLoop: idle, sweeper: true }, "The repo-sync loop commits it after its quiet period if it is still running (its last run was 5 h ago) (or the daily wiki sweep does), or commit it by hand."],
    [{ syncLoop: paused, sweeper: true }, "The repo-sync loop is paused and will not commit it until that is cleared: off default branch (feature). Clear that, or commit it by hand."],
    [{ syncLoop: failing, sweeper: true }, "The repo-sync loop is failing and will not commit it until that is cleared: git fetch failed: offline. The daily wiki sweep commits it, or commit it by hand."],
    [{ syncLoop: failingDown, sweeper: true }, "The repo-sync loop is failing and will not commit it until that is cleared: git fetch failed: offline. Clear that, or commit it by hand."],
    [{ syncLoop: failing, sweeper: false }, "The repo-sync loop is failing and will not commit it until that is cleared: git fetch failed: offline. Clear that, or commit it by hand."],
    [
      { syncLoop: conflict, sweeper: true },
      "The repo-sync loop commits it after its quiet period, or commit it by hand. Its last run stopped after the commit step and did not push, so the commit stays on this machine until that is cleared: rebase conflict in plans/p.mdx.",
    ],
    [{ syncLoop: null, sweeper: true }, "The daily wiki sweep commits it, or commit it by hand."],
    [{ syncLoop: null, sweeper: false }, "Nothing on this instance commits it automatically: commit it by hand."],
  ])("%o", (committers, who) => {
    expect(pendingBoardWriteMessage("plans/p.mdx", committers)).toBe(`${head} ${who} Then try again.`);
  });
});

// F36 class check: the doc copies of who commits a board write point at one
// table instead of restating the rule. They once said the sweeper «also runs
// beside a loop with no commit pass in ~26h», false for a blocked loop (stood
// down at any age) and a paused one (the sweeper no-ops off the default branch).
describe("the doc copies of the board-write committer rule", () => {
  const ROOT = path.join(import.meta.dir, "..", "..");
  const HEADING = "Who commits a page the plans board left dirty";
  test.each(["src/plans/write.ts", "src/dashboard/routes/plans-routes.ts", "src/plans/CLAUDE.md"])("%s", (rel) => {
    const text = readFileSync(path.join(ROOT, rel), "utf8").replace(/\s*\n\s*\*?\s*/g, " ");
    expect(text).not.toMatch(/no commit pass in ~?26 ?h/);
    expect(text).toContain(HEADING);
  });
  test("the table they point at exists", () => {
    expect(readFileSync(path.join(ROOT, "src/sync/CLAUDE.md"), "utf8")).toContain(`## ${HEADING}`);
  });
});
