-- Backfill for pre-fix rows where updateWatcher stored config as a JSON-string inside JSONB.
-- jsonb_typeof(config) = 'string' means the column holds a JSON-encoded string rather than
-- the object it should be. #>> '{}' extracts the inner unquoted text from the JSONB string,
-- which we then parse back into a proper JSONB object so path queries like
-- config->'slackChannels' work again. (Note: a plain ::text::jsonb cast is a no-op here —
-- it preserves the JSONB string type instead of unwrapping it.)
UPDATE watchers
SET config = (config #>> '{}')::jsonb
WHERE jsonb_typeof(config) = 'string';
