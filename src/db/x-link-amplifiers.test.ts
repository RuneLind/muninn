import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { getDb } from "./client.ts";
import { recordAmplifierVote, getAmplifierGroup, pruneXLinkAmplifiers } from "./x-link-amplifiers.ts";

setupTestDb();

const URL_KEY = "https://example.com/wave";

const vote = (author: string, over: Partial<Parameters<typeof recordAmplifierVote>[0]> = {}) => ({
  urlKey: URL_KEY,
  author,
  pointer: true,
  tweetPermalink: `https://x.com/${author}/status/1`,
  sourceDocId: `2026-07-26_${author}_1.md`,
  score: 0.8,
  title: `@${author}: points at it`,
  why: `${author}'s take`,
  ...over,
});

describe("x-link-amplifiers", () => {
  test("distinct pointer authors accumulate; the best-scoring one is the representative", async () => {
    await recordAmplifierVote(vote("alice", { score: 0.75 }));
    await recordAmplifierVote(vote("bob", { score: 0.9 }));
    await recordAmplifierVote(vote("carol", { score: 0.72 }));

    const group = await getAmplifierGroup(URL_KEY);
    expect(group.pointerAuthors).toBe(3);
    expect(group.best?.author).toBe("bob");
    expect(group.best?.score).toBeCloseTo(0.9, 5);
    expect(group.best?.why).toBe("bob's take");
    expect(group.best?.sourceDocId).toBe("2026-07-26_bob_1.md");
    expect(group.best?.tweetPermalink).toBe("https://x.com/bob/status/1");
  });

  test("the PK makes repeat pointers from ONE author a single vote (idempotent)", async () => {
    await recordAmplifierVote(vote("alice"));
    await recordAmplifierVote(vote("alice"));
    await recordAmplifierVote(vote("alice"));

    const group = await getAmplifierGroup(URL_KEY);
    expect(group.pointerAuthors).toBe(1);
    const rows = await getDb()`SELECT count(*)::int AS n FROM x_link_amplifiers WHERE url_key = ${URL_KEY}`;
    expect(rows[0]!.n).toBe(1);
  });

  test("a same-author later pointer refreshes the recorded member only when it scores STRICTLY higher", async () => {
    await recordAmplifierVote(vote("alice", { score: 0.8, why: "first take", sourceDocId: "doc-1" }));
    // Lower — ignored, the whole recorded set stays on the better member.
    await recordAmplifierVote(vote("alice", { score: 0.7, why: "worse take", sourceDocId: "doc-2" }));
    let group = await getAmplifierGroup(URL_KEY);
    expect(group.best?.score).toBeCloseTo(0.8, 5);
    expect(group.best?.why).toBe("first take");
    expect(group.best?.sourceDocId).toBe("doc-1");

    // Equal — also ignored (strictly-greater, so the first arrival keeps the tie).
    await recordAmplifierVote(vote("alice", { score: 0.8, why: "tie take", sourceDocId: "doc-3" }));
    group = await getAmplifierGroup(URL_KEY);
    expect(group.best?.why).toBe("first take");

    // Strictly higher — the whole set moves together.
    await recordAmplifierVote(vote("alice", { score: 0.95, why: "better take", sourceDocId: "doc-4" }));
    group = await getAmplifierGroup(URL_KEY);
    expect(group.best?.score).toBeCloseTo(0.95, 5);
    expect(group.best?.why).toBe("better take");
    expect(group.best?.sourceDocId).toBe("doc-4");
  });

  test("a gate-omitted pointer still votes (NULL score) and is beaten by any scored member", async () => {
    await recordAmplifierVote(vote("alice", { score: null, why: null, title: null }));
    let group = await getAmplifierGroup(URL_KEY);
    // The vote counts toward the threshold even though it can't represent.
    expect(group.pointerAuthors).toBe(1);
    expect(group.best).toBeNull();

    // A later scored pointer from the SAME author fills in the recorded member.
    await recordAmplifierVote(vote("alice", { score: 0.7, why: "now scored" }));
    group = await getAmplifierGroup(URL_KEY);
    expect(group.best?.score).toBeCloseTo(0.7, 5);
    expect(group.best?.why).toBe("now scored");
  });

  test("long-form voters count toward NOTHING: not the threshold, not the representative", async () => {
    await recordAmplifierVote(vote("alice", { score: 0.7 }));
    // Two long-form posts carrying the same URL, both scoring higher than the pointer.
    await recordAmplifierVote(vote("dave", { pointer: false, score: 0.99, why: "dave's own analysis" }));
    await recordAmplifierVote(vote("erin", { pointer: false, score: 0.98, why: "erin's own analysis" }));

    const group = await getAmplifierGroup(URL_KEY);
    expect(group.pointerAuthors).toBe(1);
    expect(group.best?.author).toBe("alice");
    expect(group.best?.score).toBeCloseTo(0.7, 5);
    // All three rows exist — the long-form ones are observability, not franchise — and
    // they hold no content at all (pointer-only columns).
    const rows = await getDb()<{ author: string; score: number | null; why: string | null }[]>`
      SELECT author, score, why FROM x_link_amplifiers WHERE url_key = ${URL_KEY} ORDER BY author
    `;
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.score === null && r.why === null).map((r) => r.author)).toEqual(["dave", "erin"]);
  });

  test("`pointer` is sticky-TRUE, and a long-form vote never overwrites a pointer's recorded set", async () => {
    await recordAmplifierVote(vote("alice", { score: 0.7, why: "alice points" }));
    // Same author later writes a long-form post carrying the URL, scoring higher.
    await recordAmplifierVote(vote("alice", { pointer: false, score: 0.99, why: "alice's essay" }));

    const group = await getAmplifierGroup(URL_KEY);
    expect(group.pointerAuthors).toBe(1);
    expect(group.best?.score).toBeCloseTo(0.7, 5);
    expect(group.best?.why).toBe("alice points");
  });

  test("a long-form-FIRST author is promoted to pointer when they later point (not disenfranchised)", async () => {
    await recordAmplifierVote(vote("alice", { pointer: false, score: 0.99, why: "alice's essay" }));
    expect((await getAmplifierGroup(URL_KEY)).pointerAuthors).toBe(0);

    await recordAmplifierVote(vote("alice", { pointer: true, score: 0.7, why: "alice points" }));
    const group = await getAmplifierGroup(URL_KEY);
    expect(group.pointerAuthors).toBe(1);
    // The pointer's fields win outright: the long-form insert claimed NO content columns,
    // so its 0.99 can never shadow a lower-scoring pointer in the representative slot.
    expect(group.best?.why).toBe("alice points");
    expect(group.best?.score).toBeCloseTo(0.7, 5);
  });

  test("groups are isolated by url_key", async () => {
    await recordAmplifierVote(vote("alice"));
    await recordAmplifierVote({ ...vote("bob"), urlKey: "https://example.com/other" });
    expect((await getAmplifierGroup(URL_KEY)).pointerAuthors).toBe(1);
    expect((await getAmplifierGroup("https://example.com/other")).pointerAuthors).toBe(1);
    expect((await getAmplifierGroup("https://example.com/none")).pointerAuthors).toBe(0);
    expect((await getAmplifierGroup("https://example.com/none")).best).toBeNull();
  });

  test("prune drops rows older than the cutoff and spares fresh ones", async () => {
    await recordAmplifierVote(vote("alice"));
    await recordAmplifierVote(vote("bob"));
    await getDb()`UPDATE x_link_amplifiers SET first_seen = now() - INTERVAL '40 days' WHERE author = 'alice'`;

    expect(await pruneXLinkAmplifiers(30)).toBe(1);
    const group = await getAmplifierGroup(URL_KEY);
    expect(group.pointerAuthors).toBe(1);
    expect(group.best?.author).toBe("bob");
  });
});
