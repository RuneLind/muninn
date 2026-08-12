import { test, expect, describe } from "bun:test";
import {
  blocksRebase,
  clampReason,
  decideStaging,
  describeDeferralReason,
  describeSyncState,
  FUTURE_MTIME_SKEW_MS,
  isDeniedSyncPath,
  isTransientGitLockFailure,
  isUnmergedStatus,
  SYNC_DEFERRAL_WARN_AFTER,
  SYNC_QUIET_MS,
  SYNC_REASON_MAX,
  SYNC_STALE_SUCCESS_MS,
  syncTone,
  type DirtyItem,
  type SyncLedgerEntry,
} from "./decide.ts";

const NOW = 1_800_000_000_000;
const old = (): number => NOW - SYNC_QUIET_MS - 60_000;
const fresh = (): number => NOW - 30_000;

function item(over: Partial<DirtyItem> & { path: string }): DirtyItem {
  return { xy: " M", mtimeMs: old(), ...over };
}

describe("denylist", () => {
  test("catches Obsidian churn, editor scratch and merge leftovers", () => {
    for (const p of [
      ".obsidian/workspace.json",
      "vault/.obsidian/plugins/x/data.json",
      "notes/draft.tmp",
      "notes/.page.md.swp",
      "notes/page.md~",
      "notes/#page.md#",
      "notes/.#page.md",
      ".DS_Store",
      "concepts/A.md.orig",
      "concepts/A.md.rej",
    ]) {
      expect(isDeniedSyncPath(p)).toBe(true);
    }
  });

  test("leaves ordinary pages alone — including one that merely mentions the words", () => {
    for (const p of [
      "concepts/Agent Loops.md",
      "log.md",
      "blogs/obsidian-notes.md",
      "plans/tmp-work.md",
      "life/temporary.md",
    ]) {
      expect(isDeniedSyncPath(p)).toBe(false);
    }
  });

  test("a denied path is dropped WITHOUT making the tick look quiet-filtered", () => {
    // If a denied path counted as an exclusion, a repo carrying permanent
    // .obsidian churn could never commit a deletion again.
    const d = decideStaging(
      [
        item({ path: ".obsidian/workspace.json", xy: "??", mtimeMs: fresh() }),
        item({ path: "concepts/Gone.md", xy: " D", mtimeMs: null }),
      ],
      NOW,
    );
    expect(d.denied).toEqual([".obsidian/workspace.json"]);
    expect(d.quietHeld).toBe(false);
    expect(d.stage).toEqual(["concepts/Gone.md"]);
    expect(d.deletions).toEqual(["concepts/Gone.md"]);
  });

  test("a TRACKED denied path is staged anyway — denying it could only wedge the repo", () => {
    // A committed `.obsidian/workspace.json` is routine in an Obsidian vault.
    // Dropping it from staging leaves it dirty forever, and tracked dirt makes
    // `git rebase` refuse EVERY tick — the repo never converges again.
    const d = decideStaging([item({ path: ".obsidian/workspace.json", xy: " M" })], NOW);
    expect(d.denied).toEqual([]);
    expect(d.stage).toEqual([".obsidian/workspace.json"]);
  });

  test("a tracked DELETION of a denied path is staged too", () => {
    const d = decideStaging([item({ path: "notes/scratch.tmp", xy: " D", mtimeMs: null })], NOW);
    expect(d.denied).toEqual([]);
    expect(d.stage).toEqual(["notes/scratch.tmp"]);
    expect(d.deletions).toEqual(["notes/scratch.tmp"]);
  });
});

