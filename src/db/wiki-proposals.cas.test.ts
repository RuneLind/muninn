import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  insertWikiProposal,
  approveWikiProposal,
  rejectWikiProposal,
  markWikiProposalApplied,
  markWikiProposalStale,
  markWikiProposalError,
  listAllWikiProposals,
  countDraftWikiProposals,
  getWikiProposalById,
  type InsertWikiProposalParams,
} from "./wiki-proposals.ts";

setupTestDb();

let seq = 0;
function draftParams(overrides: Partial<InsertWikiProposalParams> = {}): InsertWikiProposalParams {
  seq++;
  return {
    botName: "jarvis",
    topicKey: `topic-${seq}`,
    kind: "concept",
    mode: "create",
    targetPath: `concepts/Topic ${seq}.md`,
    draft: "---\ntype: concept\ntitle: T\n---\n\n# T\n\nbody",
    sourceDocs: [{ collection: "youtube-summaries", docId: "a", title: "A", url: "https://x/a" }],
    ...overrides,
  };
}

describe("wiki-proposals CAS transitions", () => {
  test("approve flips draft → approved and returns the row", async () => {
    const row = (await insertWikiProposal(draftParams()))!;
    const approved = await approveWikiProposal(row.id);
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");
  });

  test("reject flips draft → rejected and stamps resolved_at", async () => {
    const row = (await insertWikiProposal(draftParams()))!;
    const rejected = await rejectWikiProposal(row.id);
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.resolvedAt).not.toBeNull();
  });

  test("approve only works from draft — a rejected row can't be approved", async () => {
    const row = (await insertWikiProposal(draftParams()))!;
    await rejectWikiProposal(row.id);
    const approved = await approveWikiProposal(row.id);
    expect(approved).toBeNull();
  });

  test("reject only works from draft — an approved row can't be rejected", async () => {
    const row = (await insertWikiProposal(draftParams()))!;
    await approveWikiProposal(row.id);
    const rejected = await rejectWikiProposal(row.id);
    expect(rejected).toBeNull();
  });

  test("concurrent approve loses cleanly — exactly one winner", async () => {
    const row = (await insertWikiProposal(draftParams()))!;
    const [a, b] = await Promise.all([
      approveWikiProposal(row.id),
      approveWikiProposal(row.id),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners.length).toBe(1);
  });

  test("applied/stale/error only transition from approved", async () => {
    const row = (await insertWikiProposal(draftParams()))!;
    // From draft directly → null (not approved yet).
    expect(await markWikiProposalApplied(row.id)).toBeNull();
    expect(await markWikiProposalStale(row.id)).toBeNull();
    expect(await markWikiProposalError(row.id)).toBeNull();

    await approveWikiProposal(row.id);
    const applied = await markWikiProposalApplied(row.id);
    expect(applied!.status).toBe("applied");
    expect(applied!.resolvedAt).not.toBeNull();
  });

  test("approved → stale marks resolved_at", async () => {
    const row = (await insertWikiProposal(draftParams()))!;
    await approveWikiProposal(row.id);
    const stale = await markWikiProposalStale(row.id);
    expect(stale!.status).toBe("stale");
    expect(stale!.resolvedAt).not.toBeNull();
  });

  test("countDraftWikiProposals counts only drafts for the bot", async () => {
    const a = (await insertWikiProposal(draftParams()))!;
    (await insertWikiProposal(draftParams()))!;
    await approveWikiProposal(a.id); // no longer a draft
    (await insertWikiProposal(draftParams({ botName: "other" })))!;

    const n = await countDraftWikiProposals("jarvis");
    // Two jarvis drafts inserted, one approved away → 1 draft remains (plus any
    // earlier tests were truncated between cases by setupTestDb).
    expect(n).toBe(1);
  });

  test("listAllWikiProposals returns every status newest-first", async () => {
    const a = (await insertWikiProposal(draftParams()))!;
    const b = (await insertWikiProposal(draftParams()))!;
    await rejectWikiProposal(b.id);
    const all = await listAllWikiProposals("jarvis");
    expect(all.length).toBe(2);
    // Newest first: b inserted after a.
    expect(all[0]!.id).toBe(b.id);
    expect(all.map((p) => p.status).sort()).toEqual(["draft", "rejected"]);

    const roundtrip = await getWikiProposalById(a.id);
    expect(roundtrip!.status).toBe("draft");
  });
});
