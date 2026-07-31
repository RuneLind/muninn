import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { recordSourceDraftAttempt, getSourceDraftAttempts } from "./source-draft-attempts.ts";

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
