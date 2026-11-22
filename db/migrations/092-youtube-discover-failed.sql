-- YouTube discovery (architecture review 2026-11-16, F14): how many of a
-- shelf's yt-dlp searches failed. 0 = none; a search that found no videos is a
-- success. A seed whose every search failed makes no shelf (the weekly
-- watcher records it for a retry in watcher_snapshots instead), so every row
-- here is a shelf.
ALTER TABLE youtube_discover_runs ADD COLUMN IF NOT EXISTS failed INTEGER NOT NULL DEFAULT 0;
