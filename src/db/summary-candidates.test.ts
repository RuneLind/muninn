import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  upsertCandidate,
  listCandidates,
  getCandidateById,
  getCandidateBySourceUrl,
  setCandidateStatus,
  expireStaleCandidates,
} from "./summary-candidates.ts";

setupTestDb();

const base = {
  source: "anthropic",
  url: "https://platform.claude.com/docs/en/agents/tool-use.md",
  title: "Tool use",
  candidateSrc: "Docs (llms.txt)",
  score: 0.72,
  why: "relevant to agent work",
  botName: "jarvis",
};

describe("summary-candidates", () => {
  test("upsertCandidate inserts a new candidate with status 'new'", async () => {
    await upsertCandidate(base);
    const rows = await listCandidates({ source: "anthropic" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe(base.url);
    expect(rows[0]!.status).toBe("new");
    expect(rows[0]!.score).toBeCloseTo(0.72, 5);
    expect(rows[0]!.why).toBe("relevant to agent work");
    expect(rows[0]!.botName).toBe("jarvis");
  });

  test("upsert dedups by (source,url) and keeps the higher score", async () => {
    await upsertCandidate({ ...base, score: 0.6 });
    await upsertCandidate({ ...base, score: 0.9, why: "now a headliner" });
    const rows = await listCandidates({ source: "anthropic" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.score).toBeCloseTo(0.9, 5);
    expect(rows[0]!.why).toBe("now a headliner");
  });

  test("upsert keeps the existing higher score AND its paired why/title", async () => {
    await upsertCandidate({ ...base, score: 0.9, why: "headliner", title: "Big" });
    await upsertCandidate({ ...base, score: 0.5, why: "minor churn", title: "Small" });
    const [row] = await listCandidates({ source: "anthropic" });
    expect(row!.score).toBeCloseTo(0.9, 5);
    // why/title must stay paired with the winning (higher) score, not adopt the lower capture's.
    expect(row!.why).toBe("headliner");
    expect(row!.title).toBe("Big");
  });

  test("upsert does NOT resurrect a dismissed candidate", async () => {
    await upsertCandidate(base);
    const [row] = await listCandidates({ source: "anthropic" });
    await setCandidateStatus(row!.id, "dismissed");
    // A later capture of the same url must be a no-op (stays dismissed).
    await upsertCandidate({ ...base, score: 0.95 });
    const after = await getCandidateById(row!.id);
    expect(after!.status).toBe("dismissed");
    expect(after!.score).toBeCloseTo(0.72, 5);
  });

  test("listCandidates filters by status and orders by score desc", async () => {
    await upsertCandidate({ ...base, url: "https://a/1", score: 0.55 });
    await upsertCandidate({ ...base, url: "https://a/2", score: 0.95 });
    await upsertCandidate({ ...base, url: "https://a/3", score: 0.75 });
    const newOnes = await listCandidates({ status: "new" });
    expect(newOnes.map((c) => c.score)).toEqual([0.95, 0.75, 0.55]);

    const second = newOnes[1]!;
    await setCandidateStatus(second.id, "summarized", "anthropic-summaries/ai/claude/Doc.md");
    expect(await listCandidates({ status: "new" })).toHaveLength(2);

    const done = await listCandidates({ status: "summarized" });
    expect(done).toHaveLength(1);
    expect(done[0]!.docId).toBe("anthropic-summaries/ai/claude/Doc.md");
  });

  test("listCandidates accepts a status array and filters by botName", async () => {
    await upsertCandidate({ ...base, url: "https://a/j", botName: "jarvis", score: 0.6 });
    await upsertCandidate({ ...base, url: "https://a/m", botName: "melosys", score: 0.6 });
    expect(await listCandidates({ botName: "jarvis" })).toHaveLength(1);
    expect(await listCandidates({ status: ["new", "summarizing"] })).toHaveLength(2);
  });

  test("listCandidates accepts a source array (the inbox reads anthropic + x)", async () => {
    await upsertCandidate({ ...base, source: "anthropic", url: "https://a/1", score: 0.7 });
    await upsertCandidate({ ...base, source: "x", url: "https://x.com/u/1", score: 0.8 });
    await upsertCandidate({ ...base, source: "youtube", url: "https://yt/1", score: 0.9 });
    // A single source string still works (unchanged behavior).
    expect(await listCandidates({ source: "anthropic" })).toHaveLength(1);
    // The array form spans both verticals, still ordered by score desc.
    const both = await listCandidates({ source: ["anthropic", "x"] });
    expect(both.map((c) => c.source)).toEqual(["x", "anthropic"]);
    // No source filter returns every source.
    expect(await listCandidates({})).toHaveLength(3);
  });

  test("upsert round-trips source_doc_id, keeps newest non-null, never nulls it", async () => {
    await upsertCandidate({
      ...base,
      source: "x",
      url: "https://x.com/u/2",
      score: 0.7,
      sourceDocId: "2026-07-04_handle_12345.md",
    });
    const [row] = await listCandidates({ source: "x" });
    expect(row!.sourceDocId).toBe("2026-07-04_handle_12345.md");

    // A higher-score re-capture that omits the doc id must not null it out.
    await upsertCandidate({ ...base, source: "x", url: "https://x.com/u/2", score: 0.9 });
    const after = await getCandidateBySourceUrl("x", "https://x.com/u/2");
    expect(after!.score).toBeCloseTo(0.9, 5);
    expect(after!.sourceDocId).toBe("2026-07-04_handle_12345.md");

    // A re-capture carrying a FRESH doc id wins (huginn re-indexed under a new date).
    await upsertCandidate({
      ...base,
      source: "x",
      url: "https://x.com/u/2",
      score: 0.8,
      sourceDocId: "2026-07-06_handle_12345.md",
    });
    const reindexed = await getCandidateBySourceUrl("x", "https://x.com/u/2");
    expect(reindexed!.sourceDocId).toBe("2026-07-06_handle_12345.md");

    // Anthropic rows leave it null (resolve-by-URL behavior).
    await upsertCandidate({ ...base, url: "https://a/anthropic-null", score: 0.6 });
    const anth = await getCandidateBySourceUrl("anthropic", "https://a/anthropic-null");
    expect(anth!.sourceDocId).toBeNull();
  });

  test("upsert round-trips kind, keeps newest non-null, never nulls it", async () => {
    await upsertCandidate({ ...base, url: "https://a/kind-doc", score: 0.7, kind: "doc" });
    expect((await getCandidateBySourceUrl("anthropic", "https://a/kind-doc"))!.kind).toBe("doc");

    // X candidates carry x-post.
    await upsertCandidate({ ...base, source: "x", url: "https://x.com/u/k", score: 0.8, kind: "x-post" });
    expect((await getCandidateBySourceUrl("x", "https://x.com/u/k"))!.kind).toBe("x-post");

    // A re-capture that omits kind must not null the stored value.
    await upsertCandidate({ ...base, url: "https://a/kind-doc", score: 0.9 });
    const after = await getCandidateBySourceUrl("anthropic", "https://a/kind-doc");
    expect(after!.score).toBeCloseTo(0.9, 5);
    expect(after!.kind).toBe("doc");

    // A row captured without a kind leaves it null.
    await upsertCandidate({ ...base, url: "https://a/kind-null", score: 0.6 });
    expect((await getCandidateBySourceUrl("anthropic", "https://a/kind-null"))!.kind).toBeNull();
  });

  test("upsert round-trips author/author_score, keeps newest non-null, never nulls them", async () => {
    await upsertCandidate({
      ...base,
      source: "x",
      url: "https://x.com/u/author",
      score: 0.7,
      author: "karpathy",
      authorScore: 0.6,
    });
    const first = await getCandidateBySourceUrl("x", "https://x.com/u/author");
    expect(first!.author).toBe("karpathy");
    expect(first!.authorScore).toBeCloseTo(0.6, 5);

    // A re-capture that omits author/author_score must not null the stored values.
    await upsertCandidate({ ...base, source: "x", url: "https://x.com/u/author", score: 0.9 });
    const after = await getCandidateBySourceUrl("x", "https://x.com/u/author");
    expect(after!.score).toBeCloseTo(0.9, 5);
    expect(after!.author).toBe("karpathy");
    expect(after!.authorScore).toBeCloseTo(0.6, 5);

    // A newer non-null score wins (identity-derived, COALESCE-newest).
    await upsertCandidate({
      ...base,
      source: "x",
      url: "https://x.com/u/author",
      score: 0.95,
      author: "karpathy",
      authorScore: 0.72,
    });
    expect((await getCandidateBySourceUrl("x", "https://x.com/u/author"))!.authorScore).toBeCloseTo(0.72, 5);

    // Anthropic rows carry neither.
    await upsertCandidate({ ...base, url: "https://a/author-null", score: 0.6 });
    const anth = await getCandidateBySourceUrl("anthropic", "https://a/author-null");
    expect(anth!.author).toBeNull();
    expect(anth!.authorScore).toBeNull();
  });

  test("getCandidateBySourceUrl resolves a row by its (source,url) identity, with current status", async () => {
    expect(await getCandidateBySourceUrl("anthropic", base.url)).toBeNull();
    await upsertCandidate(base);
    const row = await getCandidateBySourceUrl("anthropic", base.url);
    expect(row).not.toBeNull();
    expect(row!.url).toBe(base.url);
    expect(row!.status).toBe("new");
    // Reflects the live status (the auto-promote dedup gate reads this).
    await setCandidateStatus(row!.id, "summarizing");
    expect((await getCandidateBySourceUrl("anthropic", base.url))!.status).toBe("summarizing");
    // Scoped by source — a different source with the same url path doesn't collide.
    expect(await getCandidateBySourceUrl("youtube", base.url)).toBeNull();
  });

  test("listCandidates summarizedWithinDays cuts old summarized rows but keeps other statuses", async () => {
    const sql = getDb();
    // A `new` row must NOT be cut by the summarized recency filter (only summarized is).
    await upsertCandidate({ ...base, url: "https://a/new-old", score: 0.5 });

    // An old summarized row (updated_at 30 days ago) — should be excluded.
    await upsertCandidate({ ...base, url: "https://a/done-old", score: 0.8 });
    const oldDone = (await getCandidateBySourceUrl("anthropic", "https://a/done-old"))!;
    await setCandidateStatus(oldDone.id, "summarized", "doc-old");
    await sql`UPDATE summary_candidates SET updated_at = now() - interval '30 days' WHERE id = ${oldDone.id}`;

    // A recent summarized row (updated_at 2 days ago) — should be kept.
    await upsertCandidate({ ...base, url: "https://a/done-new", score: 0.9 });
    const recentDone = (await getCandidateBySourceUrl("anthropic", "https://a/done-new"))!;
    await setCandidateStatus(recentDone.id, "summarized", "doc-new");
    await sql`UPDATE summary_candidates SET updated_at = now() - interval '2 days' WHERE id = ${recentDone.id}`;

    // Without the option, both summarized rows come back (honest full-history contract).
    const all = await listCandidates({ source: "anthropic" });
    expect(all.map((c) => c.url).sort()).toEqual([
      "https://a/done-new",
      "https://a/done-old",
      "https://a/new-old",
    ]);

    // With summarizedWithinDays: 7 the old summarized row drops; the `new` row stays.
    const cut = await listCandidates({ source: "anthropic", summarizedWithinDays: 7 });
    const urls = cut.map((c) => c.url).sort();
    expect(urls).toEqual(["https://a/done-new", "https://a/new-old"]);
    expect(urls).not.toContain("https://a/done-old");
  });

  test("expireStaleCandidates dismisses inactive new/error/summarizing rows, spares active + terminal ones", async () => {
    const sql = getDb();
    // Stale `new` (no activity for 15 days) → should be dismissed.
    await upsertCandidate({ ...base, url: "https://a/stale-new", score: 0.6 });
    const staleNew = (await getCandidateBySourceUrl("anthropic", "https://a/stale-new"))!;
    await sql`UPDATE summary_candidates SET created_at = now() - interval '15 days', updated_at = now() - interval '15 days' WHERE id = ${staleNew.id}`;

    // Stale `error` (no activity for 20 days) → should be dismissed.
    await upsertCandidate({ ...base, url: "https://a/stale-err", score: 0.6 });
    const staleErr = (await getCandidateBySourceUrl("anthropic", "https://a/stale-err"))!;
    await setCandidateStatus(staleErr.id, "error");
    await sql`UPDATE summary_candidates SET created_at = now() - interval '20 days', updated_at = now() - interval '20 days' WHERE id = ${staleErr.id}`;

    // Wedged `summarizing` (process crashed mid-job 30 days ago) → should be dismissed,
    // otherwise the summarize route 409s retries on it forever.
    await upsertCandidate({ ...base, url: "https://a/wedged", score: 0.6 });
    const wedged = (await getCandidateBySourceUrl("anthropic", "https://a/wedged"))!;
    await setCandidateStatus(wedged.id, "summarizing");
    await sql`UPDATE summary_candidates SET created_at = now() - interval '30 days', updated_at = now() - interval '30 days' WHERE id = ${wedged.id}`;

    // Old capture with RECENT activity (created 15 days ago, retried today → error
    // with fresh updated_at) → must NOT be expired; staleness keys on last activity.
    await upsertCandidate({ ...base, url: "https://a/retried", score: 0.6 });
    const retried = (await getCandidateBySourceUrl("anthropic", "https://a/retried"))!;
    await setCandidateStatus(retried.id, "error");
    await sql`UPDATE summary_candidates SET created_at = now() - interval '15 days' WHERE id = ${retried.id}`;

    // Fresh `new` → untouched.
    await upsertCandidate({ ...base, url: "https://a/fresh-new", score: 0.6 });
    const freshNew = (await getCandidateBySourceUrl("anthropic", "https://a/fresh-new"))!;

    // Old `summarized` → terminal, must be spared even though it's old.
    await upsertCandidate({ ...base, url: "https://a/old-done", score: 0.6 });
    const oldDone = (await getCandidateBySourceUrl("anthropic", "https://a/old-done"))!;
    await setCandidateStatus(oldDone.id, "summarized", "doc-x");
    await sql`UPDATE summary_candidates SET created_at = now() - interval '90 days', updated_at = now() - interval '90 days' WHERE id = ${oldDone.id}`;

    const expired = await expireStaleCandidates(14);
    expect(expired).toBe(3);

    expect((await getCandidateById(staleNew.id))!.status).toBe("dismissed");
    expect((await getCandidateById(staleErr.id))!.status).toBe("dismissed");
    expect((await getCandidateById(wedged.id))!.status).toBe("dismissed");
    expect((await getCandidateById(retried.id))!.status).toBe("error");
    expect((await getCandidateById(freshNew.id))!.status).toBe("new");
    expect((await getCandidateById(oldDone.id))!.status).toBe("summarized");
  });

  test("setCandidateStatus with null docId leaves an existing doc_id untouched", async () => {
    await upsertCandidate(base);
    const [row] = await listCandidates({ source: "anthropic" });
    await setCandidateStatus(row!.id, "summarized", "doc-1");
    await setCandidateStatus(row!.id, "error"); // no docId passed
    const after = await getCandidateById(row!.id);
    expect(after!.status).toBe("error");
    expect(after!.docId).toBe("doc-1");
  });
});
