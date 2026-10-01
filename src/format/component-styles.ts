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
    /* Run labels can be long ("08.09 simulering"): headers wrap, so the delta
       column stays inside the article; cells keep one line. */
    ${scope} .dt-table thead th { white-space: normal; vertical-align: bottom; }
    ${scope} .dt-delta-runs { display: block; font-size: 0.85em; }
    ${scope} .dt-delta-runs, ${scope} .dt-pct { color: var(--text-soft); font-weight: 400; }
    ${scope} .dt-good, ${scope} .dt-good .dt-pct { color: var(--dt-good); }
    ${scope} .dt-bad, ${scope} .dt-bad .dt-pct { color: var(--dt-bad); }
    ${scope} .dt-unavailable, ${scope} .dt-note, ${scope} .dt-warning, ${scope} .dt-truncated {
      color: var(--text-soft); font-size: 0.85em; margin: 0.3rem 0;
    }
    ${scope} .dt-unavailable, ${scope} .dt-warning { font-style: italic; }
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
       .check-text, not on the <li> that also holds the child rows). */
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
