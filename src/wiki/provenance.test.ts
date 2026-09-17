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
  PROVENANCE_FRONTMATTER_KEYS,
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

  test("every key the reader depends on is named by PROVENANCE_FRONTMATTER_KEYS", async () => {
    // The constant is the contract's own list; asserting the fixture through it
    // is what keeps the two from drifting apart in this repo.
    const fm = parseFrontmatter(await Bun.file(FIXTURE).text());
    for (const key of PROVENANCE_FRONTMATTER_KEYS) {
      expect(Object.hasOwn(fm, key), key).toBe(true);
    }
  });

  test("it is byte-identical to claude-usage's copy — WHEN that checkout is here", async () => {
    // Each repo pins its OWN half (the two tests above pin the reading side;
    // claude-usage's suite pins the writing side), and neither assertion can see
    // the other file — so the honest statement is that the two are compared by
    // hand, plus this opportunistic diff. It SKIPS when there is no sibling
    // checkout, by design: CI clones one repo, and a machine without the other
    // must not go red over a file it does not have.
    const sibling = path.resolve(import.meta.dir, "..", "..", "..", "claude-usage", "test", "fixtures", "wiki-stamp", "shape.md");
    if (!(await Bun.file(sibling).exists())) {
      expect(true).toBe(true); // no sibling checkout — nothing to compare
      return;
    }
    expect(await Bun.file(sibling).text()).toBe(await Bun.file(FIXTURE).text());
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

  test("a repeated value is stored ONCE — the stamper appending twice is not two sessions", async () => {
    const index = await indexOf({
      "p.md": `---\ntitle: P\nsessions: [${SESSION_A}, ${SESSION_A}]\njira: [MELOSYS-8045, melosys-8045]\nprs: [o/r#1, o/r#1]\n---\n\nbody\n`,
    });
    const meta = index.resolveRelPath("p.md")!;
    // A duplicate reached three surfaces as a real second entry: a duplicate
    // session chip, a session PRICED twice into the page's `totalCost`, and a
    // duplicate Jira row. The facet was already immune (`jiraCounts` folds each
    // page through a Set), which is exactly why this was invisible from there.
    expect(meta.sessions).toEqual([SESSION_A]);
    expect(meta.jira).toEqual(["MELOSYS-8045"]);
    expect(meta.prs).toEqual(["o/r#1"]);
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
    // A ONE-character project prefix is a key: `/^[A-Z][A-Z0-9]*-[0-9]+$/` is
    // byte for byte what claude-usage's `/api/jira-sessions` validates with
    // (`src/routes.ts`, `jiraKey`). Requiring two here made `X-1` a 400 on the
    // muninn side of a key the stamper had happily written.
    expect(isJiraKeyShape("A-1")).toBe(true);
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

/** A chip with every key set — the shape `enrichSessions` now guarantees. */
function chip(id: string, cost: number | null): ProvenanceSessionChip {
  return {
    ref: id,
    provider: null,
    id,
    title: null,
    host: null,
    model: null,
    delegatedCost: null,
    first: null,
    last: null,
    cost,
    messages: null,
    missing: false,
    unresolved: false,
    invalid: false,
  };
}

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
    // Explicit `null`, never a dropped key: a bare chip carries the SAME key set
    // as a priced one, so a client indexing `chip.cost` reads "unknown" rather
    // than "this key was forgotten".
    expect(chips[1]!.cost).toBeNull();
    expect(chips[1]!.title).toBeNull();
    expect(chips[1]!.unresolved).toBe(false);
    expect(chips[1]!.invalid).toBe(false);
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
      chip("a", null),
      chip("b", 2),
    ];
    expect(costOfSessions(chips)).toEqual({ totalCost: 2, costedSessions: 1 });
  });

  test("jiraRows always carry the browse url and say whether huginn holds the key", () => {
    const corpus = new Map([["MELOSYS-8045", "https://nav.atlassian.net/browse/MELOSYS-8045"]]);
    expect(jiraRows(["MELOSYS-8045", "MELOSYS-9"], corpus)).toEqual([
      {
        key: "MELOSYS-8045",
        url: "https://nav.atlassian.net/browse/MELOSYS-8045",
        huginnKnown: true,
      },
      { key: "MELOSYS-9", url: "https://nav.atlassian.net/browse/MELOSYS-9", huginnKnown: false },
    ]);
    // A degraded lookup drops the field — absent is "I could not ask", `false`
    // is "huginn does not have it", and it must never read as "fabricated".
    expect(jiraRows(["MELOSYS-8045"], null)[0]!.huginnKnown).toBeUndefined();
  });

  test("a key huginn holds with NO url of its own still reads as known", () => {
    // The corpus maps a key to a url that may legitimately be undefined (a doc
    // with no `url:` field). Reading the VALUE reported such a key as unknown.
    const corpus = new Map<string, string | undefined>([["MELOSYS-8045", undefined]]);
    expect(jiraRows(["MELOSYS-8045"], corpus)[0]!.huginnKnown).toBe(true);
  });
});

// ── The facet only offers chips that WORK (fix round 1) ────────────────────

describe("jiraCounts filters to key-shaped values", () => {
  test("a typo on a page is kept in the page's own row but never becomes a chip", () => {
    const pages = [
      { jira: ["MELOSYS-8045", "not a key", "melosys-8045"] },
      { jira: ["MELOSYS-8045"] },
    ] as unknown as WikiPageMeta[];
    // The reverse lookup 400s on a value that is not a key, so an unfiltered
    // facet renders a chip whose only behaviour is to fail when clicked.
    // (`melosys-8045` is lowercase here only because this fixture bypasses the
    // store's parse-time normalization — on a real page it would be uppercase.)
    expect(jiraCounts(pages)).toEqual({ "MELOSYS-8045": 2 });
  });

  test("a one-character project prefix IS a chip — upstream accepts it", () => {
    expect(jiraCounts([{ jira: ["X-1"] }] as unknown as WikiPageMeta[])).toEqual({ "X-1": 1 });
  });
});

describe("hasProvenance is the ONE gate", () => {
  const meta = (over: Partial<WikiPageMeta>) => over as WikiPageMeta;

  test("any of the three list keys opens the block; none of them closes it", () => {
    expect(hasProvenance(meta({ sessions: ["a"] }))).toBe(true);
    expect(hasProvenance(meta({ jira: ["MELOSYS-1"] }))).toBe(true);
    expect(hasProvenance(meta({ prs: ["o/r#1"] }))).toBe(true);
    expect(hasProvenance(meta({}))).toBe(false);
    // `sessions_backfilled` alone is a MARKER about a list that is not there —
    // it must not mint a block with nothing in it.
    expect(hasProvenance(meta({ sessionsBackfilled: "2026-10-14" }))).toBe(false);
  });
});
