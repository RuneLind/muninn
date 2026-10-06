// Run only under the shared test-DB lock: a case here drops and re-adds the
// transcript columns on the shared schema, which fails any suite running beside it.
import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  getSummaryFactcheck,
  getSummaryFactcheckVersioned,
  listSummaryFactcheckBadges,
  markSummaryFactcheckApplied,
  summaryFactchecksHasAppliedAt,
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

describe("summary_factchecks: applied_at and the apply CAS (migration 080)", () => {
  const answerSha = (answer: string) => new Bun.CryptoHasher("sha256").update(answer).digest("hex");
  /** A fixed microsecond value: `now()` lands on a multiple of 1000 µs about once
   *  in a thousand runs, and Postgres then prints fewer digits. */
  const pinCreatedAt = () => getDb()`UPDATE summary_factchecks SET created_at = '2026-10-05 12:00:00.123456+00'`;

  test("the column exists, and the probe says so", async () => {
    expect(await summaryFactchecksHasAppliedAt()).toBe(true);
  });

  test("a stamp on the row read in this request sets applied_at and the new hash", async () => {
    await upsertSummaryFactcheck(base);
    await pinCreatedAt();
    const row = (await getSummaryFactcheckVersioned(base.collection, base.docId))!;
    expect(row.appliedAt).toBeNull();
    // Full precision: the microseconds the epoch-ms value drops.
    expect(row.createdAtText).toContain(".123456");
    const ok = await markSummaryFactcheckApplied({
      collection: base.collection,
      docId: base.docId,
      createdAtText: row.createdAtText,
      answerSha256: answerSha(base.answer),
      bodySha256: "c".repeat(64),
    });
    expect(ok).toBe(true);
    const after = (await getSummaryFactcheck(base.collection, base.docId))!;
    expect(after.bodySha256).toBe("c".repeat(64));
    expect(after.appliedAt).not.toBeNull();
  });

  test("the epoch-ms created_at does not match the row (the CAS needs the text)", async () => {
    await upsertSummaryFactcheck(base);
    await pinCreatedAt();
    const row = (await getSummaryFactcheckVersioned(base.collection, base.docId))!;
    const ok = await markSummaryFactcheckApplied({
      collection: base.collection,
      docId: base.docId,
      createdAtText: new Date(row.createdAt).toISOString(),
      answerSha256: answerSha(base.answer),
      bodySha256: "c".repeat(64),
    });
    expect(ok).toBe(false);
  });

  test("a re-check that landed during the apply wins: 0 rows, row stays un-applied", async () => {
    await upsertSummaryFactcheck(base);
    const read = (await getSummaryFactcheckVersioned(base.collection, base.docId))!;
    await upsertSummaryFactcheck({ ...base, answer: "a newer check" });
    const ok = await markSummaryFactcheckApplied({
      collection: base.collection,
      docId: base.docId,
      createdAtText: read.createdAtText,
      answerSha256: answerSha(base.answer),
      bodySha256: "c".repeat(64),
    });
    expect(ok).toBe(false);
    const row = (await getSummaryFactcheck(base.collection, base.docId))!;
    expect(row.appliedAt).toBeNull();
    expect(row.bodySha256).toBe(base.bodySha256);
  });

  test("a re-check clears applied_at", async () => {
    await upsertSummaryFactcheck(base);
    await getDb()`UPDATE summary_factchecks SET applied_at = now()`;
    expect((await getSummaryFactcheck(base.collection, base.docId))!.appliedAt).not.toBeNull();
    const again = await upsertSummaryFactcheck(base);
    expect(again.appliedAt).toBeNull();
  });
});

describe("summary_factchecks: the upsert without migration 081's columns (080 present)", () => {
  test("a replacement still clears applied_at", async () => {
    const sql = getDb();
    await upsertSummaryFactcheck(base);
    await sql`UPDATE summary_factchecks SET applied_at = now()`;
    await sql.unsafe("ALTER TABLE summary_factchecks DROP COLUMN transcript_claims, DROP COLUMN transcript_sha256");
    try {
      const again = await upsertSummaryFactcheck({ ...base, answer: "replaced" });
      expect(again.answer).toBe("replaced");
      expect(again.appliedAt).toBeNull();
      expect(again.transcript).toBeNull();
    } finally {
      await sql.unsafe(
        "ALTER TABLE summary_factchecks ADD COLUMN IF NOT EXISTS transcript_claims JSONB, ADD COLUMN IF NOT EXISTS transcript_sha256 TEXT",
      );
    }
  });
});
