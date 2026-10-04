/**
 * The RELATED WORK rule's tuned numbers, in a module of their own so a test can
 * IMPORT them rather than re-type them.
 *
 * `related.ts` reaches `store.ts` → `registry.ts`, whose `import.meta.dir` is
 * `undefined` under Playwright's node loader — importing it from an `e2e/` spec
 * made the whole file unloadable ("No tests found"). This module imports
 * nothing, so it loads under every runner.
 *
 * ⚠️ **Importing them catches no drift on its own.**
 * `e2e/wiki-related-work.spec.ts` SIZES its fixture from these values
 * (`RELATED_HUB_BACKLINKS + 1` fillers, `RELATED_DIGEST_PRS - 1` extra refs),
 * so the fixture tracks the constant: the boundary case holds at whatever the
 * threshold is and both cut cases stay green on a move in EITHER direction —
 * measured, 25 → 10 and 25 → 30 both leave the spec passing. What catches a
 * move is the VALUE PIN in that spec, one `toBe` per constant, asserting the
 * number the paragraphs below were measured against. Re-measure on the live
 * wiki before moving either, and move the pin in the same edit.
 *
 * `related.ts` re-exports the four `RELATED_*` threshold constants, so the rule
 * and its tests still read one name each. The `STRENGTH_*` weights below them
 * are spelled once, by `strengthParts`: `strengthOf` (`strength.ts`, the one
 * neighbour rule Related work and the find palette's near map both read) sums
 * it, and the Related work bar (`wiki-related-view.ts`) draws it.
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
 * Measured on mimir 2026-09-20, FIVE pages exceed it — `log.md` (208 refs),
 * `plans/index.md` (83), `archive/mimir/2026-07-30-plans-index-pre-generation.md`
 * (32), `index.md` (27) and `blogs/2026-09-10-shipping-pipeline-review-9.mdx`
 * (19) — against 18 pages in the 6–15 band, so the constant sits in a real gap.
 */
export const RELATED_DIGEST_PRS = 15;

/** How many shared PR refs a pair needs before it is one piece of work. One
 *  shared number pairs every page that mentions a busy week. */
export const RELATED_SHARED_PRS_MIN = 2;

/** How many of the shared refs the `shares …` reason names. */
export const RELATED_SHARED_PRS_SHOWN = 2;

/**
 * A stamped session on more pages than this is a DIGEST session — a sweep, a
 * backfill, a review pass that touched half a folder — and sharing it says
 * nothing about two pages being one piece of work. The count is over EVERY page
 * in the index carrying the session, bookkeeping and culled pages included, so
 * a session does not escape the cap by stamping pages the rule later cuts.
 *
 * 12 is a forward-looking guard, not a measurement: on 2026-10-04 no session
 * sat on more than 3 mimir pages. Revisit after the provenance backfill.
 */
export const STRENGTH_SESSION_DIGEST = 12;

/** A link in ONE direction between the two pages. */
export const STRENGTH_LINK_ONE_WAY = 1.0;
/** Links in BOTH directions — more than one way, less than two: the second
 *  direction confirms the first rather than doubling it. */
export const STRENGTH_LINK_BOTH_WAYS = 1.6;
/** Per shared PR ref, counted only at `RELATED_SHARED_PRS_MIN` or more. */
export const STRENGTH_PR_WEIGHT = 0.6;
/** The PR signal's ceiling — three refs' worth. */
export const STRENGTH_PR_CAP = 1.8;
/** Per shared stamped session. A session is a stronger claim than a PR number:
 *  the same agent sitting wrote both pages. */
export const STRENGTH_SESSION_WEIGHT = 1.2;
/** The session signal's ceiling — two sessions' worth. */
export const STRENGTH_SESSION_CAP = 2.4;

/**
 * The highest score a neighbour can reach: both-ways link plus both caps.
 * DERIVED, so moving a weight moves the ceiling with it — Related work's strength bar
 * divides by this.
 */
export const STRENGTH_MAX = STRENGTH_LINK_BOTH_WAYS + STRENGTH_PR_CAP + STRENGTH_SESSION_CAP;

/** The three bar segments' widths in score units: what each signal adds. */
export interface StrengthParts {
  link: number;
  prs: number;
  sessions: number;
}

/**
 * What each signal adds to a neighbour's score — the ONE spelling of the
 * weights. `strengthOf` (`strength.ts`) sums it, and the Related work bar
 * (`wiki-related-view.ts`) draws it, so a bar's segments always add up to the
 * score printed beside it. Here rather than in `strength.ts` because the
 * browser bundle loads this module and cannot load that one.
 */
export function strengthParts(link: "out" | "in" | "both" | null, prCount: number, sessionCount: number): StrengthParts {
  return {
    link: link === "both" ? STRENGTH_LINK_BOTH_WAYS : link ? STRENGTH_LINK_ONE_WAY : 0,
    prs: prCount >= RELATED_SHARED_PRS_MIN ? Math.min(prCount * STRENGTH_PR_WEIGHT, STRENGTH_PR_CAP) : 0,
    sessions: Math.min(sessionCount * STRENGTH_SESSION_WEIGHT, STRENGTH_SESSION_CAP),
  };
}

/**
 * How much a SECOND hop keeps of its parent's closeness. A first-hop page
 * scores `s/(s+1)` (≥ 0.5, since every neighbour scores ≥ 1.0); a second-hop
 * page `near(parent) × 0.55 × s/(s+1)`, whose ceiling at `STRENGTH_MAX` is
 * ≈0.40 — so no second-hop page ever outranks a first-hop one.
 */
export const NEAR_HOP_DECAY = 0.55;

/** The near map keeps this many strongest entries — the payload bound on
 *  `/api/wiki/page`'s `near`. */
export const NEAR_MAX = 200;

/** The session reason's prefix — `shares session <ref>`, the OPEN page's own
 *  spelling of each shared ref, at most `RELATED_SHARED_PRS_SHOWN` and
 *  comma-joined like the PR reason. Here rather than in `related.ts` because
 *  the browser's `wiki-related-view.ts` parses it back out to wrap the refs. */
export const REASON_SESSION_PREFIX = "shares session ";

/** `GET /api/wiki/related`'s `limit`: the default the reader's ▸ asks for, and
 *  the ceiling a caller is clamped to. */
export const RELATED_HOP_LIMIT_DEFAULT = 6;
export const RELATED_HOP_LIMIT_MAX = 20;
