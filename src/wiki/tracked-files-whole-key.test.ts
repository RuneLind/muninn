/**
 * The whole-key rule of `tracked-files.ts` (fix round 1 of Discuss v2 PR 6):
 * which neighbours continue a key, and `wholeKey` refused with a regex.
 * `mentions.test.ts` drives it through `buildMentions` on a real repo.
 *
 * Fix round 2: the counter and the marker agree on an astral letter or digit
 * before a key; a whole-key history whose candidates include a patch past
 * realGit's 4 MB bound still counts every other candidate (real temp repos);
 * a run that times out after progress ends as `partial` (a fake runner).
 */
import { describe, expect, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realGit, type GitRun } from "./decision-triage/git.ts";
import { scanKeyKinds } from "./key-kinds.ts";
import { bodyKeyMentions, chipInsertions, jiraTrackers, markedMentions, planKeyMarks } from "./live-facts.ts";
import { parseTrackersConfig } from "./trackers/index.ts";
import { grepTracked, historyFor, wholeKeyCount } from "./tracked-files.ts";
import { testTempDir } from "../test/temp-dir.ts";

/** A key's neighbours on both sides: astral and BMP letters and digits, `_`, an emoji, punctuation. */
const NEIGHBOURS = ["𝐀MEL-12", "MEL-12𝐀", "𝟏MEL-12", "MEL-12𝟏", "MEL-12_x", "xMEL-12", "åMEL-12", "MEL-12", "😀MEL-12", "(MEL-12)"];

describe("wholeKeyCount", () => {
  test("a Unicode letter or digit on either side continues the key; `_`, `-` and punctuation do not", () => {
    expect(wholeKeyCount("MEL-1 MEL-1,MEL-1.", "MEL-1")).toBe(3);
    expect(wholeKeyCount("MEL-1_x MEL-1-x (MEL-1)", "MEL-1")).toBe(3);
    for (const t of ["MEL-10", "XMEL-1", "MEL-1å", "æMEL-1", "MEL-1٣", "٣MEL-1"]) expect(wholeKeyCount(t, "MEL-1")).toBe(0);
    expect(wholeKeyCount("a.b(c)", "a.b(c)")).toBe(1);
  });

  test("an astral letter or digit before or after the key continues it; an astral symbol does not", () => {
    // U+1D400 MATHEMATICAL BOLD CAPITAL A, U+1D7CF MATHEMATICAL BOLD DIGIT ONE, U+1F600 an emoji.
    expect([wholeKeyCount("𝐀MEL-12", "MEL-12"), wholeKeyCount("𝟏MEL-12", "MEL-12"), wholeKeyCount("MEL-12𝐀", "MEL-12"), wholeKeyCount("MEL-12𝟏", "MEL-12")]).toEqual([0, 0, 0, 0]);
    expect([wholeKeyCount("😀MEL-12", "MEL-12"), wholeKeyCount("𝐀MEL-12 MEL-12", "MEL-12")]).toEqual([1, 1]);
  });

  test("the counter, the keys scan and the reader's marks agree on each neighbour", () => {
    const kinds = [{ name: "case", pattern: "MEL-\\d+" }];
    const rows = NEIGHBOURS.map((t) => {
      const line = `See ${t} here.`;
      return {
        t,
        count: wholeKeyCount(line, "MEL-12"),
        scan: scanKeyKinds(line, kinds).matches.filter((m) => m.key === "MEL-12").length,
        marks: planKeyMarks(line, line, { grammar: null, trackers: [], kinds, relPath: "x.md" }).marks.filter((m) => m.key === "MEL-12").length,
      };
    });
    for (const r of rows) expect({ t: r.t, scan: r.scan, marks: r.marks }).toEqual({ t: r.t, scan: r.count, marks: r.count });
    expect(rows.filter((r) => r.count === 1).map((r) => r.t)).toEqual(["MEL-12_x", "MEL-12", "😀MEL-12", "(MEL-12)"]);
  });

  // Fix round 2 batch 3 (finding 4): tracker keys (`bodyKeyMentions`, the
  // tracker marks and the chips' mentions) took an ASCII boundary, so
  // `åMEL-12` and `𝐀MEL-12` were marked and `MEL-12_x` was not.
  // A chip never sits where the peek counts nothing; it skips a key a literal
  // `_` follows (`MEL-12_x`), where it would let the reader read that `_` as italics.
  test("tracker keys: the counter, bodyKeyMentions and the reader's marks agree on each neighbour; a chip only where they count", () => {
    const trackers = jiraTrackers(parseTrackersConfig([{ id: "jira", projects: ["MEL"] }], () => {}));
    const rows = [...NEIGHBOURS, "MEL-12-3", "_MEL-12"].map((t) => {
      const line = `See ${t} here.`;
      return {
        t,
        count: wholeKeyCount(line, "MEL-12"),
        body: bodyKeyMentions(line, ["MEL"]).filter((m) => m.key === "MEL-12").length,
        marks: planKeyMarks(line, line, { grammar: null, trackers, kinds: [], relPath: "x.md" }).marks.filter((m) => m.key === "MEL-12").length,
        chips: chipInsertions(line, markedMentions(line, line, "x.md", null, trackers, () => undefined), () => true).flatMap((c) => c.ids).filter((c) => c.id === "MEL-12").length,
      };
    });
    for (const r of rows) expect({ t: r.t, body: r.body, marks: r.marks, chips: r.chips }).toEqual({ t: r.t, body: r.count, marks: r.count, chips: r.t.startsWith("MEL-12_") ? 0 : r.count });
    expect(rows.filter((r) => r.count === 1).map((r) => r.t)).toEqual(["MEL-12_x", "MEL-12", "😀MEL-12", "(MEL-12)", "MEL-12-3", "_MEL-12"]);
  });

  test("grepTracked refuses wholeKey with a regex", async () => {
    expect(await grepTracked(import.meta.dir, "MEL-1", { regex: true, wholeKey: true })).toEqual({ ok: false, error: "wholeKey takes a fixed string, not a regex" });
  });
});

