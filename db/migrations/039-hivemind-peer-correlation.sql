-- Durable peer-reply correlation.
--
-- Maps an outbound (bot, peer) to the thread that originated it, so an inbound
-- reply from that peer routes back into the originating thread instead of the
-- default peer:<ns>/<name> bucket. Previously held in-memory only, which meant
-- a muninn restart (frequent under `--watch`) or a peer that took longer than
-- the in-memory TTL to reply dropped the correlation and split the reply into a
-- separate thread.
--
-- No FK on thread_id: the router validates the thread via getThreadById and
-- lazily clears stale rows, so a deleted thread degrades to the default bucket
-- rather than blocking the insert.
CREATE TABLE peer_thread_correlation (
  bot_name   TEXT        NOT NULL,
  peer_id    TEXT        NOT NULL,
  thread_id  UUID        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_name, peer_id)
);

CREATE INDEX idx_peer_thread_correlation_expires
  ON peer_thread_correlation (expires_at);
