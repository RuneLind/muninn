/**
 * The Vimeo vertical's numeric limits, in a module with NO imports.
 *
 * The cap lives here rather than in `summarizer.ts` because three unrelated
 * places need the NUMBER and only one of them wants the capture stack:
 * the route (which enforces it and reports it as `maxSec`), the summarizer, and
 * `/summaries`, whose server-rendered page injects it so the card's two
 * cap-naming sentences are derived from the same constant instead of spelling
 * "3 h" as a literal. A view importing `summarizer.ts` for one integer would
 * drag playwright-core and the whole harvest pipeline into the page render.
 */

/**
 * The longest video this vertical will capture.
 *
 * The duration is the ONLY length bound the vertical has — there is no download
 * to time out and no frame budget — so it is enforced on the oEmbed answer,
 * before a job exists.
 */
export const VIMEO_MAX_DURATION_SEC = 3 * 60 * 60;
