-- A named connector's effort level (`low`..`max`), the thinking control on
-- adaptive-thinking models. `thinking_max_tokens` is ignored there, so a thread
-- pinned to a connector had no way to change how hard the model thinks.
-- NULL falls back to the bot's config.json `effort`.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS effort TEXT;
