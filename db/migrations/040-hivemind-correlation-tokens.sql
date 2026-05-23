-- Precise peer-reply correlation via opaque minted tokens.
--
-- An *initiating* outbound (ask_peer / send_to_peer / chat `>`) mints a fresh
-- random correlation_id, sends it on the wire, and stores token → originating
-- thread here. When the peer's reply echoes the token, the router resolves it
-- back to the exact thread — no last-write-wins collision when two outbounds
-- target the same peer (the failure mode peer_thread_correlation has).
--
-- This is the precise primary path; peer_thread_correlation (migration 039)
-- stays as the (bot, peer) un-echoed fallback. Two tables, not a re-key: this
-- one grows ONE ROW PER OUTBOUND, so it has its own TTL sweep (the fallback is
-- one row per peer and updates in place). No FK on thread_id — the router
-- validates the thread via getThreadById and lazily clears stale rows, matching
-- peer_thread_correlation's behaviour.
CREATE TABLE peer_correlation_tokens (
  bot_name       TEXT        NOT NULL,
  correlation_id TEXT        NOT NULL,
  thread_id      UUID        NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_name, correlation_id)
);

-- Cheap expired-row sweep (cleanup runs opportunistically on insert) + the
-- expires_at > now() resolve filter.
CREATE INDEX idx_peer_correlation_tokens_expires
  ON peer_correlation_tokens (expires_at);