describe("decideStaging — quiet period", () => {
  test("stages a settled file and defers a fresh one", () => {
    const d = decideStaging(
      [
        item({ path: "concepts/Settled.md" }),
        item({ path: "concepts/Live.md", mtimeMs: fresh() }),
        item({ path: "concepts/New.md", xy: "??", mtimeMs: fresh() }),
      ],
      NOW,
    );
    expect(d.stage).toEqual(["concepts/Settled.md"]);
    expect(d.deferred.map((x) => x.path).sort()).toEqual(["concepts/Live.md", "concepts/New.md"]);
    expect(d.quietHeld).toBe(true);
  });

  test("the boundary is inclusive at exactly the quiet period", () => {
    const at = decideStaging([item({ path: "a.md", mtimeMs: NOW - SYNC_QUIET_MS })], NOW);
    expect(at.stage).toEqual(["a.md"]);
    const justUnder = decideStaging([item({ path: "a.md", mtimeMs: NOW - SYNC_QUIET_MS + 1 })], NOW);
    expect(justUnder.stage).toEqual([]);
  });

  test("an untracked file that has settled is staged like any other", () => {
    const d = decideStaging([item({ path: "concepts/Fresh.md", xy: "??" })], NOW);
    expect(d.stage).toEqual(["concepts/Fresh.md"]);
    expect(d.deletions).toEqual([]);
  });

  test("a mtime far in the FUTURE is treated as aged, not as forever-fresh", () => {
    // Clock skew or a restored file can stamp an mtime ahead of now. Unclamped,
    // `now - mtime < quietMs` is permanently true: the file defers itself every
    // tick AND holds every deletion in the repo with it, forever.
    const d = decideStaging(
      [
        item({ path: "concepts/Skewed.md", mtimeMs: NOW + FUTURE_MTIME_SKEW_MS + 60_000 }),
        item({ path: "concepts/Gone.md", xy: " D", mtimeMs: null }),
      ],
      NOW,
    );
    expect(d.stage.sort()).toEqual(["concepts/Gone.md", "concepts/Skewed.md"]);
    expect(d.quietHeld).toBe(false);
  });

  test("a mtime a LITTLE ahead is still fresh — that is ordinary clock skew", () => {
    const d = decideStaging([item({ path: "a.md", mtimeMs: NOW + 60_000 })], NOW);
    expect(d.stage).toEqual([]);
    expect(d.quietHeld).toBe(true);
  });
});

describe("decideStaging — deletions", () => {
  test("a deletion needs no mtime test when nothing else is held", () => {
    const d = decideStaging(
      [item({ path: "concepts/Gone.md", xy: " D", mtimeMs: null }), item({ path: "concepts/Kept.md" })],
      NOW,
    );
    expect(d.stage.sort()).toEqual(["concepts/Gone.md", "concepts/Kept.md"]);
    expect(d.deletions).toEqual(["concepts/Gone.md"]);
  });

  test("a deletion is HELD when anything in the tick was quiet-filtered", () => {
    // The unstaged-`mv` shape: git reports `D old` + `?? new` with no pairing.
    // Pushing the deletion alone would give the other machine a 404.
    const d = decideStaging(
      [
        item({ path: "concepts/Old Name.md", xy: " D", mtimeMs: null }),
        item({ path: "concepts/New Name.md", xy: "??", mtimeMs: fresh() }),
      ],
      NOW,
    );
    expect(d.stage).toEqual([]);
    expect(d.deletions).toEqual([]);
    expect(d.deferred.map((x) => x.path).sort()).toEqual([
      "concepts/New Name.md",
      "concepts/Old Name.md",
    ]);
    expect(d.deferred.find((x) => x.path === "concepts/Old Name.md")?.reason).toContain("deletion held");
  });

  test("once the new half settles, both halves go in the SAME tick", () => {
    const d = decideStaging(
      [
        item({ path: "concepts/Old Name.md", xy: " D", mtimeMs: null }),
        item({ path: "concepts/New Name.md", xy: "??", mtimeMs: old() }),
      ],
      NOW,
    );
    expect(d.stage.sort()).toEqual(["concepts/New Name.md", "concepts/Old Name.md"]);
    expect(d.deletions).toEqual(["concepts/Old Name.md"]);
    expect(d.deferred).toEqual([]);
  });
});

