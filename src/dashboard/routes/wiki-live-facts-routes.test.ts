/**
 * `GET /api/wiki/page`'s live chips (living facts PR 3b): the chip spans in
 * `html` and the `facts` payload, only on a wiki with a readable
 * `.wiki-facts.json`. Synthetic owners, repos and numbers only.
 */

import { test, expect, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { configure, reset, type LogRecord } from "@logtape/logtape";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
import * as liveFactsModule from "../../wiki/live-facts.ts";
import { __setChipPassFaultForTest, resetWikiFactsCache } from "../../wiki/live-facts.ts";
import type { LiveFactsPayload } from "../../wiki/core/live-facts-chip.ts";
import { testTempDir } from "../../test/temp-dir.ts";
import { spawnSync } from "node:child_process";

/** A one-commit git work tree at `root`, as the mentions route needs. */
function gitInit(root: string): void {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) {
    const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  }
}

const entry = (title: string, state: string, extra: Record<string, unknown> = {}) => ({
  title, state, isDraft: false, mergedAt: state === "MERGED" ? "2026-01-05T10:00:00Z" : null, inProd: null, firstProd: null, draftTag: null, checkedAt: "2026-01-20T08:00:00.000Z", ...extra,
});
const FACTS = {
  version: 1,
  prs: {
    "acme/acme-api#101": entry("DEMO-11 first", "MERGED", { inProd: true }),
    "acme/acme-api#102": entry("DEMO-11 second", "OPEN"),
  },
  keys: { "DEMO-11": { prs: ["acme/acme-api#101", "acme/acme-api#102"] } },
};
const CONFIG = { language: "no", prGrammar: { owner: "acme", aliases: { api: "acme-api" } }, trackers: [{ id: "jira", projects: ["DEMO"] }] };
const PAGE = ["---", "title: Plan", "---", "", "D1 in [[plans/plan]]: api #101 for DEMO-11, and acme/acme-api#999; DEMO-20 has no facts.", "", "<DecisionLog>", "", "- **D1** — Ship.", "", "</DecisionLog>", ""].join("\n");

