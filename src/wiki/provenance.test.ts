/**
 * The provenance keys: the shape contract, the pure helpers, and the store
 * mapping that turns four frontmatter lines into `WikiPageMeta` fields.
 *
 * The first describe block is the DRIFT GATE. `__fixtures__/wiki-stamp-shape.md`
 * is a byte-identical copy of claude-usage's
 * `test/fixtures/wiki-stamp/shape.md`, which its own suite pins from the writing
 * side; this one pins the reading side. Either repo changing the shape without
 * the other fails here or there, which is the whole point of checking the same
 * file in twice.
 */

import { test, expect, describe, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseFrontmatter, getWikiIndex, __resetWikiCacheForTest } from "./store.ts";
import {
  costOfSessions,
  enrichSessions,
  isJiraKeyShape,
  jiraBrowseUrl,
  jiraCounts,
  jiraRows,
  normalizeJiraKey,
  parsePrRef,
  parseSessionRef,
  sessionRefMatches,
  hasProvenance,
  type ProvenanceSessionChip,
} from "./provenance.ts";
import type { WikiPageMeta } from "./store.ts";

const FIXTURE = path.join(import.meta.dir, "__fixtures__", "wiki-stamp-shape.md");

const SESSION_A = "claude-code:5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60";
const SESSION_B = "opencode:ses_7f3a9b2c1d";

