/**
 * The RELATED WORK rule's tuned numbers, in a module of their own so a test can
 * IMPORT them rather than re-type them.
 *
 * `related.ts` reaches `store.ts` → `registry.ts`, whose `import.meta.dir` is
 * `undefined` under Playwright's node loader — importing it from an `e2e/` spec
 * made the whole file unloadable ("No tests found"). This module imports
 * nothing, so it loads under every runner, and `e2e/wiki-related-work.spec.ts`
 * sizes its fixture from the real values. A drift then shows up as that spec's
 * own red in BOTH directions; re-typed numbers only caught a threshold moving
 * UP.
 *
 * `related.ts` re-exports all four, so the rule and its tests still read one
 * name each.
 */

/**
 * A page with more backlinks than this is a HUB and is never a related row —
 * nor does it GET a related block of its own: it is cited by everything, so it
 * is about nothing in particular. Without the cut every neighbourhood on mimir
 * contained the same handful of pages.
 *
 * 25 is fitted to today's mimir, where exactly two pages exceed it:
 * `flows/how-we-build.mdx` (27 backlinks) and `projects/muninn/dashboard.md`
 * (26). Measured 2026-09-20 over the 547-page clone. A constant, not a name
 * list, so an acceptance run on another wiki can move it.
 */
export const RELATED_HUB_BACKLINKS = 25;

/**
 * A page naming more PR references than this is a DIGEST — a review report, a
 * month's blog, an index — and shared PR numbers say nothing about it: it names
 * half the month by construction. Cut from the PR-sharing source only; a digest
 * that really links to the open page still appears, with the link as its reason.
 *
 * Applied to BOTH ends of a pair, not only to the candidate: the rule reads
 * "≥2 shared refs means one piece of work", and that inference is equally false
 * when the digest is the page you have open.
 *
 * Measured on mimir 2026-09-20, FIVE pages exceed it — `log.md` (210 refs),
 * `plans/index.md` (84), `archive/mimir/2026-07-30-plans-index-pre-generation.md`
 * (32), `index.md` (27) and `blogs/2026-09-10-shipping-pipeline-review-9.mdx`
 * (19) — against 18 pages in the 6–15 band, so the constant sits in a real gap.
 */
export const RELATED_DIGEST_PRS = 15;

/** How many shared PR refs a pair needs before it is one piece of work. One
 *  shared number pairs every page that mentions a busy week. */
export const RELATED_SHARED_PRS_MIN = 2;

/** How many of the shared refs the `shares …` reason names. */
export const RELATED_SHARED_PRS_SHOWN = 2;
