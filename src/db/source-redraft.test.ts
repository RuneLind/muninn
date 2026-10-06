/**
 * Redraft (mimir `plans/muninn-summary-factcheck.mdx`, D6) against the REAL
 * test database: the one-transaction replace and its four exhaustive outcomes,
 * the pre-model checks that ignore only the replaced row, and the gate's marks
 * query. The model and huginn are stubbed; the wiki is a temp dir.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  getLiveSourceDocUrls,
  getLiveTopicKeys,
  getWikiProposalById,
  insertWikiProposal,
  listAllWikiProposals,
  type WikiProposal,
} from "./wiki-proposals.ts";
import { recordSourceDraftAttempt } from "./source-draft-attempts.ts";
import { listSummaryFactcheckMarks, upsertSummaryFactcheck } from "./summary-factchecks.ts";
import * as sourceRedraft from "../gardener/source-redraft.ts";
import { redraftSourceProposal } from "../gardener/source-redraft.ts";
import { sha256 } from "../gardener/util.ts";
import { sourceTopicKey } from "../gardener/source-drafter.ts";
import { __resetWikiCacheForTest } from "../wiki/store.ts";
import { FACTCHECK_SENTINEL_START } from "../wiki/factcheck-context.ts";
import type { BotConfig } from "../bots/config.ts";

setupTestDb();

const BOT = "redraftbot";
const COLLECTION = "tiktok-summaries";
const DOC = "health/5 Powerful Words.md";
const URL = "https://www.tiktok.com/@coach/video/7550000000000000000";
const BODY =
  "The creator lists five words to say each morning. Saying these words raises your cortisol and wakes you up. It takes 21 days to form a habit, so repeat them for three weeks. Sleep supports memory consolidation. The video frames this as rewiring the mind and asks viewers to commit to the practice every day without fail, ideally before checking a phone in the morning. It closes by asking viewers to share the list with a friend.";
const ANSWER =
  "### ❌ Claim 1/2 — Affirmations raise cortisol\n\nSelf-affirmation lowers cortisol responses.\n\nConfidence: 80/100\n\n### ✅ Claim 2/2 — Sleep helps memory\n\nSupported.\n\nConfidence: 90/100";

let wikiDir = "";
let bot: BotConfig;

function page(title: string, body = "The video claims the words raise cortisol; sources say they lower it."): string {
  return `---\ntype: source\ntitle: ${title}\naliases: []\ncreated: 2026-10-06\nupdated: 2026-10-06\ntags: [habits]\nurl: ${URL}\nsources: [${URL}]\n---\n\n# ${title}\n\n${body}\n`;
}

async function seedOld(
  topicKey = sourceTopicKey(COLLECTION, DOC),
  over: { url?: string; sourceTitle?: string; draft?: string } = {},
): Promise<WikiProposal> {
  const old = await insertWikiProposal({
    botName: BOT,
    topicKey,
    kind: "source",
    mode: "create",
    targetPath: "sources/Old Title.mdx",
    draft: over.draft ?? page("Old Title", "Saying these words raises your cortisol."),
    sourceDocs: [{ collection: COLLECTION, docId: DOC, title: over.sourceTitle ?? "5 Powerful Words", url: over.url ?? URL }],
  });
  await getDb()`UPDATE wiki_proposals SET created_at = now() - interval '1 day' WHERE id = ${old!.id}`;
  await recordSourceDraftAttempt({
    botName: BOT,
    collection: COLLECTION,
    docId: DOC,
    outcome: "drafted",
    degraded: false,
    reason: null,
    title: "Old Title",
    collidingPath: null,
    proposalId: old!.id,
    trigger: "capture",
  });
  await upsertSummaryFactcheck({
    collection: COLLECTION,
    docId: DOC,
    url: URL,
    bodySha256: "a".repeat(64),
    answer: ANSWER,
    claims: [
      { index: 1, title: "Affirmations raise cortisol", quote: "Saying these words raises your cortisol.", verdict: "❌", outcome: "verified", sources: [] },
      { index: 2, title: "Sleep helps memory", verdict: "✅", outcome: "verified", sources: [] },
    ],
    botName: "jarvis",
  });
  return (await getWikiProposalById(old!.id))!;
}

async function rows() {
  return getDb()<{ id: string; status: string; topic_key: string }[]>`
    SELECT id, status, topic_key FROM wiki_proposals WHERE bot_name = ${BOT} ORDER BY created_at`;
}
async function attempt() {
  const [r] = await getDb()`SELECT proposal_id, outcome, trigger_source FROM source_draft_attempts
    WHERE bot_name = ${BOT} AND collection = ${COLLECTION} AND doc_id = ${DOC}`;
  return r ?? null;
}

const fetchDoc = async () => ({ text: BODY, metadata: { url: URL } }) as never;

beforeEach(async () => {
  wikiDir = await mkdtemp(path.join(tmpdir(), "muninn-redraft-"));
  await writeFile(path.join(wikiDir, "index.md"), "# Index\n");
  __resetWikiCacheForTest();
  bot = { name: BOT, dir: wikiDir, wikiDir } as unknown as BotConfig;
});
afterEach(async () => {
  await rm(wikiDir, { recursive: true, force: true });
});

describe("redraftSourceProposal — the four outcomes", () => {
  test("drafted: old row stale, new row draft with the block, attempts row points at it", async () => {
    const old = await seedOld();
    const prompts: string[] = [];
    const out = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc,
      callDrafter: async (prompt) => {
        prompts.push(prompt);
        return page("Old Title");
      },
    });
    expect(out.outcome).toBe("drafted");
    const after = await rows();
    expect(after.map((r) => r.status)).toEqual(["stale", "draft"]);
    expect(after[0]!.id).toBe(old.id);
    const fresh = (await getWikiProposalById(after[1]!.id))!;
    expect(out).toMatchObject({ proposalId: fresh.id, targetPath: "life/sources/Old Title.mdx" });
    expect(fresh.topicKey).toBe(old.topicKey);
    expect(fresh.draft).toContain(FACTCHECK_SENTINEL_START);
    expect(fresh.draft).toContain("### ❌ Claim 1/2 — Affirmations raise cortisol");
    expect(prompts[0]).toContain("the video claims “Saying these words raises your cortisol”.");
    expect((await getWikiProposalById(old.id))!.resolvedAt).not.toBeNull();
    expect(await attempt()).toMatchObject({ proposal_id: fresh.id, outcome: "drafted", trigger_source: "redraft" });
  });

  for (const meanwhile of ["approved", "rejected", "applied"]) {
    test(`superseded_meanwhile: old draft ${meanwhile} during the model call → rolled back, nothing changed`, async () => {
      const old = await seedOld();
      const before = await attempt();
      const out = await redraftSourceProposal(bot, wikiDir, old, {
        fetchDoc,
        callDrafter: async () => {
          await getDb()`UPDATE wiki_proposals SET status = ${meanwhile} WHERE id = ${old.id}`;
          return page("Old Title");
        },
      });
      expect(out.outcome).toBe("superseded_meanwhile");
      expect((await rows()).map((r) => [r.id, r.status])).toEqual([[old.id, meanwhile]]);
      expect(await attempt()).toEqual(before);
    });
  }

  test("covered: another live row takes the key during the model call → rolled back, old stays draft", async () => {
    // A legacy key on the old row, so the competing insert does not collide
    // with it; the CAS then succeeds and the INSERT is what conflicts.
    const old = await seedOld("source:legacy:old");
    const before = await attempt();
    let competitor = "";
    const out = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc,
      callDrafter: async () => {
        const row = await insertWikiProposal({
          botName: BOT,
          topicKey: sourceTopicKey(COLLECTION, DOC),
          kind: "source",
          mode: "create",
          targetPath: "sources/Parallel.mdx",
          draft: page("Parallel"),
          sourceDocs: [{ collection: COLLECTION, docId: DOC, title: "x", url: "https://example.org/other" }],
        });
        competitor = row!.id;
        return page("Old Title");
      },
    });
    expect(out.outcome).toBe("covered");
    const after = await rows();
    expect(after.map((r) => [r.id, r.status])).toEqual([
      [old.id, "draft"],
      [competitor, "draft"],
    ]);
    expect((await getWikiProposalById(old.id))!.resolvedAt).toBeNull();
    expect(await attempt()).toEqual(before);
  });

  test("model failure or skip: no transaction, old draft and attempts row untouched", async () => {
    const old = await seedOld();
    const before = await attempt();
    const failed = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc,
      callDrafter: async () => {
        throw new Error("model timed out");
      },
    });
    expect(failed).toEqual({ outcome: "error", reason: "model timed out" });
    const skipped = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc,
      callDrafter: async () => "File created successfully.",
    });
    expect(skipped.outcome).toBe("skipped");
    const fetchFailed = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc: async () => {
        throw new Error("huginn down");
      },
      callDrafter: async () => page("Never"),
    });
    expect(fetchFailed.outcome).toBe("error");
    expect((await rows()).map((r) => [r.id, r.status])).toEqual([[old.id, "draft"]]);
    expect((await getWikiProposalById(old.id))!.draft).toBe(old.draft);
    expect(await attempt()).toEqual(before);
  });
});

describe("redraftSourceProposal — what the replacement is built from", () => {
  // Item 2: a pasted article's capture drafted it URL-less; Redraft takes the
  // same path instead of refusing a card the gate locked.
  test("a URL-less doc is redrafted the way the capture drafted it, with the pending callout", async () => {
    const old = await seedOld(undefined, { url: "", draft: page("Old Title").replace(/^url: .*\n/m, "").replace(/^sources: .*\n/m, "") });
    const out = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc: async () => ({ text: BODY, metadata: {} }) as never,
      callDrafter: async () => page("Old Title").replace(/^url: .*\n/m, "").replace(/^sources: .*\n/m, ""),
    });
    expect(out.outcome).toBe("drafted");
    const fresh = (await getWikiProposalById((out as { proposalId: string }).proposalId))!;
    expect(fresh.draft).toContain("> [!note] Source pending ingestion");
    expect(fresh.draft).toContain(FACTCHECK_SENTINEL_START);
    expect(fresh.sourceDocs[0]!.url).toBe("");
  });

  // Item 6: the old row's title is kept, so a doc drafted through the
  // collision-rename path does not hit the same collision on Redraft.
  test("the old draft's title rides as the title override", async () => {
    const old = await seedOld();
    // The title the model would pick on its own is taken in the wiki.
    await writeFile(path.join(wikiDir, "Morning Affirmations.md"), "---\ntitle: Morning Affirmations\n---\n\n# Morning Affirmations\n");
    __resetWikiCacheForTest();
    const prompts: string[] = [];
    const out = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc,
      callDrafter: async (prompt) => {
        prompts.push(prompt);
        return page("Old Title");
      },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('TITLE (chosen by the wiki\'s editor — use it VERBATIM): "Old Title"');
    expect(out).toMatchObject({ outcome: "drafted", targetPath: "life/sources/Old Title.mdx" });
  });

  // Item 7: the stored source title comes from the doc, not from the old row
  // (which stored the old PAGE title when no capture title was known).
  test("the new row's source title is the doc's own title", async () => {
    const old = await seedOld(undefined, { sourceTitle: "Old Title" });
    const out = await redraftSourceProposal(bot, wikiDir, old, { fetchDoc, callDrafter: async () => page("Old Title") });
    const fresh = (await getWikiProposalById((out as { proposalId: string }).proposalId))!;
    expect(fresh.sourceDocs[0]!.title).toBe("5 Powerful Words");
  });

  // Item 1: the replacement records the check it carries.
  test("the replacement carries the digest of the saved check's answer", async () => {
    const old = await seedOld();
    const out = await redraftSourceProposal(bot, wikiDir, old, { fetchDoc, callDrafter: async () => page("Old Title") });
    const fresh = (await getWikiProposalById((out as { proposalId: string }).proposalId))!;
    expect(fresh.sourceDocs[0]!.factcheckSha256).toBe(sha256(ANSWER));
  });

  // Item 9: the replaced row is recognisable from the listing alone: one
  // transaction, one now(), so its resolved_at IS the new row's created_at.
  test("redraftReplacements links the staled row to its replacement", async () => {
    const old = await seedOld();
    const out = await redraftSourceProposal(bot, wikiDir, old, { fetchDoc, callDrafter: async () => page("Old Title") });
    const all = await listAllWikiProposals(BOT);
    const links = sourceRedraft.redraftReplacements(all);
    expect(links.get(old.id)).toBe((out as { proposalId: string }).proposalId);
    expect(links.size).toBe(1);
  });
});

describe("redraftTitle and redraftReplacements (pure)", () => {
  test("redraftTitle reads the frontmatter title before the target stem", () => {
    expect(sourceRedraft.redraftTitle({ draft: page("Fm Title"), targetPath: "sources/Other Stem.mdx" })).toBe("Fm Title");
    expect(sourceRedraft.redraftTitle({ draft: "# No frontmatter\n", targetPath: "sources/Other Stem.mdx" })).toBe("Other Stem");
  });

  type Row = Parameters<typeof sourceRedraft.redraftReplacements>[0][number];
  const row = (over: Partial<Row>): Row => ({
    id: "x",
    botName: BOT,
    wikiName: null,
    topicKey: "source:c:d",
    kind: "source",
    status: "draft",
    createdAt: 2000,
    resolvedAt: null,
    ...over,
  });
  const stale = (over: Partial<Row> = {}) => row({ id: "old", status: "stale", createdAt: 1000, resolvedAt: 2000, ...over });
  const fresh = (over: Partial<Row> = {}) => row({ id: "new", ...over });

  test("links a staled source row to the source row created at its resolved_at, same key", () => {
    expect([...sourceRedraft.redraftReplacements([stale(), fresh()])]).toEqual([["old", "new"]]);
  });

  test("does not link across topic keys, non-stale rows, or non-source kinds", () => {
    const cases: [string, Row[]][] = [
      ["another topic key", [stale(), fresh({ topicKey: "source:c:other" })]],
      ["a rejected (not stale) row", [stale({ status: "rejected" }), fresh()]],
      ["an approved row", [stale({ status: "approved" }), fresh()]],
      ["a stale concept row", [stale({ kind: "concept" }), fresh()]],
      ["a concept replacement", [stale(), fresh({ kind: "concept" })]],
      ["another bot", [stale(), fresh({ botName: "otherbot" })]],
    ];
    for (const [name, rows] of cases) {
      expect({ name, size: sourceRedraft.redraftReplacements(rows).size }).toEqual({ name, size: 0 });
    }
  });
});

describe("redraft pre-model checks ignore only the replaced row", () => {
  test("the live-key and live-URL reads drop exactly the excluded id", async () => {
    const old = await seedOld();
    expect(await getLiveTopicKeys(BOT)).toEqual([old.topicKey]);
    expect(await getLiveTopicKeys(BOT, old.id)).toEqual([]);
    expect(await getLiveSourceDocUrls(BOT)).toEqual([URL]);
    expect(await getLiveSourceDocUrls(BOT, old.id)).toEqual([]);
  });

  test("another live proposal carrying the same URL still answers covered, before any model call", async () => {
    const old = await seedOld();
    await insertWikiProposal({
      botName: BOT,
      topicKey: sourceTopicKey("x-articles", "other-vertical"),
      kind: "source",
      mode: "create",
      targetPath: "sources/Other.mdx",
      draft: page("Other"),
      sourceDocs: [{ collection: "x-articles", docId: "other-vertical", title: "x", url: URL }],
    });
    let called = false;
    const out = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc,
      callDrafter: async () => {
        called = true;
        return page("Never");
      },
    });
    expect(out).toEqual({ outcome: "covered", reason: "a live source proposal already covers this url" });
    expect(called).toBe(false);
    expect((await getWikiProposalById(old.id))!.status).toBe("draft");
  });

  test("the URL already in the wiki still answers covered", async () => {
    const old = await seedOld();
    await writeFile(path.join(wikiDir, "Existing.md"), `---\ntitle: Existing\nurl: ${URL}\n---\n\n# Existing\n`);
    __resetWikiCacheForTest();
    let called = false;
    const out = await redraftSourceProposal(bot, wikiDir, old, {
      fetchDoc,
      callDrafter: async () => {
        called = true;
        return page("Never");
      },
    });
    expect(out.outcome).toBe("covered");
    expect(called).toBe(false);
  });

  test("a row that is not a create-mode source draft is refused before any read", async () => {
    const old = await seedOld();
    for (const p of [{ ...old, status: "approved" as const }, { ...old, mode: "update" as const }, { ...old, kind: "concept" as const }]) {
      const out = await redraftSourceProposal(bot, wikiDir, p, {
        fetchDoc: async () => {
          throw new Error("must not fetch");
        },
      });
      expect(out.outcome).toBe("skipped");
    }
  });
});

describe("listSummaryFactcheckMarks", () => {
  test("counts ❌ and ⚠️ (with or without VS16) per document", async () => {
    await upsertSummaryFactcheck({
      collection: COLLECTION,
      docId: DOC,
      url: URL,
      bodySha256: "a".repeat(64),
      answer: "",
      claims: [
        { index: 1, title: "a", verdict: "❌", outcome: "verified", sources: [] },
        { index: 2, title: "b", verdict: "⚠️", outcome: "verified", sources: [] },
        { index: 3, title: "c", verdict: "⚠", outcome: "verified", sources: [] },
        { index: 4, title: "d", verdict: "✅", outcome: "verified", sources: [] },
      ],
      botName: "jarvis",
    });
    const marks = await listSummaryFactcheckMarks();
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ collection: COLLECTION, docId: DOC, bad: 1, warn: 2 });
    expect(Math.abs(marks[0]!.checkedAt - Date.now())).toBeLessThan(60_000);
  });

  // Item 11: the gate and the rider count with ONE predicate, so a verdict the
  // rider reads as ❌ (padded, the word form) is one the gate counts.
  test("counts with the rider's predicate", async () => {
    await upsertSummaryFactcheck({
      collection: COLLECTION,
      docId: DOC,
      url: URL,
      bodySha256: "a".repeat(64),
      answer: "",
      claims: [
        { index: 1, title: "a", verdict: " ❌ ", outcome: "verified", sources: [] },
        { index: 2, title: "b", verdict: "bad", outcome: "verified", sources: [] },
        { index: 3, title: "c", verdict: "WARN", outcome: "verified", sources: [] },
      ],
      botName: "jarvis",
    });
    expect((await listSummaryFactcheckMarks())[0]).toMatchObject({ bad: 2, warn: 1 });
  });

  test("one malformed claims value costs that row, not every flag", async () => {
    await upsertSummaryFactcheck({
      collection: COLLECTION,
      docId: DOC,
      url: URL,
      bodySha256: "a".repeat(64),
      answer: "ok",
      claims: [{ index: 1, title: "a", verdict: "❌", outcome: "verified", sources: [] }],
      botName: "jarvis",
    });
    await getDb()`INSERT INTO summary_factchecks (collection, doc_id, url, body_sha256, answer, claims, bot_name)
      VALUES (${COLLECTION}, 'health/broken.md', null, ${"b".repeat(64)}, 'x', '{"not":"an array"}'::jsonb, 'jarvis')`;
    await getDb()`INSERT INTO summary_factchecks (collection, doc_id, url, body_sha256, answer, claims, bot_name)
      VALUES (${COLLECTION}, 'health/scalar.md', null, ${"c".repeat(64)}, 'y', '"❌"'::jsonb, 'jarvis')`;
    const marks = await listSummaryFactcheckMarks();
    const byDoc = new Map(marks.map((m) => [m.docId, m]));
    expect(byDoc.get(DOC)).toMatchObject({ bad: 1, warn: 0 });
    expect(byDoc.get("health/broken.md")).toMatchObject({ bad: 0, warn: 0 });
    expect(byDoc.get("health/scalar.md")).toMatchObject({ bad: 0, warn: 0 });
  });

  test("answerSha256 hashes the answer as stored, edge whitespace included", async () => {
    const answer = "  \n### ❌ Claim 1/1 — a\n\nb\n  ";
    await upsertSummaryFactcheck({
      collection: COLLECTION,
      docId: DOC,
      url: URL,
      bodySha256: "a".repeat(64),
      answer,
      claims: [],
      botName: "jarvis",
    });
    expect((await listSummaryFactcheckMarks())[0]!.answerSha256).toBe(sha256(answer));
  });

  test("answerSha256 is the JS sha256 of the answer, non-ASCII included", async () => {
    const answer = "### ❌ Claim 1/1 — Café Ø\n\nÆrlig talt: “nei”.";
    await upsertSummaryFactcheck({
      collection: COLLECTION,
      docId: DOC,
      url: URL,
      bodySha256: "a".repeat(64),
      answer,
      claims: [],
      botName: "jarvis",
    });
    expect((await listSummaryFactcheckMarks())[0]!.answerSha256).toBe(sha256(answer));
  });
});
