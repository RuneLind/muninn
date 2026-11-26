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
// unmarked middle, and the page open says so once, with the counts; before,
// the skipped lines (then the page's end) went unmarked with no signal.
// Class-check sweep B: the lines are the FILE's, past every transform between
// the file and the scanned body; the counts say what they name; one warning
// per page open whatever the renders; over-long lines alone are info.
describe("GET /api/wiki/page — a page past the key scan's budget is logged once per page open, in the file's lines", () => {
  let root = "";
  let app: Hono;
  let prevExtra: string | undefined;
  const records: LogRecord[] = [];
  /** ~1.2 M characters of `MEL-<n>` lines past KEY_SCAN_PAGE_MAX (1,000,000),
   *  each key's number its own line in the file. */
  function bigPage(o: { head: string[]; eol?: string; sentinelInside?: boolean; longLines?: number; extra?: string }): string {
    const lines = [...o.head, ""];
    if (o.extra) lines.push(o.extra, "");
    for (let i = 0; i < (o.longLines ?? 0); i++) lines.push(`long ${"z".repeat(4_100)}`);
    for (let i = 0; i < 6_000; i++) {
      if (o.sentinelInside && (i === 2_990 || i === 3_010)) lines.push(i === 2_990 ? "<!-- factcheck:start -->" : "<!-- factcheck:end -->");
      lines.push(`- MEL-${lines.length + 1} ${"y".repeat(190)}`);
    }
    return lines.join(o.eol ?? "\n") + (o.eol ?? "\n");
  }
  const FM = ["---", "title: Big", "a: 1", "b: 2", "---"];
  /** One page per transform between the file and `readerBody`'s string. */
  const ROWS: Record<string, string> = {
    "no frontmatter: the H1 stays (the title is the file stem)": bigPage({ head: ["# Big"] }),
    "5 frontmatter lines and the matching H1": bigPage({ head: [...FM, "# Big"] }),
    "frontmatter and a non-matching H1 (kept)": bigPage({ head: [...FM, "# Other"] }),
    "empty frontmatter, no H1": bigPage({ head: ["---", "---"] }),
    "frontmatter, blank lines, then the matching H1": bigPage({ head: [...FM, "", "", "# Big"] }),
    "frontmatter, the H1 and a live fact-check block inside the middle": bigPage({ head: [...FM, "# Big"], sentinelInside: true }),
    "a live fact-check block before the keys": bigPage({ head: [...FM, "# Big", "", "<!-- factcheck:start -->", "Checked.", "<!-- factcheck:end -->"] }),
    "CRLF line ends with frontmatter and the H1": bigPage({ head: [...FM, "# Big"], eol: "\r\n" }),
    "a setext H1 (never stripped)": bigPage({ head: [...FM, "Big", "==="] }),
    "over-long lines above the middle": bigPage({ head: [...FM, "# Big"], longLines: 3 }),
  };
  const slug = (name: string) => name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

  beforeAll(async () => {
    root = await testTempDir(path.join(tmpdir(), "wiki-marks-budget-"));
    await mkdir(path.join(root, "notes"), { recursive: true });
    for (const [name, page] of Object.entries(ROWS)) await writeFile(path.join(root, `notes/${slug(name)}.md`), page, "utf8");
    await writeFile(path.join(root, "notes/chip.md"), bigPage({ head: [...FM, "# Big"], extra: "DEMO-11 has facts." }), "utf8");
    await writeFile(path.join(root, "notes/small.md"), "# Small\n\nMEL-1 and MEL-2.\n", "utf8");
    await writeFile(path.join(root, "notes/long.md"), `# Long\n\nMEL-1 here.\n\nMEL-2 ${"z".repeat(4_100)}\n\nMEL-3 ${"z".repeat(4_100)}\n`, "utf8");
    await writeFile(path.join(root, ".wiki-reader.json"), JSON.stringify({ keys: [{ name: "case", pattern: "MEL-\\d+" }], trackers: [{ id: "jira", projects: ["DEMO"] }] }), "utf8");
    await writeFile(path.join(root, ".wiki-facts.json"), JSON.stringify({ version: 1, prs: {}, keys: { "DEMO-11": { prs: [] } } }), "utf8");
    gitInit(root);
    prevExtra = process.env.WIKI_EXTRA;
    process.env.WIKI_EXTRA = `budget=${root}`;
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
    resetWikiFactsCache();
    await rm(root, { recursive: true, force: true });
  });

  const open = async (rel: string) => {
    records.length = 0;
    const res = await app.request(`/api/wiki/page?wiki=budget&relPath=${encodeURIComponent(rel)}`);
    expect(res.status).toBe(200);
    const html = ((await res.json()) as { html: string }).html;
    return { html, marks: [...html.matchAll(/data-wiki-key="([^"]+)"/g)].map((m) => m[1]!), logged: records.filter((r) => String(r.rawMessage).startsWith("key marks:")) };
  };
  type Props = { wiki: string; relPath: string; fromLine: number; toLine: number; middleLines: number; middleChars: number; longLines: number; longChars: number };

  for (const [name, page] of Object.entries(ROWS))
    test(`${name}: the warning names the file lines of the first and last unmarked keys`, async () => {
      const { marks, logged } = await open(`notes/${slug(name)}.md`);
      const keys = [...page.matchAll(/MEL-(\d+)/g)].map((m) => Number(m[1]));
      const marked = new Set(marks.map((k) => Number(k.slice(4))));
      const unmarked = keys.filter((n) => !marked.has(n));
      // The keys sit at both ends of the page, the unmarked ones in one run between.
      expect([marked.has(keys[0]!), marked.has(keys.at(-1)!), unmarked.length > 0]).toEqual([true, true, true]);
      const [from, to] = [unmarked[0]!, unmarked.at(-1)!];
      expect(keys.filter((n) => n >= from && n <= to).every((n) => !marked.has(n))).toBe(true);
      expect(logged.length).toBe(1);
      expect(logged[0]!.level).toBe("warning");
      const p = logged[0]!.properties as Props;
      expect([p.wiki, p.relPath]).toEqual(["budget", `notes/${slug(name)}.md`]);
      expect([p.fromLine, p.toLine]).toEqual([from, to]);
      const said = logged[0]!.message.map(String).join("");
      expect(Number(/\((\d+) lines/.exec(said)![1])).toBeLessThanOrEqual(to - from + 1);
      // The middle's own count: one key per skipped body line, so never more than the range.
      expect(p.middleLines).toBe(unmarked.length);
      expect(p.middleLines).toBeLessThanOrEqual(p.toLine - p.fromLine + 1);
      // Characters as the scan counts them: each skipped line's, its `\r` included.
      const fileLines = page.split("\n");
      const charsOf = (keep: (line: string) => boolean) => fileLines.filter(keep).reduce((sum, line) => sum + line.length, 0);
      const unmarkedSet = new Set(unmarked);
      expect(p.middleChars).toBe(charsOf((line) => unmarkedSet.has(Number(/MEL-(\d+)/.exec(line)?.[1]))));
      expect(p.longLines).toBe(name.startsWith("over-long") ? 3 : 0);
      expect(p.longChars).toBe(charsOf((line) => line.startsWith("long ")));
      // The message as written names the same lines.
      expect(said).toContain(`lines ${from}–${to}`);
    });

  test("a chip fault after the marks are planned renders three times and still warns once", async () => {
    // Throws only with chips: the marks render with chips, then the chips-only
    // render throw; the render without chips (marks kept) succeeds.
    const real = liveFactsModule.applyChipsAndMarks;
    const spy = spyOn(liveFactsModule, "applyChipsAndMarks").mockImplementation((body, chips, ...rest) => {
      if (chips.length) throw new Error("injected chip fault after planKeyMarks");
      return real(body, chips, ...rest);
    });
    try {
      const { html, marks, logged } = await open("notes/chip.md");
      expect(spy.mock.calls.length).toBe(3);
      expect(html).not.toContain('class="fact-chip"');
      expect(marks.length).toBeGreaterThan(0);
      expect(logged.map((r) => r.level)).toEqual(["warning"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("a page served without its marks says nothing of the scan: only the marks' own warning", async () => {
    // Throws only with marks, after the scan was collected: both renders with marks fail.
    const real = liveFactsModule.applyChipsAndMarks;
    const spy = spyOn(liveFactsModule, "applyChipsAndMarks").mockImplementation((body, chips, marks, ...rest) => {
      if (marks.length) throw new Error("injected marks fault after the scan");
      return real(body, chips, marks, ...rest);
    });
    try {
      const { marks, logged } = await open(`notes/${slug("5 frontmatter lines and the matching H1")}.md`);
      expect(marks).toEqual([]);
      expect(logged).toEqual([]);
      expect(records.map((r) => String(r.rawMessage))).toEqual(["key marks failed on {relPath}; page rendered without them: {error}"]);
    } finally {
      spy.mockRestore();
    }
  });

  test("over-long lines alone are info, not a warning, and the count is theirs", async () => {
    const { marks, logged } = await open("notes/long.md");
    expect(marks).toEqual(["MEL-1"]);
    expect(logged.length).toBe(1);
    expect(logged[0]!.level).toBe("info");
    expect(logged[0]!.properties).toMatchObject({ relPath: "notes/long.md", longLines: 2, longChars: 2 * ("MEL-2 ".length + 4_100) });
  });

  test("a page that fits logs nothing", async () => {
    const { marks, logged } = await open("notes/small.md");
    expect(marks).toEqual(["MEL-1", "MEL-2"]);
    expect(logged).toEqual([]);
  });
});
