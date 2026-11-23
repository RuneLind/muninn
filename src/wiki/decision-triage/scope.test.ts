import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDirSync } from "../../test/temp-dir.ts";
import { TRIAGE_PASS_BOUND_MS } from "../work-map/loop.ts";
import { settleTriageRun } from "./loop-deps.ts";
import { outInsideLog } from "./script-roots.ts";
import { triageScope } from "./scope.ts";

function fixture() {
  const tmp = testTempDirSync(path.join(tmpdir(), "triage-scope-"));
  const dir = (name: string, reader?: string) => {
    const root = path.join(tmp, name);
    mkdirSync(root);
    if (reader !== undefined) writeFileSync(path.join(root, ".wiki-reader.json"), reader);
    return root;
  };
  return { tmp, dir };
}

describe("triageScope: registered, answer cards, a work map, not readonly", () => {
  test("each way out, with its reason and whether it is a fault", async () => {
    const { tmp, dir } = fixture();
    const roots: Record<string, string> = {
      plain: dir("plain"),
      declared: dir("declared", JSON.stringify({ workMap: { kind: "work" } })),
      noanswers: dir("noanswers"),
      themes: dir("themes", JSON.stringify({ workMap: { kind: "themes" } })),
      broken: dir("broken", "{ nope"),
      ro: dir("ro"),
      gone: path.join(tmp, "gone"),
    };
    const unreadable = dir("unreadable");
    mkdirSync(path.join(unreadable, ".wiki-reader.json"));
    roots.unreadable = unreadable;
    const scope = await triageScope({
      workMapWikis: ["plain", "Declared", "noanswers", "themes", "broken", "ro", "gone", "unreadable", "unknown", "PLAIN"],
      answerWikis: new Set(["plain", "declared", "themes", "broken", "ro", "gone", "unreadable", "unknown"]),
      entryOf: (name) => (roots[name.toLowerCase()] ? { name, root: roots[name.toLowerCase()]!, source: "extra" } : undefined),
      isReadonlyRoot: (root) => root === roots.ro,
    });
    expect(scope.covered.map((e) => e.name)).toEqual(["plain", "Declared"]);
    const byName = Object.fromEntries(scope.dropped.map((d) => [d.wiki, [d.fault, d.reason]]));
    expect(byName.noanswers).toEqual([false, "not in WIKI_ANSWER_WIKIS"]);
    expect(byName.themes).toEqual([false, "a themes map"]);
    expect(byName.broken).toEqual([true, ".wiki-reader.json is not valid JSON"]);
    expect(byName.ro).toEqual([true, "a readonly root (WIKI_READONLY_ROOTS)"]);
    expect(byName.gone).toEqual([true, "its root does not exist"]);
    expect(byName.unreadable).toEqual([true, ".wiki-reader.json exists but could not be read"]);
    expect(byName.unknown![0]).toBe(true);
    expect(byName.unknown![1]).toContain("no root");
  });
});

test("the whole pass's bound is 2 h", () => {
  expect(TRIAGE_PASS_BOUND_MS).toBe(2 * 60 * 60_000);
});

describe("settleTriageRun", () => {
  test("a throw records failed; a throw after a stop records nothing and reads as aborted", async () => {
    const failed: string[] = [];
    const record = async (e: string) => void failed.push(e);
    const live = new AbortController();
    const res = await settleTriageRun(async () => { throw new Error("disk full"); }, live.signal, record);
    expect(res).toEqual({ outcome: "failed" });
    expect(failed).toEqual(["disk full"]);
    const stopped = new AbortController();
    stopped.abort();
    expect(await settleTriageRun(async () => { throw new Error("closing"); }, stopped.signal, record)).toEqual({ outcome: "aborted" });
    expect(failed).toEqual(["disk full"]);
  });

  test("a throw after verdicts landed reads as what the record says it was", async () => {
    const res = await settleTriageRun(async () => { throw new Error("disk full"); }, new AbortController().signal, async () => "partial");
    expect(res).toEqual({ outcome: "partial" });
  });
});

describe("outInsideLog", () => {
  test("an absent log folder holds nothing, but a path that would create it still counts", () => {
    const { tmp } = fixture();
    const log = path.join(tmp, "absent", "log");
    expect(outInsideLog(path.join(tmp, "elsewhere.jsonl"), log)).toBe(false);
    expect(outInsideLog(path.join(log, "w.jsonl"), log)).toBe(true);
    expect(outInsideLog(`${log}-sibling.jsonl`, log)).toBe(false);
  });
  test("an existing log folder goes by identity", () => {
    const { tmp } = fixture();
    const log = path.join(tmp, "log");
    mkdirSync(log);
    expect(outInsideLog(path.join(log, "sub", "w.jsonl"), log)).toBe(true);
    expect(outInsideLog(path.join(tmp, "x.jsonl"), log)).toBe(false);
    symlinkSync(log, path.join(tmp, "alias"));
    expect(outInsideLog(path.join(tmp, "alias", "w.jsonl"), log)).toBe(true);
  });
});
