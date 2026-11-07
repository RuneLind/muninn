/**
 * The triage status line's text as `e2e/wiki-decision-inbox.spec.ts` asserts it,
 * shared with a unit test that renders the line at every hour (the seeded run is
 * 2 h old, so between 00:00 and 02:00 Oslo it carries yesterday's date).
 */
export const TRIAGE_CHECKED_3_CARDS = /Triage checked (\d{2}\.\d{2} )?\d{2}:\d{2} · 3 cards · 1 with code facts/;
