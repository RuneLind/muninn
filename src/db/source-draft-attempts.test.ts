import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  recordSourceDraftAttempt,
  getSourceDraftAttempts,
  deleteSourceDraftAttempt,
  deleteSourceDraftAttemptForProposal,
} from "./source-draft-attempts.ts";

setupTestDb();

const base = {
  botName: "jarvis",
  collection: "x-articles",
  docId: "ai/general/First, the graph itself.md",
  outcome: "skipped" as const,
  degraded: false,
  reason: 'drafter judged the existing page "Graph Engineering" already covers this doc',
  title: "Graph Engineering for Multi-Agentic Systems",
  collidingPath: "concepts/Graph Engineering for Multi-Agentic Systems.md",
  proposalId: null,
  trigger: "capture" as const,
};

describe("source-draft-attempts", () => {
  test("no attempts → an empty map (the pre-ledger render path)", async () => {
    expect((await getSourceDraftAttempts("nobody")).size).toBe(0);
  });

  test("records a skip and reads it back keyed <collection>/<docId>", async () => {
    await recordSourceDraftAttempt(base);
    const byKey = await getSourceDraftAttempts("jarvis");
    const row = byKey.get(`${base.collection}/${base.docId}`);
    expect(row).toBeDefined();
    expect(row!.outcome).toBe("skipped");
    expect(row!.reason).toContain("already covers");
    expect(row!.collidingPath).toBe("concepts/Graph Engineering for Multi-Agentic Systems.md");
    expect(row!.trigger).toBe("capture");
    expect(typeof row!.attemptedAt).toBe("number");
  });

  test("a retry UPSERTS — one row per doc, describing the MOST RECENT run", async () => {
    await recordSourceDraftAttempt(base);
    const first = (await getSourceDraftAttempts("jarvis")).get(`${base.collection}/${base.docId}`)!;
    await recordSourceDraftAttempt({
      ...base,
      outcome: "drafted",
      reason: null,
      collidingPath: null,
      title: "First, the Graph Itself",
      proposalId: "11111111-1111-4111-8111-111111111111",
      trigger: "doc",
    });
    const byKey = await getSourceDraftAttempts("jarvis");
    const rows = [...byKey.values()].filter((r) => r.docId === base.docId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe("drafted");
    expect(rows[0]!.collidingPath).toBeNull();
    expect(rows[0]!.proposalId).toBe("11111111-1111-4111-8111-111111111111");
    expect(rows[0]!.attemptedAt).toBeGreaterThanOrEqual(first.attemptedAt);
  });

  // A rejected proposal / a deleted doc makes the recorded outcome a lie: the row
  // would keep saying "drafted" about a gate entry that no longer exists, and a
  // re-capture under the same id would inherit a months-old skip reason.
  test("delete drops the row for that bot+doc only", async () => {
    await recordSourceDraftAttempt(base);
    await recordSourceDraftAttempt({ ...base, docId: "other.md" });
    await deleteSourceDraftAttempt("jarvis", base.collection, base.docId);
    const byKey = await getSourceDraftAttempts("jarvis");
    expect(byKey.get(`${base.collection}/${base.docId}`)).toBeUndefined();
    expect(byKey.get(`${base.collection}/other.md`)).toBeDefined();
  });

  test("deleting a doc that was never attempted is a no-op, not an error", async () => {
    await deleteSourceDraftAttempt("jarvis", "x-articles", "never-seen.md");
  });

  // A gardener CONCEPT proposal lists every member doc in `source_docs`. Keying the
  // reject cleanup on those docs blanked the "why" line for members whose OWN source
  // draft was still live in the gate — so it is keyed on the proposal instead.
  test("deleteForProposal drops only the row that proposal produced", async () => {
    const P = "22222222-2222-4222-8222-222222222222";
    await recordSourceDraftAttempt({
      ...base,
      docId: "member-a.md",
      outcome: "drafted",
      proposalId: P,
    });
    await recordSourceDraftAttempt({ ...base, docId: "member-b.md" }); // same wave, own skip
    await recordSourceDraftAttempt({
      ...base,
      docId: "member-c.md",
      outcome: "drafted",
      proposalId: "33333333-3333-4333-8333-333333333333",
    });

    await deleteSourceDraftAttemptForProposal(P);

    const byKey = await getSourceDraftAttempts("jarvis");
    expect(byKey.get(`${base.collection}/member-a.md`)).toBeUndefined();
    expect(byKey.get(`${base.collection}/member-b.md`)).toBeDefined();
    expect(byKey.get(`${base.collection}/member-c.md`)).toBeDefined();
  });

  test("deleteForProposal for an unknown proposal is a no-op", async () => {
    await recordSourceDraftAttempt(base);
    await deleteSourceDraftAttemptForProposal("44444444-4444-4444-8444-444444444444");
    expect((await getSourceDraftAttempts("jarvis")).size).toBe(1);
  });

  test("scoped per bot — another bot's wiki never inherits an attempt", async () => {
    await recordSourceDraftAttempt(base);
    await recordSourceDraftAttempt({ ...base, botName: "melosys", outcome: "error", reason: "boom" });
    expect((await getSourceDraftAttempts("jarvis")).get(`${base.collection}/${base.docId}`)!.outcome).toBe(
      "skipped",
    );
    expect((await getSourceDraftAttempts("melosys")).get(`${base.collection}/${base.docId}`)!.outcome).toBe(
      "error",
    );
  });
});
