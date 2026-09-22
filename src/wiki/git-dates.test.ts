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
import {
  parseGitLog,
  buildWikiGitDates,
  classifyPageChange,
  SWEEP_THRESHOLD,
  __setClassifyBudgetForTest,
} from "./git-dates.ts";
import { setFrontmatterScalar } from "../plans/frontmatter.ts";

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

// ── The metadata-only rule ───────────────────────────────────────────────────
//
// A mechanical frontmatter write moves a page's mtime without editing it, and the
// dirty set is what hands a page to the mtime rule. The verdict itself is pure
// (`classifyPageChange`, below); everything around it is a claim about what `git
// status` and `git cat-file` emit, so those run against a REAL temp git repo — a
// hand-written fixture would prove only that a Set works.

/** Page text with one frontmatter block and one body line, so a case can move
 *  exactly one of the two. */
const pageText = (fm: string[], body: string) => `---\n${fm.join("\n")}\n---\n\n${body}\n`;

test("classifyPageChange: a frontmatter metadata rewrite is metadata-only", () => {
  expect(
    classifyPageChange(
      pageText(["title: A", "series: one"], "Prose."),
      pageText(["title: A", "series: two"], "Prose."),
    ),
  ).toBe("metadata-only");
});

test("classifyPageChange: an ADDED or REMOVED metadata key is metadata-only too", () => {
  // What a series join and a `/plans` flip actually do: the key was not there.
  expect(
    classifyPageChange(pageText(["title: A"], "Prose."), pageText(["title: A", "series: one"], "Prose.")),
  ).toBe("metadata-only");
  expect(
    classifyPageChange(pageText(["title: A", "priority: 2"], "Prose."), pageText(["title: A"], "Prose.")),
  ).toBe("metadata-only");
});

test("classifyPageChange: one body line is enough to make it a real edit", () => {
  expect(
    classifyPageChange(
      pageText(["title: A", "series: one"], "Old prose."),
      pageText(["title: A", "series: two"], "New prose."),
    ),
  ).toBe("edit");
});

test("classifyPageChange: a frontmatter key OUTSIDE the set is a real edit", () => {
  expect(
    classifyPageChange(pageText(["title: A"], "Prose."), pageText(["title: B"], "Prose.")),
  ).toBe("edit");
});

test("classifyPageChange: a metadata KEY line in the BODY is a real edit", () => {
  // mimir documents these very keys, so `prs: […]` occurs at column 0 inside body
  // code fences. The body is compared byte for byte, so the spelling is irrelevant.
  expect(
    classifyPageChange(
      pageText(["title: A"], "```yaml\nprs: [owner/repo#1]\n```"),
      pageText(["title: A"], "```yaml\nprs: [owner/repo#2]\n```"),
    ),
  ).toBe("edit");
});

test("classifyPageChange: an INDENTED metadata-looking line is a real edit", () => {
  // The key shape is anchored at column 0, `parseFrontmatter`'s own rule — a
  // nested child, a list item under a block key, a comment: none of them is a
  // line a mechanical writer owns, so none of them may be forgiven.
  expect(
    classifyPageChange(
      pageText(["meta:", "  series: one"], "Prose."),
      pageText(["meta:", "  series: two"], "Prose."),
    ),
  ).toBe("edit");
});

test("classifyPageChange: identical text is `identical`, whatever git says", () => {
  // `git status` reports a mode-only change (`chmod`) as modified with no content
  // difference at all. There is no edit to hide, so the page dates from history.
  const text = pageText(["title: A"], "Prose.");
  expect(classifyPageChange(text, text)).toBe("identical");
});

test("classifyPageChange: a page with no frontmatter is a real edit on any change", () => {
  expect(classifyPageChange("# A\n\nOld.\n", "# A\n\nNew.\n")).toBe("edit");
  // …including one that GAINS a fence, which is a page being restructured.
  expect(classifyPageChange("# A\n", pageText(["series: one"], "# A"))).toBe("edit");
});

test("the REAL writer behind a series join and a /plans flip produces a metadata-only change", () => {
  // `setFrontmatterScalar` is the one line-upsert both mechanical writers use, so
  // running it through the verdict pins the two ends of the rule together: a key
  // the writer is pointed at that is not in the set is still an edit.
  const before = pageText(["title: A", "plan_status: in-flight"], "Prose.");
  const changed = (key: string, value: string) => {
    const edit = setFrontmatterScalar(before, key, value);
    expect(edit.kind).toBe("changed");
    return (edit as { kind: "changed"; content: string }).content;
  };
  expect(classifyPageChange(before, changed("series", "wiki-provenance"))).toBe("metadata-only");
  expect(classifyPageChange(before, changed("plan_status", "shipped"))).toBe("metadata-only");
  expect(classifyPageChange(before, changed("title", "B"))).toBe("edit");
});

