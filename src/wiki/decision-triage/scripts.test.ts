/** The two scripts' gates, each in its own process: every case here must stop
 *  before a model call, and the database they point at does not answer. */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { DECISION_TRIAGE_PROMPT_VERSION } from "./schema.ts";
import { git } from "./test-repo.ts";

const REPO = path.join(import.meta.dir, "..", "..", "..");
const RUN = path.join(REPO, "scripts", "decision-triage-run.ts");
const SCORE = path.join(REPO, "scripts", "decision-triage-score.ts");

/** `logFolder`: the machine has a log folder, so an `--out` refusal cannot hide the gate under test. */
function world({ logFolder = true } = {}) {
  const tmp = testTempDirSync(path.join(tmpdir(), "triage-scripts-"));
  mkdirSync(path.join(tmp, "no-bots"));
  if (logFolder) mkdirSync(path.join(tmp, ".muninn", "decision-triage"), { recursive: true });
  const w = path.join(tmp, "w");
  mkdirSync(w);
  const themes = path.join(tmp, "themes");
  mkdirSync(themes);
  writeFileSync(path.join(themes, ".wiki-reader.json"), JSON.stringify({ workMap: { kind: "themes" } }));
  return { tmp, w, themes, out: path.join(tmp, "out.jsonl") };
}