/** `commits` commits naming KEY-7, oldest first; the one at `bigAt` (0 = newest) adds a file past realGit's 4 MB bound that names it. `sha` is newest first, as the log lists it. */
async function repoWithBigPatch(bigAt: number, commits: number): Promise<{ root: string; sha: string[] }> {
  const root = path.join(await realpath(await testTempDir(path.join(tmpdir(), "muninn-whole-big-"))), "wiki");
  await mkdir(root, { recursive: true });
  const git = async (...args: string[]) => {
    const res = await realGit(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args]);
    if (!res.ok) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
  };
  await git("init", "-q", "-b", "main");
  const sha: string[] = [];
  for (let n = commits - 1; n >= 0; n--) {
    if (n === bigAt) {
      // ~4.6 MB of added lines in the -U0 patch.
      const filler = Array.from({ length: 90_000 }, (_, i) => `filler line ${i} of the big appendix, no key on it`).join("\n");
      await writeFile(path.join(root, "big.md"), `# Big\n\nKEY-7 is in the big appendix.\n${filler}\n`);
    } else await writeFile(path.join(root, `note-${n}.md`), `Note ${n} names KEY-7.\n`);
    await git("add", "-A");
    await git("commit", "-q", "-m", n === bigAt ? "big appendix" : `note ${n}`);
    sha.unshift(await git("rev-parse", "HEAD"));
  }
  return { root, sha };
}

describe("historyFor with wholeKey: a patch past realGit's bound", () => {
  test("the newest commit's patch alone passes 4 MB: the older commits are still counted, it is reported uncounted", async () => {
    const { root, sha } = await repoWithBigPatch(0, 3);
    const res = await historyFor(root, "KEY-7", { wholeKey: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.commits.map((c) => c.hash)).toEqual([sha[1]!, sha[2]!]);
    expect(res.uncounted).toEqual([sha[0]!]);
    expect(res.partial).toBe(true);
  });

  test("a big patch in the middle: the commits after it are counted, in log order", async () => {
    const { root, sha } = await repoWithBigPatch(1, 4);
    const res = await historyFor(root, "KEY-7", { wholeKey: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.commits.map((c) => c.hash)).toEqual([sha[0]!, sha[2]!, sha[3]!]);
    expect(res.commits.map((c) => c.files)).toEqual([["note-0.md"], ["note-2.md"], ["note-3.md"]]);
    expect(res.uncounted).toEqual([sha[1]!]);
    expect(res.partial).toBe(true);
  });

  test("no patch past the bound: every commit, not partial, nothing uncounted", async () => {
    const { root, sha } = await repoWithBigPatch(-1, 3);
    const res = await historyFor(root, "KEY-7", { wholeKey: true });
    if (!res.ok) throw new Error(res.error);
    expect(res.commits.map((c) => c.hash)).toEqual(sha);
    expect([res.partial, res.uncounted]).toEqual([false, undefined]);
  });

  const H = (c: string) => c.repeat(40);
  const patch = (hash: string) => `\x1e${hash}\n\ndiff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -0,0 +1 @@\n+KEY-7\n`;
  const rec = (hash: string, subject: string) => `\x1e${hash}\x1f2026-01-02T03:04:05+01:00\x1fAnn\x1f${subject}\0\na.md\0`;

  test("a patch run that times out after a commit was counted ends the scan as partial, with what was counted", async () => {
    const runs: string[] = [];
    const fake: GitRun = async (_cwd, args, opts) => {
      if (args.includes("--format=%H")) return { ok: true, stdout: `${H("a")}\n${H("b")}\n${H("c")}\n`, exitCode: 0 };
      if (args.includes("-p")) {
        runs.push(opts?.stdin ?? "");
        // Run 1: a whole, cut inside b. Run 2 (from b): times out with nothing whole.
        if (runs.length === 1) return { ok: true, stdout: patch(H("a")) + patch(H("b")).slice(0, 20), capped: true };
        return { ok: false, stdout: patch(H("b")).slice(0, 20), timedOut: true, stderr: "git log timed out after 1 ms" };
      }
      return { ok: true, stdout: rec(H("a"), "a names it"), exitCode: 0 };
    };
    const res = await historyFor("/nonexistent", "KEY-7", { wholeKey: true, git: fake });
    expect(runs).toEqual([`${H("a")}\n${H("b")}\n${H("c")}\n`, `${H("b")}\n${H("c")}\n`]);
    if (!res.ok) throw new Error(res.error);
    expect(res.commits.map((c) => c.hash)).toEqual([H("a")]);
    expect([res.partial, res.uncounted]).toEqual([true, undefined]);
  });

  test("a patch run that times out before any commit was counted is an error", async () => {
    const fake: GitRun = async (_cwd, args) => {
      if (args.includes("--format=%H")) return { ok: true, stdout: `${H("a")}\n`, exitCode: 0 };
      return { ok: false, stdout: "", timedOut: true, stderr: "git log timed out after 1 ms" };
    };
    expect(await historyFor("/nonexistent", "KEY-7", { wholeKey: true, git: fake })).toEqual({ ok: false, error: "git log timed out" });
  });
});
