-- Create users table: canonical source of user identity
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT,
  platform TEXT NOT NULL DEFAULT 'web',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ
);

CREATE INDEX idx_users_platform ON users(platform);
CREATE INDEX idx_users_last_seen ON users(last_seen_at DESC);

CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_users_updated_at();

-- Backfill from messages (primary source — has username + platform)
INSERT INTO users (id, username, platform, created_at, last_seen_at)
SELECT
  user_id,
  COALESCE(
    (SELECT m2.username FROM messages m2
     WHERE m2.user_id = m.user_id AND m2.role = 'user' AND m2.username IS NOT NULL
     ORDER BY m2.created_at DESC LIMIT 1),
    user_id
  ),
  COALESCE(
    (mode() WITHIN GROUP (ORDER BY m.platform))::text,
    'web'
  ),
  MIN(m.created_at),
  MAX(m.created_at)
FROM messages m
WHERE m.role = 'user'
GROUP BY m.user_id
ON CONFLICT (id) DO NOTHING;

-- Backfill thread-only users (web users created via chat UI with no messages yet)
INSERT INTO users (id, username, platform, created_at)
SELECT t.user_id, t.user_id, 'web', MIN(t.created_at)
FROM threads t
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = t.user_id)
GROUP BY t.user_id
ON CONFLICT (id) DO NOTHING;

-- Backfill user_settings users (have settings but maybe no messages or threads)
INSERT INTO users (id, username, platform, created_at)
SELECT us.user_id, us.user_id, 'web', us.created_at
FROM user_settings us
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = us.user_id)
ON CONFLICT (id) DO NOTHING;