async function script(file: string, args: string[], tmp: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "--no-env-file", file, ...args], {
    cwd: tmp,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: tmp,
      MUNINN_BOTS_DIR: path.join(tmp, "no-bots"),
      DATABASE_URL: "postgresql://x@127.0.0.1:1/x_test",
      DECISION_TRIAGE_REPO_ROOTS: tmp,
      WORK_MAP_WIKIS: "w,themes",
      WIKI_ANSWER_WIKIS: "w,themes",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

describe("decision-triage-run.ts refuses before anything runs", () => {
  test("a wiki outside WORK_MAP_WIKIS", async () => {
    const { tmp, w, out } = world();
    const res = await script(RUN, ["--wiki", "other", "--out", out, "--root", `other=${w}`], tmp);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("other: not in WORK_MAP_WIKIS");
    expect(existsSync(out)).toBe(false);
  });

  test("a themes wiki", async () => {
    const { tmp, themes, out } = world();
    const res = await script(RUN, ["--wiki", "themes", "--out", out, "--root", `themes=${themes}`], tmp);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("themes: a themes map");
    expect(existsSync(out)).toBe(false);
  });

  test("a wiki with no answer cards here", async () => {
    const { tmp, w, out } = world();
    const res = await script(RUN, ["--wiki", "w", "--out", out, "--root", `w=${w}`], tmp, { WIKI_ANSWER_WIKIS: "themes" });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("w: not in WIKI_ANSWER_WIKIS");
  });

  test("a missing root blames the root, not --out", async () => {
    const { tmp, out } = world();
    const res = await script(RUN, ["--wiki", "w", "--out", out, "--root", `w=${path.join(tmp, "gone")}`], tmp);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("its root does not exist");
    expect(res.stderr).not.toContain("--out");
  });

  test("a readonly root", async () => {
    const { tmp, w, out } = world();
    const res = await script(RUN, ["--wiki", "w", "--out", out, "--root", `w=${w}`], tmp, { WIKI_READONLY_ROOTS: w });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("readonly root");
    expect(existsSync(out)).toBe(false);
  });

  test("--out inside the log folder, whether or not the folder exists yet", async () => {
    const { tmp, w } = world({ logFolder: false });
    const log = path.join(tmp, ".muninn", "decision-triage");
    const absent = await script(RUN, ["--wiki", "w", "--out", path.join(log, "w.jsonl"), "--root", `w=${w}`], tmp);
    expect(absent.code).toBe(2);
    expect(absent.stderr).toContain("--out");
    expect(existsSync(log)).toBe(false);
    mkdirSync(log, { recursive: true });
    const there = await script(RUN, ["--wiki", "w", "--out", path.join(log, "w.jsonl"), "--root", `w=${w}`], tmp);
    expect(there.code).toBe(2);
    expect(there.stderr).toContain("--out");
  });
});

test("no log folder yet: an --out elsewhere is no reason to refuse, and an empty wiki refuses in the file", async () => {
  const { tmp, w, out } = world({ logFolder: false });
  const res = await script(RUN, ["--wiki", "w", "--out", out, "--root", `w=${w}`], tmp);
  expect(res.code).toBe(1);
  const run = JSON.parse(readFileSync(out, "utf8").trim()) as { outcome: string; reason: string };
  expect(run).toMatchObject({ outcome: "refused", reason: "the wiki has no pages" });
  expect(existsSync(path.join(tmp, ".muninn", "decision-triage"))).toBe(false);
});

describe("decision-triage-score.ts refuses a readonly root before any model call", () => {
  const baseline = (tmp: string) => {
    const file = path.join(tmp, "baseline.json");
    writeFileSync(file, JSON.stringify({ items: [{ wiki: "w", relPath: "p.mdx", id: "O1", answeredAt: "2026-10-01T10:00:00Z", commit: "abc", hashMatches: true, replayable: true }] }));
    return file;
  };

  test("--replay", async () => {
    const { tmp, w } = world();
    const res = await script(SCORE, ["--replay", "--dry-run", "--baseline", baseline(tmp), "--root", `w=${w}`, "--log-dir", path.join(tmp, "l")], tmp, { WIKI_READONLY_ROOTS: w });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("REFUSED");
    expect(res.stderr).toContain("readonly root");
  });

  test("--replay names a baseline wiki the slice leaves out", async () => {
    const { tmp, w } = world();
    const res = await script(SCORE, ["--replay", "--dry-run", "--baseline", baseline(tmp), "--root", `w=${w}`, "--log-dir", path.join(tmp, "l")], tmp, { WORK_MAP_WIKIS: "themes" });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("w: not in WORK_MAP_WIKIS");
  });

  test("--since", async () => {
    const { tmp, w } = world();
    const res = await script(SCORE, ["--since", "2026-11-06", "--dry-run", "--root", `w=${w}`, "--log-dir", path.join(tmp, "l")], tmp, { WIKI_READONLY_ROOTS: w });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("REFUSED");
    expect(res.stderr).toContain("readonly root");
  });
});

describe("a bad flag value is one usage line, exit 2", () => {
  const usage = (res: { code: number; stderr: string }) => {
    expect(res.code).toBe(2);
    expect(res.stderr.trim().split("\n")).toHaveLength(1);
    expect(res.stderr).toContain("usage");
    expect(res.stderr).not.toMatch(/^\s+at /m);
  };

  test.each([
    ["--root with no path", SCORE, ["--root", "mimir"], "--root takes"],
    ["--root with an empty path", SCORE, ["--root", "mimir="], "--root takes"],
    ["--since nonsense", SCORE, ["--since", "nonsense"], "--since takes"],
    ["--since empty", SCORE, ["--since", ""], "--since takes"],
    ["--since a day the calendar lacks", SCORE, ["--since", "2026-02-30"], "--since takes"],
    ["--since with a time", SCORE, ["--since", "2026-02-20T10:00:00Z"], "--since takes"],
    ["--until nonsense", SCORE, ["--labels", "--until", "nonsense"], "--until takes"],
    ["an unknown flag", SCORE, ["--replya"], "--replya"],
    ["the run script's --root", RUN, ["--wiki", "w", "--out", "/nowhere/out.jsonl", "--root", "w"], "--root takes"],
  ] as const)("%s", async (_name, file, args, says) => {
    const { tmp } = world();
    const res = await script(file, [...args], tmp);
    usage(res);
    expect(res.stderr).toContain(says);
  });

  test("a hand file that is not {read, wrong} is a usage line", async () => {
    const { tmp, w } = world();
    const hand = path.join(tmp, "hand.json");
    writeFileSync(hand, "{}");
    git(w, "init", "-q");
    usage(await script(SCORE, ["--since", "2026-11-06", "--hand", hand, "--root", `w=${w}`, "--log-dir", path.join(tmp, "l")], tmp));
    usage(await script(SCORE, ["--since", "2026-11-06", "--hand", path.join(tmp, "gone.json"), "--root", `w=${w}`, "--log-dir", path.join(tmp, "l")], tmp));
  });
});

test("--since on a wiki root that is no repo refuses with the reason, before the database", async () => {
  const { tmp, w } = world();
  const res = await script(SCORE, ["--since", "2026-11-06", "--root", `w=${w}`, "--log-dir", path.join(tmp, "l")], tmp, { WORK_MAP_WIKIS: "w" });
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("REFUSED");
  expect(res.stderr).toContain("not a git repository");
});

describe("--since holds the one decision point, before it reads an answer", () => {
  const DAY = 86_400_000;
  /** A wiki whose log started `days` ago, with these record lines already on file. */
  function logged(days: number, records: object[], over: object = {}) {
    const { tmp, w } = world();
    const logDir = path.join(tmp, "l");
    mkdirSync(logDir);
    const line = { type: "run", runId: "r", at: Date.now() - days * DAY - 1000, wiki: "w", model: "m", promptVersion: DECISION_TRIAGE_PROMPT_VERSION, usage: { calls: 1 }, repoRoots: null, repos: [], cards: 0, floor: null, outcome: "ok", ...over };
    writeFileSync(path.join(logDir, "w.jsonl"), `${JSON.stringify(line)}\n`);
    const file = path.join(logDir, "part2-scorings.jsonl");
    if (records.length > 0) writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(""));
    const args = ["--since", "2026-11-06", "--root", `w=${w}`, "--log-dir", logDir];
    return { tmp, args, file, before: records.length > 0 ? readFileSync(file, "utf8") : null };
  }
  const scoring = (day: number, result: string, input: object | null = null) => ({ type: "scoring", at: 1, day, promptVersion: DECISION_TRIAGE_PROMPT_VERSION, result, hand: null, input });
  const env = { WORK_MAP_WIKIS: "w" };

  test("day 16 after a day 14 miss is refused, and the record does not move", async () => {
    const { tmp, args, file, before } = logged(16, [scoring(14, "miss")]);
    const res = await script(SCORE, args, tmp, env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("REFUSED (day 16)");
    expect(res.stderr).toContain("no scoring between");
    expect(res.stdout).toBe("");
    expect(readFileSync(file, "utf8")).toBe(before!);
  });

  test("day 20 after a pass is refused", async () => {
    const { tmp, args } = logged(20, [scoring(14, "pass")]);
    const res = await script(SCORE, args, tmp, env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("REFUSED (day 20)");
    expect(res.stderr).toContain("passed");
  });

  test("a second scoring past day 28 is refused", async () => {
    const { tmp, args } = logged(31, [scoring(14, "miss"), scoring(30, "miss")]);
    const res = await script(SCORE, args, tmp, env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("final");
  });

  test("--final on day 3 is refused and writes no record", async () => {
    const { tmp, args, file } = logged(3, []);
    const res = await script(SCORE, [...args, "--final"], tmp, env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("REFUSED (day 3)");
    expect(res.stderr).toContain("--final");
    expect(existsSync(file)).toBe(false);
  });

  test("a record line that does not parse refuses", async () => {
    const { tmp, args, file } = logged(20, [scoring(14, "miss")]);
    writeFileSync(file, "{not json\n");
    const res = await script(SCORE, args, tmp, env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("broken");
  });

  test("a --since later than the window is a usage line", async () => {
    const { tmp, args } = logged(3, [], { at: Date.parse("2026-11-07T04:00:00Z") });
    const res = await script(SCORE, ["--since", "2026-11-09", ...args.slice(2)], tmp, env);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("usage error: --since 2026-11-09 is later than");
  });

  test("--dry-run on a refused day writes nothing and is not refused at the gate", async () => {
    const { tmp, args, file, before } = logged(16, [scoring(14, "miss")]);
    const res = await script(SCORE, [...args, "--dry-run"], tmp, env);
    // The root is no repo here: getting that far shows the gate did not stop it.
    expect(res.stderr).toContain("not a git repository");
    expect(readFileSync(file, "utf8")).toBe(before!);
  });

  test("--hand on a recorded pass adds the sample to its figures, once", async () => {
    const report = { verdict: { caught: 9, of: 10, flagged: 9, cards: 20 }, sharePct: 45, shareRaw: 45, textAlone: {}, rule: { caught: 0, of: 10, flagged: 0, cards: 20, sharePct: 0, shareRaw: 0 }, perWiki: {}, late: {}, lateTextAlone: {}, notScored: 0, byKind: {}, catchesBy: { ASK_OWNER: 9, ASK_OTHER: 0 } };
    const input = { report, floor: { labelled: 20, added: 10, addedPages: 2, met: true }, day: 14, shares: { askOwnerMedian: 0.2, askAnyMedian: 0.4, nights: 10 }, handRead: null, handWrong: null, settledThenAnswered: 0, context: { refused: 0, failed: 0, absent: 0, wikiNights: 10, olderLines: 0 } };
    const { tmp, args, file } = logged(20, [scoring(14, "pass", input)]);
    const hand = path.join(tmp, "hand.json");
    writeFileSync(hand, JSON.stringify({ read: 5, wrong: 1 }));
    const res = await script(SCORE, [...args, "--hand", hand], tmp, env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("MISS (day 14)");
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    const again = await script(SCORE, [...args, "--hand", hand], tmp, env);
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("REFUSED (day 20)");
  });
});
