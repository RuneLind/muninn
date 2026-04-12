-- Phase 0.4 follow-up: link benchmark runs to the analysis trace too.
--
-- benchmark_runs already has trace_id (the JUDGE call). This adds a separate
-- column for the original ANALYSIS call's trace, so the dashboard can link
-- to both:
--   trace_id           — the Sonnet judge call we made when scoring
--   analysis_trace_id  — the original muninn analysis that produced the
--                        candidate report we're scoring
--
-- Phase 0 reports judging *historical* candidates (e.g. the March 16 report)
-- will have analysis_trace_id NULL because the original trace expired or
-- was never recorded. Phase 1+ runs against fresh worktrees will populate
-- both, since the runner produces the analysis itself.

ALTER TABLE benchmark_runs ADD COLUMN analysis_trace_id UUID;
CREATE INDEX idx_benchmark_runs_analysis_trace ON benchmark_runs (analysis_trace_id);
