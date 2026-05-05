import { SHARED_STYLES } from "../shared-styles.ts";

export const BENCHMARK_STYLES = `
  ${SHARED_STYLES}

  .bench-container {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px;
  }

  .page-header {
    margin-bottom: 24px;
  }
  .page-header h1 {
    font-size: 20px;
    color: var(--text-primary);
    margin-bottom: 4px;
  }
  .page-header p {
    font-size: 13px;
    color: var(--text-dim);
  }

  .runs-table {
    width: 100%;
    border-collapse: collapse;
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    overflow: hidden;
  }
  .runs-table th, .runs-table td {
    padding: 12px 14px;
    text-align: left;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 13px;
  }
  .runs-table th {
    background: var(--bg-deep);
    color: var(--text-soft);
    font-weight: 600;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .runs-table tbody tr {
    cursor: pointer;
    transition: background 0.1s;
  }
  .runs-table tbody tr:hover {
    background: var(--bg-surface);
  }
  .runs-table td.num {
    font-variant-numeric: tabular-nums;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .runs-table .issue-key {
    font-weight: 600;
    color: var(--accent-light);
  }
  .runs-table .model-cell {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-soft);
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: help;
  }

  .hit-rate {
    font-weight: 700;
    font-size: 14px;
  }
  .hit-rate.high { color: var(--status-success); }
  .hit-rate.med  { color: var(--status-warning); }
  .hit-rate.low  { color: var(--status-error); }

  .highlighted-rate.zero { color: var(--status-error); }
  .highlighted-rate.partial { color: var(--status-warning); }
  .highlighted-rate.full { color: var(--status-success); }

  .status-badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-badge.done    { background: var(--tint-success); color: var(--status-success); }
  .status-badge.running { background: var(--tint-info); color: var(--status-info); }
  .status-badge.error   { background: var(--tint-error); color: var(--status-error); }

  .empty-state {
    text-align: center;
    padding: 48px 24px;
    color: var(--text-dim);
    background: var(--bg-panel);
    border: 1px dashed var(--border-secondary);
    border-radius: 10px;
  }
  .empty-state code {
    background: var(--bg-deep);
    padding: 2px 6px;
    border-radius: 4px;
    color: var(--text-secondary);
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
  }

  /* Detail page */
  .detail-header {
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 16px;
  }
  .detail-meta {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-top: 16px;
  }
  .detail-meta .metric .label {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .detail-meta .metric .value {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    margin-top: 4px;
  }
  .detail-meta .metric .value.high { color: var(--status-success); }
  .detail-meta .metric .value.med  { color: var(--status-warning); }
  .detail-meta .metric .value.low  { color: var(--status-error); }

  .detail-paths {
    margin-top: 16px;
    font-size: 12px;
    color: var(--text-dim);
    font-family: 'SF Mono', 'Fira Code', monospace;
    line-height: 1.7;
  }
  .detail-paths .path-label {
    color: var(--text-faint);
    margin-right: 8px;
  }

  .detail-actions {
    margin-top: 16px;
    display: flex;
    gap: 8px;
  }
  .detail-actions a {
    color: var(--accent-light);
    text-decoration: none;
    font-size: 12px;
    border: 1px solid var(--border-secondary);
    padding: 6px 12px;
    border-radius: 6px;
    transition: background 0.1s, border-color 0.1s;
  }
  .detail-actions a:hover {
    background: var(--bg-surface);
    border-color: var(--accent);
  }
  .detail-actions .trace-missing {
    color: var(--text-faint);
    font-size: 12px;
    border: 1px dashed var(--border-secondary);
    padding: 6px 12px;
    border-radius: 6px;
    font-style: italic;
  }

  .claims-list {
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 8px;
  }
  .claim {
    padding: 14px 16px;
    border-radius: 8px;
    border-left: 3px solid var(--border-secondary);
    margin-bottom: 8px;
    background: var(--bg-deep);
  }
  .claim:last-child { margin-bottom: 0; }
  .claim.found    { border-left-color: var(--status-success); }
  .claim.partial  { border-left-color: var(--status-warning); }
  .claim.missing  { border-left-color: var(--status-error); }

  .claim.highlighted {
    background: linear-gradient(90deg, color-mix(in srgb, var(--status-warning) 8%, var(--bg-deep)), var(--bg-deep));
  }

  .claim-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .verdict-badge {
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 700;
  }
  .verdict-badge.found    { background: var(--tint-success); color: var(--status-success); }
  .verdict-badge.partial  { background: var(--tint-warning); color: var(--status-warning); }
  .verdict-badge.missing  { background: var(--tint-error); color: var(--status-error); }

  .highlighted-marker {
    background: var(--tint-warning);
    color: var(--status-warning);
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 700;
  }

  .claim-id {
    color: var(--text-muted);
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
  }

  .claim-text {
    color: var(--text-secondary);
    font-size: 14px;
    line-height: 1.55;
    margin-bottom: 8px;
  }

  .claim-evidence {
    margin-top: 8px;
    padding: 10px 14px;
    background: var(--bg-inset);
    border-left: 2px solid var(--accent);
    border-radius: 0 6px 6px 0;
    color: var(--text-tertiary);
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    line-height: 1.5;
  }
  .claim-evidence .label {
    color: var(--text-faint);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
    display: block;
  }

  .claim-notes {
    margin-top: 8px;
    color: var(--text-soft);
    font-size: 12px;
    font-style: italic;
  }
  .claim-notes::before {
    content: "Note: ";
    color: var(--text-dim);
    font-style: normal;
    font-weight: 600;
  }

  .back-link {
    display: inline-block;
    margin-bottom: 16px;
    color: var(--accent-light);
    text-decoration: none;
    font-size: 13px;
  }
  .back-link:hover { text-decoration: underline; }

  /* Re-judge panel */
  .rejudge-panel {
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 20px 24px;
    margin: 16px 0;
  }
  .rejudge-panel h2 {
    font-size: 14px;
    color: var(--text-primary);
    margin: 0 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .rejudge-panel .subtitle {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 14px;
  }
  .rejudge-form {
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }
  .rejudge-form label {
    font-size: 12px;
    color: var(--text-soft);
  }
  .rejudge-form input[type="number"] {
    width: 60px;
    background: var(--bg-deep);
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    color: var(--text-primary);
    padding: 6px 10px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 13px;
  }
  .rejudge-form button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 7px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.1s;
  }
  .rejudge-form button:hover:not(:disabled) { background: var(--accent-light); }
  .rejudge-form button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .rejudge-form .hint {
    color: var(--text-faint);
    font-size: 11px;
    margin-left: auto;
  }
  .rejudge-status {
    margin-top: 12px;
    font-size: 12px;
    color: var(--text-soft);
  }
  .rejudge-status.running { color: var(--status-info); }
  .rejudge-status.done { color: var(--status-success); }
  .rejudge-status.error { color: var(--status-error); }

  .rejudge-children {
    margin-top: 16px;
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .rejudge-children th {
    text-align: left;
    padding: 8px 10px;
    background: var(--bg-deep);
    color: var(--text-dim);
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .rejudge-children td {
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-subtle);
    font-variant-numeric: tabular-nums;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .rejudge-children tr:hover td { background: var(--bg-surface); }
  .rejudge-children .summary-row td {
    background: var(--bg-deep);
    font-weight: 700;
    border-top: 2px solid var(--border-primary);
    border-bottom: none;
  }
  .rejudge-children a {
    color: var(--accent-light);
    text-decoration: none;
  }
  .rejudge-children a:hover { text-decoration: underline; }

  .rejudge-empty {
    margin-top: 14px;
    padding: 14px;
    text-align: center;
    color: var(--text-faint);
    font-size: 12px;
    background: var(--bg-deep);
    border-radius: 8px;
  }

  /* Preview panel */
  .preview-panel {
    background: var(--bg-panel);
    border: 1px solid var(--accent);
    border-radius: 10px;
    padding: 20px 24px;
    margin: 0 0 16px;
    display: none;
  }
  .preview-panel.visible { display: block; }
  .preview-panel h2 {
    font-size: 14px;
    color: var(--text-primary);
    margin: 0 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .preview-panel .subtitle {
    font-size: 11px;
    color: var(--text-dim);
    margin-bottom: 14px;
  }
  .preview-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
    margin-bottom: 14px;
  }
  .preview-card {
    background: var(--bg-deep);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .preview-card .card-label {
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }
  .preview-card .card-body {
    font-size: 12px;
    color: var(--text-secondary);
    font-family: 'SF Mono', 'Fira Code', monospace;
    line-height: 1.5;
    word-break: break-word;
  }
  .preview-card .card-body .kv {
    display: flex;
    gap: 8px;
    margin-bottom: 3px;
  }
  .preview-card .card-body .kv .k {
    color: var(--text-dim);
    min-width: 80px;
    flex-shrink: 0;
  }
  .preview-section {
    margin-top: 14px;
  }
  .preview-section h3 {
    font-size: 11px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 0 0 6px;
    font-weight: 700;
  }
  .preview-section pre {
    background: var(--bg-deep);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 10px 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-secondary);
    max-height: 240px;
    overflow: auto;
    white-space: pre-wrap;
    margin: 0;
  }
  .preview-section .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .preview-section .tag {
    background: var(--bg-deep);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 10px;
    color: var(--text-soft);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .preview-section .tag.deny { color: var(--status-error); opacity: 0.75; }
  .preview-actions {
    margin-top: 16px;
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .preview-actions button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .preview-actions button.secondary {
    background: var(--bg-deep);
    color: var(--text-soft);
    border: 1px solid var(--border-secondary);
  }
  .preview-actions .hint {
    font-size: 11px;
    color: var(--text-faint);
  }
  .preview-error {
    background: var(--tint-error);
    color: var(--status-error);
    border: 1px solid var(--status-error);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12px;
    margin-top: 8px;
  }
  .preview-warnings {
    background: var(--tint-warning);
    color: var(--status-warning);
    border: 1px solid var(--status-warning);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 11px;
    margin-top: 8px;
  }

  /* Binary flag annotation for low-sample highlighted */
  .binary-flag-note {
    display: inline-block;
    margin-left: 6px;
    font-size: 10px;
    color: var(--text-faint);
    font-weight: 400;
    font-style: italic;
  }

  /* Run form */
  .run-form {
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 16px 20px;
    margin-bottom: 16px;
    display: grid;
    grid-template-columns: 1fr 1fr auto;
    gap: 10px;
    align-items: end;
  }
  .run-form .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .run-form label {
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .run-form select {
    background: var(--bg-deep);
    border: 1px solid var(--border-secondary);
    border-radius: 6px;
    color: var(--text-primary);
    padding: 7px 10px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
  }
  .run-form button {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 6px;
    padding: 8px 16px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
  }
  .run-form button:disabled { opacity: 0.5; cursor: not-allowed; }
  .run-form .hint {
    grid-column: 1 / -1;
    font-size: 11px;
    color: var(--text-faint);
  }

  /* Live view */
  .live-header {
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 20px 24px;
    margin-bottom: 16px;
  }
  .live-header h1 {
    font-size: 20px;
    color: var(--text-primary);
    margin: 0 0 8px;
  }
  .live-header .subtitle {
    font-size: 12px;
    color: var(--text-dim);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }

  .live-status {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    margin-left: 8px;
  }
  .live-status.pending { background: var(--tint-info); color: var(--status-info); }
  .live-status.running { background: var(--tint-warning); color: var(--status-warning); }
  .live-status.done { background: var(--tint-success); color: var(--status-success); }
  .live-status.error { background: var(--tint-error); color: var(--status-error); }

  .live-metrics {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
    margin-top: 14px;
  }
  .live-metrics .metric {
    background: var(--bg-deep);
    border: 1px solid var(--border-subtle);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .live-metrics .metric .label {
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .live-metrics .metric .value {
    font-size: 18px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
    margin-top: 2px;
  }

  .live-waterfall {
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  .live-waterfall h2 {
    font-size: 13px;
    color: var(--text-primary);
    margin: 0 0 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .lw-bars { position: relative; }
  .lw-row {
    display: grid;
    grid-template-columns: 260px 1fr;
    align-items: center;
    height: 24px;
    gap: 12px;
  }
  .lw-label {
    font-size: 11px;
    color: var(--text-soft);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .lw-bar-track {
    position: relative;
    height: 14px;
    background: color-mix(in srgb, white 3%, transparent);
    border-radius: 3px;
  }
  .lw-bar {
    position: absolute;
    height: 100%;
    border-radius: 3px;
    min-width: 2px;
    background: var(--accent);
  }
  .lw-bar.kind-tool { background: var(--status-info); }
  .lw-bar.kind-event { background: var(--text-faint); }
  .lw-bar.status-error { background: var(--status-error); }
  .lw-bar.running { background: repeating-linear-gradient(45deg, var(--accent) 0 6px, color-mix(in srgb, var(--accent) 60%, transparent) 6px 12px); }
  .lw-duration {
    position: absolute;
    right: 4px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 10px;
    color: rgba(255,255,255,0.9);
    text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .lw-empty {
    text-align: center;
    padding: 30px 10px;
    color: var(--text-faint);
    font-size: 12px;
  }

  .live-logs {
    background: var(--bg-panel);
    border: 1px solid var(--border-primary);
    border-radius: 10px;
    padding: 16px 20px;
  }
  .live-logs h2 {
    font-size: 13px;
    color: var(--text-primary);
    margin: 0 0 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .live-logs pre {
    background: var(--bg-deep);
    border: 1px solid var(--border-subtle);
    border-radius: 6px;
    padding: 10px 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    color: var(--text-secondary);
    max-height: 260px;
    overflow-y: auto;
    white-space: pre-wrap;
    margin: 0;
  }
  .live-logs pre .stderr { color: var(--status-error); }
`;

export function esc(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function rateClass(rate: number | null): string {
  if (rate === null) return "";
  if (rate >= 0.6) return "high";
  if (rate >= 0.4) return "med";
  return "low";
}

export function highlightedClass(highlightedTotal: number | null, highlightedRate: number | null): string {
  if (!highlightedTotal || highlightedRate === null) return "";
  if (highlightedRate === 0) return "zero";
  if (highlightedRate >= 0.5) return "full";
  return "partial";
}

export function fmtRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Highlighted rate is only treated as a rate when the issue has >= 3
 * highlighted claims. Below that it's a binary flag (0/1 or 1/1) that
 * shouldn't drive ship/reject decisions — see workdoc-feedback-loop-overhaul.md.
 */
export const HIGHLIGHTED_RATE_MIN_N = 3;

export function shouldSuppressHighlighted(highlightedTotal: number | null): boolean {
  return highlightedTotal === null || highlightedTotal < HIGHLIGHTED_RATE_MIN_N;
}

export function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
