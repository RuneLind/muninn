/**
 * CSS for the component block vocabulary (Callout, Verdict, Pill, Figure,
 * FileRef, ComparisonTable, Meter, Diff, FileTree, Checklist, AnnotatedCode,
 * CodeTabs + its Tab child, Fold), scoped to a caller-supplied selector.
 *
 * The class names and markup mirror mimir's MDX explainer set
 * (`scripts/mdx-explainer/components.tsx` + `template.ts`) so the vocabulary
 * reads identically across explainers, wiki pages, and chat answers. Colors map
 * onto muninn's shared design tokens (`shared-styles.ts`), which are already
 * theme-aware — referencing them gives light + dark for free.
 *
 * Injected once per scope: the `/wiki` article pane (`.wiki-article`), the
 * research answer body (`.answer-body`), and the web chat bubble (`.web-content`).
 *
 * Spacing and table/diagram treatment are tuned to match the compiled MDX
 * explainer shell (`scripts/mdx-explainer/template.ts`, `baseCss`). Block
 * spacing is rem-scale (root-relative, so fixed across scopes — matching the
 * explainer's absolute rhythm); font-sizes use `em` so text tracks each scope's
 * own base size (14px wiki, 15px research, 13px chat).
 *
 * `.diagram*` matches no markup yet — it lands with client-side mermaid
 * (visual-parity PR C), which wraps rendered diagrams in this class family.
 */