describe("decideStaging — rename pairs", () => {
  test("a staged rename whose new half is fresh defers BOTH halves", () => {
    const d = decideStaging(
      [item({ path: "concepts/New.md", xy: "R ", origPath: "concepts/Old.md", mtimeMs: fresh() })],
      NOW,
    );
    expect(d.stage).toEqual([]);
    expect(d.deferred.map((x) => x.path).sort()).toEqual(["concepts/New.md", "concepts/Old.md"]);
    expect(d.quietHeld).toBe(true);
  });

  test("a settled rename stages both halves, the origin as a deletion", () => {
    const d = decideStaging(
      [item({ path: "concepts/New.md", xy: "R ", origPath: "concepts/Old.md" })],
      NOW,
    );
    expect(d.stage).toEqual(["concepts/New.md", "concepts/Old.md"]);
    expect(d.deletions).toEqual(["concepts/Old.md"]);
  });

  test("a rename of a TRACKED denied path still moves — the denylist is untracked-only", () => {
    const d = decideStaging(
      [item({ path: "concepts/New.md", xy: "R ", origPath: "concepts/Old.md.tmp" })],
      NOW,
    );
    expect(d.denied).toEqual([]);
    expect(d.stage).toEqual(["concepts/New.md", "concepts/Old.md.tmp"]);
  });

  test("a COPY record is an ordinary add — its origin still exists and is not a deletion", () => {
    // git sets origPath for `C` as well as `R`, but a copy's source is still on
    // disk: staging it as a deletion would delete a file nobody removed.
    const d = decideStaging(
      [item({ path: "concepts/Copy.md", xy: "C ", origPath: "concepts/Source.md" })],
      NOW,
    );
    expect(d.stage).toEqual(["concepts/Copy.md"]);
    expect(d.deletions).toEqual([]);
  });

  test("a fresh COPY defers only the new path, never its untouched source", () => {
    const d = decideStaging(
      [item({ path: "concepts/Copy.md", xy: "C ", origPath: "concepts/Source.md", mtimeMs: fresh() })],
      NOW,
    );
    expect(d.deferred.map((x) => x.path)).toEqual(["concepts/Copy.md"]);
    expect(d.quietHeld).toBe(true);
  });
});

describe("deferral reasons", () => {
  test("names the real blocking sets and distinguishes outside-subtree dirt", () => {
    const r = describeDeferralReason({
      quietHeld: ["wiki/concepts/Live.md"],
      outside: ["src/main.py", "README.md"],
      inScope: [],
    });
    expect(r).toContain("wiki/concepts/Live.md");
    expect(r).toContain("outside the wiki subtree");
    expect(r).toContain("src/main.py");
    // The old hardcoded wiki-mode string claimed an edit-in-progress whatever the
    // cause; the reason must never say that when the cause is another process.
    expect(r).not.toBe("active edits (3 files < 5 min)");
  });

  test("outside-subtree dirt alone never reads as a quiet hold", () => {
    const r = describeDeferralReason({ quietHeld: [], outside: ["data/x.json"], inScope: [] });
    expect(r).toContain("outside the wiki subtree");
    expect(r).not.toContain("last 5 min");
  });

  test("a long list is sampled, not dumped", () => {
    const many = Array.from({ length: 12 }, (_, i) => `p/${i}.md`);
    const r = describeDeferralReason({ quietHeld: [], outside: [], inScope: many });
    expect(r).toContain("+9 more");
    expect(r.length).toBeLessThanOrEqual(SYNC_REASON_MAX);
  });
});

describe("isTransientGitLockFailure", () => {
  test("git's own index.lock wording maps to transient, matching the pre-flight", () => {
    // The pre-flight already calls a YOUNG index.lock transient. The same lock
    // appearing one step later (a shell `git status`, an editor's git plugin)
    // landed on `error` — a red card for the identical, self-healing condition.
    expect(
      isTransientGitLockFailure(
        "fatal: Unable to create '/x/.git/index.lock': File exists.\n\n" +
          "Another git process seems to be running in this repository",
      ),
    ).toBe(true);
    expect(isTransientGitLockFailure("error: could not lock config file .git/index.lock")).toBe(true);
  });

  test("an ordinary failure is NOT transient", () => {
    expect(isTransientGitLockFailure("error: pathspec 'x.md' did not match any file(s)")).toBe(false);
    expect(isTransientGitLockFailure("CONFLICT (content): Merge conflict in log.md")).toBe(false);
    expect(isTransientGitLockFailure("")).toBe(false);
  });
});

