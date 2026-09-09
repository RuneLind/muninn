/**
 * Which `/summaries` sources a capture RE-RUN can act on.
 *
 * Its own import-free module for the reason `src/vimeo/limits.ts` exists: the
 * doc panel's view needs this list to decide whether to render the `↻ Re-run ▾`
 * control, and `src/dashboard/routes/summaries-rerun.ts` — which owns the
 * behaviour — imports Hono, four job stores and every vertical's prompt builder.
 * A view must not acquire that graph to spell four strings.
 *
 * The route module imports this and asserts every entry is a registered summary
 * source, so the two lists cannot drift.
 *
 * `x-article` is here for its VIDEO documents: an X video capture stores a
 * transcript, a pasted X article does not, so the route's own `no_transcript`
 * refusal is what tells the two apart — the client does not have to.
 */
export const RERUN_SOURCES: readonly string[] = ["youtube", "vimeo", "tiktok", "x-article"];
