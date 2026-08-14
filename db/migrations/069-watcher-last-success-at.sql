-- Watermark for "the checker last completed a trustworthy run", distinct from
-- `last_run_at`, which advances on quiet-hours skips (runner.ts, the whole-run
-- skip) and on failures (runner.ts, "prevent retry storms"). The email checker
-- bounds its Gmail query on THIS column so a skipped or failed tick cannot
-- silently drop that window's mail — `last_run_at` cannot express that.
--
-- NULL means "never recorded a success". Readers must fall back to their old
-- unbounded behaviour on NULL rather than treating it as epoch 0 (which would
-- be a nearly-56-year lookback on the first tick after this migration).
ALTER TABLE watchers ADD COLUMN IF NOT EXISTS last_success_at TIMESTAMPTZ;