describe("clampReason", () => {
  test("a five-line git stderr becomes one clamped line", () => {
    const stderr =
      "ssh: connect to host github.com port 22: Operation timed out\n" +
      "fatal: Could not read from remote repository.\n\n" +
      "Please make sure you have the correct access rights\n" +
      "and the repository exists.";
    const out = clampReason(stderr);
    expect(out).not.toContain("\n");
    expect(out).toBe("ssh: connect to host github.com port 22: Operation timed out");
  });

  test("an over-long single line is truncated at the cap", () => {
    const out = clampReason("x".repeat(400));
    expect(out.length).toBe(SYNC_REASON_MAX);
    expect(out.endsWith("…")).toBe(true);
  });

  test("leading blank lines and inner whitespace runs are collapsed", () => {
    expect(clampReason("\n\n  fatal:   bad   ref  \n more")).toBe("fatal: bad ref");
  });
});

describe("status predicates", () => {
  test("isUnmergedStatus catches every conflict spelling", () => {
    for (const xy of ["UU", "AA", "DD", "AU", "UD", "UA", "DU"]) {
      expect(isUnmergedStatus(xy)).toBe(true);
    }
    for (const xy of [" M", "M ", "??", "R ", " D", "A "]) {
      expect(isUnmergedStatus(xy)).toBe(false);
    }
  });

  test("blocksRebase excludes untracked and includes staged + unstaged changes", () => {
    // Verified against real git: untracked-only dirt rebases fine; an unstaged
    // tracked modification exits 1 with "cannot rebase: You have unstaged changes".
    expect(blocksRebase("??")).toBe(false);
    expect(blocksRebase("!!")).toBe(false);
    expect(blocksRebase(" M")).toBe(true);
    expect(blocksRebase("M ")).toBe(true);
    expect(blocksRebase("MM")).toBe(true);
    expect(blocksRebase(" D")).toBe(true);
    expect(blocksRebase("R ")).toBe(true);
    expect(blocksRebase("A ")).toBe(true);
  });
});

describe("card state", () => {
  const entry = (over: Partial<SyncLedgerEntry> = {}): SyncLedgerEntry => ({
    state: "ok",
    consecutiveDeferrals: 0,
    lastSuccessMs: NOW - 60_000,
    lastRunMs: NOW,
    ...over,
  });

  test("a healthy repo is ok", () => {
    expect(syncTone(entry(), NOW)).toBe("ok");
  });

  test("one deferral is normal, a run of them is a warning", () => {
    expect(syncTone(entry({ state: "deferred", consecutiveDeferrals: 1 }), NOW)).toBe("ok");
    expect(
      syncTone(entry({ state: "deferred", consecutiveDeferrals: SYNC_DEFERRAL_WARN_AFTER }), NOW),
    ).toBe("warn");
  });

  test("no successful sync in ~2h warns even with no deferral streak", () => {
    expect(syncTone(entry({ lastSuccessMs: NOW - SYNC_STALE_SUCCESS_MS - 1 }), NOW)).toBe("warn");
  });

  test("a status-only repo never warns on staleness (it has nothing to sync)", () => {
    expect(
      syncTone(entry({ state: "status-only", lastSuccessMs: NOW - SYNC_STALE_SUCCESS_MS - 1 }), NOW),
    ).toBe("ok");
  });

  test("blocked and error are always bad; paused and retrying warn", () => {
    expect(syncTone(entry({ state: "blocked" }), NOW)).toBe("bad");
    expect(syncTone(entry({ state: "error" }), NOW)).toBe("bad");
    expect(syncTone(entry({ state: "paused" }), NOW)).toBe("warn");
    expect(syncTone(entry({ state: "retrying" }), NOW)).toBe("warn");
  });

  test("a repo that never synced in this process is not retroactively stale", () => {
    // lastSuccessMs null = "no sync yet in this process", not "hours behind".
    expect(syncTone(entry({ lastSuccessMs: null, lastRunMs: null }), NOW)).toBe("ok");
  });

  test("describeSyncState reads as the card's label", () => {
    expect(describeSyncState("blocked", "needs human")).toBe("blocked: needs human");
    expect(describeSyncState("deferred", "active edits (3 files < 5 min)")).toBe(
      "deferred: active edits (3 files < 5 min)",
    );
    expect(describeSyncState("ok")).toBe("in sync");
  });
});
