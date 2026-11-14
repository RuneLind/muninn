-- YouTube discovery (plan muninn-youtube-discovery, PR 2): the Discover page's
-- stored runs. One run per seed summary searched (its queries and counts), one
-- hit per video the run showed. A video's state (new/later/dismissed/queued)
-- and its details probe are per VIDEO: every write sets them on each hit row of
-- that id, and a new run's hit copies them from the newest row it already has.
-- Two tables rather than `summary_candidates`: its UNIQUE (source, url) allows
-- one row per video, so a video found by two seeds could sit on one shelf only,
-- and its status lifecycle (expiry, the Anthropic summarizer) does not fit.
CREATE TABLE IF NOT EXISTS youtube_discover_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seed_source   TEXT NOT NULL DEFAULT 'youtube',
  seed_doc_id   TEXT NOT NULL,
  seed_title    TEXT NOT NULL,
  seed_video_id TEXT,
  seed_category TEXT,
  seed_date     TEXT,
  queries       JSONB NOT NULL DEFAULT '[]'::jsonb,
  searched      INTEGER NOT NULL DEFAULT 0,
  known         INTEGER NOT NULL DEFAULT 0,
  origin        TEXT NOT NULL CHECK (origin IN ('reader', 'page', 'watcher')),
  bot_name      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_youtube_discover_runs_seed ON youtube_discover_runs (seed_source, seed_doc_id, created_at DESC);

CREATE TABLE IF NOT EXISTS youtube_discover_hits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        UUID NOT NULL REFERENCES youtube_discover_runs(id) ON DELETE CASCADE,
  video_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  channel       TEXT,
  duration_sec  INTEGER,
  view_count    BIGINT,
  score         REAL NOT NULL,
  why           TEXT,
  query         TEXT,
  rank          INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'later', 'dismissed', 'queued')),
  details       JSONB,
  details_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_youtube_discover_hits_video ON youtube_discover_hits (video_id);
CREATE INDEX IF NOT EXISTS idx_youtube_discover_hits_known ON youtube_discover_hits (video_id) WHERE state IN ('dismissed', 'queued');
