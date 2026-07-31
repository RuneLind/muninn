/**
 * Parser semantics for the git date walk — creation dates (first appearance) and
 * update dates (newest NON-SWEEP commit) from one pass. The `git log` output shapes
 * below are literal — captured from real `git log --reverse --name-status -M
 * --diff-merges=first-parent --format=%at` runs in mimir — so the rename/copy/sweep
 * rules are pinned against what git actually emits, not against a paraphrase of it.
 *
 * `buildWikiGitDates` itself spawns git and is covered by the real-repo smoke at the
 * bottom, which skips cleanly outside a git checkout.
 */

import { test, expect } from "bun:test";
import { parseGitLog, buildWikiGitDates, SWEEP_THRESHOLD } from "./git-dates.ts";

/** `%at` is seconds; the maps are ms. */
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const ms = (iso: string) => Math.floor(Date.parse(iso) / 1000) * 1000;

/** The two maps, addressed one at a time so each rule reads as its own assertion. */
const created = (stdout: string) => parseGitLog(stdout).created;
const touched = (stdout: string) => parseGitLog(stdout).touched;

/** A commit big enough to classify as a sweep, as literal git output. */
function sweepCommit(iso: string, paths: string[], status = "M"): string {
  return [`${at(iso)}`, ...paths.map((p) => `${status}\t${p}`)].join("\n");
}
/** `n` throwaway paths, for padding a commit up over the sweep threshold. */
const filler = (n: number, tag = "f") =>
  Array.from({ length: n }, (_, i) => `plans/${tag}-${i}.md`);

test("first appearance of a path wins", () => {
  const out = created(
    [
      `${at("2026-05-04T10:00:00Z")}`,
      "A\tplans/one.md",
      `${at("2026-07-31T10:00:00Z")}`,
      "M\tplans/one.md",
    ].join("\n"),
  );
  expect(out.get("plans/one.md")).toBe(ms("2026-05-04T10:00:00Z"));
});

test("a rename carries the source's creation date to the new path", () => {
  // The mimir case: `wiki/`→`projects/` (2026-07-08) and `.md`→`.mdx` conversions.
  // Without this the renamed page dates to the rename commit — the very bug the
  // module exists to fix, just relocated.
  const out = created(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "A\twiki/muninn/voice.md",
      `${at("2026-07-08T10:00:00Z")}`,
      "R100\twiki/muninn/voice.md\tprojects/muninn/voice.md",
    ].join("\n"),
  );
  expect(out.get("projects/muninn/voice.md")).toBe(ms("2026-04-02T10:00:00Z"));
  // The source keeps its own date — it may still be referenced by a later rename.
  expect(out.get("wiki/muninn/voice.md")).toBe(ms("2026-04-02T10:00:00Z"));
});

test("a rename chain carries the ORIGINAL date across both hops", () => {
  const out = created(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "A\ta.md",
      `${at("2026-05-04T10:00:00Z")}`,
      "R100\ta.md\tb.md",
      `${at("2026-07-08T10:00:00Z")}`,
      "R98\tb.md\tc.mdx",
    ].join("\n"),
  );
  expect(out.get("c.mdx")).toBe(ms("2026-04-02T10:00:00Z"));
});

test("a rename from OUTSIDE the walk dates to the rename commit", () => {
  // Scoping the log to the wiki subtree means a file moved in from elsewhere in the
  // repo has no prior record. Dating it to the move is the honest floor — "the wiki
  // has had it since" — not a guess at its earlier life.
  const out = created(
    [`${at("2026-05-04T10:00:00Z")}`, "R100\tdocs/old.md\tplans/new.md"].join("\n"),
  );
  expect(out.get("plans/new.md")).toBe(ms("2026-05-04T10:00:00Z"));
});

test("a copy is a NEW page: it keeps the copy commit's date, and the source keeps its own", () => {
  // Unreachable today (`-C` is not passed to `git log`, so git never emits `C`), and
  // pinned precisely because of that: a copy inheriting its source's creation date
  // would sink a genuinely new page in "Recently added" — the exact failure this
  // module exists to prevent — and there would be no live case to notice it.
  const out = created(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "A\torig.md",
      `${at("2026-07-08T10:00:00Z")}`,
      "C100\torig.md\tdupe.md",
    ].join("\n"),
  );
  expect(out.get("orig.md")).toBe(ms("2026-04-02T10:00:00Z"));
  expect(out.get("dupe.md")).toBe(ms("2026-07-08T10:00:00Z"));
});

