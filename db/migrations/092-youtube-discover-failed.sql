-- YouTube discovery (architecture review 2026-11-16, F14): how many of a run's
-- calls failed — the yt-dlp searches that answered nothing, plus the read, the
-- queries call or the rank call when one of those failed. 0 is a complete run;
-- a search that found no videos is a success. The weekly watcher stores a row
-- for a failed seed too and searches a seed whose newest run has failed > 0
-- first next week, so its window is not skipped.
ALTER TABLE youtube_discover_runs ADD COLUMN IF NOT EXISTS failed INTEGER NOT NULL DEFAULT 0;
