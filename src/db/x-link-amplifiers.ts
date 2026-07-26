import { getDb } from "./client.ts";

/**
 * Cross-run amplifier votes for pointer destinations (X hype-dedup **step 2b**).
 *
 * Step 2a keyed TOP-TIER pointer candidates on their normalized destination URL, so a
 * hype wave from top-5% authors collapses to one inbox row. Sub-tier pointers (authors
 * outside huginn's top-5%) still vanish — `isLinkTweet` requires a tier. Step 2b gives
 * them a way in that does NOT relax the quality bar to "any author": each sub-tier
 * pointer records a vote here, and a destination earns a candidate row only once
 * `captureAmplifyMin` (default 3) **distinct POINTER authors** have pointed at it.
 *
 * **Why the content columns.** By the time the third member of a wave arrives, members
 * one and two have been consumed and marked seen in earlier runs — their x-feed docs are
 * not in this run's batch. Recording each member's gate output (`score`/`why`/`title`/
 * `source_doc_id`/`tweet_permalink`) is what makes "admit from the top-scoring member of
 * the wave" possible at all; without it the representative could only ever be the
 * current run's pointer.
 *
 * **`pointer` is the admission franchise** (CAPPED contract item 3). A LONG-FORM post
 * carrying the group URL keeps its own tweet-keyed `x-post` row and records a
 * `pointer = false` vote here for OBSERVABILITY ONLY: it never counts toward the
 * threshold ({@link getAmplifierGroup} counts `WHERE pointer`) and is never eligible as
 * the representative. Counting long-form voters would let two footnote links + one
 * pointer admit a destination row *alongside* the two x-post rows — the duplication this
 * plan exists to remove — and would hollow out the ≥3-distinct-authors threshold, which
 * is the compensating control for relaxing the top-author-only gate.
 *
 * **Farm-ring risk (documented, not built).** ≥3 distinct authors is the only thing
 * standing between this and a coordinated ring promoting itself. The author-scores JSON
 * carries a `community` field; a same-community discount on the distinct-author count is
 * the named v2 lever.
 */

/** One member's vote on a destination — the row shape written per pointer/long-form item. */
export interface AmplifierVote {
  /** Normalized destination URL (`destinationGroupKey`) — the group identity. */
  urlKey: string;
  /** Normalized (lowercased, bare) X handle. Never null — callers skip null-author items. */
  author: string;
  /**
   * `true` = pointer tweet (counts toward the threshold, eligible as representative);
   * `false` = long-form carrying the same URL (observability only).
   */
  pointer: boolean;
  tweetPermalink?: string | null;
  sourceDocId?: string | null;
  /** Gate score, or null when the gate omitted this item (the vote still counts). */
  score?: number | null;
  title?: string | null;
  why?: string | null;
}

/** The best recorded POINTER member of a group — the row a wave admission is built from. */
export interface AmplifierMember {
  author: string;
  tweetPermalink: string | null;
  sourceDocId: string | null;
  score: number;
  title: string | null;
  why: string | null;
}

export interface AmplifierGroup {
  /** DISTINCT authors who voted as POINTERS. Long-form voters are excluded by design. */
  pointerAuthors: number;
  /** Highest-scoring recorded pointer member, or null (no pointer has a gate score yet). */
  best: AmplifierMember | null;
}

/**
 * Record one member's vote, idempotently.
 *
 * The PK `(url_key, author)` is what makes "3 distinct authors" real: one account
 * pointing at the same destination in five runs is ONE vote, forever.
 *
 * Conflict semantics — expressed as per-column `CASE`s rather than a bare
 * `DO UPDATE … WHERE EXCLUDED.score > x_link_amplifiers.score`, because two independent
 * things move here and a single row-level `WHERE` would couple them:
 *  - **`pointer` is sticky-TRUE.** Once an author has pointed at a destination they hold
 *    the franchise; a later long-form mention from the same author must not revoke it.
 *    Under a score-only `WHERE`, an author whose long-form vote landed FIRST could never
 *    be promoted to pointer and would be silently disenfranchised.
 *  - **The content set moves only on a strictly better POINTER.** `EXCLUDED.pointer` is
 *    part of the predicate so a long-form vote can never write itself into the
 *    representative fields of a row whose `pointer` flag it just inherited. A NULL stored
 *    score (gate-omitted first arrival) is beaten by any scored member (`COALESCE(…, -1)`);
 *    a NULL incoming score never wins.
 *
 * **The content columns are POINTER-ONLY, on insert as well as on conflict.** A
 * `pointer = false` vote writes NULLs into `score`/`title`/`why`/`tweet_permalink`/
 * `source_doc_id` — its observable content is its own existence (`author`, `pointer`,
 * `first_seen`). Without this, a long-form-FIRST author would seed the row with essay
 * content at a high score, and their later pointer (necessarily a lower, pointer-scored
 * number) could not beat it — so promoting that author to `pointer = true` would hand the
 * representative slot to a long-form post through the back door, defeating CAPPED item 3
 * by a different route than the threshold count.
 *
 * `first_seen` is deliberately absent from the SET list — it is the group's age for
 * {@link pruneXLinkAmplifiers}, not a last-touched clock.
 */