test("paths containing spaces survive parsing", () => {
  // A real mimir filename. The status regex captures the rest of the line wholesale,
  // so only a TAB is special.
  const out = created(
    [`${at("2026-04-02T10:00:00Z")}`, "A\tplans/Mac-mini headless setup.md"].join("\n"),
  );
  expect(out.get("plans/Mac-mini headless setup.md")).toBe(ms("2026-04-02T10:00:00Z"));
});

test("non-ASCII paths arrive UNQUOTED because the spawn forces core.quotePath=false", () => {
  // Captured from huginn-nav, which is 32% non-ASCII names. Both spellings below are
  // real git output — the unquoted one only exists BECAUSE of the `-c
  // core.quotePath=false` in `git()`. With git's default (quotePath=true) the second
  // form is what arrives, and it is why this must be a flag at the spawn and not a
  // parser feature: the escaped key matches no `relPath`, doesn't survive the subtree
  // strip, and drops the page silently.
  const good = created(
    [`${at("2026-04-02T10:00:00Z")}`, "M\twiki/concepts/Årsavregning.md"].join("\n"),
  );
  expect(good.get("wiki/concepts/Årsavregning.md")).toBe(ms("2026-04-02T10:00:00Z"));

  // Documenting the failure shape, not endorsing it: the parser does NOT unquote, so a
  // regression that loses the flag produces this useless key rather than silently
  // half-working. The real-git test below is what actually guards the flag.
  const quoted = created(
    [`${at("2026-04-02T10:00:00Z")}`, 'M\t"wiki/concepts/\\303\\205rsavregning.md"'].join("\n"),
  );
  expect(quoted.has("wiki/concepts/Årsavregning.md")).toBe(false);
});

test("a deletion does not resurrect or shadow a later re-add", () => {
  // First appearance wins, so a file deleted and re-added keeps its ORIGINAL date.
  // That is the intended reading: the page existed then, and the history says so.
  const out = created(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "A\tp.md",
      `${at("2026-05-04T10:00:00Z")}`,
      "D\tp.md",
      `${at("2026-07-08T10:00:00Z")}`,
      "A\tp.md",
    ].join("\n"),
  );
  expect(out.get("p.md")).toBe(ms("2026-04-02T10:00:00Z"));
});

test("file entries before any commit stamp are ignored, not dated to the epoch", () => {
  const out = created(["A\torphan.md", `${at("2026-04-02T10:00:00Z")}`, "A\tok.md"].join("\n"));
  expect(out.has("orphan.md")).toBe(false);
  expect(out.get("ok.md")).toBe(ms("2026-04-02T10:00:00Z"));
});

test("empty output is an empty map, not a throw", () => {
  expect(created("").size).toBe(0);
  expect(created("\n\n").size).toBe(0);
  expect(touched("").size).toBe(0);
});

// ---------------------------------------------------------------------------
// Update dates — the newest NON-SWEEP commit per path.
// ---------------------------------------------------------------------------

test("touched: the newest small commit wins over an older one", () => {
  const out = touched(
    [
      `${at("2026-05-04T10:00:00Z")}`,
      "A\tplans/one.md",
      `${at("2026-07-24T10:00:00Z")}`,
      "M\tplans/one.md",
    ].join("\n"),
  );
  expect(out.get("plans/one.md")).toBe(ms("2026-07-24T10:00:00Z"));
});

test("touched: a SWEEP contributes no update date — the real edit stands", () => {
  // The whole point. mimir's 2026-07-31 plan-status backfill touched 148 files in
  // one commit, which made every plan read as edited that minute. `mimir-wiki-polish`
  // should keep reporting its real 2026-05-04 touch.
  const out = touched(
    [
      `${at("2026-05-04T10:00:00Z")}`,
      "M\tplans/polish.md",
      sweepCommit("2026-07-31T12:31:00Z", ["plans/polish.md", ...filler(SWEEP_THRESHOLD - 1)]),
    ].join("\n"),
  );
  expect(out.get("plans/polish.md")).toBe(ms("2026-05-04T10:00:00Z"));
});

