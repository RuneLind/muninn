import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { testTempDir } from "../../test/temp-dir.ts";
import { WIKI_LOCK_BASENAME } from "../lockfile.ts";
import { WIKI_READONLY_REASON } from "../readonly.ts";
import { joinWorkMap } from "./join.ts";
import { WORK_MAP_VERSION, type WorkMap } from "./schema.ts";
import { fileStateStore } from "./state.ts";
import { WORK_MAP_FILE, writeWorkMapFile } from "./write.ts";

async function wikiDir(): Promise<string> {
  const dir = await testTempDir(path.join(tmpdir(), "work-map-write-"));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "log.md"), "# Activity Log\n");
  return dir;
}

describe("writeWorkMapFile", () => {
  test("writes the map, commits only that path, and adds no log.md entry", async () => {
    const dir = await wikiDir();
    const commits: [string, string[], string][] = [];
    try {
      const out = await writeWorkMapFile({
        wikiDir: dir,
        content: '{"a":1}\n',
        commitMessage: "work-map: organize x",
        isReadonly: () => false,
        isReadonlyRoot: () => false,
        commit: async (d, paths, msg) => {
          commits.push([d, paths, msg]);
          return { committed: true };
        },
      });
      expect(out).toEqual({ outcome: "written", commit: { committed: true } });
      expect(await readFile(path.join(dir, WORK_MAP_FILE), "utf8")).toBe('{"a":1}\n');
      expect(await readFile(path.join(dir, "log.md"), "utf8")).toBe("# Activity Log\n");
      expect(commits).toEqual([[dir, [WORK_MAP_FILE], "work-map: organize x"]]);
      expect(existsSync(path.join(dir, WIKI_LOCK_BASENAME))).toBe(false);
      // Same bytes again: no write, no commit.
      const again = await writeWorkMapFile({ wikiDir: dir, content: '{"a":1}\n', commitMessage: "m", isReadonly: () => false, isReadonlyRoot: () => false, commit: null });
      expect(again).toEqual({ outcome: "noop" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("refuses on a readonly instance and on a readonly root before opening anything", async () => {
    let opened = 0;
    const base = { wikiDir: "/nowhere", content: "{}", commitMessage: "m", commit: null, readFile: async () => (opened++, null) };
    expect(await writeWorkMapFile({ ...base, isReadonly: () => true })).toEqual({ outcome: "forbidden", reason: WIKI_READONLY_REASON });
    const root = await writeWorkMapFile({ ...base, isReadonly: () => false, isReadonlyRoot: () => true });
    expect(root.outcome).toBe("forbidden");
    expect(opened).toBe(0);
  });

  test("another process holding .wiki-write.lock answers `locked` and writes nothing", async () => {
    const dir = await wikiDir();
    try {
      await writeFile(path.join(dir, WIKI_LOCK_BASENAME), JSON.stringify({ pid: process.pid, host: "elsewhere", op: "x", at: new Date().toISOString() }) + "\n");
      const out = await writeWorkMapFile({ wikiDir: dir, content: "{}", commitMessage: "m", isReadonly: () => false, isReadonlyRoot: () => false, commit: null, lockWaitMs: 50 });
      expect(out.outcome).toBe("locked");
      expect(existsSync(path.join(dir, WORK_MAP_FILE))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stop that fired while the write queued skips the write", async () => {
    const dir = await wikiDir();
    try {
      const out = await writeWorkMapFile({ wikiDir: dir, content: "{}", commitMessage: "m", isReadonly: () => false, isReadonlyRoot: () => false, commit: null, proceed: () => false });
      expect(out).toEqual({ outcome: "noop" });
      expect(existsSync(path.join(dir, WORK_MAP_FILE))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fileStateStore", () => {
  test("records attempts newest first, keeps the last success and at most 10", async () => {
    const dir = await testTempDir(path.join(tmpdir(), "work-map-state-"));
    try {
      const store = fileStateStore(dir);
      expect(await store.read("Mimir")).toBeNull();
      await store.record("Mimir", { at: 1, outcome: "ok" });
      for (let i = 2; i <= 12; i++) await store.record("Mimir", { at: i, outcome: "refused", error: `r${i}` });
      const s = await store.read("mimir");
      expect(s?.lastSuccessAt).toBe(1);
      expect(s?.attempts.length).toBe(10);
      expect(s?.attempts[0]).toEqual({ at: 12, outcome: "refused", error: "r12" });
      expect(existsSync(path.join(dir, "mimir.json"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("joinWorkMap", () => {
  test("joins by relPath; a page gone since the run drops out, its derivedFrom too", () => {
    const map: WorkMap = {
      version: WORK_MAP_VERSION,
      wiki: "w",
      runAtMs: 1,
      model: "m",
      coverage: { sessionsSinceMs: 0, sessionsAsOfMs: 0, touchWindowDays: 28, activePages: 3, threads: 0, logEntries: 0, digestChars: 0, warnings: [] },
      summary: "",
      needsYou: [{ title: "t", kind: "decision", why: "", action: "", pages: ["plans/gone.mdx", "Plans/A.mdx"], effort: "e" }],
      themes: [],
      efforts: [
        {
          id: "e",
          name: "E",
          aliases: [],
          oneLine: "",
          state: "active",
          pages: [
            { id: "plans/a.mdx", role: "plan" },
            { id: "plans/gone.mdx", role: "report", derivedFrom: "plans/a.mdx" },
            { id: "blogs/b.mdx", role: "explainer", derivedFrom: "plans/gone.mdx" },
          ],
          why: "",
          confidence: 1,
          next: "",
          related: [],
          daily: [],
        },
      ],
      loose: ["plans/gone.mdx", "notes/c.md"],
    };
    const pages = [{ relPath: "plans/a.mdx", title: "A" }, { relPath: "blogs/b.mdx", title: "B" }, { relPath: "notes/c.md", title: "C" }];
    const j = joinWorkMap(map, pages);
    expect(j.efforts[0]!.pages.map((p) => [p.id, p.derivedFrom ?? null, p.page.title])).toEqual([
      ["plans/a.mdx", null, "A"],
      ["blogs/b.mdx", null, "B"],
    ]);
    expect(j.needsYou[0]!.pages).toEqual(["plans/a.mdx"]);
    expect(j.loose.map((p) => p.relPath)).toEqual(["notes/c.md"]);
  });
});
