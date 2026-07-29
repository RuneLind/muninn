/**
 * CSS for the component block vocabulary (Callout, Verdict, Pill, Figure,
 * FileRef, ComparisonTable, Meter, Diff, FileTree, Checklist, AnnotatedCode,
 * CodeTabs + its Tab child), scoped to a caller-supplied selector.
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
    ${scope} .check-mark { flex: none; font-weight: 700; font-variant-numeric: tabular-nums; }
    ${scope} .check-done .check-mark { color: var(--status-success); }
    ${scope} .check-todo .check-mark { color: var(--text-muted); }
    ${scope} .check-todo { color: var(--text-muted); }
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
         Explain-selection payload (which reads the selection's text). */
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
