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
  `;
}
