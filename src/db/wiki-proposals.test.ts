import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  insertWikiProposal,
  getWikiProposalById,
  listWikiProposalsByStatus,
  getLiveTopicKeys,
  getRejectedTopicKeys,
  getRecentlyRejectedTopicKeys,
  getConsumedDocIds,
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
});