describe("GET /api/wiki/page — live chips", () => {
  let withFacts = "";
  let without = "";
  let app: Hono;
  let prevExtra: string | undefined;

  beforeAll(async () => {
    withFacts = await testTempDir(path.join(tmpdir(), "wiki-chips-"));
    without = await testTempDir(path.join(tmpdir(), "wiki-nochips-"));
    for (const root of [withFacts, without]) {
      await mkdir(path.join(root, "plans"), { recursive: true });
      await writeFile(path.join(root, "plans/plan.md"), PAGE, "utf8");
      await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    }
    await writeFile(path.join(withFacts, ".wiki-facts.json"), JSON.stringify(FACTS), "utf8");
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `chips=${withFacts},nochips=${without}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    resetWikiFactsCache();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    resetWikiFactsCache();
    await rm(withFacts, { recursive: true, force: true });
    await rm(without, { recursive: true, force: true });
  });

  const get = async (wiki: string) => {
    const res = await app.request(`/api/wiki/page?wiki=${wiki}&relPath=plans%2Fplan.md`);
    expect(res.status).toBe(200);
    return (await res.json()) as { html: string; facts?: LiveFactsPayload };
  };

  test("chips after the mentions that have entries, and their facts", async () => {
    const data = await get("chips");
    expect([...data.html.matchAll(/data-live-fact="([^"]+)"/g)].map((m) => m[1])).toEqual(["acme/acme-api#101", "DEMO-11"]);
    expect(Object.keys(data.facts!.prs).sort()).toEqual(["acme/acme-api#101", "acme/acme-api#102"]);
    expect(Object.keys(data.facts!.keys)).toEqual(["DEMO-11"]);
  });

  test("a throw in the chip pass still opens the page: 200, no chip, no facts field", async () => {
    __setChipPassFaultForTest(new Error("injected chip-pass fault"));
    try {
      const data = await get("chips");
      expect(data.html).not.toContain("fact-chip");
      expect(data.html).toContain("DEMO-11");
      expect(data.facts).toBeUndefined();
    } finally {
      __setChipPassFaultForTest(null);
    }
  });

  test("a throw after the payload was collected: the plain page, and the collected facts are dropped", async () => {
    __setChipPassFaultForTest(new Error("injected fault after collect"), "collected");
    try {
      const data = await get("chips");
      expect(data.html).not.toContain("fact-chip");
      expect(data.html).toContain("DEMO-11");
      expect(data.facts).toBeUndefined();
    } finally {
      __setChipPassFaultForTest(null);
    }
  });

  test("a wiki with no facts file: no chip, no facts field", async () => {
    const data = await get("nochips");
    expect(data.html).not.toContain("fact-chip");
    expect(data.facts).toBeUndefined();
  });
});

// KEY MARKS beside the chips (Discuss v2 PR 6): DEMO-20 has no facts entry,
// so it is the page's one mark. Each failure drops only its own pass, and
// the warning names the pass that failed.
describe("GET /api/wiki/page — key marks beside live chips", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;
  const records: LogRecord[] = [];

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-marks-"));
    await mkdir(path.join(root, "plans"), { recursive: true });
    await writeFile(path.join(root, "plans/plan.md"), PAGE, "utf8");
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    await writeFile(path.join(root, ".wiki-facts.json"), JSON.stringify(FACTS), "utf8");
    // The mentions route reads with git: marks only on a git work tree (fix round 1 J3).
    gitInit(root);
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `marks=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    resetWikiFactsCache();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
    await configure({
      reset: true,
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [
        { category: ["muninn"], sinks: ["capture"], lowestLevel: "warning" },
        { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
      ],
    });
  });

  afterAll(async () => {
    await reset();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    resetWikiFactsCache();
    await rm(root, { recursive: true, force: true });
  });

  const get = async () => {
    records.length = 0;
    const res = await app.request(`/api/wiki/page?wiki=marks&relPath=plans%2Fplan.md`);
    expect(res.status).toBe(200);
    return (await res.json()) as { html: string; facts?: LiveFactsPayload };
  };
  const chips = (html: string) => [...html.matchAll(/data-live-fact="([^"]+)"/g)].map((m) => m[1]);
  const marks = (html: string) => [...html.matchAll(/data-wiki-key="([^"]+)"/g)].map((m) => m[1]);
  const warnings = () => records.map((r) => String(r.rawMessage));

  test("both passes: the chips and the marks (a chipped key is marked too, fix round 1 J1)", async () => {
    const data = await get();
    expect(chips(data.html)).toEqual(["acme/acme-api#101", "DEMO-11"]);
    expect(marks(data.html)).toEqual(["DEMO-11", "DEMO-20"]);
    expect(warnings()).toEqual([]);
  });

  test("a throw in the marks pass drops the marks alone: chips and facts kept, the marks' own warning", async () => {
    const spy = spyOn(liveFactsModule, "planKeyMarks").mockImplementation(() => {
      throw new Error("injected marks fault");
    });
    try {
      const data = await get();
      expect(chips(data.html)).toEqual(["acme/acme-api#101", "DEMO-11"]);
      expect(Object.keys(data.facts?.keys ?? {})).toEqual(["DEMO-11"]);
      expect(marks(data.html)).toEqual([]);
      expect(data.html).toContain("DEMO-20 has no facts");
      expect(warnings()).toEqual(["key marks failed on {relPath}; page rendered without them: {error}"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a throw in the chip pass keeps the marks: no chip, the mark, the chips' own warning", async () => {
    __setChipPassFaultForTest(new Error("injected chip-pass fault"));
    try {
      const data = await get();
      expect(chips(data.html)).toEqual([]);
      expect(marks(data.html)).toContain("DEMO-20");
      expect(warnings()).toEqual(["live chips failed on {relPath}; page rendered without chips: {error}"]);
    } finally {
      __setChipPassFaultForTest(null);
    }
  });
});

// WHERE THE MENTIONS ROUTE ANSWERS (fix round 1 J3): the key marks and the
// reader's `mentions` flag only for a registered wiki (the route 400s a
// `WIKI_DIR` override's empty name) whose root is a git work tree (the route
// 500s elsewhere). Both share one gate.
describe("GET /api/wiki/page — marks and the mentions flag only where the mentions route answers", () => {
  let git = "";
  let plain = "";
  let app: Hono;
  let prevExtra: string | undefined;
  let prevDir: string | undefined;

  beforeAll(async () => {
    git = await testTempDir(path.join(tmpdir(), "wiki-marks-git-"));
    plain = await testTempDir(path.join(tmpdir(), "wiki-marks-plain-"));
    for (const root of [git, plain]) {
      await mkdir(path.join(root, "plans"), { recursive: true });
      await writeFile(path.join(root, "plans/plan.md"), PAGE, "utf8");
      await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify(CONFIG), "utf8");
    }
    gitInit(git);
    prevExtra = process.env.WIKI_EXTRA;
    prevDir = process.env.WIKI_DIR;
    process.env.WIKI_EXTRA = `gitwiki=${git},plainwiki=${plain}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    resetWikiFactsCache();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
  });

  afterAll(async () => {
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    if (prevDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = prevDir;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    resetWikiFactsCache();
    await rm(git, { recursive: true, force: true });
    await rm(plain, { recursive: true, force: true });
  });

  const get = async (query: string) => {
    const res = await app.request(`/api/wiki/page?${query}relPath=plans%2Fplan.md`);
    expect(res.status).toBe(200);
    return (await res.json()) as { html: string; reader: { mentions?: boolean } };
  };
  const marks = (html: string) => [...html.matchAll(/data-wiki-key="([^"]+)"/g)].map((m) => m[1]);
  const text = (html: string) => html.replace(/<[^>]+>/g, "");

  test("a registered git wiki: its keys marked, the flag on", async () => {
    const data = await get("wiki=gitwiki&");
    expect(marks(data.html)).toEqual(["DEMO-11", "DEMO-20"]);
    expect(data.reader.mentions).toBe(true);
  });

  test("a registered wiki that is no git work tree: no mark, the flag off", async () => {
    const data = await get("wiki=plainwiki&");
    expect(text(data.html)).toContain("DEMO-20 has no facts");
    expect(marks(data.html)).toEqual([]);
    expect(data.reader.mentions).toBe(false);
  });

  test("the WIKI_DIR override (no registry name), even on a git work tree: no mark, the flag off", async () => {
    process.env.WIKI_DIR = git;
    __resetWikiCacheForTest();
    try {
      const data = await get("");
      expect(text(data.html)).toContain("DEMO-20 has no facts");
      expect(marks(data.html)).toEqual([]);
      expect(data.reader.mentions).toBe(false);
    } finally {
      delete process.env.WIKI_DIR;
      __resetWikiCacheForTest();
    }
  });
});

// Fix round 2 batch 3 (finding 5): a page past the `keys` scan's budget has an
// unmarked middle, and the render says so once, with the counts; before, the
// skipped lines (then the page's end) went unmarked with no signal.
describe("GET /api/wiki/page — a page past the key scan's budget is logged once per render", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;
  const records: LogRecord[] = [];
  // ~1.2 M characters of one-kind lines: past KEY_SCAN_PAGE_MAX (1,000,000).
  const BIG = ["# Big", "", ...Array.from({ length: 6_000 }, (_, i) => `- MEL-${i + 1} ${"y".repeat(190)}`)].join("\n");

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-marks-budget-"));
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes/big.md"), BIG, "utf8");
    await writeFile(path.join(root, "notes/small.md"), "# Small\n\nMEL-1 and MEL-2.\n", "utf8");
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }] }), "utf8");
    gitInit(root);
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `budget=${root}`;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    app = new Hono();
    app.onError((err, c) => c.json({ error: String(err) }, 500));
    registerWikiRoutes(app, {} as Parameters<typeof registerWikiRoutes>[1]);
    await configure({
      reset: true,
      sinks: { capture: (r: LogRecord) => records.push(r) },
      loggers: [
        { category: ["muninn"], sinks: ["capture"], lowestLevel: "info" },
        { category: ["logtape", "meta"], sinks: [], lowestLevel: "error" },
      ],
    });
  });

  afterAll(async () => {
    await reset();
    if (prevExtra === undefined) delete process.env.WIKI_EXTRA;
    else process.env.WIKI_EXTRA = prevExtra;
    __resetWikiRegistryForTest();
    __resetWikiCacheForTest();
    await rm(root, { recursive: true, force: true });
  });

  const open = async (rel: string) => {
    records.length = 0;
    const res = await app.request(`/api/wiki/page?wiki=budget&relPath=${encodeURIComponent(rel)}`);
    expect(res.status).toBe(200);
    const html = ((await res.json()) as { html: string }).html;
    return { marks: [...html.matchAll(/data-wiki-key="([^"]+)"/g)].map((m) => m[1]), logged: records.filter((r) => String(r.rawMessage).startsWith("key marks:")) };
  };

  test("its first and last lines are marked, its middle is not, and one warning names the skipped lines", async () => {
    const { marks, logged } = await open("notes/big.md");
    expect([marks.includes("MEL-1"), marks.includes("MEL-6000"), marks.includes("MEL-3000")]).toEqual([true, true, false]);
    expect(logged.length).toBe(1);
    const p = logged[0]!.properties as { wiki: string; relPath: string; skippedLines: number; skippedChars: number; fromLine: number; toLine: number };
    expect(logged[0]!.level).toBe("warning");
    expect([p.wiki, p.relPath]).toEqual(["budget", "notes/big.md"]);
    expect(p.skippedLines).toBe(p.toLine - p.fromLine + 1);
    expect(p.skippedLines).toBeGreaterThan(0);
    expect(p.skippedChars).toBeGreaterThan(0);
  });

  test("a page that fits logs nothing", async () => {
    const { marks, logged } = await open("notes/small.md");
    expect(marks).toEqual(["MEL-1", "MEL-2"]);
    expect(logged).toEqual([]);
  });
});