export function componentBlockCss(scope: string): string {
  return `
    ${scope} .callout {
      border-left: 4px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      border-radius: 0 8px 8px 0;
      padding: 1rem 1.2rem;
      margin: 1.5rem 0;
    }
    ${scope} .callout-title { display: block; margin-bottom: 0.35rem; font-weight: 600; color: var(--accent-light); }
    ${scope} .callout-body > :first-child { margin-top: 0; }
    ${scope} .callout-body > :last-child { margin-bottom: 0; }
    ${scope} .callout-info { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
    ${scope} .callout-info .callout-title { color: var(--accent-light); }
    ${scope} .callout-good { border-left-color: var(--status-success); background: color-mix(in srgb, var(--status-success) 14%, transparent); }
    ${scope} .callout-good .callout-title { color: var(--status-success); }
    ${scope} .callout-bad { border-left-color: var(--status-error); background: color-mix(in srgb, var(--status-error) 14%, transparent); }
    ${scope} .callout-bad .callout-title { color: var(--status-error); }
    ${scope} .callout-warn { border-left-color: var(--status-warning); background: color-mix(in srgb, var(--status-warning) 14%, transparent); }
    ${scope} .callout-warn .callout-title { color: var(--status-warning); }
    /* A resolved callout: one compact good-tone row, body behind the fold. */
    ${scope} .callout-resolved { padding: 0.45rem 0.9rem; margin: 1rem 0; }
    ${scope} .callout-resolved > summary { cursor: pointer; color: var(--text-secondary); }
    ${scope} .callout-resolved > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    ${scope} .callout-resolved-mark { color: var(--status-success); font-weight: 700; }
    ${scope} .callout-resolved-date { font-variant-numeric: tabular-nums; }
    ${scope} .callout-resolved-title { font-weight: 600; }
    ${scope} .callout-resolved > .callout-body { margin-top: 0.6rem; }
    ${scope} .verdict { font-weight: 600; }
    ${scope} .verdict-yes { color: var(--status-success); }
    ${scope} .verdict-no { color: var(--status-error); }
    ${scope} .pill {
      display: inline-block;
      font-size: 0.75em;
      font-weight: 600;
      padding: 0.12em 0.6em;
      border-radius: 999px;
      border: 1px solid var(--border-secondary);
      color: var(--text-muted);
      vertical-align: middle;
      margin-left: 0.4rem;
    }
    ${scope} .pill-rec { border-color: var(--status-success); color: var(--status-success); }
    ${scope} .pill-warn { border-color: var(--status-warning); color: var(--status-warning); }
    ${scope} .tablewrap { overflow-x: auto; margin: 1.2rem 0; }
    ${scope} .tablewrap table {
      border-collapse: collapse;
      margin: 0;
      width: 100%;
      font-size: 0.92em;
      background: var(--bg-surface);
    }
    ${scope} .tablewrap th, ${scope} .tablewrap td {
      border: 1px solid var(--border-secondary);
      padding: 0.55rem 0.7rem;
      text-align: left;
      vertical-align: top;
    }
    ${scope} .tablewrap th { background: var(--bg-inset); color: var(--text-primary); }
    ${scope} .fileref { color: var(--accent-light); font-family: var(--mono, ui-monospace, monospace); }
    ${scope} .figure { margin: 1.4rem 0; }
    ${scope} .figure-body { overflow-x: auto; }
    ${scope} .figure img { max-width: 100%; height: auto; }
    ${scope} .embed { margin: 1.4rem 0; }
    ${scope} .embed-fallback { color: var(--text-muted); font-size: 0.9em; margin: 0; }
    ${scope} .fold {
      margin: 1.4rem 0;
      border: 1px solid var(--border-secondary);
      border-radius: 10px;
      background: var(--bg-surface);
    }
    ${scope} .fold > summary {
      cursor: pointer;
      padding: 0.55rem 0.9rem;
      font-weight: 600;
      color: var(--text-primary);
      border-radius: 10px;
    }
    ${scope} .fold > summary:hover { color: var(--accent-light); }
    ${scope} .fold > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    ${scope} .fold[open] > summary {
      border-bottom: 1px solid var(--border-secondary);
      border-radius: 10px 10px 0 0;
    }
    ${scope} .fold-body { padding: 0.2rem 1rem 0.9rem; }
    ${scope} .fold-body > :first-child { margin-top: 0.6rem; }
    ${scope} .fold-body > :last-child { margin-bottom: 0; }
    /* The section heading the fold's own title repeats. Hidden, not removed —
       the reader's Explain helper finds a selection's section by walking back to
       a heading tag, so dropping the element would move every following
       paragraph into the previous section. */
    ${scope} .fold-heading-dup { display: none; }
    /* --text-soft, not --text-muted: muted sits under 4.5:1 on the light fold fill. */
    ${scope} .fold-summary {
      margin-left: 0.6rem;
      font-weight: 400;
      font-size: 0.88em;
      color: var(--text-soft);
    }
    /* A section kept as history, dimmed by COLOUR rather than opacity: opacity
       multiplies every colour inside, so a --text-soft chip fell to 2.50:1 in
       light (3.65:1 dark). --text-soft (and --text-secondary for headings) keeps every line
       at >= 4.5:1; the muted dashed rule carries the rest. Full on hover/focus. */
    ${scope} .historic {
      margin: 1.4rem 0;
      padding-left: 0.9rem;
      border-left: 3px dashed var(--border-secondary);
    }
    ${scope} .historic-stamp { font-size: 0.85em; color: var(--text-soft); margin-bottom: 0.4rem; }
    ${scope} .historic-mark { font-weight: 700; }
    ${scope} .historic-since { font-family: var(--mono, ui-monospace, monospace); }
    ${scope} .historic-body { color: var(--text-soft); transition: color 0.15s; }
    ${scope} .historic-body :is(h1, h2, h3, h4, h5, h6) { color: var(--text-secondary); }
    ${scope} .historic:hover .historic-body,
    ${scope} .historic:focus-within .historic-body { color: inherit; }
    ${scope} .historic:hover .historic-body :is(h1, h2, h3, h4, h5, h6),
    ${scope} .historic:focus-within .historic-body :is(h1, h2, h3, h4, h5, h6) { color: var(--text-primary); }
    /* NextMoves: one card per lane. The renderer picks the column count from
       the number of cards (nm-cols-N: up to three in a row, four as 2×2), so
       no count leaves a card alone on a row; a narrow container goes to one
       column. A blocked lane is a full-width strip below (nm-strips).
       Label text on the you lane is --accent-light: --accent itself measures
       under 4.5:1 as text on the dark panel. */
    ${scope} .next-moves { margin: 1.4rem 0; container-type: inline-size; }
    ${scope} .nm-intro { margin-bottom: 0.6rem; }
    ${scope} .nm-grid { display: grid; gap: 0.75rem; }
    ${scope} .nm-cols-1 { grid-template-columns: minmax(0, 1fr); }
    ${scope} .nm-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    ${scope} .nm-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    ${scope} .nm-cols-auto { grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); }
    @container (max-width: 520px) {
      ${scope} .nm-grid { grid-template-columns: minmax(0, 1fr); }
    }
    ${scope} .nm-strips { display: grid; gap: 0.5rem; margin-top: 0.75rem; }
    ${scope} .nm-strips .nm-lane {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.85rem;
      padding: 0.4rem 0.85rem; background: transparent; border-style: dashed;
    }
    ${scope} .nm-strips .nm-head { margin-bottom: 0; }
    ${scope} .nm-strips .nm-body { flex: 1 1 16rem; min-width: 0; }
    ${scope} .nm-since-raw { font-style: italic; }
    ${scope} .nm-lane {
      min-width: 0;
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      padding: 0.6rem 0.85rem;
      background: var(--bg-surface);
    }
    ${scope} .nm-lane.nm-you {
      border-left: 4px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface));
    }
    ${scope} .nm-head {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem;
      font-size: 0.85em; color: var(--text-secondary); margin-bottom: 0.35rem;
    }
    ${scope} .nm-who { font-weight: 700; }
    ${scope} .nm-you .nm-who { color: var(--accent-light); }
    ${scope} .nm-count, ${scope} .nm-since { color: var(--text-soft); font-variant-numeric: tabular-nums; }
    ${scope} .nm-body > :first-child { margin-top: 0; }
    ${scope} .nm-body > :last-child { margin-bottom: 0; }
    ${scope} .nm-body > ul, ${scope} .nm-body > ol { margin: 0; padding-left: 1.2rem; }
    /* The reader's compact «Oppfølging» block (D13): a title with a count line,
       then one closed <details> per lane — label, count, age and a one-line
       peek in the summary, the body when opened. The viewer's lanes (the
       reader's .nm-mine) carry an inset rule and a «deg» mark. */
    ${scope} .nm-compact .nm-title-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.75rem; margin-bottom: 0.45rem; }
    ${scope} .nm-compact .nm-title { font-weight: 700; font-size: 1.1em; color: var(--text-primary); }
    ${scope} .nm-compact .nm-sum { font-size: 0.88em; color: var(--text-soft); }
    ${scope} .nm-compact .nm-lanes { border: 1px solid var(--border-secondary); border-radius: 10px; overflow: hidden; }
    ${scope} .nm-compact .nm-lane {
      border: 0; border-radius: 0; padding: 0; background: var(--bg-surface);
      border-top: 1px solid var(--border-secondary);
    }
    ${scope} .nm-compact .nm-lane:first-child { border-top: 0; }
    ${scope} .nm-compact .nm-lane.nm-you { border-left: 0; background: var(--bg-surface); }
    ${scope} .nm-compact .nm-lane.nm-mine { box-shadow: inset 4px 0 0 var(--accent); }
    ${scope} .nm-compact .nm-head {
      display: flex; flex-wrap: nowrap; align-items: baseline; gap: 0.2rem 0.6rem;
      margin: 0; padding: 0.5rem 0.85rem; cursor: pointer; list-style: none; font-size: 0.9em;
    }
    ${scope} .nm-compact .nm-head > * { flex: none; }
    ${scope} .nm-compact .nm-head::-webkit-details-marker { display: none; }
    ${scope} .nm-compact .nm-head::before { content: "▸" / ""; color: var(--text-soft); flex: none; }
    ${scope} .nm-compact .nm-lane[open] > .nm-head::before { content: "▾" / ""; }
    ${scope} .nm-compact .nm-head:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    ${scope} .nm-compact .nm-blocked .nm-who { color: var(--text-secondary); }
    ${scope} .nm-compact .nm-mine-mark {
      font-size: 0.85em; font-weight: 600; padding: 0 0.4rem; border-radius: 999px;
      border: 1px solid currentColor; color: var(--accent-light);
    }
    ${scope} .nm-compact .nm-head > .nm-peek { flex: 1 1 0; color: var(--text-soft); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    ${scope} .nm-compact .nm-body { padding: 0.2rem 0.95rem 0.75rem; }
    ${scope} .nm-compact .nm-qcards > .nm-qcard > .question { margin: 0.75rem 0 0; }
    @container (max-width: 520px) {
      ${scope} .nm-compact .nm-head { flex-wrap: wrap; }
      ${scope} .nm-compact .nm-head > .nm-peek { flex: 1 1 100%; }
    }
    ${scope} .q-moved { font-size: 0.9em; margin: 0.6rem 0; }
    ${scope} .q-moved-link { color: var(--accent-light); }
    /* Query: one card per prod query. Muted lines are --text-soft (4.5:1 on
       --bg-surface in both schemes, pinned by e2e/wiki-query.spec.ts). The
       table scrolls inside its own box; the header row stays put. */
    ${scope} .query {
      margin: 1.4rem 0;
      border: 1px solid var(--border-secondary);
      border-radius: 10px;
      background: var(--bg-surface);
      padding: 0.8rem 1rem;
      scroll-margin-top: 1rem;
    }
    ${scope} .query-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.6rem; font-weight: 600; }
    ${scope} .query-id { font-family: var(--mono, ui-monospace, monospace); color: var(--accent-light); text-decoration: none; }
    ${scope} .query-id:hover { text-decoration: underline; }
    ${scope} .query-answer { margin-top: 0.35rem; }
    ${scope} .query-meta {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.9rem;
      margin-top: 0.4rem; font-size: 0.85em; color: var(--text-soft);
    }
    ${scope} .query-run { font-variant-numeric: tabular-nums; }
    ${scope} .query-use {
      display: inline-block; margin-left: 0.35rem; padding: 0 0.45rem;
      border: 1px solid var(--border-secondary); border-radius: 999px;
      font-family: var(--mono, ui-monospace, monospace);
    }
    ${scope} .query-body { margin-top: 0.7rem; }
    ${scope} .query-body > :first-child { margin-top: 0; }
    ${scope} .query-result { margin-top: 0.8rem; }
    ${scope} .query-result-head { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.85em; margin-bottom: 0.3rem; }
    ${scope} .query-rows, ${scope} .query-truncated, ${scope} .query-unavailable, ${scope} .query-warning { color: var(--text-soft); font-size: 0.85em; }
    ${scope} .query-unavailable, ${scope} .query-warning { font-style: italic; margin: 0.3rem 0; }
    ${scope} .query-truncated { margin: 0.3rem 0 0; }
    ${scope} .query-table-wrap {
      max-height: 24rem; overflow: auto;
      border: 1px solid var(--border-secondary); border-radius: 6px;
    }
    ${scope} .query-table { margin: 0; border-collapse: collapse; width: max-content; min-width: 100%; font-size: 0.85em; }
    ${scope} .query-table th {
      position: sticky; top: 0; background: var(--bg-surface); text-align: left; white-space: pre-line;
    }
    ${scope} .query-table th button {
      all: unset; cursor: pointer; display: inline-flex; gap: 0.3rem; align-items: baseline;
    }
    ${scope} .query-table th button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    ${scope} .query-sort-mark { color: var(--text-soft); font-size: 0.85em; }
    ${scope} .query-table td { font-variant-numeric: tabular-nums; white-space: pre-line; vertical-align: top; }
    ${scope} .query-table .query-num { text-align: right; }
    ${scope} .query-sql { margin-top: 0.8rem; }
    ${scope} .query-sql > summary { cursor: pointer; font-weight: 600; color: var(--text-secondary); }
    ${scope} .query-sql > summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    ${scope} .query-sql-body { margin-top: 0.4rem; }
    /* Query explorer (reader only): a search box and uses chips above a run of
       two or more cards. Muted text is --text-soft, pinned by
       e2e/wiki-caseboard.spec.ts. */
    ${scope} .query[hidden] { display: none; }
    ${scope} .qx-bar {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 0.6rem;
      margin: 1.4rem 0 -0.6rem;
    }
    ${scope} .qx-search {
      flex: 1 1 12rem; min-width: 0; padding: 0.3rem 0.55rem; font: inherit; font-size: 0.9em;
      color: var(--text-primary); background: var(--bg-surface);
      border: 1px solid var(--border-secondary); border-radius: 6px;
    }
    ${scope} .qx-search:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    ${scope} .qx-chips { display: flex; flex-wrap: wrap; gap: 0.3rem; }
    ${scope} .qx-chip {
      font: inherit; font-size: 0.8em; font-family: var(--mono, ui-monospace, monospace); cursor: pointer;
      padding: 0.05rem 0.5rem; border-radius: 999px; color: var(--text-secondary);
      background: transparent; border: 1px solid var(--border-secondary);
    }
    ${scope} .qx-chip[aria-pressed="true"] { color: var(--text-primary); border-color: var(--accent); background: var(--tint-purple); }
    ${scope} .qx-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    ${scope} .qx-count { color: var(--text-soft); font-size: 0.85em; font-variant-numeric: tabular-nums; }
    /* CaseBoard: a count strip, then one row per case grouped by status. The
       pill carries the status in words; its tint only helps the scan. */
    ${scope} .caseboard {
      margin: 1.4rem 0; border: 1px solid var(--border-secondary); border-radius: 10px;
      background: var(--bg-surface); padding: 0.7rem 1rem;
    }
    ${scope} .cb-strip { margin: 0 0 0.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
    ${scope} .cb-sep { color: var(--text-soft); font-weight: 400; }
    ${scope} .cb-unavailable, ${scope} .cb-truncated, ${scope} .cb-warning {
      color: var(--text-soft); font-size: 0.85em; margin: 0.3rem 0;
    }
    ${scope} .cb-unavailable, ${scope} .cb-warning { font-style: italic; }
    ${scope} .cb-group + .cb-group { border-top: 1px solid var(--border-secondary); }
    ${scope} .cb-row {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem;
      padding: 0.35rem 0; scroll-margin-top: 1rem;
    }
    ${scope} .cb-row + .cb-row { border-top: 1px dashed var(--border-secondary); }
    ${scope} .cb-row:target { background: var(--tint-purple); }
    ${scope} .cb-id {
      font-family: var(--mono, ui-monospace, monospace); font-weight: 600; color: var(--accent-light);
      text-decoration: none; white-space: nowrap;
    }
    ${scope} a.cb-id:hover { text-decoration: underline; }
    ${scope} .cb-pill {
      font-size: 0.8em; padding: 0 0.5rem; border-radius: 999px; color: var(--text-primary);
      border: 1px solid var(--border-secondary);
    }
    ${scope} .cb-hold { background: var(--tint-warning); }
    ${scope} .cb-wait { background: var(--tint-info); }
    ${scope} .cb-wrong { background: var(--tint-error); }
    ${scope} .cb-none { background: var(--tint-neutral); }
    ${scope} .cb-ok { background: var(--tint-success); }
    ${scope} .cb-unknown { background: var(--tint-magenta); border-style: dashed; }
    ${scope} .cb-owner { color: var(--text-soft); font-size: 0.85em; }
    ${scope} .cb-note { flex: 1 1 18rem; min-width: 0; }
    ${scope} .cb-refs { display: inline-flex; flex-wrap: wrap; gap: 0.3rem; }
    ${scope} .cb-ref {
      font-family: var(--mono, ui-monospace, monospace); font-size: 0.8em; color: var(--text-soft);
      padding: 0 0.4rem; border: 1px solid var(--border-secondary); border-radius: 999px;
    }
    /* DeltaTable: runs right-aligned, the delta last. better= colours a change
       good or bad; a change with no better= and no change stay uncoloured. */
    ${scope} .delta-table { margin: 1.2rem 0; --dt-good: var(--tok-str); --dt-bad: var(--status-error); }
    ${scope} .dt-body > :first-child { margin-top: 0; }
    ${scope} .dt-wrap { overflow-x: auto; }
    ${scope} .dt-table { margin: 0; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    ${scope} .dt-table th[scope="row"] { text-align: left; font-weight: 400; }
    ${scope} .dt-table .dt-run, ${scope} .dt-table .dt-delta { text-align: right; }
    ${scope} .dt-table td.dt-run, ${scope} .dt-table td.dt-delta { white-space: nowrap; }
    /* Run labels can be long ("08.09 simulering"): only the cells above keep
       one line, so a header wraps and the delta column stays inside the
       article (e2e/wiki-caseboard.spec.ts fails with th nowrap). */
    ${scope} .dt-table thead th { vertical-align: bottom; }
    ${scope} .dt-delta-runs, ${scope} .dt-delta-dir { display: block; font-size: 0.85em; }
    ${scope} .dt-delta-dir { color: var(--text-soft); font-weight: 400; }
    ${scope} .dt-mark { font-weight: 600; }
    ${scope} .dt-overflow { color: var(--text-soft); font-size: 0.85em; font-style: italic; }
    ${scope} .dt-delta-runs, ${scope} .dt-pct { color: var(--text-soft); font-weight: 400; }
    ${scope} .dt-good, ${scope} .dt-good .dt-pct { color: var(--dt-good); }
    ${scope} .dt-bad, ${scope} .dt-bad .dt-pct { color: var(--dt-bad); }
    ${scope} .dt-unavailable, ${scope} .dt-note, ${scope} .dt-warning, ${scope} .dt-truncated {
      color: var(--text-soft); font-size: 0.85em; margin: 0.3rem 0;
    }
    ${scope} .dt-unavailable, ${scope} .dt-warning { font-style: italic; }
    /* Tldr: the page's lead box. A full border with an accent top rule, so it
       does not read as a callout's left bar. */
    ${scope} .tldr {
      margin: 1.4rem 0; padding: 0.8rem 1.1rem; border-radius: 10px; background: var(--bg-surface);
      border: 1px solid var(--border-secondary); border-top: 3px solid var(--accent);
    }
    ${scope} .tldr-label {
      font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--accent-light); margin-bottom: 0.35rem;
    }
    ${scope} .tldr-body > :first-child { margin-top: 0; }
    ${scope} .tldr-body > :last-child { margin-bottom: 0; }
    /* More: the Tldr's closed «Mer om saken» part, under a hairline. */
    ${scope} .tldr-more { margin-top: 0.6rem; padding-top: 0.4rem; border-top: 1px solid var(--border-secondary); }
    ${scope} .tldr-more > summary { cursor: pointer; font-size: 0.92em; font-weight: 600; color: var(--accent-light); }
    ${scope} .tldr-more-body > :first-child { margin-top: 0.4rem; }
    ${scope} .tldr-more-body > :last-child { margin-bottom: 0; }
    /* StatusRows: a label column and a value column; a state phrase is a
       text-on-tint pill like the CaseBoard's. */
    ${scope} .status-rows { margin: 1rem 0; }
    ${scope} .sr-grid {
      display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.2rem 0.9rem; align-items: baseline;
      padding: 0.55rem 0.85rem; border: 1px solid var(--border-secondary); border-radius: 9px; background: var(--bg-surface);
    }
    ${scope} .sr-grid + .sr-grid { margin-top: 0.5rem; }
    ${scope} .sr-row { display: contents; }
    ${scope} .sr-label { color: var(--text-soft); font-size: 0.85em; font-weight: 600; }
    ${scope} .sr-value { min-width: 0; }
    ${scope} .sr-sep { color: var(--text-soft); }
    ${scope} .sr-state {
      font-size: 0.9em; padding: 0 0.45rem; border-radius: 999px; white-space: nowrap;
      color: var(--text-primary); border: 1px solid var(--border-secondary);
    }
    ${scope} .sr-good { background: var(--tint-success); }
    ${scope} .sr-warn { background: var(--tint-warning); }
    ${scope} .sr-muted { background: var(--tint-neutral); }
    ${scope} .sr-info { background: var(--tint-info); }
    ${scope} .status-rows :not(pre) > code { overflow-wrap: anywhere; }
    @media (max-width: 520px) {
      ${scope} .sr-grid { grid-template-columns: minmax(0, 1fr); }
    }
    /* Timeline: dated items on a vertical rail, the date as the marker. The gtl-
       prefix, because chat's inspector styles timeline/tl-item unscoped. */
    ${scope} .gtl { margin: 1.2rem 0; }
    ${scope} .gtl-list {
      list-style: none; margin: 0.6rem 0 0.6rem 0.4rem; padding: 0 0 0 1.1rem;
      border-left: 2px solid var(--border-secondary);
    }
    ${scope} .gtl-item { position: relative; padding: 0.2rem 0; }
    ${scope} .gtl-dated::before {
      content: ""; position: absolute; box-sizing: border-box; width: 10px; height: 10px; border-radius: 50%;
      left: calc(-1.1rem - 6px); top: 0.75em; background: var(--accent);
    }
    ${scope} .gtl-date {
      font-family: var(--mono, ui-monospace, monospace); font-weight: 600; font-variant-numeric: tabular-nums;
      color: var(--text-secondary); margin-right: 0.5rem; white-space: nowrap;
    }
    /* DecisionLog: the id as a chip with its own anchor; a struck or
       superseded item dims to --text-soft, which keeps 4.5:1. */
    ${scope} .decision-log { margin: 1.2rem 0; }
    ${scope} .dl-list { list-style: none; margin: 0.6rem 0; padding: 0; }
    ${scope} .dl-item { padding: 0.25rem 0; scroll-margin-top: 1rem; }
    ${scope} .dl-item:target { background: var(--tint-purple); }
    ${scope} .dl-list > .dl-noid { list-style: disc; margin-left: 1.25rem; }
    ${scope} .dl-id {
      display: inline-block; font-family: var(--mono, ui-monospace, monospace); font-size: 0.8em; font-weight: 700;
      padding: 0 0.45rem; margin-right: 0.5rem; border-radius: 999px; border: 1px solid var(--border-secondary);
      background: var(--bg-surface); color: var(--accent-light); text-decoration: none;
    }
    ${scope} a.dl-id:hover { text-decoration: underline; }
    ${scope} .dl-dim, ${scope} .dl-dim .dl-id { color: var(--text-soft); }
    /* Question: an answer card. The state pill reuses the CaseBoard pill's
       text-on-tint pairing; muted lines are --text-soft. */
    ${scope} .question {
      margin: 1.2rem 0; padding: 0.7rem 1rem; border-radius: 10px; background: var(--bg-surface);
      border: 1px solid var(--border-secondary); border-left: 3px solid var(--accent);
    }
    ${scope} .q-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.5rem; }
    ${scope} .q-label {
      font-size: 0.78em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent-light);
    }
    ${scope} .q-id {
      font-family: var(--mono, ui-monospace, monospace); font-weight: 600; color: var(--accent-light); text-decoration: none;
    }
    ${scope} a.q-id:hover, ${scope} a.q-decision:hover { text-decoration: underline; }
    ${scope} .q-state {
      font-size: 0.8em; padding: 0 0.5rem; border-radius: 999px; color: var(--text-primary);
      border: 1px solid var(--border-secondary); background: var(--tint-info);
    }
    ${scope} .q-decided .q-state { background: var(--tint-success); }
    ${scope} .q-closed .q-state { background: var(--tint-neutral); }
    ${scope} .q-decision { color: inherit; font-family: var(--mono, ui-monospace, monospace); font-weight: 600; }
    ${scope} .q-body { margin-top: 0.4rem; }
    ${scope} .q-for, ${scope} .q-note { color: var(--text-soft); font-size: 0.85em; margin: 0.4rem 0 0; }
    ${scope} .q-for-label { font-weight: 600; }
    ${scope} .question :not(pre) > code { overflow-wrap: anywhere; }
    /* RunChecklist: a step count, then labelled Command / Expect / Stop-if rows
       under each step. */
    ${scope} .run-checklist { margin: 1.2rem 0; }
    ${scope} .rc-count { color: var(--text-soft); font-size: 0.85em; font-variant-numeric: tabular-nums; }
    ${scope} .run-checklist > .checklist { margin-top: 0.3rem; }
    /* A step number sits in a fixed right-aligned box in the row's left
       padding, out of flow, so a flex row (gap) and a block parent row (no
       gap) put the mark at the same x, whatever the number's width. */
    ${scope} .check-item:has(> .rc-num) { position: relative; padding-left: calc(3ch + 0.5rem); }
    ${scope} .rc-num {
      position: absolute; left: 0; top: 0.15rem; width: 3ch; text-align: right;
      color: var(--text-soft); font-weight: 400; font-variant-numeric: tabular-nums;
    }
    ${scope} .rc-row {
      display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: 0.1rem 0.6rem; align-items: baseline;
      margin: 0.25rem 0 0 1.5rem;
    }
    ${scope} .rc-label { color: var(--text-soft); font-size: 0.85em; font-weight: 600; }
    ${scope} .rc-value { min-width: 0; }
    ${scope} .rc-value > :is(pre, .fence) { margin: 0.1rem 0; }
    /* A long identifier in inline code wraps instead of widening the page. */
    ${scope} :is(.tldr, .gtl, .decision-log, .run-checklist) :not(pre) > code { overflow-wrap: anywhere; }
    /* Narrow screens: the label stacks above its value. */
    @media (max-width: 520px) {
      ${scope} .rc-row { grid-template-columns: minmax(0, 1fr); margin-left: 0.75rem; }
    }
    ${scope} .diagram {
      background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      border-radius: 10px;
      padding: 1.2rem;
      margin: 1.4rem 0;
      text-align: center;
    }
    ${scope} .diagram-body { overflow-x: auto; }
    ${scope} .diagram svg { max-width: 100%; height: auto; }
    ${scope} .caption { color: var(--text-muted); font-size: 0.85em; text-align: center; margin-top: 0.5rem; }
    ${scope} .meter { display: flex; align-items: center; gap: 0.6rem; margin: 1rem 0; }
    ${scope} .meter-label { font-weight: 600; color: var(--text-primary); }
    ${scope} .meter-bar {
      flex: 1;
      height: 0.5rem;
      min-width: 3rem;
      background: var(--bg-inset);
      border: 1px solid var(--border-secondary);
      border-radius: 999px;
      overflow: hidden;
    }
    ${scope} .meter-fill { display: block; height: 100%; background: var(--accent); border-radius: 999px; }
    ${scope} .meter-value { color: var(--text-muted); font-size: 0.85em; font-variant-numeric: tabular-nums; white-space: nowrap; }
    ${scope} .meter-good .meter-fill { background: var(--status-success); }
    ${scope} .meter-warn .meter-fill { background: var(--status-warning); }
    ${scope} .meter-bad .meter-fill { background: var(--status-error); }
    ${scope} .diff {
      margin: 1.2rem 0;
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      overflow: hidden;
      font-family: var(--mono, ui-monospace, monospace);
      font-size: 0.85em;
      background: var(--bg-surface);
    }
    ${scope} .diff-line {
      display: block;
      padding: 0.05rem 0.7rem;
      white-space: pre-wrap;
      word-break: break-word;
      border-left: 3px solid transparent;
    }
    ${scope} .diff-add { background: color-mix(in srgb, var(--status-success) 16%, transparent); border-left-color: var(--status-success); }
    ${scope} .diff-del { background: color-mix(in srgb, var(--status-error) 16%, transparent); border-left-color: var(--status-error); }
    ${scope} .diff-ctx { color: var(--text-muted); }
    ${scope} .filetree {
      margin: 1.2rem 0;
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      background: var(--bg-surface);
      overflow-x: auto;
    }
    ${scope} .filetree pre {
      margin: 0;
      padding: 0.8rem 1rem;
      background: transparent;
      border: 0;
      font-family: var(--mono, ui-monospace, monospace);
      font-size: 0.85em;
      line-height: 1.5;
      color: var(--text-primary);
      white-space: pre;
    }
    ${scope} .filetree code { background: transparent; padding: 0; color: inherit; }
    ${scope} .checklist { list-style: none; margin: 1.2rem 0; padding: 0; }
    ${scope} .check-item {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      padding: 0.15rem 0;
      line-height: 1.5;
    }
    ${scope} .check-item.check-parent { display: block; }
    ${scope} :is(.check-item, .check-plain) > .checklist { margin: 0.15rem 0 0 1.5rem; }
    ${scope} .checklist > .check-plain { list-style-type: disc; margin-left: 1.25rem; padding: 0.15rem 0; }
    ${scope} .check-ol > .check-plain { list-style-type: decimal; }
    ${scope} .check-mark { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
    /* Child combinators: a row's colours come from its OWN state, never from a
       parent row it is nested in (a parent's todo text colour sits on its
       .check-text, not on the <li> that also holds the child rows; a flat row
       carries a .check-text too, in the same colour as its <li>). */
    ${scope} .check-done > .check-mark { color: var(--status-success); }
    ${scope} .check-todo > .check-mark { color: var(--text-muted); }
    ${scope} .check-todo:not(.check-parent), ${scope} .check-todo > .check-text { color: var(--text-muted); }
    ${scope} .annotated-code {
      margin: 1.2rem 0;
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-surface);
    }
    ${scope} .annotated-code-file {
      padding: 0.45rem 0.9rem;
      font-family: var(--mono, ui-monospace, monospace);
      font-size: 0.8em;
      color: var(--accent-light);
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border-secondary);
    }
    ${scope} .annotated-code-panel pre { margin: 0; border-radius: 0; }
    ${scope} .annotated-code-notes {
      padding: 0.6rem 0.9rem;
      font-size: 0.9em;
      color: var(--text-muted);
      border-top: 1px solid var(--border-secondary);
    }
    ${scope} .annotated-code-notes > :first-child { margin-top: 0; }
    ${scope} .annotated-code-notes > :last-child { margin-bottom: 0; }
    ${scope} .code-tabs {
      margin: 1.2rem 0;
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-surface);
    }
    ${scope} .code-tabs-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.15rem;
      padding: 0.3rem 0.3rem 0;
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border-secondary);
    }
    ${scope} .code-tabs-tab {
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font: inherit;
      font-size: 0.85em;
      padding: 0.4rem 0.8rem;
      border-radius: 6px 6px 0 0;
      cursor: pointer;
    }
    ${scope} .code-tabs-tab:hover { color: var(--text-primary); }
    ${scope} .code-tabs-tab.is-active {
      color: var(--accent-light);
      background: var(--bg-surface);
      font-weight: 600;
    }
    /* The server marks the first panel .is-active, so it shows before (and
     * without) the client enhancer; the enhancer moves .is-active on tab click. */
    ${scope} .code-tabs-panel { display: none; }
    ${scope} .code-tabs-panel.is-active { display: block; }
    ${scope} .code-tabs-panel pre { margin: 0.6rem; }
    ${scope} .code-tabs-fallback { margin: 1.2rem 0; }
    ${scope} .code-tab-standalone {
      margin: 1.2rem 0;
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-surface);
    }
    ${scope} .code-tab-label {
      padding: 0.4rem 0.8rem;
      font-size: 0.8em;
      font-weight: 600;
      color: var(--accent-light);
      background: var(--bg-inset);
      border-bottom: 1px solid var(--border-secondary);
    }
    ${scope} .code-tab-standalone pre { margin: 0.6rem; }

    /* ── Fact-check annotation ──────────────────────────────────────────────
       A marked passage carries a verdict-tinted underline and a chip at its end.
       The underline is a border-bottom rather than text-decoration so it survives
       a wrapped passage cleanly, and the tint is deliberately faint on ok — the
       article must still read as prose, not as a highlighted textbook. */
    ${scope} .fc-mark { border-bottom: 1px dotted var(--border-secondary); }
    ${scope} .fc-mark-ok { border-bottom-color: color-mix(in srgb, var(--status-success) 55%, transparent); }
    ${scope} .fc-mark-warn { border-bottom-color: var(--status-warning); }
    ${scope} .fc-mark-bad {
      border-bottom-color: var(--status-error);
      background: color-mix(in srgb, var(--status-error) 10%, transparent);
    }
    ${scope} .fc-mark-unknown { border-bottom-style: dashed; }
    /* A Fact tag owning its whole line is claimed by the BLOCK parser, so it can't
       carry the inline underline (a border under a block spans the full column and
       reads as a rule). It gets a left rail in the same verdict colour instead —
       the mark must stay visible in both forms, or a fully-wrapped paragraph would
       silently look unchecked. */
    ${scope} .fc-mark-block {
      display: block;
      border-bottom: 0;
      border-left: 2px solid var(--border-secondary);
      padding-left: 0.7rem;
      margin: 0.5rem 0;
    }
    ${scope} .fc-mark-block.fc-mark-ok { border-left-color: color-mix(in srgb, var(--status-success) 55%, transparent); }
    ${scope} .fc-mark-block.fc-mark-warn { border-left-color: var(--status-warning); }
    ${scope} .fc-mark-block.fc-mark-bad { border-left-color: var(--status-error); }

    ${scope} .fc-chip {
      appearance: none;
      display: inline-flex;
      align-items: center;
      vertical-align: baseline;
      margin-left: 0.25em;
      padding: 0 0.45em;
      height: 1.15em;
      border-radius: 999px;
      border: 1px solid transparent;
      background: transparent;
      font: inherit;
      font-size: 0.75em;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      font-variant-numeric: tabular-nums;
      /* The chip is chrome, not prose: its glyph and its visually-hidden label
         must stay out of a copied paragraph and out of the reader's
         Explain-selection payload (which reads the selection's text). The same
         hazard covers the reader layer's toolbar and its cloned evidence card —
         see the matching rules in factcheckReaderCss below. */
      -webkit-user-select: none;
      user-select: none;
    }
    /* The label is for assistive tech only — the glyph carries it visually. Not
       display:none, which would remove it from the accessibility tree too. */
    ${scope} .fc-chip-label {
      position: absolute;
      width: 1px; height: 1px;
      margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip-path: inset(50%); white-space: nowrap;
    }
    ${scope} .fc-chip-ok {
      color: var(--status-success);
      background: color-mix(in srgb, var(--status-success) 16%, transparent);
      border-color: color-mix(in srgb, var(--status-success) 40%, transparent);
    }
    ${scope} .fc-chip-warn {
      color: var(--status-warning);
      background: color-mix(in srgb, var(--status-warning) 18%, transparent);
      border-color: var(--status-warning);
    }
    ${scope} .fc-chip-bad {
      color: var(--status-error);
      background: color-mix(in srgb, var(--status-error) 18%, transparent);
      border-color: var(--status-error);
    }
    ${scope} .fc-chip-unknown { color: var(--text-muted); border-color: var(--border-secondary); }
    ${scope} .fc-chip:hover { filter: brightness(1.25); }
    ${scope} .fc-chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    ${scope} .fc-chip[aria-expanded="true"] { outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); }

    /* The appendix: one collapsed summary line by default. */
    ${scope} .fc-block {
      margin: 1.5rem 0 0;
      border: 1px solid var(--border-secondary);
      border-radius: 10px;
      background: var(--bg-surface);
    }
    ${scope} .fc-strip {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
      padding: 0.55rem 0.9rem;
      cursor: pointer;
      font-size: 0.9em;
      color: var(--text-muted);
      border-radius: 10px;
    }
    ${scope} .fc-strip-lead b { color: var(--text-primary); }
    ${scope} .fc-count {
      display: inline-flex;
      align-items: center;
      gap: 0.3em;
      padding: 0.1em 0.6em;
      border-radius: 999px;
      border: 1px solid var(--border-secondary);
      font-size: 0.85em;
      font-weight: 600;
    }
    ${scope} .fc-count-ok { border-color: var(--status-success); color: var(--status-success); }
    ${scope} .fc-count-warn { border-color: var(--status-warning); color: var(--status-warning); }
    ${scope} .fc-count-bad { border-color: var(--status-error); color: var(--status-error); }
    ${scope} .fc-block-body {
      padding: 0.2rem 1rem 0.9rem;
      border-top: 1px solid var(--border-secondary);
      font-size: 0.95em;
    }
    ${scope} .fc-claim { padding: 0.5rem 0 0.6rem; }
    ${scope} .fc-claim + .fc-claim { border-top: 1px solid var(--border-primary); }
    ${scope} .fc-claim > :first-child { margin-top: 0.4rem; }
  `;
}

