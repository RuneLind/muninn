-- Discuss's wiki agent (mimir plan muninn-wiki-discuss, P2b, D7): one row per
-- turn of a discussion about one wiki page. A table of its own, not the page's
-- article thread: that thread would mix chat turns into the discussion and send
-- discuss turns to the memory, goal and schedule extractors. `id` is the turn
-- id P4 names when it applies the turn's proposed edit; `end_state` is how the
-- turn ended ('running' while it runs). A running turn touches `heartbeat_at`
-- every few seconds; one whose heartbeat stopped (its process died) is closed
-- as 'abandoned' by the next start on its discussion and by the boot sweep.
CREATE TABLE IF NOT EXISTS wiki_discuss_turns (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id  UUID NOT NULL,
  seq            INTEGER NOT NULL,
  wiki           TEXT NOT NULL,
  rel_path       TEXT NOT NULL,
  page_hash      TEXT NOT NULL,
  selection      TEXT,
  question       TEXT NOT NULL,
  location       JSONB,
  answer         TEXT NOT NULL DEFAULT '',
  end_state      TEXT NOT NULL DEFAULT 'running' CHECK (end_state IN ('running', 'done', 'error', 'timeout', 'abandoned')),
  error          TEXT,
  reader_left    BOOLEAN NOT NULL DEFAULT false,
  bot_name       TEXT NOT NULL,
  connector      TEXT NOT NULL,
  model          TEXT,
  surface        JSONB NOT NULL DEFAULT '{}'::jsonb,
  card           TEXT,
  tool_calls     JSONB NOT NULL DEFAULT '[]'::jsonb,
  proposed_edit  JSONB,
  cost_usd       DOUBLE PRECISION,
  duration_ms    INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  heartbeat_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  UNIQUE (discussion_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_wiki_discuss_turns_page ON wiki_discuss_turns (wiki, rel_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wiki_discuss_turns_running ON wiki_discuss_turns (heartbeat_at) WHERE end_state = 'running';
