-- Discuss's tab (mimir plan muninn-wiki-discuss, P3): when the reader took a
-- turn on to Claude Code («Continue in Claude Code»). NULL until then; set once,
-- by `markDiscussTurnHandedOver`, and never moved by a later hand-over.
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS handed_over_at TIMESTAMPTZ;