/**
 * Reader-only: the answer card's composer, answers and log fold (answer cards
 * PR 3). Only the wiki reader's client injects this chrome, so chat and
 * `/research` never ship it. Text sits on --text-primary or --text-soft; each
 * tint carries --text-primary, pinned at 4.5:1 in `e2e/wiki-answer-card.spec.ts`.
 */
export function questionReaderCss(scope: string): string {
  return `
    ${scope} .q-answered .q-state { background: var(--tint-warning); }
    ${scope} .q-copied .q-state { background: var(--tint-neutral); }
    ${scope} .q-new {
      font-size: 0.8em; padding: 0 0.5rem; border-radius: 999px; color: var(--text-primary);
      background: var(--tint-warning); border: 1px solid var(--status-warning);
    }
    ${scope} .q-answers { display: grid; gap: 0.4rem; margin-top: 0.6rem; }
    ${scope} .q-answer {
      padding: 0.5rem 0.7rem; border-radius: 8px; background: var(--bg-panel);
      border: 1px dashed var(--border-secondary);
    }
    ${scope} .q-by {
      display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.4rem;
      font-size: 0.85em; color: var(--text-soft);
    }
    /* A part carries its own leading separator, so a wrap never strands a "·". */
    ${scope} .q-by > .q-time, ${scope} .q-by > .q-edited { white-space: nowrap; }
    ${scope} .q-author { color: var(--text-primary); font-weight: 600; }
    ${scope} .q-asked, ${scope} .q-pick {
      display: inline-block; padding: 0 0.45rem; border-radius: 999px; font-size: 0.85em; color: var(--text-primary);
    }
    ${scope} .q-asked-yes { background: var(--tint-success); }
    /* "not asked" is a fact, not an alert: no fill, so it reads apart from
       the Answered pill and the "N new" badge (both --tint-warning). */
    ${scope} .q-asked-no {
      background: transparent; color: var(--text-soft); border: 1px dashed var(--border-secondary);
    }
    /* An author's group (WIKI_ANSWER_GROUPS): muted, a fact about the author. */
    ${scope} .q-group {
      display: inline-block; padding: 0 0.4rem; border-radius: 4px; font-size: 0.8em;
      background: var(--tint-neutral); color: var(--text-soft);
    }
    ${scope} .q-group-label {
      position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
      overflow: hidden; clip-path: inset(50%); white-space: nowrap;
    }
    ${scope} .q-pick { background: var(--tint-info); font-weight: 600; margin: 0.3rem 0.4rem 0 0; }
    ${scope} .q-answer-body { white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 0.3rem; }
    ${scope} .q-redacted { color: var(--text-soft); font-style: italic; }
    ${scope} .q-log { margin-top: 0.4rem; }
    ${scope} .q-log > summary { cursor: pointer; font-size: 0.85em; color: var(--text-soft); }
    ${scope} .q-log-item { margin: 0.4rem 0 0; padding-left: 0.6rem; border-left: 2px solid var(--border-secondary); }
    ${scope} section.question[tabindex]:focus:not(:focus-visible) { outline: none; }
    ${scope} .q-edit, ${scope} .q-cancel, ${scope} .q-retry, ${scope} .q-clear-choice,
    ${scope} .q-redact, ${scope} .q-redact-no {
      font: inherit; font-size: 0.95em; padding: 0 0.55rem; border-radius: 6px; cursor: pointer;
      background: transparent; color: var(--text-primary); border: 1px solid var(--border-secondary);
    }
    ${scope} .q-edit:hover, ${scope} .q-cancel:hover, ${scope} .q-retry:hover, ${scope} .q-clear-choice:hover,
    ${scope} .q-redact:hover, ${scope} .q-redact-no:hover {
      border-color: var(--accent);
    }
    ${scope} .q-redact-confirm {
      display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.5rem; margin-top: 0.35rem;
      padding: 0.3rem 0.6rem; border-radius: 6px; font-size: 0.85em; color: var(--text-primary);
      background: var(--tint-error); border-left: 3px solid var(--status-error);
    }
    ${scope} .q-redact-yes {
      font: inherit; font-weight: 600; padding: 0 0.6rem; border-radius: 6px; cursor: pointer;
      background: transparent; color: var(--text-primary); border: 1px solid var(--status-error);
    }
    ${scope} .q-redact-yes:disabled, ${scope} .q-redact-no:disabled { opacity: 0.6; cursor: default; }
    /* On the error tint --border-secondary is ~1.1:1; --text-soft reads at 3:1+ in both themes. */
    ${scope} .q-redact-confirm .q-redact-no:not(:hover) { border-color: var(--text-soft); }
    ${scope} .q-clear-choice[hidden] { display: none; }
    ${scope} .q-retry { margin-left: 0.4rem; }
    ${scope} .q-composer { margin-top: 0.6rem; }
    ${scope} .q-choices { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.4rem; }
    ${scope} .q-choice {
      display: inline-flex; align-items: center; gap: 0.3rem; padding: 0.2rem 0.6rem; border-radius: 8px;
      cursor: pointer; background: var(--bg-panel); color: var(--text-primary); border: 1px solid var(--border-secondary);
    }
    ${scope} .q-choice:has(input:checked) { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    ${scope} .q-text {
      display: block; width: 100%; box-sizing: border-box; min-height: 4.5rem; resize: vertical;
      padding: 0.5rem 0.6rem; border-radius: 8px; font: inherit; line-height: 1.45;
      background: var(--bg-panel); color: var(--text-primary); border: 1px solid var(--border-secondary);
    }
    ${scope} .q-text:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
    ${scope} .q-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
    ${scope} .q-save {
      font: inherit; font-weight: 600; padding: 0.3rem 0.9rem; border-radius: 7px; border: none; cursor: pointer;
      background: var(--accent-hover); color: #fff;
    }
    ${scope} .q-save:disabled { opacity: 0.5; cursor: default; }
    ${scope} .q-count { margin-left: auto; font-size: 0.8em; color: var(--text-soft); font-variant-numeric: tabular-nums; }
    ${scope} .q-count-over { color: var(--text-primary); background: var(--tint-error); padding: 0 0.4rem; border-radius: 4px; }
    ${scope} .q-over { font-size: 0.85em; margin: 0.35rem 0 0; color: var(--text-primary); }
    ${scope} .q-over[hidden] { display: none; }
    ${scope} .q-msg { font-size: 0.85em; margin: 0.5rem 0 0; padding: 0.3rem 0.6rem; border-radius: 6px; color: var(--text-primary); }
    ${scope} .q-msg-error { background: var(--tint-error); border-left: 3px solid var(--status-error); }
    ${scope} .q-msg-warn { background: var(--tint-warning); border-left: 3px solid var(--status-warning); }
  `;
}

