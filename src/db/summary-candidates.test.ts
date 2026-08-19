import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import {
  upsertCandidate,
  upsertDestinationCandidate,
  listCandidates,
  getCandidateById,
  getCandidateBySourceUrl,
  setCandidateStatus,
  expireStaleCandidates,
  candidateOutcomeStats,
  candidateRecentStats,
  RECENT_WINDOW_DEFAULT_DAYS,
  ACCEPTANCE_TARGET,
  HYPE_DEDUP_SWEEP_REASON,
} from "./summary-candidates.ts";
import {
  REPACKAGING_CLAMP_SHIPPED_AT,
  REPACKAGING_SCORE_CAP,
} from "../watchers/repackaging-shape.ts";

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

  // --- Destination-keyed pointer rows (X hype-dedup step 2a) ---

  const destUrl = "https://example.com/announce";
  const member = (over: Record<string, unknown>) => ({
    ...base,
    source: "x",
    url: destUrl,
    kind: "x-link" as const,
    ...over,
  });

  test("upsertDestinationCandidate replaces the WHOLE set when a better member arrives", async () => {
    await upsertDestinationCandidate(
      member({ score: 0.75, why: "dave says watch", title: "@dave: drop", candidateSrc: "X (@dave)", author: "dave", authorScore: 0.6, sourceDocId: "d1.md" }),
    );
    await upsertDestinationCandidate(
      member({ score: 0.9, why: "frank: the source", title: "@frank: drop", candidateSrc: "X (@frank)", author: "frank", authorScore: 0.8, sourceDocId: "f1.md" }),
    );

    const row = (await getCandidateBySourceUrl("x", destUrl))!;
    // Every field belongs to the SAME (winning) member — no mixed precedence.
    expect(row.score).toBeCloseTo(0.9, 5);
    expect(row.why).toBe("frank: the source");
    expect(row.title).toBe("@frank: drop");
    expect(row.candidateSrc).toBe("X (@frank)");
    expect(row.author).toBe("frank");
    expect(row.authorScore).toBeCloseTo(0.8, 5);
    expect(row.sourceDocId).toBe("f1.md");
    expect(await listCandidates({ source: "x" })).toHaveLength(1);
  });

  test("upsertDestinationCandidate leaves the stored representative alone when it wins or ties", async () => {
    await upsertDestinationCandidate(member({ score: 0.9, why: "winner", sourceDocId: "f1.md" }));
    await upsertDestinationCandidate(member({ score: 0.72, why: "late arrival", sourceDocId: "g1.md" }));
    await upsertDestinationCandidate(member({ score: 0.9, why: "exact tie", sourceDocId: "h1.md" }));

    const row = (await getCandidateBySourceUrl("x", destUrl))!;
    expect(row.score).toBeCloseTo(0.9, 5);
    expect(row.why).toBe("winner");
    expect(row.sourceDocId).toBe("f1.md");
  });

  test("upsertDestinationCandidate never resurrects a MANUALLY dismissed destination row", async () => {
    await upsertDestinationCandidate(member({ score: 0.7, why: "first" }));
    const first = (await getCandidateBySourceUrl("x", destUrl))!;
    await setCandidateStatus(first.id, "dismissed", null, "manual");

    await upsertDestinationCandidate(member({ score: 0.98, why: "loud new wave member" }));

    const after = (await getCandidateById(first.id))!;
    expect(after.status).toBe("dismissed");
    expect(after.score).toBeCloseTo(0.7, 5);
    expect(after.why).toBe("first");
  });

  test("a summarized destination row stays terminal", async () => {
    await upsertDestinationCandidate(member({ score: 0.7, why: "first" }));
    const first = (await getCandidateBySourceUrl("x", destUrl))!;
    await setCandidateStatus(first.id, "summarized", "ai/x/doc.md");

    await upsertDestinationCandidate(member({ score: 0.99, why: "later member" }));

    const after = (await getCandidateById(first.id))!;
    expect(after.status).toBe("summarized");
    expect(after.score).toBeCloseTo(0.7, 5);
    expect(after.docId).toBe("ai/x/doc.md");
  });

  test("upsertDestinationCandidate reports whether a row was ACTUALLY written", async () => {
    // Load-bearing for the step-2b wave admission, which logs "admitted from @author" and
    // counts the destination as captured — both would be lies on a suppressed write, since
    // an ON CONFLICT … DO UPDATE whose WHERE fails raises nothing.
    expect(await upsertDestinationCandidate(member({ score: 0.7, why: "insert" }))).toBe(true);
    expect(await upsertDestinationCandidate(member({ score: 0.9, why: "replace" }))).toBe(true);
    // A tie/loss still bumps updated_at ⇒ a row IS written.
    expect(await upsertDestinationCandidate(member({ score: 0.5, why: "loser" }))).toBe(true);

    const first = (await getCandidateBySourceUrl("x", destUrl))!;
    await setCandidateStatus(first.id, "dismissed", null, "manual");
    expect(await upsertDestinationCandidate(member({ score: 0.99, why: "suppressed" }))).toBe(false);
  });

  test("an `error` row is re-admitted by a better later member (its only recovery path)", async () => {
    await upsertDestinationCandidate(member({ score: 0.7, why: "first", sourceDocId: "d1.md" }));
    const first = (await getCandidateBySourceUrl("x", destUrl))!;
    await setCandidateStatus(first.id, "error");

    await upsertDestinationCandidate(
      member({ score: 0.9, why: "second wave member", sourceDocId: "d2.md" }),
    );

    const after = (await getCandidateById(first.id))!;
    expect(after.status).toBe("new");
    expect(after.score).toBeCloseTo(0.9, 5);
    expect(after.why).toBe("second wave member");
    expect(after.sourceDocId).toBe("d2.md");
  });

  test("an AUTO-EXPIRED row is re-admitted — expiry is bookkeeping, not a judgement", async () => {
    await upsertDestinationCandidate(member({ score: 0.7, why: "first" }));
    const first = (await getCandidateBySourceUrl("x", destUrl))!;
    // Age it past the 14-day floor, then run the real expiry sweep.
    const sql = getDb();
    await sql`UPDATE summary_candidates SET created_at = now() - interval '30 days', updated_at = now() - interval '30 days' WHERE id = ${first.id}`;
    expect(await expireStaleCandidates(14)).toBeGreaterThan(0);
    expect((await getCandidateById(first.id))!.dismissedReason).toBe("expired");

    await upsertDestinationCandidate(member({ score: 0.97, why: "the 0.97 wave" }));

    const after = (await getCandidateById(first.id))!;
    expect(after.status).toBe("new");
    expect(after.dismissedReason).toBeNull();
    expect(after.score).toBeCloseTo(0.97, 5);
    expect(after.why).toBe("the 0.97 wave");
  });

  test("a SWEPT row is re-admitted — the backlog sweep is bulk bookkeeping, not a judgement", async () => {
    // The one-shot hype-dedup sweep clears a pre-calibration shelf in bulk. If that reason
    // were terminal, a swept destination key would be poisoned forever and silently swallow
    // every later wave member — exactly the failure the 'expired' carve-out exists to stop.
    await upsertDestinationCandidate(member({ score: 0.7, why: "pre-calibration capture" }));
    const first = (await getCandidateBySourceUrl("x", destUrl))!;
    await setCandidateStatus(first.id, "dismissed", null, HYPE_DEDUP_SWEEP_REASON);

    expect(
      await upsertDestinationCandidate(member({ score: 0.96, why: "post-sweep 0.96 wave" })),
    ).toBe(true);

    const after = (await getCandidateById(first.id))!;
    expect(after.status).toBe("new");
    expect(after.dismissedReason).toBeNull();
    expect(after.score).toBeCloseTo(0.96, 5);
    expect(after.why).toBe("post-sweep 0.96 wave");
  });

  test("a tie bumps updated_at (expiry clock) without touching any content column", async () => {
    await upsertDestinationCandidate(member({ score: 0.9, why: "winner", sourceDocId: "f1.md" }));
    const first = (await getCandidateBySourceUrl("x", destUrl))!;
    // Backdate so the bump is unambiguous even on a fast clock.
    const sql = getDb();
    await sql`UPDATE summary_candidates SET updated_at = now() - interval '10 days' WHERE id = ${first.id}`;
    const stale = (await getCandidateById(first.id))!;

    await upsertDestinationCandidate(member({ score: 0.9, why: "exact tie", sourceDocId: "h1.md" }));

    const after = (await getCandidateById(first.id))!;
    expect(after.updatedAt).toBeGreaterThan(stale.updatedAt);
    expect(after.score).toBeCloseTo(0.9, 5);
    expect(after.why).toBe("winner");
    expect(after.sourceDocId).toBe("f1.md");
    expect(after.status).toBe("new");
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

  describe("candidateOutcomeStats", () => {
    // Small factory: upsert a candidate then drive it to a terminal outcome.
    // status 'summarized' records a doc; a dismissal takes an explicit reason
    // ('manual' / 'expired'); omit the reason to leave it NULL ("unknown").
    async function seedOutcome(
      slug: string,
      score: number,
      kind: "doc" | "commit" | "release" | "blog" | "x-post",
      status: "summarized" | "dismissed" | "error",
      reason?: "manual" | "expired" | typeof HYPE_DEDUP_SWEEP_REASON,
      source = "anthropic",
    ) {
      const url = "https://o/" + slug;
      await upsertCandidate({ ...base, source, url, score, kind });
      const row = (await getCandidateBySourceUrl(source, url))!;
      if (status === "summarized") await setCandidateStatus(row.id, "summarized", "doc-" + slug);
      else if (status === "dismissed") await setCandidateStatus(row.id, "dismissed", null, reason ?? null);
      else await setCandidateStatus(row.id, "error");
      return row;
    }

    test("separates dismissed reasons; acceptance excludes expired + unknown; ignores pending rows", async () => {
      await seedOutcome("s1", 0.7, "doc", "summarized");
      await seedOutcome("s2", 0.7, "doc", "summarized");
      await seedOutcome("dm", 0.7, "doc", "dismissed", "manual");
      await seedOutcome("dx", 0.7, "doc", "dismissed", "expired");
      await seedOutcome("du", 0.7, "doc", "dismissed"); // NULL reason = unknown
      // A still-`new` row must not count toward any outcome.
      await upsertCandidate({ ...base, url: "https://o/pending", score: 0.7, kind: "doc" });

      const stats = await candidateOutcomeStats();
      const doc = stats.byKind.find((k) => k.source === "anthropic" && k.kind === "doc")!;
      expect(doc).toBeDefined();
      expect(doc.summarized).toBe(2);
      expect(doc.dismissedManual).toBe(1);
      expect(doc.dismissedExpired).toBe(1);
      expect(doc.dismissedUnknown).toBe(1);
      expect(doc.error).toBe(0);
      // total counts scored outcomes only — the pending `new` row is excluded.
      expect(doc.total).toBe(5);
      // acceptance = summarized / (summarized + manual) = 2/3; expired + unknown are OUT.
      expect(doc.acceptanceRate).toBeCloseTo(2 / 3, 3);
    });

    test("hype-dedup-sweep rows get their own bucket: counted in total, OUT of the acceptance denominator", async () => {
      await seedOutcome("hs1", 0.9, "x-post", "summarized", undefined, "x");
      await seedOutcome("hm1", 0.9, "x-post", "dismissed", "manual", "x");
      // The one-shot backlog sweep bulk-dismisses a pre-calibration shelf.
      await seedOutcome("hw1", 0.9, "x-post", "dismissed", HYPE_DEDUP_SWEEP_REASON, "x");
      await seedOutcome("hw2", 0.9, "x-post", "dismissed", HYPE_DEDUP_SWEEP_REASON, "x");

      const stats = await candidateOutcomeStats();
      const x = stats.byKind.find((k) => k.source === "x" && k.kind === "x-post")!;
      expect(x).toBeDefined();
      expect(x.dismissedSwept).toBe(2);
      // Swept rows land in NEITHER manual nor unknown.
      expect(x.dismissedManual).toBe(1);
      expect(x.dismissedUnknown).toBe(0);
      expect(x.dismissedExpired).toBe(0);
      // total includes them …
      expect(x.total).toBe(4);
      // … but the rate is still summarized / (summarized + manual) = 1/2, untouched.
      expect(x.acceptanceRate).toBeCloseTo(0.5, 3);

      // Same honesty in the score-band histogram.
      const band = stats.byBand.find((b) => b.band === 0.9)!;
      expect(band.dismissedSwept).toBe(2);
      expect(band.total).toBe(4);
      expect(band.acceptanceRate).toBeCloseTo(0.5, 3);
    });

    test("an UNCLASSIFIED dismissed_reason lands in the catch-all bucket, still counted in total", async () => {
      // dismissed_reason is free text: a future sweep/auto-dismisser must not silently
      // fall out of `total` (which would make the shelf accounting quietly wrong).
      await seedOutcome("os1", 0.7, "doc", "summarized");
      await seedOutcome("om1", 0.7, "doc", "dismissed", "manual");
      const other = await seedOutcome("oo1", 0.7, "doc", "dismissed");
      const sql = getDb();
      await sql`UPDATE summary_candidates SET dismissed_reason = 'some-future-sweep' WHERE id = ${other.id}`;

      const stats = await candidateOutcomeStats();
      const doc = stats.byKind.find((k) => k.source === "anthropic" && k.kind === "doc")!;
      expect(doc.dismissedOther).toBe(1);
      // It is NOT miscounted as any of the known buckets.
      expect(doc.dismissedManual).toBe(1);
      expect(doc.dismissedExpired).toBe(0);
      expect(doc.dismissedSwept).toBe(0);
      expect(doc.dismissedUnknown).toBe(0);
      // Counted in total …
      expect(doc.total).toBe(3);
      // … but OUT of the acceptance denominator: 1/(1+1).
      expect(doc.acceptanceRate).toBeCloseTo(0.5, 3);

      const band = stats.byBand.find((b) => b.band === 0.7)!;
      expect(band.dismissedOther).toBe(1);
      expect(band.total).toBe(3);
    });

    test("acceptanceRate is null when there are no accept/reject decisions", async () => {
      // Only an expired dismissal — the denominator (summarized + manual) is 0.
      await seedOutcome("only-expired", 0.6, "doc", "dismissed", "expired");
      const stats = await candidateOutcomeStats();
      const doc = stats.byKind.find((k) => k.kind === "doc")!;
      expect(doc.summarized + doc.dismissedManual).toBe(0);
      expect(doc.acceptanceRate).toBeNull();
    });

    test("expireStaleCandidates stamps dismissed_reason='expired'; a manual dismiss keeps 'manual'", async () => {
      const sql = getDb();
      await upsertCandidate({ ...base, url: "https://o/stale", score: 0.6, kind: "doc" });
      const stale = (await getCandidateBySourceUrl("anthropic", "https://o/stale"))!;
      await sql`UPDATE summary_candidates SET created_at = now() - interval '20 days', updated_at = now() - interval '20 days' WHERE id = ${stale.id}`;

      const man = await seedOutcome("man", 0.6, "doc", "dismissed", "manual");

      const n = await expireStaleCandidates(14);
      expect(n).toBe(1); // only the stale non-terminal row
      const expired = (await getCandidateById(stale.id))!;
      expect(expired.status).toBe("dismissed");
      expect(expired.dismissedReason).toBe("expired");
      // The already-dismissed manual row is terminal — expire never touches it.
      expect((await getCandidateById(man.id))!.dismissedReason).toBe("manual");
    });

    test("suggests the lowest floor whose at-or-above acceptance ≥ 0.5, and bins score bands float-safely", async () => {
      // commit kind across three bands with known accept/reject:
      //   0.9: 3 summarized, 0 manual   (this band 1.0)
      //   0.7: 1 summarized, 1 manual   (this band 0.5)
      //   0.5: 0 summarized, 5 manual   (this band 0.0)
      // Cumulative-from-top: ≥0.9 → 3/3=1.0 ; ≥0.7 → 4/5=0.8 ; ≥0.5 → 4/10=0.4.
      // Lowest floor still clearing 0.5 is 0.7.
      await seedOutcome("c9a", 0.9, "commit", "summarized");
      await seedOutcome("c9b", 0.9, "commit", "summarized");
      await seedOutcome("c9c", 0.9, "commit", "summarized");
      await seedOutcome("c7a", 0.7, "commit", "summarized");
      await seedOutcome("c7b", 0.7, "commit", "dismissed", "manual");
      for (let i = 0; i < 5; i++) await seedOutcome("c5_" + i, 0.5, "commit", "dismissed", "manual");

      const stats = await candidateOutcomeStats();
      const commit = stats.suggestedFloors.find((s) => s.kind === "commit")!;
      expect(commit.suggestedFloor).toBeCloseTo(0.7, 5);

      // Score bands are 0.1-wide and bin by the displayed score despite REAL float error
      // (0.7 stored as 0.69999998 must NOT fall into band 0.6).
      const bands: Record<string, (typeof stats.byBand)[number]> = {};
      for (const b of stats.byBand) bands[b.band.toFixed(1)] = b;
      expect(bands["0.9"]!.summarized).toBe(3);
      expect(bands["0.7"]!.total).toBe(2);
      expect(bands["0.5"]!.dismissedManual).toBe(5);
      expect(bands["0.6"]).toBeUndefined();
    });
  });

  describe("candidateRecentStats", () => {
    test("windowed block: untriaged separate from rejected, float4-safe repackaging count", async () => {
      const sql = getDb();
      // Four x rows, one per bucket, plus the three repackaging cases. Titles carry the
      // `@handle: ` prefix exactly as the X capture writes them.
      const seed = async (
        slug: string,
        title: string,
        score: number,
        status: "new" | "summarized" | "dismissed",
        reason?: "manual" | "expired",
      ) => {
        const url = "https://x/" + slug;
        await upsertCandidate({ ...base, source: "x", url, title, score, kind: "x-post" });
        const row = (await getCandidateBySourceUrl("x", url))!;
        if (status === "summarized") await setCandidateStatus(row.id, "summarized", "doc-" + slug);
        else if (status === "dismissed")
          await setCandidateStatus(row.id, "dismissed", null, reason ?? null);
        return row;
      };

      // Shaped (ALL-CAPS) at 0.9 — the one row that must be counted.
      await seed("shaped-hi", "@a: EVERYONE IS SLEEPING on this", 0.9, "new");
      // Shaped but stored at exactly the 0.8 cap: float4 reads back as 0.80000001, so a
      // raw `score > 0.8` counts it and the rounded comparison must not.
      await seed("shaped-cap", "@b: 🚨 clamped by #454", 0.8, "new");
      // Unshaped at 0.9.
      await seed("plain-hi", "@c: a careful writeup of tool use", 0.9, "summarized");
      await seed("rejected", "@d: hype thread", 0.6, "dismissed", "manual");
      await seed("expired", "@e: stale pointer", 0.6, "dismissed", "expired");

      // An x-LINK pointer, shaped and well above the cap: `clampScores` never touches
      // this kind, so counting it would make the target-0 metric permanently non-zero.
      await upsertCandidate({
        ...base,
        source: "x",
        url: "https://x/pointer",
        title: "@g: 🚨 JUST DROPPED, look at this",
        score: 0.95,
        kind: "x-link",
      });

      // A row OUTSIDE the window must not appear anywhere in the block.
      const old = await seed("ancient", "@f: OLDNEWSHERE from months ago", 0.95, "new");
      await sql`UPDATE summary_candidates SET created_at = now() - interval '40 days' WHERE id = ${old.id}`;

      const recent = await candidateRecentStats(7);
      expect(recent.windowDays).toBe(7);
      expect(recent.target).toBe(ACCEPTANCE_TARGET);
      expect(Date.parse(recent.since)).toBeLessThan(Date.now());
      expect(recent.repackaging.cap).toBe(REPACKAGING_SCORE_CAP);

      const x = recent.bySource.find((s) => s.source === "x")!;
      expect(x).toBeDefined();
      expect(x.captured).toBe(6); // the 40-day-old row is excluded; the x-link row is in
      expect(x.pending).toBe(3); // never looked at — NOT rejections
      expect(x.triaged).toBe(3);
      expect(x.summarized).toBe(1);
      expect(x.dismissedManual).toBe(1);
      expect(x.dismissedAuto).toBe(1); // expired
      expect(x.error).toBe(0);
      expect(x.acceptanceRate).toBeCloseTo(0.5, 5);
      // Only the 0.9 shaped x-post row: the 0.8 one is AT the cap, the other 0.9 one is
      // unshaped, the shaped 0.95 x-LINK row is a deliberate clamp exemption, and the
      // out-of-window shaped 0.95 row is out of the window.
      expect(x.repackagingShapedAbove08).toBe(1);

      // A wider window reaches the 40-day-old row — but it was captured long BEFORE the
      // clamp shipped, and the score ratchet means its high is permanent, so it is out
      // of the metric. The window start is what moves; the repackaging floor does not.
      const wide = await candidateRecentStats(90);
      const wideX = wide.bySource.find((s) => s.source === "x")!;
      expect(wideX.captured).toBe(7);
      expect(wideX.repackagingShapedAbove08).toBe(1);
      // 90 days reaches back past #454, so the clamp ship time is the binding bound.
      expect(wide.repackaging.floored).toBe(true);
      expect(wide.repackaging.since).toBe(REPACKAGING_CLAMP_SHIPPED_AT.toISOString());
      expect(Date.parse(wide.since)).toBeLessThan(Date.parse(wide.repackaging.since));
    });

    test("a NaN window falls back to the default instead of throwing on Invalid Date", async () => {
      // `Math.round(NaN)` is NaN and `new Date(NaN).toISOString()` is a RangeError, which
      // used to 500 the whole calibration route rather than degrade one block.
      const recent = await candidateRecentStats(NaN);
      expect(recent.windowDays).toBe(RECENT_WINDOW_DEFAULT_DAYS);
      expect(Number.isNaN(Date.parse(recent.since))).toBe(false);
    });

    test("non-x sources omit the repackaging count entirely", async () => {
      await upsertCandidate({ ...base, url: "https://o/anth1", score: 0.9, kind: "doc" });
      const recent = await candidateRecentStats(7);
      const anth = recent.bySource.find((s) => s.source === "anthropic")!;
      expect(anth.captured).toBe(1);
      expect(anth.pending).toBe(1);
      expect(anth.acceptanceRate).toBeNull();
      // Absent, not 0 — the metric is X-vertical policy and would be a lie elsewhere.
      expect(anth.repackagingShapedAbove08).toBeUndefined();
    });
  });
});
