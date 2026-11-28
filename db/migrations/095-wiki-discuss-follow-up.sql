-- Discuss v3 P2 (mimir plan muninn-wiki-discuss-v3, D9/D12): a reader card's
-- follow-ups. `origin_turn_id` is the card's first turn (null on that first
-- turn, and on every older row); `passage` is where a card's first turn's
-- passage stands (the reader's before/after, heading and edge flags, plus the
-- DOM-order held passage it re-places the card with); `sent_from` is where the
-- reader typed the turn. All three are null on older rows: no backfill.
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS origin_turn_id UUID REFERENCES wiki_discuss_turns(id) ON DELETE SET NULL;
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS passage JSONB;
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS sent_from TEXT;
ALTER TABLE wiki_discuss_turns DROP CONSTRAINT IF EXISTS wiki_discuss_turns_sent_from_check;
ALTER TABLE wiki_discuss_turns ADD CONSTRAINT wiki_discuss_turns_sent_from_check CHECK (sent_from IS NULL OR sent_from IN ('card', 'chat', 'tab', 'trace'));
