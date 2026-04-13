-- Backfill for pre-fix rows where updateWatcher stored config as a JSON-string inside JSONB.
-- jsonb_typeof(config) = 'string' means the column holds a JSON-encoded string rather than
-- the object it should be. Re-parse with ::text::jsonb so path queries like config->'slackChannels'
-- work again.
UPDATE watchers
SET config = (config #>> '{}')::jsonb
WHERE jsonb_typeof(config) = 'string';
