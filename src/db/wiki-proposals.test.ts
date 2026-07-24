import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  insertWikiProposal,
  getWikiProposalById,
  listWikiProposalsByStatus,
  listAllWikiProposals,
  countDraftWikiProposals,
  getLiveTopicKeys,
  getLiveSourceDocUrls,
  getRejectedTopicKeys,
  getRecentlyRejectedTopicKeys,
  getConsumedDocIds,
  getPendingDocIds,
  listAllWikiProposalsByWiki,
  countDraftWikiProposalsByWiki,
  getLiveTopicKeysByWiki,
  getLiveOrAppliedTopicKeysByWiki,
  getRecentlyRejectedTopicKeysByWiki,
  type InsertWikiProposalParams,
} from "./wiki-proposals.ts";

setupTestDb();

function makeProposal(overrides: Partial<InsertWikiProposalParams> = {}): InsertWikiProposalParams {
  return {
    botName: "jarvis",
    topicKey: "context-compaction",
    kind: "concept",
    mode: "create",
    targetPath: "concepts/Context Compaction.md",
    draft: "---\ntype: concept\ntitle: Context Compaction\n---\n\n# Context Compaction\n\nbody",
    sourceDocs: [{ collection: "youtube-summaries", docId: "2026-07-07_a.md", title: "A", url: "https://a" }],
    rationale: "clusters",
    ...overrides,
  };
}

describe("wiki_proposals CRUD", () => {
  test("insert + get round-trip", async () => {
    const row = await insertWikiProposal(makeProposal());
    expect(row).not.toBeNull();
    expect(row!.status).toBe("draft");
    expect(row!.sourceDocs).toHaveLength(1);
    const fetched = await getWikiProposalById(row!.id);
    expect(fetched!.topicKey).toBe("context-compaction");
    expect(fetched!.createdAt).toBeGreaterThan(0);
    // No related_pages supplied → NULL column, mapped back to null.
    expect(fetched!.relatedPages).toBeNull();
  });

  test("related_pages round-trip (title + optional relPath)", async () => {
    const row = await insertWikiProposal(
      makeProposal({
        topicKey: "with-related",
        relatedPages: [{ title: "RAG", relPath: "concepts/RAG.md" }, { title: "Unresolved" }],
      }),
    );
    const fetched = await getWikiProposalById(row!.id);
    expect(fetched!.relatedPages).toEqual([
      { title: "RAG", relPath: "concepts/RAG.md" },
      { title: "Unresolved" },
    ]);
  });

  test("ON CONFLICT DO NOTHING against the live partial unique index", async () => {
    const first = await insertWikiProposal(makeProposal());
    expect(first).not.toBeNull();

    // Same (bot, topicKey) while a draft is live → skipped.
    const dup = await insertWikiProposal(makeProposal());
    expect(dup).toBeNull();

    // Resolve the live row → the topic is no longer live → a fresh draft succeeds.
    await getDb()`UPDATE wiki_proposals SET status = 'applied' WHERE id = ${first!.id}`;
    const again = await insertWikiProposal(makeProposal());
    expect(again).not.toBeNull();
    expect(again!.id).not.toBe(first!.id);
  });

  test("listWikiProposalsByStatus filters by bot + status", async () => {
    await insertWikiProposal(makeProposal({ topicKey: "a" }));
    await insertWikiProposal(makeProposal({ topicKey: "b", botName: "other" }));
    const jarvis = await listWikiProposalsByStatus("jarvis", "draft");
    expect(jarvis.map((p) => p.topicKey).sort()).toEqual(["a"]);
  });

  test("live + rejected topic keys", async () => {
    const live = await insertWikiProposal(makeProposal({ topicKey: "live-one" }));
    const rej = await insertWikiProposal(makeProposal({ topicKey: "rejected-one" }));
    await getDb()`UPDATE wiki_proposals SET status = 'rejected' WHERE id = ${rej!.id}`;

    expect(await getLiveTopicKeys("jarvis")).toEqual(["live-one"]);
    expect(await getRejectedTopicKeys("jarvis")).toEqual(["rejected-one"]);
    // guard against unused var lint on `live`
    expect(live!.status).toBe("draft");
  });

  test("getRecentlyRejectedTopicKeys applies the resolved_at TTL boundary", async () => {
    // Three rejected rows: one resolved just INSIDE the 7-day window, one just
    // OUTSIDE it, and one with a NULL resolved_at (ad-hoc ops row).
    const inside = await insertWikiProposal(makeProposal({ topicKey: "inside-window" }));
    const outside = await insertWikiProposal(makeProposal({ topicKey: "outside-window" }));
    const nullres = await insertWikiProposal(makeProposal({ topicKey: "null-resolved" }));
    const sql = getDb();
    // Just inside: resolved 6 days + 23h ago.
    await sql`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() - interval '6 days 23 hours' WHERE id = ${inside!.id}`;
    // Just outside: resolved 7 days + 1h ago.
    await sql`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() - interval '7 days 1 hour' WHERE id = ${outside!.id}`;
    // Rejected but resolved_at left NULL → treated as expired (excluded from skip).
    await sql`UPDATE wiki_proposals SET status = 'rejected', resolved_at = NULL WHERE id = ${nullres!.id}`;

    const recent = await getRecentlyRejectedTopicKeys("jarvis", 7);
    expect(recent).toContain("inside-window");
    expect(recent).not.toContain("outside-window");
    expect(recent).not.toContain("null-resolved");

    // The unfiltered hint set still sees ALL three rejections.
    const all = await getRejectedTopicKeys("jarvis");
    expect(all).toContain("inside-window");
    expect(all).toContain("outside-window");
    expect(all).toContain("null-resolved");
  });

  test("consumed doc ids come from applied proposals' source_docs", async () => {
    const applied = await insertWikiProposal(makeProposal({ topicKey: "applied-topic" }));
    await getDb()`UPDATE wiki_proposals SET status = 'applied' WHERE id = ${applied!.id}`;
    // A still-draft proposal's docs are NOT consumed.
    await insertWikiProposal(makeProposal({
      topicKey: "draft-topic",
      sourceDocs: [{ collection: "x-articles", docId: "draft-doc.md", title: "D", url: "https://d" }],
    }));

    const consumed = await getConsumedDocIds("jarvis");
    expect(consumed.has("youtube-summaries/2026-07-07_a.md")).toBe(true);
    expect(consumed.has("x-articles/draft-doc.md")).toBe(false);
  });

  test("consumed kind filter: an applied SOURCE page is excluded for the weekly gardener but still credits unfiltered", async () => {
    const src = await insertWikiProposal(
      makeProposal({
        topicKey: "source:youtube-summaries:vidZ",
        kind: "source",
        targetPath: "sources/Some Video.mdx",
        sourceDocs: [{ collection: "youtube-summaries", docId: "vidZ", title: "Z", url: "https://z" }],
      }),
    );
    await getDb()`UPDATE wiki_proposals SET status = 'applied' WHERE id = ${src!.id}`;

    // Weekly gardener seam passes ["concept","entity"] → source doc NOT excluded
    // from harvest (stays eligible for concept/entity synthesis).
    const filtered = await getConsumedDocIds("jarvis", ["concept", "entity"]);
    expect(filtered.has("youtube-summaries/vidZ")).toBe(false);

    // Backlog-crediting path (unfiltered) → the source-paged doc DOES count as consumed.
    const all = await getConsumedDocIds("jarvis");
    expect(all.has("youtube-summaries/vidZ")).toBe(true);
  });
});