/**
 * CSS for the /wiki reader's fact-check INTERACTION layer — the toolbar
 * `wiki-factcheck-reader.ts` inserts above the article, the evidence card a chip
 * expands, and the layer-off state its toggle flips.
 *
 * Deliberately NOT part of `componentBlockCss`: nothing client-side inserts a
 * toolbar or a card in web chat or the /research answer pane, so shipping these
 * rules there was dead weight. The shared `.fc-mark`/`.fc-chip`/`.fc-block`
 * rules stay above — those markup shapes DO render in every scope.
 */
export function factcheckReaderCss(scope: string): string {
  return `
    ${scope} .fc-toolbar {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      flex-wrap: wrap;
      margin: 0 0 1.1rem;
      padding: 0.45rem 0.85rem;
      border: 1px solid var(--border-secondary);
      border-radius: 10px;
      background: var(--bg-surface);
      font-size: 0.9em;
      color: var(--text-muted);
      /* Same hazard as the chip: the toolbar is chrome, so its date and counts
         must never enter a copied paragraph or the Explain-selection payload. */
      -webkit-user-select: none;
      user-select: none;
    }
    ${scope} .fc-toolbar-summary { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
    ${scope} .fc-toolbar-toggle {
      margin-left: auto;
      appearance: none;
      font: inherit;
      font-size: 0.9em;
      cursor: pointer;
      padding: 0.15em 0.7em;
      border-radius: 999px;
      border: 1px solid var(--border-secondary);
      background: transparent;
      color: var(--text-muted);
    }
    ${scope} .fc-toolbar-toggle:hover { color: var(--text-primary); border-color: var(--accent); }
    ${scope} .fc-toolbar-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

    /* Layer OFF — the whole point of the toggle is that the article reads clean
       underneath, so the tints go transparent (never a layout-shifting border
       removal) and the chrome hides outright. */
    ${scope}.fc-off .fc-mark { border-bottom-color: transparent; background: transparent; }
    ${scope}.fc-off .fc-mark-block { border-left-color: transparent; }
    ${scope}.fc-off .fc-chip,
    ${scope}.fc-off .fc-block,
    ${scope}.fc-off .fc-toolbar-summary,
    ${scope}.fc-off .fc-card { display: none; }

    ${scope} .fc-card {
      position: relative;
      margin: 0.6rem 0 1.1rem;
      padding: 0.15rem 2.3rem 0.4rem 0.9rem;
      border: 1px solid var(--border-secondary);
      border-left: 3px solid var(--border-secondary);
      border-radius: 8px;
      background: var(--bg-surface);
      font-size: 0.95em;
      /* Cloned evidence — the appendix already carries it once. A card sitting
         mid-article must not smuggle itself into a copy or an Explain selection. */
      -webkit-user-select: none;
      user-select: none;
    }
    /* The rail carries the claim's own verdict, so an open card reads as part of
       the mark it belongs to rather than as a generic accent panel. */
    ${scope} .fc-card-ok { border-left-color: color-mix(in srgb, var(--status-success) 55%, transparent); }
    ${scope} .fc-card-warn { border-left-color: var(--status-warning); }
    ${scope} .fc-card-bad { border-left-color: var(--status-error); }
    ${scope} .fc-card-unknown { border-left-color: var(--border-secondary); }
    ${scope} .fc-card .fc-claim { padding-top: 0; }
    ${scope} .fc-card-close {
      position: absolute;
      top: 0.4rem;
      right: 0.5rem;
      appearance: none;
      border: 0;
      background: transparent;
      color: var(--text-muted);
      font: inherit;
      font-size: 0.95em;
      line-height: 1;
      cursor: pointer;
      padding: 0.2rem 0.35rem;
      border-radius: 6px;
    }
    ${scope} .fc-card-close:hover { color: var(--text-primary); }
    ${scope} .fc-card-close:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  `;
}
