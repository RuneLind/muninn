/**
 * `GET /api/wiki/page`'s live chips (living facts PR 3b): the chip spans in
 * `html` and the `facts` payload, only on a wiki with a readable
 * `.wiki-facts.json`. Synthetic owners, repos and numbers only.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { registerWikiRoutes } from "./wiki-routes.ts";
import { __resetWikiRegistryForTest } from "../../wiki/registry-memo.ts";
import { __resetWikiCacheForTest } from "../../wiki/store.ts";
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
const PAGE = ["---", "title: Plan", "---", "", "D1 in [[plans/plan]]: api #101 for DEMO-11, and acme/acme-api#999.", "", "<DecisionLog>", "", "- **D1** — Ship.", "", "</DecisionLog>", ""].join("\n");

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
