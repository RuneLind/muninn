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
  type WikiProposal,
} from "./wiki-proposals.ts";
import { recordSourceDraftAttempt } from "./source-draft-attempts.ts";
import { listSummaryFactcheckMarks, upsertSummaryFactcheck } from "./summary-factchecks.ts";
import { redraftSourceProposal } from "../gardener/source-redraft.ts";
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

async function seedOld(topicKey = sourceTopicKey(COLLECTION, DOC)): Promise<WikiProposal> {
  const old = await insertWikiProposal({
    botName: BOT,
    topicKey,
    kind: "source",
    mode: "create",
    targetPath: "sources/Old Title.mdx",
    draft: page("Old Title", "Saying these words raises your cortisol."),
    sourceDocs: [{ collection: COLLECTION, docId: DOC, title: "5 Powerful Words", url: URL }],
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
        return page("Morning Affirmations");
      },
    });
    expect(out.outcome).toBe("drafted");
    const after = await rows();
    expect(after.map((r) => r.status)).toEqual(["stale", "draft"]);
    expect(after[0]!.id).toBe(old.id);
    const fresh = (await getWikiProposalById(after[1]!.id))!;
    expect(out).toMatchObject({ proposalId: fresh.id, targetPath: "life/sources/Morning Affirmations.mdx" });
    expect(fresh.topicKey).toBe(old.topicKey);
    expect(fresh.draft).toContain(FACTCHECK_SENTINEL_START);
    expect(fresh.draft).toContain("### ❌ Claim 1/2 — Affirmations raise cortisol");
    expect(prompts[0]).toContain('the video claims "Saying these words raises your cortisol."');
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
          return page("Morning Affirmations");
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
        return page("Morning Affirmations");
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
});