test("touched: the threshold is a floor, not a ceiling — one file under it still counts", () => {
  // Sized exactly at the boundary so an off-by-one in either direction fails here
  // rather than silently reclassifying every mid-sized commit in a real wiki.
  const paths = (n: number) => ["plans/p.md", ...filler(n - 1)];
  const justUnder = touched(sweepCommit("2026-07-24T10:00:00Z", paths(SWEEP_THRESHOLD - 1)));
  expect(justUnder.get("plans/p.md")).toBe(ms("2026-07-24T10:00:00Z"));
  const exactlyAt = touched(sweepCommit("2026-07-24T10:00:00Z", paths(SWEEP_THRESHOLD)));
  expect(exactlyAt.has("plans/p.md")).toBe(false);
});

test("touched: a page whose every commit was a sweep is ABSENT, not dated to a sweep", () => {
  // 19 of mimir's 151 plans at threshold 10 (`huginn-graphrag-improvements.md` was
  // added in the 2026-05-04 consolidation and only ever swept since). Absence is the
  // contract: it is what lets `pageTimeMs` fall back to the creation date instead of
  // showing a sweep's timestamp as if it were an edit.
  const stdout = [
    sweepCommit("2026-05-04T10:00:00Z", ["plans/only-swept.md", ...filler(12, "a")], "A"),
    sweepCommit("2026-07-31T12:31:00Z", ["plans/only-swept.md", ...filler(12, "b")]),
  ].join("\n");
  expect(touched(stdout).has("plans/only-swept.md")).toBe(false);
  // …but it still HAS a creation date, which is exactly the fallback.
  expect(created(stdout).get("plans/only-swept.md")).toBe(ms("2026-05-04T10:00:00Z"));
});

test("touched: a rename CARRIES the source's update history to the new path", () => {
  // Sharper than the creation-side rule: the reorg that renames a page is itself a
  // sweep, so without carrying, the page's entire real edit history would be stranded
  // under a path that no longer exists and the page would read as never edited.
  const stdout = [
    `${at("2026-04-02T10:00:00Z")}`,
    "A\twiki/muninn/voice.md",
    `${at("2026-05-04T10:00:00Z")}`,
    "M\twiki/muninn/voice.md",
    sweepCommit(
      "2026-07-08T10:00:00Z",
      ["wiki/muninn/voice.md\tprojects/muninn/voice.md", ...filler(20)],
      "R100",
    ),
  ].join("\n");
  expect(touched(stdout).get("projects/muninn/voice.md")).toBe(ms("2026-05-04T10:00:00Z"));
});

test("touched: a SMALL rename counts as its own edit", () => {
  // Renaming one page deliberately (a `.md`→`.mdx` conversion) is a real touch, so
  // the rename commit wins over the older edit it carries forward.
  const out = touched(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "M\ta.md",
      `${at("2026-07-19T10:00:00Z")}`,
      "R098\ta.md\ta.mdx",
    ].join("\n"),
  );
  expect(out.get("a.mdx")).toBe(ms("2026-07-19T10:00:00Z"));
});

test("touched: a rename RETIRES the source path", () => {
  // A later file reusing the old path must start from its own history, not inherit
  // its predecessor's. (A COPY, by contrast, leaves the source in place — below.)
  const out = touched(
    [`${at("2026-04-02T10:00:00Z")}`, "M\ta.md", `${at("2026-07-19T10:00:00Z")}`, "R100\ta.md\tb.md"].join(
      "\n",
    ),
  );
  expect(out.has("a.md")).toBe(false);
  expect(out.get("b.md")).toBe(ms("2026-07-19T10:00:00Z"));
});

test("touched: a COPY does not retire the source, and does not touch it either", () => {
  // Unlike a rename, a copy emits one entry (for the new path) and leaves the source
  // alone on disk — so the source keeps its OWN last edit, unmoved by the copy. Also
  // unreachable today; see the creation-side copy test above for why it is pinned.
  const out = touched(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "M\torig.md",
      `${at("2026-07-08T10:00:00Z")}`,
      "C100\torig.md\tdupe.md",
    ].join("\n"),
  );
  expect(out.get("orig.md")).toBe(ms("2026-04-02T10:00:00Z"));
  expect(out.get("dupe.md")).toBe(ms("2026-07-08T10:00:00Z"));
});