test("classifyPageChange: an unterminated fence is not a frontmatter block", () => {
  // `splitFrontmatter` needs a CLOSING `---`; without one there is no block, so a
  // `series:` line in what looks like frontmatter is body and the page is dirty.
  expect(classifyPageChange("---\nseries: one\n", "---\nseries: two\n")).toBe("edit");
});

/** Run git in the fixture repo, throwing on failure so a broken SETUP is never
 *  mistaken for a failing assertion. Identity + signing are pinned: a runner has
 *  no git identity and a developer may have `commit.gpgsign` on. */
async function fixtureGit(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(
    [
      "git",
      "-C",
      cwd,
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "user.name=fixture",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

/** A page: frontmatter block, then prose. `extra` lands in the body. The H1 is a
 *  separate argument so the `title:` case can change the KEY and nothing else —
 *  a body line moving with it would make the page dirty for the position rule
 *  instead, and the key-set assertion would pin nothing. */
function page(title: string, series: string, prose: string, extra = "", heading = title): string {
  return `---\ntitle: ${title}\nseries: ${series}\nplan_status: in-flight\n---\n\n# ${heading}\n\n${prose}\n${extra}`;
}

/**
 * ONE fixture wiki holding every shape the rule has to tell apart, nested in a
 * subdirectory of its repo so the wiki-relative ↔ repo-relative translation is
 * exercised for real.
 */
async function metadataOnlyFixture(): Promise<{ wiki: string; dir: string }> {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "git-dates-meta-"));
  const wiki = path.join(dir, "wiki");
  await mkdir(wiki, { recursive: true });
  const write = (rel: string, text: string) => writeFile(path.join(wiki, rel), text);

  await write("meta-only.md", page("Meta only", "alpha", "Unchanged prose."));
  await write("meta-and-prose.md", page("Meta and prose", "alpha", "Original prose."));
  await write("staged-prose.md", page("Staged prose", "alpha", "Original prose."));
  await write("deleted.md", page("Deleted", "alpha", "Doomed prose."));
  await write("title-only.md", page("Title only", "alpha", "Unchanged prose."));
  await write(
    "body-fence.md",
    page("Body fence", "alpha", "Documenting the keys:", "\n```yaml\nseries: quoted-alpha\n```\n"),
  );
  await write("clean.md", page("Clean", "alpha", "Never touched."));

  await fixtureGit(dir, "init", "-b", "main");
  await fixtureGit(dir, "add", "-A");
  await fixtureGit(dir, "commit", "-m", "seed");

  // (a) frontmatter metadata only — what a series join or a plan-status flip does.
  await write("meta-only.md", page("Meta only", "beta", "Unchanged prose."));
  // (b) the same metadata write plus one real prose line.
  await write("meta-and-prose.md", page("Meta and prose", "beta", "Rewritten prose."));
  // (c) a real prose edit that is STAGED, leaving the worktree clean against the
  //     index — which is what both wiki writers do before they commit.
  await write("staged-prose.md", page("Staged prose", "alpha", "Rewritten prose."));
  await fixtureGit(dir, "add", "--", "wiki/staged-prose.md");
  // (d) untracked.
  await write("untracked.md", page("Untracked", "alpha", "Brand new."));
  // (e) deleted from the worktree, still in HEAD.
  await rm(path.join(wiki, "deleted.md"));
  // (f) a frontmatter key OUTSIDE the metadata set.
  await write(
    "title-only.md",
    page("Title only, renamed", "alpha", "Unchanged prose.", "", "Title only"),
  );
  // (g) a metadata-shaped line edited inside a BODY code fence.
  await write(
    "body-fence.md",
    page("Body fence", "alpha", "Documenting the keys:", "\n```yaml\nseries: quoted-beta\n```\n"),
  );

  return { wiki, dir };
}

test("buildWikiGitDates: a metadata-only edit loses the mtime rule, every other dirty shape keeps it", async () => {
  const { rm } = await import("node:fs/promises");
  const { wiki, dir } = await metadataOnlyFixture();
  try {
    const dates = await buildWikiGitDates(wiki);
    expect(dates).not.toBeNull();
    const dirty = dates!.dirty;

    // (a) the whole point: a frontmatter-key rewrite is not an edit.
    expect(dirty.has("meta-only.md")).toBe(false);
    // …and it is still a tracked page with git dates, so it falls back to them
    // rather than dropping out of the ranking altogether.
    expect(dates!.created.get("meta-only.md")).toBeGreaterThan(0);

    // (b) one prose line is enough.
    expect(dirty.has("meta-and-prose.md")).toBe(true);
    // (c) a STAGED prose edit — empty to a bare `git diff`, which is why the
    //     classification diffs against HEAD.
    expect(dirty.has("staged-prose.md")).toBe(true);
    // (d) untracked: no HEAD diff at all, so it would pass the test vacuously.
    expect(dirty.has("untracked.md")).toBe(true);
    // (e) deleted: likewise, and it is the caller's `deletions` input.
    expect(dirty.has("deleted.md")).toBe(true);
    // (f) a frontmatter key outside the metadata set is an authored edit.
    expect(dirty.has("title-only.md")).toBe(true);
    // (g) the same key spelling, in the body.
    expect(dirty.has("body-fence.md")).toBe(true);

    // The control: an untouched page was never dirty to begin with.
    expect(dirty.has("clean.md")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Fix round 1: the shapes the diff parser could not name ───────────────────
//
// Every case below is a page `git diff HEAD` describes in a spelling the old
// parser keyed under something else (a trailing TAB, a C-quoted header, no
// header at all) or not at all (a binary-detected page), plus the two the
// position test read as metadata. The rule is a CONTENT comparison now, so each
// candidate gets a positive drop/keep answer and every unknown keeps the page.

/** A temp repo with a `wiki/` subdirectory, seeded and committed. `write` takes
 *  bytes as well as text, for the NUL-byte case. */
async function seededWiki(
  seed: Record<string, string | Uint8Array>,
): Promise<{ wiki: string; dir: string; write: (rel: string, body: string | Uint8Array) => Promise<void> }> {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "git-dates-fix1-"));
  const wiki = path.join(dir, "wiki");
  await mkdir(wiki, { recursive: true });
  const write = (rel: string, body: string | Uint8Array) =>
    writeFile(path.join(wiki, rel), body as Parameters<typeof writeFile>[1]);
  for (const [rel, body] of Object.entries(seed)) await write(rel, body);
  await fixtureGit(dir, "init", "-b", "main");
  await fixtureGit(dir, "add", "-A");
  await fixtureGit(dir, "commit", "-m", "seed");
  return { wiki, dir, write };
}

test("a page whose NAME carries a space keeps its mtime after a prose edit", async () => {
  // `git diff` appends a TAB to `+++ b/<path>` for a name with a space, so the
  // parser's verdict landed under `<path>\t` and the page read as "no verdict" —
  // which the old rule dropped. Measured on a clone of the real jarvis wiki
  // (1290 pages, 1180 of them space-named): a prose edit on every page left 110
  // dirty instead of 1290.
  const { rm } = await import("node:fs/promises");
  const { wiki, dir, write } = await seededWiki({
    "Mac mini headless setup.md": page("Spaced", "alpha", "Original prose."),
  });
  try {
    await write("Mac mini headless setup.md", page("Spaced", "alpha", "Rewritten prose."));
    const dates = await buildWikiGitDates(wiki);
    expect(dates!.dirty.has("Mac mini headless setup.md")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a page whose NAME carries a quote keeps its mtime after a prose edit", async () => {
  // git C-quotes the whole header for a `"`/`\`/control character — `+++
  // "b/q\"uote.md"` — whatever `core.quotePath` says, so the `b/` strip answered
  // null and the page again had no verdict.
  const { rm } = await import("node:fs/promises");
  const name = 'q"uote.md';
  const { wiki, dir, write } = await seededWiki({ [name]: page("Quoted", "alpha", "Original prose.") });
  try {
    await write(name, page("Quoted", "alpha", "Rewritten prose."));
    const dates = await buildWikiGitDates(wiki);
    expect(dates!.dirty.has(name)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a page carrying a NUL byte keeps its mtime after a prose edit", async () => {
  // A NUL makes git call the file binary: `Binary files … differ`, no `+++` line
  // at all. The old guard set `ok = false` on that line, but `file` was still
  // null, so the flush recorded nothing and the page fell into the same
  // no-verdict drop.
  const { rm } = await import("node:fs/promises");
  const enc = new TextEncoder();
  const withNul = (prose: string) => {
    const text = page("Binary", "alpha", prose);
    const bytes = enc.encode(text);
    const out = new Uint8Array(bytes.length + 1);
    out.set(bytes);
    out[bytes.length] = 0; // the byte that makes git say "binary"
    return out;
  };
  const { wiki, dir, write } = await seededWiki({ "binary.md": withNul("Original prose.") });
  try {
    await write("binary.md", withNul("Rewritten prose."));
    const dates = await buildWikiGitDates(wiki);
    expect(dates!.dirty.has("binary.md")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a repo configured with diff.noprefix still tells a prose edit from a metadata write", async () => {
  // `diff.noprefix` / `diff.mnemonicPrefix` / `diff.external` are ordinary user
  // config and they change the header the old parser read the path off — every
  // candidate unnamed, so EVERY tracked-modified page was dropped. Both
  // directions are asserted, because under the old rule the metadata case passed
  // for the wrong reason.
  const { rm } = await import("node:fs/promises");
  const { wiki, dir, write } = await seededWiki({
    "prose.md": page("Prose", "alpha", "Original prose."),
    "meta.md": page("Meta", "alpha", "Unchanged prose."),
  });
  try {
    await fixtureGit(dir, "config", "diff.noprefix", "true");
    await write("prose.md", page("Prose", "alpha", "Rewritten prose."));
    await write("meta.md", page("Meta", "beta", "Unchanged prose."));
    const dates = await buildWikiGitDates(wiki);
    expect(dates!.dirty.has("prose.md")).toBe(true);
    expect(dates!.dirty.has("meta.md")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting a metadata-shaped FIRST BODY line is an edit, not a metadata write", async () => {
  // For a pure deletion git anchors the hunk at the preceding KEPT line, so a
  // body line deleted immediately under the closing fence comes back as
  // `@@ -6 +5,0 @@` — `newStart == end`, which passed the old `newStart > end`
  // position test. The line reads `prs: [...]`, so the page was dropped.
  const { rm } = await import("node:fs/promises");
  const withPrsLine = `---\ntitle: Straddle\nseries: alpha\nplan_status: in-flight\n---\nprs: [owner/repo#1]\nprose here\n`;
  const withoutPrsLine = `---\ntitle: Straddle\nseries: alpha\nplan_status: in-flight\n---\nprose here\n`;
  const { wiki, dir, write } = await seededWiki({ "straddle.md": withPrsLine });
  try {
    await write("straddle.md", withoutPrsLine);
    const dates = await buildWikiGitDates(wiki);
    expect(dates!.dirty.has("straddle.md")).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a mode-only change is dropped: identical content is not an edit", async () => {
  // `chmod +x` is the one shape `git status` really does report as modified with
  // no content difference (a touch or an identical rewrite is compared by
  // content and reports clean). There is no edit to hide, so the page dates from
  // git history like a clean one. Same verdict before and after this round — it
  // is pinned as a decision, not as a fix.
  const { rm, chmod } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const { wiki, dir } = await seededWiki({ "mode.md": page("Mode", "alpha", "Unchanged prose.") });
  try {
    await chmod(path.join(wiki, "mode.md"), 0o755);
    const dates = await buildWikiGitDates(wiki);
    expect(dates!.dirty.has("mode.md")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a classification that exceeds its budget keeps EVERY dirty page", async () => {
  // The classification runs on the index-build critical path, so it is bounded —
  // and the degrade is the UNCLASSIFIED dirty set, never the empty one. Driven
  // with a `git` shim on PATH that sleeps on the subcommands a classification
  // spawns, so the budget is exceeded for real rather than faked.
  const { rm, writeFile, mkdir } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const { wiki, dir, write } = await seededWiki({
    "prose.md": page("Prose", "alpha", "Original prose."),
    "meta.md": page("Meta", "alpha", "Unchanged prose."),
  });
  const realGit = Bun.which("git");
  const shimDir = path.join(dir, "shim");
  const pathBefore = process.env.PATH;
  try {
    await write("prose.md", page("Prose", "alpha", "Rewritten prose."));
    await write("meta.md", page("Meta", "beta", "Unchanged prose."));
    await write("untracked.md", page("Untracked", "alpha", "Brand new."));
    await mkdir(shimDir, { recursive: true });
    const shim = path.join(shimDir, "git");
    await writeFile(
      shim,
      `#!/bin/sh\nfor a in "$@"; do\n  case "$a" in cat-file|diff) sleep 6 ;; esac\ndone\nexec ${realGit} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${shimDir}:${pathBefore ?? ""}`;
    __setClassifyBudgetForTest(50);
    const dates = await buildWikiGitDates(wiki);
    // Nothing is classified, so nothing is dropped — including the page whose
    // edit really was metadata-only.
    expect(dates!.dirty.has("prose.md")).toBe(true);
    expect(dates!.dirty.has("meta.md")).toBe(true);
    // …and the untracked page, which never reaches the classification at all,
    // must not be lost with it.
    expect(dates!.dirty.has("untracked.md")).toBe(true);
  } finally {
    __setClassifyBudgetForTest(null);
    process.env.PATH = pathBefore;
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);
