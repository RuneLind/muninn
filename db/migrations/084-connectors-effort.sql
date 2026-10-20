-- A named connector's effort level (`low`..`max`), the thinking control on
-- adaptive-thinking models. `thinking_max_tokens` is ignored there, so a thread
-- pinned to a connector had no way to change how hard the model thinks.
-- NULL falls back to the bot's config.json `effort`.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS effort TEXT;

-- The unique key gains effort: two connectors that differ only in effort
-- (`low` vs `high` on one model) are the case this column exists for.
DROP INDEX IF EXISTS idx_connectors_unique_config;
CREATE UNIQUE INDEX idx_connectors_unique_config
  ON connectors (connector_type, COALESCE(model, ''), COALESCE(base_url, ''), COALESCE(effort, ''));
