/**
 * CSS for the component block vocabulary (Callout, Verdict, Pill, Figure,
 * FileRef, ComparisonTable), scoped to a caller-supplied selector.
 *
 * The class names and markup mirror mimir's MDX explainer set
 * (`scripts/mdx-explainer/components.tsx` + `template.ts`) so the vocabulary
 * reads identically across explainers, wiki pages, and chat answers. Colors map
 * onto muninn's shared design tokens (`shared-styles.ts`), which are already
 * theme-aware — referencing them gives light + dark for free.
 *
 * Injected once per scope: the `/wiki` article pane (`.wiki-article`) and the
 * web chat bubble (`.web-content`).
 */
export function componentBlockCss(scope: string): string {
  return `
    ${scope} .callout {
      border-left: 4px solid var(--accent);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border-radius: 0 8px 8px 0;
      padding: 10px 14px;
      margin: 12px 0;
    }
    ${scope} .callout-title { display: block; margin-bottom: 4px; font-weight: 600; color: var(--accent-light); }
    ${scope} .callout-body > :first-child { margin-top: 0; }
    ${scope} .callout-body > :last-child { margin-bottom: 0; }
    ${scope} .callout-info { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    ${scope} .callout-info .callout-title { color: var(--accent-light); }
    ${scope} .callout-good { border-left-color: var(--status-success); background: color-mix(in srgb, var(--status-success) 12%, transparent); }
    ${scope} .callout-good .callout-title { color: var(--status-success); }
    ${scope} .callout-bad { border-left-color: var(--status-error); background: color-mix(in srgb, var(--status-error) 12%, transparent); }
    ${scope} .callout-bad .callout-title { color: var(--status-error); }
    ${scope} .callout-warn { border-left-color: var(--status-warning); background: color-mix(in srgb, var(--status-warning) 12%, transparent); }
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
    }
    ${scope} .pill-rec { border-color: var(--status-success); color: var(--status-success); }
    ${scope} .pill-warn { border-color: var(--status-warning); color: var(--status-warning); }
    ${scope} .tablewrap { overflow-x: auto; margin: 12px 0; }
    ${scope} .fileref { color: var(--accent-light); font-family: var(--mono, ui-monospace, monospace); }
    ${scope} .figure { margin: 14px 0; }
    ${scope} .figure-body { overflow-x: auto; }
    ${scope} .figure img { max-width: 100%; height: auto; }
    ${scope} .caption { color: var(--text-muted); font-size: 0.85em; text-align: center; margin-top: 6px; }
  `;
}
