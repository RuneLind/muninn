-- Store the preferred default user per bot (single source of truth for plugin + chat page)
CREATE TABLE bot_default_user (
  bot_name TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
