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
import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { realGit, type GitResult, type GitRun } from "./decision-triage/git.ts";
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

// ── Class check (Discuss v2 PR 6, sweep A): the whole-key history's time budget ──
//
// One row per cell of the state space: the listing run, each patch run and the
// names run (ok / capped / timed out / failed, and a patch run's two cuts), by
// how many changed commits were found (0, 1..limit, > limit). The runner is a
// fake that ENFORCES `timeoutMs`: a run whose given timeout is below what it
// needs times out after that timeout, with the output it had streamed. Its
// clock is the system clock under `setSystemTime`, so the deadline the code
// reads moves as the runs take time. Not reachable, so no row: a capped
// listing (no line bound is set, and 300 `%H` lines are at most 19,500 bytes
// against realGit's 4,000,000-byte bound).

const TIMEOUT = 30_000;
const RESERVE = 3_000;
const T0 = 1_800_000_000_000;

type Kind = "list" | "patch" | "names";
/** One scripted run: what it returns when it is given time enough, how long it takes, and what it had written when a timeout kills it. */
interface Step {
  needs?: number;
  res?: Partial<GitResult>;
  streamed?: string;
}
interface Call {
  kind: Kind;
  at: number;
  timeoutMs: number;
  stdin?: string;
}

function timedRunner(script: Record<Kind, Step[]>): { git: GitRun; calls: Call[] } {
  const calls: Call[] = [];
  const next: Record<Kind, number> = { list: 0, patch: 0, names: 0 };
  const git: GitRun = async (_cwd, args, opts = {}) => {
    const kind: Kind = args.includes("--name-only") ? "names" : args.includes("-p") ? "patch" : "list";
    const step = script[kind][next[kind]++];
    if (!step) throw new Error(`no ${kind} run ${next[kind]} was scripted`);
    const at = Date.now();
    const timeoutMs = opts.timeoutMs ?? 15_000;
    calls.push({ kind, at: at - T0, timeoutMs, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const needs = step.needs ?? 10;
    if (timeoutMs < needs) {
      setSystemTime(new Date(at + timeoutMs));
      return { ok: false, stdout: step.streamed ?? "", timedOut: true, stderr: `git log timed out after ${timeoutMs} ms` };
    }
    setSystemTime(new Date(at + needs));
    return { ok: true, stdout: "", exitCode: 0, ...step.res };
  };
  return { git, calls };
}

const HB = (c: string) => c.repeat(40);
/** A commit's `-p -U0` record: `change` adds a line holding KEY-7 (the count moves); otherwise it edits one (the count stays). */
const patchOf = (hash: string, change = true) =>
  `\x1e${hash}\n\ndiff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1 +1${change ? ",2" : ""} @@\n${change ? "" : "-KEY-7 old\n"}+KEY-7 new\n${change ? "+KEY-7 more\n" : ""}`;
const cutPatch = (hash: string) => patchOf(hash).slice(0, 50);
const recOf = (hash: string) => `\x1e${hash}\x1f2026-01-02T03:04:05+01:00\x1fAnn\x1fsubject ${hash.slice(0, 1)}\0\na.md\0`;
const listOf = (...hs: string[]) => ({ res: { stdout: hs.map((h) => `${h}\n`).join("") } });
const ok = (stdout: string, needs = 10): Step => ({ needs, res: { stdout } });
const capped = (stdout: string, needs = 10): Step => ({ needs, res: { stdout, capped: true } });
const failed = (stderr: string): Step => ({ res: { ok: false, stdout: "", exitCode: 128, stderr } });
const slow = (streamed: string, needs = 10 * TIMEOUT): Step => ({ needs, streamed });

interface Row {
  cell: string;
  list: Step;
  patch?: Step[];
  names?: Step[];
  limit?: number;
  /** `{ error }`, or the commits (hash, and whether the names run described it), partial and uncounted. */
  want: { error: string } | { commits: [string, "described" | "bare"][]; partial: boolean; uncounted?: string[] };
  /** The runs made, in order, and checks on the timeouts they were given. */
  runs: Kind[];
  check?: (calls: Call[]) => void;
}

const A = HB("a");
const B = HB("b");
const C = HB("c");
const D = HB("d");

const ROWS: Row[] = [
  // The listing run.
  { cell: "L1 listing ok, no candidate", list: listOf(), want: { commits: [], partial: false }, runs: ["list"] },
  {
    cell: "L2 listing ok, 300 candidates (the scan bound): partial",
    list: listOf(...Array.from({ length: 300 }, (_, i) => i.toString(16).padStart(40, "0"))),
    patch: [ok(patchOf("0".repeat(40)))],
    names: [ok(recOf("0".repeat(40)))],
    want: { commits: [["0".repeat(40), "described"]], partial: true },
    runs: ["list", "patch", "names"],
  },
  {
    cell: "L3 listing timed out: error, and it was given the scan's share of the deadline, not 30 s (M11)",
    list: slow(`${A}\n`, TIMEOUT - RESERVE + 1),
    want: { error: "git log timed out" },
    runs: ["list"],
    check: (calls) => expect(calls[0]!.timeoutMs).toBe(TIMEOUT - RESERVE),
  },
  { cell: "L4 listing failed: error", list: failed("fatal: bad revision"), want: { error: "git log failed: fatal: bad revision" }, runs: ["list"] },

  // Each patch run, by the changed commits found.
  {
    cell: "P1 patch ok, 0 changed: no names run",
    list: listOf(A),
    patch: [ok(patchOf(A, false))],
    want: { commits: [], partial: false },
    runs: ["list", "patch"],
  },
  {
    cell: "P1 patch ok, 1..limit changed",
    list: listOf(A, B),
    patch: [ok(patchOf(A) + patchOf(B, false))],
    names: [ok(recOf(A))],
    want: { commits: [[A, "described"]], partial: false },
    runs: ["list", "patch", "names"],
  },
  {
    cell: "P2 capped mid-commit: the next run starts at the cut commit",
    list: listOf(A, B, C),
    patch: [capped(patchOf(A) + cutPatch(B)), ok(patchOf(B) + patchOf(C))],
    names: [ok(recOf(A) + recOf(B) + recOf(C))],
    want: { commits: [[A, "described"], [B, "described"], [C, "described"]], partial: false },
    runs: ["list", "patch", "patch", "names"],
    check: (calls) => expect(calls.filter((c) => c.kind === "patch").map((c) => c.stdin)).toEqual([`${A}\n${B}\n${C}\n`, `${B}\n${C}\n`]),
  },
  {
    cell: "P3 capped on its first commit: uncounted, the next run starts after it",
    list: listOf(A, B),
    patch: [capped(cutPatch(A)), ok(patchOf(B))],
    names: [ok(recOf(B))],
    want: { commits: [[B, "described"]], partial: true, uncounted: [A] },
    runs: ["list", "patch", "patch", "names"],
  },
  {
    cell: "P4 timed out before any commit was read whole: error",
    list: listOf(A),
    patch: [slow(cutPatch(A))],
    want: { error: "git log timed out" },
    runs: ["list", "patch"],
  },
  {
    cell: "P4 timed out after only an uncounted commit: error (nothing was counted)",
    list: listOf(A, B),
    patch: [capped(cutPatch(A)), slow(cutPatch(B))],
    want: { error: "git log timed out" },
    runs: ["list", "patch", "patch"],
  },
  {
    cell: "P5 timed out after a commit was read, 0 changed: partial, no names run",
    list: listOf(A, B),
    patch: [slow(patchOf(A, false) + cutPatch(B))],
    want: { commits: [], partial: true },
    runs: ["list", "patch"],
  },
  {
    cell: "P6 the first run timed out after a changed commit: the names run still has the reserve",
    list: listOf(A, B),
    patch: [slow(patchOf(A) + cutPatch(B))],
    names: [ok(recOf(A), 100)],
    want: { commits: [[A, "described"]], partial: true },
    runs: ["list", "patch", "names"],
    check: (calls) => {
      expect(calls[1]!.timeoutMs).toBe(TIMEOUT - RESERVE - 10);
      expect(calls[2]!.timeoutMs).toBe(RESERVE);
    },
  },
  {
    cell: "P6 a later run timed out after a changed commit: what was counted is kept",
    list: listOf(A, B, C),
    patch: [capped(patchOf(A) + cutPatch(B), 1_000), slow(cutPatch(B))],
    names: [ok(recOf(A), 100)],
    want: { commits: [[A, "described"]], partial: true },
    runs: ["list", "patch", "patch", "names"],
    check: (calls) => {
      // The patch runs get what is left of the scan's share; the names run the reserve.
      expect(calls.filter((c) => c.kind === "patch").map((c) => c.timeoutMs)).toEqual([TIMEOUT - RESERVE - 10, TIMEOUT - RESERVE - 1_010]);
      expect(calls[3]!.timeoutMs).toBe(RESERVE);
    },
  },
  {
    cell: "P7 failed: error",
    list: listOf(A),
    patch: [failed("fatal: bad object")],
    want: { error: "git log failed: fatal: bad object" },
    runs: ["list", "patch"],
  },
  {
    cell: "P7 failed after a changed commit: error (a git failure is not a bound)",
    list: listOf(A, B),
    patch: [capped(patchOf(A) + cutPatch(B)), failed("fatal: bad object")],
    want: { error: "git log failed: fatal: bad object" },
    runs: ["list", "patch", "patch"],
  },
  {
    cell: "P8 capped, and the run read the list's last commit whole: headers misaligned, stop (M15)",
    list: listOf(A, B),
    patch: [capped(patchOf(A) + patchOf(B) + cutPatch(C))],
    names: [ok(recOf(A) + recOf(B))],
    want: { commits: [[A, "described"], [B, "described"]], partial: true },
    runs: ["list", "patch", "names"],
  },
  {
    cell: "P8 capped, and the run read a commit not on the list: stop (M15)",
    list: listOf(A, B),
    patch: [capped(patchOf(C) + cutPatch(A)), ok(patchOf(B))],
    names: [ok(recOf(C))],
    want: { commits: [[C, "described"]], partial: true },
    runs: ["list", "patch", "names"],
  },
  {
    cell: "P9 no scan time left after a capped run: no further run is spawned, partial",
    list: listOf(A, B, C),
    patch: [capped(patchOf(A) + cutPatch(B), TIMEOUT - RESERVE - 10)],
    names: [ok(recOf(A), 100)],
    want: { commits: [[A, "described"]], partial: true },
    runs: ["list", "patch", "names"],
  },

  // The count against `limit`.
  {
    cell: "C limit exactly: not partial",
    limit: 2,
    list: listOf(A, B),
    patch: [ok(patchOf(A) + patchOf(B))],
    names: [ok(recOf(A) + recOf(B))],
    want: { commits: [[A, "described"], [B, "described"]], partial: false },
    runs: ["list", "patch", "names"],
  },
  {
    cell: "C over limit: the scan stops at once, the first `limit` are kept, partial (M14)",
    limit: 2,
    list: listOf(A, B, C, D),
    patch: [capped(patchOf(A) + patchOf(B) + patchOf(C) + cutPatch(D))],
    names: [ok(recOf(A) + recOf(B))],
    want: { commits: [[A, "described"], [B, "described"]], partial: true },
    runs: ["list", "patch", "names"],
    check: (calls) => expect(calls.find((c) => c.kind === "names")!.stdin).toBe(`${A}\n${B}\n`),
  },

  // The names run.
  {
    cell: "N1 names ok, given what is left of the whole deadline, not 30 s (M13)",
    list: { needs: 15_000, ...listOf(A) },
    patch: [ok(patchOf(A), 5_000)],
    names: [ok(recOf(A))],
    want: { commits: [[A, "described"]], partial: false },
    runs: ["list", "patch", "names"],
    check: (calls) => expect(calls.map((c) => c.timeoutMs)).toEqual([TIMEOUT - RESERVE, TIMEOUT - RESERVE - 15_000, TIMEOUT - 20_000]),
  },
  {
    cell: "N2 names capped: the commits it described keep their record, the cut one its bare hash, partial",
    list: listOf(A, B),
    patch: [ok(patchOf(A) + patchOf(B))],
    names: [capped(recOf(A) + recOf(B))],
    want: { commits: [[A, "described"], [B, "bare"]], partial: true },
    runs: ["list", "patch", "names"],
  },
  {
    cell: "N3 names timed out: the commits it had not finished keep their bare hash, partial",
    list: listOf(A, B),
    patch: [ok(patchOf(A) + patchOf(B))],
    names: [slow(recOf(A) + recOf(B).slice(0, 30))],
    want: { commits: [[A, "described"], [B, "bare"]], partial: true },
    runs: ["list", "patch", "names"],
  },
  {
    cell: "N4 names failed: error",
    list: listOf(A),
    patch: [ok(patchOf(A))],
    names: [failed("fatal: bad object")],
    want: { error: "git log failed: fatal: bad object" },
    runs: ["list", "patch", "names"],
  },
];

describe("historyFor with wholeKey: the time budget, one row per cell (class check)", () => {
  afterAll(() => setSystemTime());
  for (const row of ROWS) {
    test(row.cell, async () => {
      setSystemTime(new Date(T0));
      const { git, calls } = timedRunner({ list: [row.list], patch: row.patch ?? [], names: row.names ?? [] });
      const res = await historyFor("/nonexistent", "KEY-7", { wholeKey: true, git, ...(row.limit ? { limit: row.limit } : {}) });
      setSystemTime();
      expect(calls.map((c) => c.kind)).toEqual(row.runs);
      if ("error" in row.want) expect(res).toEqual({ ok: false, error: row.want.error });
      else {
        if (!res.ok) throw new Error(res.error);
        expect(res.commits.map((c) => [c.hash, c.subject ? "described" : "bare"])).toEqual(row.want.commits);
        for (const c of res.commits.filter((c) => !c.subject)) expect(c).toEqual({ hash: c.hash, date: "", author: "", subject: "", files: [], fileCount: 0 });
        expect({ partial: res.partial, uncounted: res.uncounted }).toEqual({ partial: row.want.partial, uncounted: row.want.uncounted });
      }
      row.check?.(calls);
    });
  }
});

describe("historyFor with wholeKey: a timeout after progress, through realGit", () => {
  // realGit enforces every timeout it is given. The second patch run is the
  // one that runs out of time: realGit is given 1 ms and the system clock moves
  // to the whole deadline, as a run killed there leaves it. The names run gets
  // the code's own timeout (the defect: 1 ms, so every counted commit was lost).
  test("a big patch cuts run 1 after a changed commit, run 2 times out: the counted commit comes back described, partial", async () => {
    const { root, sha } = await repoWithBigPatch(1, 4);
    let patchRuns = 0;
    const namesTimeouts: number[] = [];
    const git: GitRun = (cwd, args, opts = {}) => {
      if (args.includes("-p") && ++patchRuns === 2) {
        setSystemTime(new Date(T0 + TIMEOUT));
        return realGit(cwd, args, { ...opts, timeoutMs: 1 });
      }
      if (args.includes("--name-only")) namesTimeouts.push(opts.timeoutMs ?? -1);
      return realGit(cwd, args, opts);
    };
    setSystemTime(new Date(T0));
    try {
      const res = await historyFor(root, "KEY-7", { wholeKey: true, git });
      if (!res.ok) throw new Error(res.error);
      expect(res.commits.map((c) => [c.hash, c.subject])).toEqual([[sha[0]!, "note 0"]]);
      expect(res.partial).toBe(true);
      expect(namesTimeouts).toEqual([RESERVE]);
    } finally {
      setSystemTime();
    }
  });
});

test("the constants the rows assume", async () => {
  const tracked = await import("./tracked-files.ts");
  expect([(tracked as Record<string, unknown>).HISTORY_TIMEOUT_MS, (tracked as Record<string, unknown>).HISTORY_NAMES_RESERVE_MS]).toEqual([TIMEOUT, RESERVE]);
});
