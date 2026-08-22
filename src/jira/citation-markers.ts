/**
 * The `[n]` REPAIR — a deterministic post-pass over the generated draft.
 *
 * **Why it exists.** The prompt used to instruct the model to mark claims with
 * `[n]`, while `## Referanser` is appended server-side as an unnumbered,
 * key-deduped list over the depth slice. The two never met: measured on a real
 * `Skisse` draft, the body carried `[5]`, `[4]`, `[6]` and `[7]` and the paste
 * had nothing to resolve them against — a Jira description shipping dangling
 * footnote numbers. The instruction is gone (`prompt.ts` now asks for the key or
 * the title in prose), and this is the backstop for a model that emits them
 * anyway.
 *
 * **A repair, not a lint.** It flags nothing and reports nothing: unlike
 * `markdown-check.ts`, whose whole point is that a construct Jira will not
 * convert must be seen by a human, a dangling marker has exactly one correct
 * resolution — delete it — and there is nothing for the reader to decide.
 *
 * **Only markers it can PROVE are markers.** `n` must be between 1 and the
 * number of citations the model was actually given (`citationsUsed`), which on
 * this corpus is at most `JIRA_STORED_MAX_SOURCES` (24). That is what keeps a
 * literal `[2024]` — or a `[12]` chapter reference in a `Skisse` draft written
 * from 6 sources — in the text. The residual is accepted: a hallucinated `[7]`
 * over 6 citations survives, because from here it is indistinguishable from an
 * ordinary bracketed number, and the instruction change is what stops it being
 * produced.
 *
 * Pure and IO-free, like its `src/jira/` siblings.
 */

/**
 * A whole RUN of markers plus the whitespace around it — `[1][2][3]`, not one
 * `[1]` at a time.
 *
 * Two reasons it is a run rather than a single marker. Whitespace is part of the
 * match because the alternative — collapsing double spaces afterwards — eats
 * list indentation and the inside of a `Full` draft's fenced code excerpt; and
 * matching one marker at a time then hands the FIRST of a run the leading space
 * and the LAST the trailing one, so `grunnlaget [1][2][3] er` came back as
 * `grunnlageter`.
 */
const MARKER_RUN_RE = /([ \t]*)((?:\[\d+\][ \t]*)+)/g;
const ONE_MARKER_RE = /\[(\d+)\]/g;

export function stripCitationMarkers(markdown: string, citationsUsed: number): string {
  if (citationsUsed <= 0) return markdown;
  const isMarker = (token: string): boolean => {
    const n = Number(token.slice(1, -1));
    return Number.isInteger(n) && n >= 1 && n <= citationsUsed;
  };

  return markdown.replace(MARKER_RUN_RE, (match, before: string, run: string) => {
    const tokens = run.match(ONE_MARKER_RE) ?? [];
    const kept = tokens.filter((t) => !isMarker(t));
    if (kept.length === tokens.length) return match; // nothing in the run is ours
    const trailing = /[ \t]*$/.exec(run)?.[0] ?? "";
    // Both sides had space ⇒ the words on either side still need one between them.
    if (kept.length === 0) return before && trailing ? " " : "";
    return `${before}${kept.join("")}${trailing}`;
  });
}
