-- Discuss v3 P2 (mimir plan muninn-wiki-discuss-v3, D9/D12): a reader card's
-- follow-ups. `origin_turn_id` is the card's first turn (null on that first
-- turn, and on every older row); `passage` is where the passage of a turn with
-- a selection and no origin stands (a card's first turn, a tab «Ask here» turn:
-- the reader's before/after, heading and edge flags, plus the DOM-order held
-- passage a card is re-placed with); `sent_from` is where the reader typed the
-- turn. All three are null on older rows: no backfill.
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS origin_turn_id UUID REFERENCES wiki_discuss_turns(id) ON DELETE SET NULL;
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS passage JSONB;
ALTER TABLE wiki_discuss_turns ADD COLUMN IF NOT EXISTS sent_from TEXT;
ALTER TABLE wiki_discuss_turns DROP CONSTRAINT IF EXISTS wiki_discuss_turns_sent_from_check;
ALTER TABLE wiki_discuss_turns ADD CONSTRAINT wiki_discuss_turns_sent_from_check CHECK (sent_from IS NULL OR sent_from IN ('card', 'chat', 'tab', 'trace'));
-- The self-referencing FK's index: a deleted turn (every turn of a deleted
-- thread) looks up the rows that name it, which otherwise scans the table.
CREATE INDEX IF NOT EXISTS idx_wiki_discuss_turns_origin ON wiki_discuss_turns (origin_turn_id) WHERE origin_turn_id IS NOT NULL;