describe("wiki-keyed (consolidation) proposals — isolation from bot-keyed reads", () => {
  /** A wiki-keyed row: bot_name is the truthful synthesis bot, wiki_name keys it
   *  to the standalone wiki. Every field distinct from the jarvis makeProposal
   *  defaults so nothing leaks by accident. */
  function mimirRow(overrides: Partial<InsertWikiProposalParams> = {}): InsertWikiProposalParams {
    return {
      botName: "jarvis",
      wikiName: "mimir",
      topicKey: "mimir-topic",
      kind: "synthesis",
      mode: "create",
      targetPath: "blogs/2026-07-24-x.mdx",
      draft: "---\ntype: synthesis\ntitle: X\n---\n\nbody",
      sourceDocs: [{ collection: "mimir", docId: "projects/muninn/x.md", title: "X", url: "https://mimir/x" }],
      rationale: "consolidation",
      ...overrides,
    };
  }

  test("a wiki-keyed row with bot_name='jarvis' is invisible under every bot-keyed read for jarvis", async () => {
    const sql = getDb();

    // Baseline: a legacy bot-keyed jarvis draft the bot's flows still expect.
    const legacy = await insertWikiProposal(makeProposal({ topicKey: "legacy-live" }));
    expect(legacy).not.toBeNull();

    // Wiki-keyed rows across the statuses the reads exercise.
    const draftRow = await insertWikiProposal(mimirRow({ topicKey: "mimir-draft" }));
    const sourceRow = await insertWikiProposal(
      mimirRow({
        topicKey: "mimir-source",
        kind: "source",
        targetPath: "sources/S.mdx",
        sourceDocs: [{ collection: "mimir", docId: "s.md", title: "S", url: "https://mimir/s" }],
      }),
    );
    const appliedRow = await insertWikiProposal(
      mimirRow({
        topicKey: "mimir-applied",
        sourceDocs: [{ collection: "mimir", docId: "applied.md", title: "A", url: "https://mimir/applied" }],
      }),
    );
    const rejectedRow = await insertWikiProposal(mimirRow({ topicKey: "mimir-rejected" }));
    expect([draftRow, sourceRow, appliedRow, rejectedRow].every((r) => r !== null)).toBe(true);
    await sql`UPDATE wiki_proposals SET status = 'applied' WHERE id = ${appliedRow!.id}`;
    await sql`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE id = ${rejectedRow!.id}`;

    // ── The 9 bot-keyed reads: jarvis sees ONLY its legacy row, never mimir's. ──
    const mimirKeys = ["mimir-draft", "mimir-source", "mimir-applied", "mimir-rejected"];

    // 1. listWikiProposalsByStatus
    expect((await listWikiProposalsByStatus("jarvis", "draft")).map((p) => p.topicKey)).toEqual(["legacy-live"]);
    // 2. listAllWikiProposals
    const all = (await listAllWikiProposals("jarvis")).map((p) => p.topicKey);
    expect(all).toContain("legacy-live");
    for (const k of mimirKeys) expect(all).not.toContain(k);
    // 3. countDraftWikiProposals — only the legacy draft.
    expect(await countDraftWikiProposals("jarvis")).toBe(1);
    // 4. getLiveTopicKeys
    expect(await getLiveTopicKeys("jarvis")).toEqual(["legacy-live"]);
    // 5. getLiveSourceDocUrls — the mimir source url must not leak.
    expect(await getLiveSourceDocUrls("jarvis")).not.toContain("https://mimir/s");
    // 6. getRejectedTopicKeys
    expect(await getRejectedTopicKeys("jarvis")).not.toContain("mimir-rejected");
    // 7. getRecentlyRejectedTopicKeys
    expect(await getRecentlyRejectedTopicKeys("jarvis", 7)).not.toContain("mimir-rejected");
    // 8. getConsumedDocIds — the applied mimir doc is not consumed for jarvis.
    expect((await getConsumedDocIds("jarvis")).has("mimir/applied.md")).toBe(false);
    // 9. getPendingDocIds — the draft/source mimir docs are not pending for jarvis.
    const pending = await getPendingDocIds("jarvis");
    expect(pending.has("mimir/x.md")).toBe(false);
    expect(pending.has("mimir/s.md")).toBe(false);

    // ── Wiki-scoped reads DO see mimir's rows (and not jarvis's legacy row). ──
    const byWiki = (await listAllWikiProposalsByWiki("mimir")).map((p) => p.topicKey).sort();
    expect(byWiki).toEqual([...mimirKeys].sort());
    expect(await countDraftWikiProposalsByWiki("mimir")).toBe(2); // draft + source
    expect((await getLiveTopicKeysByWiki("mimir")).sort()).toEqual(["mimir-draft", "mimir-source"]);
    expect((await getRecentlyRejectedTopicKeysByWiki("mimir", 7))).toEqual(["mimir-rejected"]);
    // The wiki-keyed row carries wiki_name back through mapRow.
    expect(draftRow!.wikiName).toBe("mimir");
    expect(legacy!.wikiName).toBeNull();
  });

  test("getLiveOrAppliedTopicKeysByWiki includes applied topic keys (the new consolidation skip-list)", async () => {
    const sql = getDb();
    const live = await insertWikiProposal(mimirRow({ topicKey: "co-live" }));
    const applied = await insertWikiProposal(mimirRow({ topicKey: "co-applied", targetPath: "blogs/a.mdx" }));
    const rejected = await insertWikiProposal(mimirRow({ topicKey: "co-rejected", targetPath: "blogs/r.mdx" }));
    await sql`UPDATE wiki_proposals SET status = 'applied' WHERE id = ${applied!.id}`;
    await sql`UPDATE wiki_proposals SET status = 'rejected', resolved_at = now() WHERE id = ${rejected!.id}`;

    const skip = (await getLiveOrAppliedTopicKeysByWiki("mimir")).sort();
    expect(skip).toContain("co-live");
    expect(skip).toContain("co-applied");
    // A rejected topic is NOT in this skip-list (rejections are handled by the
    // TTL'd recently-rejected list, so a topic can be re-proposed after rejection).
    expect(skip).not.toContain("co-rejected");
    // getLiveTopicKeysByWiki (draft/approved only) does NOT include the applied one.
    expect(await getLiveTopicKeysByWiki("mimir")).toEqual(["co-live"]);
    expect(live!.status).toBe("draft");
  });

  test("dedup index is keyed on COALESCE(wiki_name, bot_name): a bot-keyed and a wiki-keyed row share a topic_key without colliding", async () => {
    // Same bot_name='jarvis' + same topic_key, but the mimir row's COALESCE key is
    // 'mimir' (wiki_name) while the legacy row's is 'jarvis' — no conflict.
    const legacy = await insertWikiProposal(makeProposal({ topicKey: "shared-key" }));
    const wiki = await insertWikiProposal(mimirRow({ topicKey: "shared-key" }));
    expect(legacy).not.toBeNull();
    expect(wiki).not.toBeNull();

    // Two live wiki-keyed rows for the SAME wiki + topic_key DO collide (no-op).
    const dup = await insertWikiProposal(mimirRow({ topicKey: "shared-key" }));
    expect(dup).toBeNull();

    // Retiring the live mimir row frees the topic for a fresh draft.
    await getDb()`UPDATE wiki_proposals SET status = 'applied' WHERE id = ${wiki!.id}`;
    const again = await insertWikiProposal(mimirRow({ topicKey: "shared-key" }));
    expect(again).not.toBeNull();
    expect(again!.id).not.toBe(wiki!.id);
  });
});
