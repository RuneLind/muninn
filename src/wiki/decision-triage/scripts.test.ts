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
});

test("--since refuses, citing D19, before the database", async () => {
  const { tmp, w } = world();
  const res = await script(SCORE, ["--since", "2026-11-06", "--root", `w=${w}`, "--log-dir", path.join(tmp, "l")], tmp);
  expect(res.code).toBe(2);
  expect(res.stderr).toContain("REFUSED: part (2) is off");
  expect(res.stderr).toContain("D19");
});
