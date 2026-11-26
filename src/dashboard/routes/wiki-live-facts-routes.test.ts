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

  test("both passes: the chips and the mark", async () => {
    const data = await get();
    expect(chips(data.html)).toEqual(["acme/acme-api#101", "DEMO-11"]);
    expect(marks(data.html)).toEqual(["DEMO-20"]);
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