describe("the shape fixture", () => {
  test("parseFrontmatter reads all four keys off the shared fixture", async () => {
    const fm = parseFrontmatter(await Bun.file(FIXTURE).text());
    expect(fm.sessions).toEqual([SESSION_A, SESSION_B]);
    expect(fm.sessions_backfilled).toBe("2026-10-14");
    expect(fm.jira).toEqual(["MELOSYS-8045"]);
    expect(fm.prs).toEqual(["navikt/melosys-api#1234", "RuneLind/muninn#543"]);
  });

  test("the index maps them onto the page meta, sessions in file order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prov-fixture-"));
    try {
      await copyFile(FIXTURE, path.join(root, "shape.md"));
      __resetWikiCacheForTest();
      const index = await getWikiIndex({ root, refresh: true });
      const meta = index!.resolveRelPath("shape.md")!;
      expect(meta.sessions).toEqual([SESSION_A, SESSION_B]);
      expect(meta.sessionsBackfilled).toBe("2026-10-14");
      expect(meta.jira).toEqual(["MELOSYS-8045"]);
      expect(meta.prs).toEqual(["navikt/melosys-api#1234", "RuneLind/muninn#543"]);
    } finally {
      __resetWikiCacheForTest();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the store mapping", () => {
  let root = "";
  afterEach(async () => {
    __resetWikiCacheForTest();
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  async function indexOf(pages: Record<string, string>) {
    root = await mkdtemp(path.join(tmpdir(), "prov-store-"));
    for (const [name, body] of Object.entries(pages)) {
      await writeFile(path.join(root, name), body);
    }
    __resetWikiCacheForTest();
    return (await getWikiIndex({ root, refresh: true }))!;
  }

  test("a page declaring nothing carries no provenance fields at all", async () => {
    const index = await indexOf({ "plain.md": "---\ntype: plan\n---\n\n# Plain\n" });
    const meta = index.resolveRelPath("plain.md")!;
    // Absent, not `[]` — an empty array per page is listing payload asserting
    // nothing, and `hasProvenance` is what gates the page route's block.
    expect(meta.sessions).toBeUndefined();
    expect(meta.jira).toBeUndefined();
    expect(meta.prs).toBeUndefined();
    expect(meta.sessionsBackfilled).toBeUndefined();
    expect(hasProvenance(meta)).toBe(false);
  });

  test("jira keys are normalized to trimmed uppercase, sessions are left verbatim", async () => {
    const index = await indexOf({
      "p.md": `---\ntitle: P\njira: [ melosys-8045 , Abc-12 ]\nsessions: [ ${SESSION_A} ]\n---\n\nbody\n`,
    });
    const meta = index.resolveRelPath("p.md")!;
    expect(meta.jira).toEqual(["MELOSYS-8045", "ABC-12"]);
    expect(meta.sessions).toEqual([SESSION_A]);
  });

  test("a blank sessions_backfilled is dropped rather than stored as an empty string", async () => {
    const index = await indexOf({
      "p.md": `---\ntitle: P\nsessions: [${SESSION_A}]\nsessions_backfilled: "   "\n---\n\nbody\n`,
    });
    expect(index.resolveRelPath("p.md")!.sessionsBackfilled).toBeUndefined();
  });
});

describe("pure helpers", () => {
  test("normalizeJiraKey trims and uppercases; the shape check runs on that form", () => {
    expect(normalizeJiraKey("  melosys-8045 ")).toBe("MELOSYS-8045");
    expect(isJiraKeyShape("MELOSYS-8045")).toBe(true);
    expect(isJiraKeyShape("A-1")).toBe(false); // needs ≥2 prefix chars
    expect(isJiraKeyShape("bogus")).toBe(false);
    expect(isJiraKeyShape("MELOSYS-")).toBe(false);
    expect(isJiraKeyShape("melosys-8045")).toBe(false); // normalize first
    expect(jiraBrowseUrl("MELOSYS-8045")).toBe("https://nav.atlassian.net/browse/MELOSYS-8045");
  });

  test("parseSessionRef splits on the FIRST colon and keeps the tail exact", () => {
    expect(parseSessionRef(SESSION_A)).toEqual({
      ref: SESSION_A,
      provider: "claude-code",
      id: "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60",
    });
    expect(parseSessionRef("opencode:ses:with:colons")).toEqual({
      ref: "opencode:ses:with:colons",
      provider: "opencode",
      id: "ses:with:colons",
    });
    // A bare id, a leading colon and a trailing colon are all "no provider" —
    // the id must stay exactly what the ledger is keyed on.
    expect(parseSessionRef("bare-id").provider).toBeNull();
    expect(parseSessionRef("bare-id").id).toBe("bare-id");
    expect(parseSessionRef(":x").id).toBe(":x");
    expect(parseSessionRef("x:").id).toBe("x:");
  });

  test("sessionRefMatches accepts either spelling of the same session", () => {
    expect(sessionRefMatches(SESSION_A, SESSION_A)).toBe(true);
    expect(sessionRefMatches(SESSION_A, "5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60")).toBe(true);
    expect(sessionRefMatches("5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60", SESSION_A)).toBe(true);
    expect(sessionRefMatches(SESSION_A, SESSION_B)).toBe(false);
  });

  test("parsePrRef builds a GitHub url from a coordinate and null from anything else", () => {
    expect(parsePrRef("RuneLind/muninn#543")).toEqual({
      ref: "RuneLind/muninn#543",
      url: "https://github.com/RuneLind/muninn/pull/543",
    });
    expect(parsePrRef("not a coordinate").url).toBeNull();
    expect(parsePrRef("owner/repo#abc").url).toBeNull();
  });

  test("jiraCounts counts PAGES, so one page naming a key twice counts once", () => {
    const pages = [
      { jira: ["MELOSYS-8045", "MELOSYS-8045"] },
      { jira: ["MELOSYS-8045", "MELOSYS-9"] },
      { jira: undefined },
    ] as unknown as WikiPageMeta[];
    expect(jiraCounts(pages)).toEqual({ "MELOSYS-8045": 2, "MELOSYS-9": 1 });
    expect(jiraCounts([{ jira: undefined }] as unknown as WikiPageMeta[])).toEqual({});
  });
});

describe("enrichment and the money line", () => {
  const facts = new Map([
    ["5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60", { title: "A session", host: "mini", cost: 1.5, messages: 12, first: "2026-10-14T09:00:00Z", last: "2026-10-14T10:00:00Z" }],
  ]);

  test("a known id is priced and keeps its provider prefix for the glyph", () => {
    const [chip] = enrichSessions([SESSION_A], { facts });
    expect(chip!.missing).toBe(false);
    expect(chip!.provider).toBe("claude-code");
    expect(chip!.ref).toBe(SESSION_A);
    expect(chip!.cost).toBe(1.5);
    expect(chip!.title).toBe("A session");
  });

  test("an id the ledger does not hold is a bare chip that contributes no money", () => {
    const chips = enrichSessions([SESSION_A, SESSION_B], { facts });
    expect(chips[1]!.missing).toBe(true);
    expect(chips[1]!.cost).toBeUndefined();
    // 1 of 2 priced — `costedSessions` is the denominator the total is over,
    // so a reaped session can never read as a $0 one.
    expect(costOfSessions(chips)).toEqual({ totalCost: 1.5, costedSessions: 1 });
  });

  test("the drill-down link is built only when a public URL is configured", () => {
    expect(enrichSessions([SESSION_A], { facts })[0]!.url).toBeUndefined();
    expect(enrichSessions([SESSION_A], { facts }, "http://mini:8787/")[0]!.url).toBe(
      "http://mini:8787/#/session/5a2ee3f0-c7ea-42f4-8082-1b2c3d4e5f60",
    );
    // A missing session still gets the link: the page it opens is claude-usage's
    // own answer about that id, which is what a reader clicking it is asking.
    expect(enrichSessions([SESSION_B], { facts }, "http://mini:8787")[0]!.url).toBe(
      "http://mini:8787/#/session/ses_7f3a9b2c1d",
    );
  });

  test("costOfSessions ignores a priced-looking chip whose cost is null", () => {
    const chips: ProvenanceSessionChip[] = [
      { ref: "a", provider: null, id: "a", missing: false, cost: null },
      { ref: "b", provider: null, id: "b", missing: false, cost: 2 },
    ];
    expect(costOfSessions(chips)).toEqual({ totalCost: 2, costedSessions: 1 });
  });

  test("jiraRows always carry the browse url and add huginn's only when the corpus holds it", () => {
    const corpus = new Map([["MELOSYS-8045", "https://nav.atlassian.net/browse/MELOSYS-8045"]]);
    expect(jiraRows(["MELOSYS-8045", "MELOSYS-9"], corpus)).toEqual([
      {
        key: "MELOSYS-8045",
        url: "https://nav.atlassian.net/browse/MELOSYS-8045",
        huginnUrl: "https://nav.atlassian.net/browse/MELOSYS-8045",
      },
      { key: "MELOSYS-9", url: "https://nav.atlassian.net/browse/MELOSYS-9" },
    ]);
    // A degraded lookup drops the field — it must never read as "fabricated".
    expect(jiraRows(["MELOSYS-8045"], null)[0]!.huginnUrl).toBeUndefined();
  });
});
