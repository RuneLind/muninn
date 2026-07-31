/**
 * Parser semantics for the git creation-date walk. The `git log` output shapes below
 * are literal — captured from real `git log --reverse --name-status -M
 * --diff-merges=first-parent --format=%at` runs in mimir — so the rename/copy rules
 * are pinned against what git actually emits, not against a paraphrase of it.
 *
 * `buildGitCreatedMap` itself spawns git and is covered by the real-repo smoke at
 * the bottom, which skips cleanly outside a git checkout.
 */

import { test, expect } from "bun:test";
import { parseGitCreatedLog, buildGitCreatedMap } from "./git-created.ts";

/** `%at` is seconds; the map is ms. */
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const ms = (iso: string) => Math.floor(Date.parse(iso) / 1000) * 1000;

test("first appearance of a path wins", () => {
  const out = parseGitCreatedLog(
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
  const out = parseGitCreatedLog(
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
  const out = parseGitCreatedLog(
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
  const out = parseGitCreatedLog(
    [`${at("2026-05-04T10:00:00Z")}`, "R100\tdocs/old.md\tplans/new.md"].join("\n"),
  );
  expect(out.get("plans/new.md")).toBe(ms("2026-05-04T10:00:00Z"));
});

test("a copy leaves the source's date intact and gives the copy the source's date", () => {
  const out = parseGitCreatedLog(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "A\torig.md",
      `${at("2026-07-08T10:00:00Z")}`,
      "C100\torig.md\tdupe.md",
    ].join("\n"),
  );
  expect(out.get("orig.md")).toBe(ms("2026-04-02T10:00:00Z"));
  expect(out.get("dupe.md")).toBe(ms("2026-04-02T10:00:00Z"));
});

test("paths containing spaces and non-ASCII survive parsing", () => {
  // Real mimir/melosys-kode-wiki filenames. The status regex captures the rest of
  // the line wholesale, so only a TAB is special.
  const out = parseGitCreatedLog(
    [
      `${at("2026-04-02T10:00:00Z")}`,
      "A\tplans/Mac-mini headless setup.md",
      "A\tprojects/melosys/trygdeavgift-beregning-æøå.md",
    ].join("\n"),
  );
  expect(out.get("plans/Mac-mini headless setup.md")).toBe(ms("2026-04-02T10:00:00Z"));
  expect(out.get("projects/melosys/trygdeavgift-beregning-æøå.md")).toBe(
    ms("2026-04-02T10:00:00Z"),
  );
});

test("a deletion does not resurrect or shadow a later re-add", () => {
  // First appearance wins, so a file deleted and re-added keeps its ORIGINAL date.
  // That is the intended reading: the page existed then, and the history says so.
  const out = parseGitCreatedLog(
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
  const out = parseGitCreatedLog(["A\torphan.md", `${at("2026-04-02T10:00:00Z")}`, "A\tok.md"].join("\n"));
  expect(out.has("orphan.md")).toBe(false);
  expect(out.get("ok.md")).toBe(ms("2026-04-02T10:00:00Z"));
});

test("empty output is an empty map, not a throw", () => {
  expect(parseGitCreatedLog("").size).toBe(0);
  expect(parseGitCreatedLog("\n\n").size).toBe(0);
});

test("buildGitCreatedMap: degrades to null outside a git repo", async () => {
  // `/` is never a git repo (and if a machine made it one, this asserts the wrong
  // thing rather than failing dirty — hence the explicit null check only).
  expect(await buildGitCreatedMap("/")).toBeNull();
});

test("buildGitCreatedMap: a symlinked root still resolves its subtree pathspec", async () => {
  // `git rev-parse --show-toplevel` reports a symlink-RESOLVED path, so subtracting an
  // unresolved root escapes upward into a `..` relative path and degrades the whole
  // walk to null. On macOS every `/tmp` path hits this — including the e2e fixtures'
  // `WIKI_EXTRA` wikis and any mkdtemp root — so it is a shipping path, not a test-only
  // quirk. Uses this repo via its own symlinked temp view to keep the assertion real.
  const { mkdtemp, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const dir = await mkdtemp(path.join(tmpdir(), "git-created-link-"));
  const link = path.join(dir, "wiki");
  try {
    await symlink(import.meta.dir, link);
    const map = await buildGitCreatedMap(link);
    expect(map).not.toBeNull();
    expect(map!.get("store.ts")).toBeGreaterThan(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildGitCreatedMap: real repo — this file's own creation date is tracked", async () => {
  // Smoke over the muninn checkout itself, scoped to src/wiki (exercising the
  // toplevel resolution + subtree pathspec + prefix stripping that a
  // parser-only test cannot reach). Skips if the repo has no history.
  const map = await buildGitCreatedMap(import.meta.dir);
  if (!map || map.size === 0) return;
  const known = map.get("store.ts");
  expect(known).toBeGreaterThan(0);
  // Keys are wiki-relative (prefix stripped), never repo-relative.
  for (const key of map.keys()) expect(key.startsWith("src/wiki/")).toBe(false);
});