test("sweep-ness is decided per COMMIT, so the LAST commit is classified too", () => {
  // The parser buffers a commit's entries until the next stamp; the final commit has
  // no following stamp, so it is only classified if the trailing flush runs. Without
  // it the largest, newest sweep — the exact shape that motivated this module — would
  // be the one commit that escaped classification.
  const out = touched(
    [
      `${at("2026-05-04T10:00:00Z")}`,
      "M\tplans/p.md",
      sweepCommit("2026-07-31T12:31:00Z", ["plans/p.md", ...filler(30)]),
    ].join("\n"),
  );
  expect(out.get("plans/p.md")).toBe(ms("2026-05-04T10:00:00Z"));
});

test("buildWikiGitDates: degrades to null outside a git repo", async () => {
  // `/` is never a git repo (and if a machine made it one, this asserts the wrong
  // thing rather than failing dirty — hence the explicit null check only).
  expect(await buildWikiGitDates("/")).toBeNull();
});

test("buildWikiGitDates: a symlinked root still resolves its subtree pathspec", async () => {
  // `git rev-parse --show-toplevel` reports a symlink-RESOLVED path, so subtracting an
  // unresolved root escapes upward into a `..` relative path and degrades the whole
  // walk to null. On macOS every `/tmp` path hits this — including the e2e fixtures'
  // `WIKI_EXTRA` wikis and any mkdtemp root — so it is a shipping path, not a test-only
  // quirk. Uses this repo via its own symlinked temp view to keep the assertion real.
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "git-dates-link-"));
  const link = path.join(dir, "wiki");
  try {
    await symlink(import.meta.dir, link);
    const dates = await buildWikiGitDates(link);
    expect(dates).not.toBeNull();
    expect(dates!.created.get("store.ts")).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildWikiGitDates: real repo — this file's own dates are tracked", async () => {
  // Smoke over the muninn checkout itself, scoped to src/wiki (exercising the
  // toplevel resolution + subtree pathspec + prefix stripping that a
  // parser-only test cannot reach). Skips if the repo has no history.
  const dates = await buildWikiGitDates(import.meta.dir);
  if (!dates || dates.created.size === 0) return;
  expect(dates.created.get("store.ts")).toBeGreaterThan(0);
  // `store.ts` has a long history of ordinary commits, so it must also carry a
  // non-sweep touch — and it can never predate its own creation.
  expect(dates.touched.get("store.ts")!).toBeGreaterThanOrEqual(dates.created.get("store.ts")!);
  // Keys are wiki-relative (prefix stripped), never repo-relative — on BOTH maps and
  // the dirty set, since they are looked up with the same key.
  for (const key of dates.created.keys()) expect(key.startsWith("src/wiki/")).toBe(false);
  for (const key of dates.touched.keys()) expect(key.startsWith("src/wiki/")).toBe(false);
  for (const key of dates.dirty) expect(key.startsWith("src/wiki/")).toBe(false);
});

test("buildWikiGitDates: real repo — an uncommitted edit shows up as DIRTY", async () => {
  // The one signal history cannot supply. Written into the module's own directory so
  // the subtree pathspec + the wiki-relative key are exercised for real; a
  // hand-written fixture would prove only that a Set works.
  const { writeFile, rm } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const rel = "__dirty-probe.tmp.md";
  const abs = path.join(import.meta.dir, rel);
  try {
    await writeFile(abs, "# scratch\n");
    const dates = await buildWikiGitDates(import.meta.dir);
    if (!dates || dates.created.size === 0) return; // no git history — nothing to assert
    expect(dates.dirty.has(rel)).toBe(true);
    // …and it is untracked, so git supplies no date for it at all. That pairing is
    // what `updatedSignal` reads as "trust this page's mtime".
    expect(dates.created.has(rel)).toBe(false);
  } finally {
    await rm(abs, { force: true });
  }
});
