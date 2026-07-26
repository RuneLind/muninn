-- X hype-dedup step 2b: cross-run amplifier votes for pointer destinations.
--
-- A "wave" is N pointer tweets at the SAME external destination, arriving ≈1 per 2h
-- watcher batch over days. Step 2a collapsed the TOP-TIER pointers of such a wave onto
-- one destination-keyed `summary_candidates` row. Step 2b extends admission to SUB-TIER
-- pointers (authors outside huginn's top-5%), which vanish entirely today: each pointer
-- records a VOTE here, and a destination earns a candidate row only once
-- `captureAmplifyMin` DISTINCT POINTER authors have voted for it.
--
-- Why the score/title/why/doc columns exist: the earlier members of a wave are consumed
-- and marked seen in earlier runs, so by the time the threshold is crossed their x-feed
-- docs are no longer in the batch. Without recording each member's gate output here,
-- "admit from the top-scoring member of the wave" would be impossible and the
-- representative could only ever be the CURRENT run's pointer.
--
-- `pointer` is the admission franchise. A LONG-FORM post carrying the group URL keeps
-- its own tweet-keyed x-post row (judged under step 1's repackaging cap) and records a
-- vote here with `pointer = FALSE` for OBSERVABILITY ONLY: it never counts toward
-- `captureAmplifyMin` and can never be the representative. Counting long-form voters
-- would let two footnote links + one pointer admit a destination row ALONGSIDE the two
-- x-post rows — the duplication this whole plan exists to remove — and would hollow out
-- the ≥3-distinct-authors threshold, which is the compensating control for relaxing the
-- top-author-only gate.
--
-- ⚠️ Mirrored in db/init.sql — identical columns + constraints + index, or
-- schema-drift.test.ts reds.
CREATE TABLE IF NOT EXISTS x_link_amplifiers (
  -- Normalized destination URL (`destinationGroupKey`) — the same key the
  -- destination-keyed summary_candidates row uses.
  url_key         TEXT NOT NULL,
  -- Normalized (lowercased, bare) X handle. Null-author pointers (the parser's
  -- "unknown" fallback) are never recorded — an unattributable vote can't be a
  -- DISTINCT author.
  author          TEXT NOT NULL,
  -- TRUE = pointer tweet (counts toward the admission threshold, eligible to be the
  -- representative). FALSE = long-form carrying the same URL (observability only).
  pointer         BOOLEAN NOT NULL DEFAULT TRUE,
  tweet_permalink TEXT,
  source_doc_id   TEXT,
  -- Gate output for this member. NULL when the gate omitted the item — the vote is
  -- still recorded (votes and admission are decoupled), it just can never win
  -- representative.
  score           REAL,
  title           TEXT,
  why             TEXT,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (url_key, author)
);

-- Prune scan (`pruneXLinkAmplifiers`, ~30 days), attached to the /summaries load
-- alongside expireStaleCandidates.
CREATE INDEX IF NOT EXISTS idx_x_link_amplifiers_first_seen ON x_link_amplifiers (first_seen);
