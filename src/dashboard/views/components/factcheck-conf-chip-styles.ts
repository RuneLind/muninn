/**
 * The fact-check confidence chip's CSS (`enhanceConfidenceHtml` in
 * `wiki-ask-render.ts` emits the markup) — one copy shared by the /wiki
 * reader and the /summaries Fact check section.
 */
export const FACTCHECK_CONF_CHIP_CSS = `
    /* Per-claim confidence line (evidence strength, NOT the verdict) — a band-
       colored chip carrying the 0-100 score, rendered in place of the model's
       Confidence NN/100 text line by enhanceConfidenceHtml. */
    .wiki-fc-conf-line { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
    .wiki-fc-conf-key {
      font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-dim);
    }
    .wiki-fc-conf-chip {
      font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 999px;
      font-variant-numeric: tabular-nums; border: 1px solid transparent;
    }
    .wiki-fc-conf-chip.hi { color: var(--status-success); border-color: color-mix(in srgb, var(--status-success) 45%, transparent); background: color-mix(in srgb, var(--status-success) 14%, transparent); }
    .wiki-fc-conf-chip.mid { color: var(--status-warning); border-color: color-mix(in srgb, var(--status-warning) 45%, transparent); background: color-mix(in srgb, var(--status-warning) 14%, transparent); }
    .wiki-fc-conf-chip.lo { color: var(--status-error); border-color: color-mix(in srgb, var(--status-error) 45%, transparent); background: color-mix(in srgb, var(--status-error) 14%, transparent); }
`;