export async function recordAmplifierVote(p: AmplifierVote): Promise<void> {
  const sql = getDb();
  const content = p.pointer
    ? {
        tweetPermalink: p.tweetPermalink ?? null,
        sourceDocId: p.sourceDocId ?? null,
        score: p.score ?? null,
        title: p.title ?? null,
        why: p.why ?? null,
      }
    : { tweetPermalink: null, sourceDocId: null, score: null, title: null, why: null };
  await sql`
    INSERT INTO x_link_amplifiers (url_key, author, pointer, tweet_permalink, source_doc_id, score, title, why)
    VALUES (
      ${p.urlKey}, ${p.author}, ${p.pointer}, ${content.tweetPermalink}, ${content.sourceDocId},
      ${content.score}, ${content.title}, ${content.why}
    )
    ON CONFLICT (url_key, author) DO UPDATE
      SET pointer = x_link_amplifiers.pointer OR EXCLUDED.pointer,
          score = CASE WHEN EXCLUDED.pointer AND EXCLUDED.score > COALESCE(x_link_amplifiers.score, -1) THEN EXCLUDED.score ELSE x_link_amplifiers.score END,
          title = CASE WHEN EXCLUDED.pointer AND EXCLUDED.score > COALESCE(x_link_amplifiers.score, -1) THEN EXCLUDED.title ELSE x_link_amplifiers.title END,
          why = CASE WHEN EXCLUDED.pointer AND EXCLUDED.score > COALESCE(x_link_amplifiers.score, -1) THEN EXCLUDED.why ELSE x_link_amplifiers.why END,
          tweet_permalink = CASE WHEN EXCLUDED.pointer AND EXCLUDED.score > COALESCE(x_link_amplifiers.score, -1) THEN EXCLUDED.tweet_permalink ELSE x_link_amplifiers.tweet_permalink END,
          source_doc_id = CASE WHEN EXCLUDED.pointer AND EXCLUDED.score > COALESCE(x_link_amplifiers.score, -1) THEN EXCLUDED.source_doc_id ELSE x_link_amplifiers.source_doc_id END
  `;
}

/**
 * The admission state of one destination group: how many DISTINCT POINTER authors have
 * voted, and the best-scoring recorded pointer member (the row an admission is built
 * from — its score/why/title/doc/author, never the current run's pointer unless it
 * happens to be the best).
 *
 * Tie-break on `author` so the representative is deterministic across concurrent runs.
 */
export async function getAmplifierGroup(urlKey: string): Promise<AmplifierGroup> {
  const sql = getDb();
  const [counts] = await sql<{ pointer_authors: string }[]>`
    SELECT count(DISTINCT author) AS pointer_authors
    FROM x_link_amplifiers
    WHERE url_key = ${urlKey} AND pointer
  `;
  const [best] = await sql<
    { author: string; tweet_permalink: string | null; source_doc_id: string | null; score: number; title: string | null; why: string | null }[]
  >`
    SELECT author, tweet_permalink, source_doc_id, score, title, why
    FROM x_link_amplifiers
    WHERE url_key = ${urlKey} AND pointer AND score IS NOT NULL
    ORDER BY score DESC, author ASC
    LIMIT 1
  `;
  return {
    pointerAuthors: Number(counts?.pointer_authors ?? 0),
    best: best
      ? {
          author: best.author,
          tweetPermalink: best.tweet_permalink,
          sourceDocId: best.source_doc_id,
          score: best.score,
          title: best.title,
          why: best.why,
        }
      : null,
  };
}

/**
 * Drop amplifier rows older than `days` (default 30) — a wave that never reached the
 * threshold in a month is not a wave. Attached to the same `/summaries` load call site
 * as `expireStaleCandidates`; cleanup therefore depends on dashboard visits, which is
 * accepted (the table is tiny and the miss is unbounded growth, not incorrectness).
 *
 * Note this prunes per-ROW, not per-group: a long-dormant group whose members aged out
 * loses its old votes and must re-accumulate, which is the intended "wave went cold"
 * behaviour.
 */
export async function pruneXLinkAmplifiers(days = 30): Promise<number> {
  const sql = getDb();
  const rows = await sql`
    DELETE FROM x_link_amplifiers
    WHERE first_seen < now() - ${`${days} days`}::interval
    RETURNING url_key
  `;
  return rows.length;
}
