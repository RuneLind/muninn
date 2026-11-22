import { describe, expect, test } from "bun:test";
import { pendingBoardWriteMessage } from "./board-dirt.ts";

// F36 (arch review 2026-11-16): Done's refusal names only the committers this
// instance runs for the wiki. The route's DB test drives the loop and the
// nobody cases end to end; the sweeper ones are a bot wiki, which that fixture
// does not register.
describe("pendingBoardWriteMessage", () => {
  const head = "plans/p.mdx carries a priority or status change from the plans board that is not committed yet.";
  test.each([
    [{ syncLoop: true, sweeper: true }, "The repo-sync loop commits it after its quiet period (or the daily wiki sweep does), or commit it by hand."],
    [{ syncLoop: true, sweeper: false }, "The repo-sync loop commits it after its quiet period, or commit it by hand."],
    [{ syncLoop: false, sweeper: true }, "The daily wiki sweep commits it, or commit it by hand."],
    [{ syncLoop: false, sweeper: false }, "Nothing on this instance commits it automatically: commit it by hand."],
  ])("%o", (committers, who) => {
    expect(pendingBoardWriteMessage("plans/p.mdx", committers)).toBe(`${head} ${who} Then try again.`);
  });
});
