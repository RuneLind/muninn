import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  getSummaryFactcheck,
  listSummaryFactcheckBadges,
  upsertSummaryFactcheck,
  type SummaryFactcheckInput,
} from "./summary-factchecks.ts";

setupTestDb();

const base: SummaryFactcheckInput = {
  collection: "youtube-summaries",
  docId: "health/sleep/A talk.md",
  url: "https://www.youtube.com/watch?v=abc",
  bodySha256: "a".repeat(64),
  answer: "### ✅ Claim 1/2 — x\n\n### ❌ Claim 2/2 — y",
  claims: [
    { index: 1, title: "x", verdict: "✅", outcome: "verified", confidence: 90, sources: ["https://a.example"] },
    { index: 2, title: "y", quote: "y said", verdict: "❌", outcome: "verified", sources: [] },
  ],
  botName: "jarvis",
};

describe("summary_factchecks", () => {
  test("round-trips a row, timestamps as epoch ms", async () => {
    const saved = await upsertSummaryFactcheck(base);
    const got = await getSummaryFactcheck(base.collection, base.docId);
    expect(got).toEqual(saved);
    expect(got!.claims).toEqual(base.claims);
    expect(typeof got!.createdAt).toBe("number");
    expect(Math.abs(got!.createdAt - Date.now())).toBeLessThan(60_000);
  });

  test("an unknown document is null", async () => {
    expect(await getSummaryFactcheck("youtube-summaries", "nope.md")).toBeNull();
  });

  test("a re-check REPLACES the row (one row per document)", async () => {
    await upsertSummaryFactcheck(base);
    await getDb()`UPDATE summary_factchecks SET created_at = now() - interval '2 days'`;
    const second = await upsertSummaryFactcheck({ ...base, bodySha256: "b".repeat(64), answer: "new", claims: [], url: null });
    const rows = await getDb()`SELECT count(*)::int AS n FROM summary_factchecks`;
    expect(rows[0]!.n).toBe(1);
    expect(second.answer).toBe("new");
    expect(second.url).toBeNull();
    expect(second.bodySha256).toBe("b".repeat(64));
    // created_at moves with the replacement — it dates the result shown.
    expect(Date.now() - second.createdAt).toBeLessThan(60_000);
  });

  test("the same doc id in another collection is a separate row", async () => {
    await upsertSummaryFactcheck(base);
    await upsertSummaryFactcheck({ ...base, collection: "article-summaries", url: null });
    expect((await getSummaryFactcheck("article-summaries", base.docId))!.url).toBeNull();
    expect((await getSummaryFactcheck(base.collection, base.docId))!.url).toBe(base.url);
  });

  test("badges count ❌ claims and the total, in one listing", async () => {
    await upsertSummaryFactcheck(base);
    await upsertSummaryFactcheck({ ...base, docId: "clean.md", claims: [base.claims[0]!] });
    const badges = (await listSummaryFactcheckBadges()).sort((a, b) => a.docId.localeCompare(b.docId));
    expect(badges).toEqual([
      { collection: "youtube-summaries", docId: "clean.md", bad: 0, total: 1 },
      { collection: "youtube-summaries", docId: "health/sleep/A talk.md", bad: 1, total: 2 },
    ]);
  });
});
