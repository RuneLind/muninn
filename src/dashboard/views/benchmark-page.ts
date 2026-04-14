import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import type { BenchmarkRunRow } from "../../db/benchmark-runs.ts";
import type { GoldClaim } from "../../benchmarks/types.ts";
import type { LiveJob } from "../../benchmarks/live-job.ts";
import type {
  DiscoveredIssue,
  DiscoveredTreatment,
} from "../../benchmarks/treatment-discovery.ts";

// Server-side HTML escape — null-safe, handles &<>"'
function esc(str: unknown): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLES = `
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

function rateClass(rate: number | null): string {
  if (rate === null) return "";
  if (rate >= 0.6) return "high";
  if (rate >= 0.4) return "med";
  return "low";
}

function highlightedClass(highlightedTotal: number | null, highlightedRate: number | null): string {
  if (!highlightedTotal || highlightedRate === null) return "";
  if (highlightedRate === 0) return "zero";
  if (highlightedRate >= 0.5) return "full";
  return "partial";
}

function fmtRate(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

/**
 * Highlighted rate is only treated as a rate when the issue has >= 3
 * highlighted claims. Below that it's a binary flag (0/1 or 1/1) that
 * shouldn't drive ship/reject decisions — see workdoc-feedback-loop-overhaul.md.
 */
const HIGHLIGHTED_RATE_MIN_N = 3;

function shouldSuppressHighlighted(highlightedTotal: number | null): boolean {
  return highlightedTotal === null || highlightedTotal < HIGHLIGHTED_RATE_MIN_N;
}

/** mean/stddev for a plain number array. Stddev uses n-1 (sample). */
function meanStddev(values: number[]): { mean: number; stddev: number } | null {
  if (values.length === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length === 1) return { mean, stddev: 0 };
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderBenchmarkListPage(
  runs: BenchmarkRunRow[],
  issues: DiscoveredIssue[] = [],
  treatments: DiscoveredTreatment[] = [],
): string {
  // Hide the highlighted column when *every* visible run has
  // highlighted_total < 3. If any run has enough highlighted claims to be
  // a real rate, keep the column on for consistency.
  const showHighlightedCol = runs.some(
    (r) => !shouldSuppressHighlighted(r.highlightedTotal),
  );

  const rowsHtml = runs.length === 0
    ? `<div class="empty-state">
        <p>No benchmark runs yet.</p>
        <p style="margin-top: 12px;">Run the judge from the CLI:</p>
        <p style="margin-top: 8px;">
          <code>bun run benchmarks/scripts/score-report.ts MELOSYS-7588 bots/melosys/reports/rune-tester-1/MELOSYS-7588.md</code>
        </p>
      </div>`
    : `<table class="runs-table">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Hit rate</th>
            ${showHighlightedCol ? "<th>Highlighted</th>" : ""}
            <th>Claims</th>
            <th>Tokens (out)</th>
            <th>Wallclock</th>
            <th>Started</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${runs
            .map((r) => {
              const hClass = rateClass(r.hitRate);
              const hlClass = highlightedClass(r.highlightedTotal, r.highlightedRate);
              const claims = r.foundCount !== null
                ? `${r.foundCount + (r.partialCount ?? 0)}/${(r.foundCount ?? 0) + (r.partialCount ?? 0) + (r.missingCount ?? 0)}`
                : "—";
              const highlightedCell = showHighlightedCol
                ? `<td class="num"><span class="highlighted-rate ${hlClass}">${
                    r.highlightedTotal && r.highlightedTotal > 0
                      ? shouldSuppressHighlighted(r.highlightedTotal)
                        ? `${r.highlightedFound ?? 0}/${r.highlightedTotal}`
                        : `${r.highlightedFound ?? 0}/${r.highlightedTotal}`
                      : "—"
                  }</span></td>`
                : "";
              return `<tr onclick="window.location='/benchmark/runs/${esc(r.id)}'">
                <td><span class="issue-key">${esc(r.issueKey)}</span></td>
                <td class="num"><span class="hit-rate ${hClass}">${fmtRate(r.hitRate)}</span></td>
                ${highlightedCell}
                <td class="num">${claims}</td>
                <td class="num">${r.outputTokens?.toLocaleString() ?? "—"}</td>
                <td class="num">${r.wallclockMs ? `${(r.wallclockMs / 1000).toFixed(1)}s` : "—"}</td>
                <td class="num">${fmtTime(r.startedAt)}</td>
                <td><span class="status-badge ${esc(r.status)}">${esc(r.status)}</span></td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>`;

  const runFormHtml = issues.length > 0 && treatments.length > 0
    ? `<form class="run-form" onsubmit="return startRunCell(event)">
        <div class="field">
          <label>Issue</label>
          <select id="run-issue">
            ${issues.map((i) => `<option value="${esc(i.issueKey)}">${esc(i.issueKey)} — ${esc(i.title.slice(0, 60))}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label>Treatment</label>
          <select id="run-treatment">
            ${treatments.map((t) => `<option value="${esc(t.path)}" data-label="${esc(t.label)}">${esc(t.label)}</option>`).join("")}
          </select>
        </div>
        <button type="submit">Run cell (live)</button>
        <div class="hint">Spawns run-cell.ts as a subprocess with a pre-allocated analysis trace ID and redirects to the live waterfall. Reuses whichever MCP instances the treatment needs.</div>
      </form>`
    : `<div class="run-form" style="display:block; color: var(--text-faint); font-size: 12px;">
        No issues or treatments discovered in <code>benchmarks/issues</code> and <code>benchmarks/treatments</code>.
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn — Benchmark</title>
  <style>${STYLES}</style>
</head>
<body>
  ${renderNav("benchmark")}
  <div class="bench-container">
    <div class="page-header">
      <h1>Jira Analysis Benchmark</h1>
      <p>How much of each issue's reviewed analysis does muninn's first-pass capture?</p>
    </div>
    ${runFormHtml}
    ${rowsHtml}
  </div>
  <script>${RUN_FORM_SCRIPT}</script>
</body>
</html>`;
}

const RUN_FORM_SCRIPT = `
async function startRunCell(ev) {
  ev.preventDefault();
  const issue = document.getElementById('run-issue').value;
  const treatmentEl = document.getElementById('run-treatment');
  const treatmentPath = treatmentEl.value;
  const button = ev.target.querySelector('button');
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const res = await fetch('/api/benchmark/cells', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueKey: issue, treatmentPath }),
    });
    if (res.status !== 202) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + res.status));
    }
    const data = await res.json();
    window.location = '/benchmark/run-live/' + data.traceId;
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Run cell (live)';
    alert('Failed to start cell: ' + err.message);
  }
  return false;
}
`;

/** Subset of the in-memory re-judge job state the route handler passes in. */
export interface RejudgeJobSnapshot {
  parentRunId: string;
  totalPasses: number;
  completedPasses: number;
  startedAt: number;
  status: "running" | "done" | "error";
  error: string | null;
  childRunIds: string[];
}

export function renderBenchmarkDetailPage(
  run: BenchmarkRunRow,
  rejudgeChildren: BenchmarkRunRow[] = [],
  rejudgeJob: RejudgeJobSnapshot | null = null,
): string {
  const claims = run.judgeResult?.goldClaims ?? [];
  const claimsHtml = claims
    .map((c: GoldClaim) => {
      const verdictClass = c.verdict;
      const highlightClass = c.highlighted ? " highlighted" : "";
      return `<div class="claim ${verdictClass}${highlightClass}">
        <div class="claim-head">
          <span class="verdict-badge ${verdictClass}">${c.verdict}</span>
          ${c.highlighted ? '<span class="highlighted-marker">★ highlighted</span>' : ""}
          <span class="claim-id">${esc(c.id)}</span>
          ${c.section ? `<span>· ${esc(c.section)}</span>` : ""}
        </div>
        <div class="claim-text">${esc(c.claim)}</div>
        ${
          c.evidenceQuote
            ? `<div class="claim-evidence">
                 <span class="label">evidence quote from candidate</span>
                 "${esc(c.evidenceQuote)}"
               </div>`
            : ""
        }
        ${c.notes ? `<div class="claim-notes">${esc(c.notes)}</div>` : ""}
      </div>`;
    })
    .join("");

  const hClass = rateClass(run.hitRate);
  const hlClass = highlightedClass(run.highlightedTotal, run.highlightedRate);
  const suppressHighlighted = shouldSuppressHighlighted(run.highlightedTotal);

  // Re-judge panel: aggregates parent + all successful children into a
  // mean ± stddev headline, lists each pass, and holds the Re-judge form.
  const canRejudge = run.parentRunId === null && run.status === "done";
  const isRejudgeChild = run.parentRunId !== null;
  const rejudgePanelHtml = isRejudgeChild
    ? renderRejudgeChildNotice(run.parentRunId!)
    : renderRejudgePanel(run, rejudgeChildren, rejudgeJob, canRejudge);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn — Benchmark — ${esc(run.issueKey)}</title>
  <style>${STYLES}</style>
</head>
<body>
  ${renderNav("benchmark")}
  <div class="bench-container">
    <a href="/benchmark" class="back-link">← All runs</a>

    <div class="detail-header">
      <h1 style="font-size: 20px; color: var(--text-primary); margin-bottom: 4px;">
        ${esc(run.issueKey)}
      </h1>
      <p style="font-size: 12px; color: var(--text-dim);">
        Judged ${fmtTime(run.startedAt)} · ${esc(run.judgeModel)} · prompt ${esc(run.judgePromptVersion)}
      </p>

      <div class="detail-meta">
        <div class="metric">
          <div class="label">Hit rate</div>
          <div class="value ${hClass}">${fmtRate(run.hitRate)}</div>
        </div>
        <div class="metric">
          <div class="label">
            Highlighted
            ${suppressHighlighted && (run.highlightedTotal ?? 0) > 0
              ? `<span class="binary-flag-note">binary flag — n=${run.highlightedTotal}</span>`
              : ""}
          </div>
          <div class="value ${suppressHighlighted ? "" : hlClass === "full" ? "high" : hlClass === "partial" ? "med" : "low"}">${
            run.highlightedTotal && run.highlightedTotal > 0
              ? `${run.highlightedFound ?? 0}/${run.highlightedTotal}`
              : "—"
          }</div>
        </div>
        <div class="metric">
          <div class="label">Wallclock</div>
          <div class="value">${run.wallclockMs ? `${(run.wallclockMs / 1000).toFixed(1)}s` : "—"}</div>
        </div>
        <div class="metric">
          <div class="label">Output tokens</div>
          <div class="value">${run.outputTokens?.toLocaleString() ?? "—"}</div>
        </div>
      </div>

      <div class="detail-paths">
        <div><span class="path-label">gold:</span>${esc(run.goldPath)}</div>
        <div><span class="path-label">candidate:</span>${esc(run.candidatePath)}</div>
      </div>

      <div class="detail-actions">
        ${
          run.traceId
            ? `<a href="/traces?trace=${esc(run.traceId)}" title="The Sonnet judge call we made when scoring">View judge trace</a>`
            : `<span class="trace-missing">judge trace: not available</span>`
        }
        ${
          run.analysisTraceId
            ? `<a href="/traces?trace=${esc(run.analysisTraceId)}" title="The original muninn analysis call that produced the candidate report">View analysis trace</a>`
            : `<span class="trace-missing" title="Either the report was generated before this feature shipped, or the original trace expired (default retention 7 days)">analysis trace: not captured</span>`
        }
      </div>
    </div>

    ${rejudgePanelHtml}

    <div class="claims-list">
      ${claimsHtml || '<div class="empty-state"><p>No per-claim data on this run.</p></div>'}
    </div>
  </div>
  <script>${REJUDGE_SCRIPT}</script>
</body>
</html>`;
}

function renderRejudgeChildNotice(parentRunId: string): string {
  return `<div class="rejudge-panel">
    <h2>Re-judge pass</h2>
    <p class="subtitle">
      This row is a re-judge pass of
      <a href="/benchmark/runs/${esc(parentRunId)}" style="color: var(--accent-light);">the parent run</a>.
      Open the parent to see all passes and aggregate statistics.
    </p>
  </div>`;
}

function renderRejudgePanel(
  run: BenchmarkRunRow,
  children: BenchmarkRunRow[],
  job: RejudgeJobSnapshot | null,
  canRejudge: boolean,
): string {
  const doneChildren = children.filter((c) => c.status === "done" && c.hitRate !== null);
  const allHits: number[] = [];
  if (run.hitRate !== null && run.status === "done") allHits.push(run.hitRate);
  for (const c of doneChildren) if (c.hitRate !== null) allHits.push(c.hitRate);
  const stats = meanStddev(allHits);

  const rowsHtml = children
    .map((c, idx) => {
      const pass = `pass ${idx + 1}`;
      const hit = c.hitRate !== null ? fmtRate(c.hitRate) : "—";
      const tokens = c.outputTokens?.toLocaleString() ?? "—";
      const wall = c.wallclockMs ? `${(c.wallclockMs / 1000).toFixed(1)}s` : "—";
      const when = fmtTime(c.startedAt);
      const statusBadge = `<span class="status-badge ${esc(c.status)}">${esc(c.status)}</span>`;
      const errorCell = c.error ? `<span title="${esc(c.error)}">error</span>` : "";
      return `<tr>
        <td>${pass}</td>
        <td><a href="/benchmark/runs/${esc(c.id)}">${esc(c.judgePromptVersion)}</a></td>
        <td>${hit}</td>
        <td>${tokens}</td>
        <td>${wall}</td>
        <td>${when}</td>
        <td>${statusBadge} ${errorCell}</td>
      </tr>`;
    })
    .join("");

  const summaryRow = stats
    ? `<tr class="summary-row">
        <td colspan="2">mean ± stddev (n=${allHits.length}, parent + ${doneChildren.length} passes)</td>
        <td>${(stats.mean * 100).toFixed(1)}% ± ${(stats.stddev * 100).toFixed(1)}pp</td>
        <td colspan="4"></td>
      </tr>`
    : "";

  const childrenTable =
    children.length === 0
      ? `<div class="rejudge-empty">
           No re-judge passes yet. Run re-judge to smooth the ~6–7pp judge variance without re-spending analysis cost.
         </div>`
      : `<table class="rejudge-children">
           <thead>
             <tr>
               <th>#</th>
               <th>Prompt</th>
               <th>Hit rate</th>
               <th>Tokens (out)</th>
               <th>Wall</th>
               <th>Started</th>
               <th>Status</th>
             </tr>
           </thead>
           <tbody>
             ${rowsHtml}
             ${summaryRow}
           </tbody>
         </table>`;

  let statusLine = "";
  if (job?.status === "running") {
    statusLine = `<div class="rejudge-status running" data-rejudge-status>
      Running re-judge — pass ${job.completedPasses}/${job.totalPasses} (polling…)
    </div>`;
  } else if (job?.status === "done") {
    statusLine = `<div class="rejudge-status done">
      Re-judge complete — ${job.completedPasses} passes persisted.
    </div>`;
  } else if (job?.status === "error") {
    statusLine = `<div class="rejudge-status error">
      Re-judge failed: ${esc(job.error ?? "unknown error")}
    </div>`;
  }

  const formDisabled = job?.status === "running" || !canRejudge;
  const formHtml = canRejudge
    ? `<form class="rejudge-form" onsubmit="return startRejudge(event, '${esc(run.id)}')">
         <label for="rejudge-n">Passes:</label>
         <input type="number" id="rejudge-n" min="1" max="10" value="3" ${formDisabled ? "disabled" : ""}>
         <button type="submit" ${formDisabled ? "disabled" : ""}>
           ${job?.status === "running" ? "Running…" : "Re-judge"}
         </button>
         <span class="hint">~$0.15 per pass · reuses the stored candidate · no new analysis</span>
       </form>`
    : run.status === "done"
      ? ""
      : `<p class="subtitle" style="margin-top: 4px;">Re-judge is only available for parent runs in <code>done</code> status.</p>`;

  return `<div class="rejudge-panel">
    <h2>Re-judge passes</h2>
    <p class="subtitle">
      Re-judging writes child rows against the stored candidate so you can smooth the ~6–7pp inter-run judge variance without re-spending analysis cost.
    </p>
    ${formHtml}
    ${statusLine}
    ${childrenTable}
  </div>`;
}

const REJUDGE_SCRIPT = `
async function startRejudge(ev, runId) {
  ev.preventDefault();
  const input = document.getElementById('rejudge-n');
  const passes = parseInt(input.value, 10) || 3;
  const button = ev.target.querySelector('button');
  button.disabled = true;
  button.textContent = 'Starting…';
  try {
    const res = await fetch('/api/benchmark/runs/' + runId + '/rejudge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passes })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + res.status));
    }
    pollRejudge(runId);
  } catch (err) {
    button.disabled = false;
    button.textContent = 'Re-judge';
    alert('Failed to start re-judge: ' + err.message);
  }
  return false;
}

async function pollRejudge(runId) {
  let statusEl = document.querySelector('[data-rejudge-status]');
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'rejudge-status running';
    statusEl.setAttribute('data-rejudge-status', '');
    const panel = document.querySelector('.rejudge-panel');
    const form = panel && panel.querySelector('.rejudge-form');
    if (form) form.insertAdjacentElement('afterend', statusEl);
  }

  const tick = async () => {
    try {
      const res = await fetch('/api/benchmark/runs/' + runId + '/rejudge-children');
      if (!res.ok) return;
      const data = await res.json();
      const job = data.job;
      if (!job) return;
      if (job.status === 'running') {
        statusEl.textContent = 'Running re-judge — pass ' + job.completedPasses + '/' + job.totalPasses + ' (polling…)';
        setTimeout(tick, 4000);
      } else if (job.status === 'done') {
        statusEl.className = 'rejudge-status done';
        statusEl.textContent = 'Re-judge complete — reloading…';
        setTimeout(() => window.location.reload(), 800);
      } else if (job.status === 'error') {
        statusEl.className = 'rejudge-status error';
        statusEl.textContent = 'Re-judge failed: ' + (job.error || 'unknown error');
      }
    } catch (err) {
      setTimeout(tick, 4000);
    }
  };
  tick();
}

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.querySelector('[data-rejudge-status]');
  if (statusEl) {
    const runIdMatch = window.location.pathname.match(/\\/benchmark\\/runs\\/([0-9a-f-]+)/);
    if (runIdMatch) pollRejudge(runIdMatch[1]);
  }
});
`;

export function renderBenchmarkRunLivePage(job: LiveJob): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn — Live cell — ${esc(job.issueKey)}</title>
  <style>${STYLES}</style>
</head>
<body>
  ${renderNav("benchmark")}
  <div class="bench-container">
    <a href="/benchmark" class="back-link">← All runs</a>

    <div class="live-header">
      <h1>
        ${esc(job.issueKey)} · ${esc(job.treatmentLabel)}
        <span class="live-status ${esc(job.status)}" data-live-status>${esc(job.status)}</span>
      </h1>
      <p class="subtitle">
        trace ${esc(job.traceId)} ·
        started ${fmtTime(job.startedAt)} ·
        <a href="/benchmark/run-live/${esc(job.traceId)}/kill" onclick="return killLive(event, '${esc(job.traceId)}')" style="color: var(--status-error);">Kill</a>
      </p>
      <div class="live-metrics">
        <div class="metric"><div class="label">Elapsed</div><div class="value" data-metric-elapsed>0s</div></div>
        <div class="metric"><div class="label">Spans</div><div class="value" data-metric-spans>0</div></div>
        <div class="metric"><div class="label">Tool calls</div><div class="value" data-metric-tools>0</div></div>
        <div class="metric"><div class="label">Tokens (in/out)</div><div class="value" data-metric-tokens>—</div></div>
        <div class="metric"><div class="label">Exit</div><div class="value" data-metric-exit>—</div></div>
      </div>
    </div>

    <div class="live-waterfall">
      <h2>Analysis trace (polling every 2s)</h2>
      <div class="lw-bars" id="lwBars"><div class="lw-empty">Waiting for first span…</div></div>
    </div>

    <div class="live-logs">
      <h2>Subprocess log (tail)</h2>
      <pre id="liveLogs"><span style="color: var(--text-faint);">(no output yet)</span></pre>
    </div>
  </div>

  <script>
    const TRACE_ID = ${JSON.stringify(job.traceId)};
    const STARTED_AT = ${job.startedAt};

    function esc(s) {
      return String(s ?? '')
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }
    function fmtDur(ms) {
      if (ms == null) return '—';
      if (ms < 1000) return ms + 'ms';
      if (ms < 60000) return (ms/1000).toFixed(1) + 's';
      const m = Math.floor(ms/60000);
      const s = Math.round((ms%60000)/1000);
      return m + 'm' + (s < 10 ? '0'+s : s) + 's';
    }

    let latestJob = null;
    let latestSpans = [];
    let stopped = false;

    function nestingDepth(s, byId) {
      let d = 0, cur = s;
      while (cur.parentId && byId[cur.parentId]) { d++; cur = byId[cur.parentId]; }
      return d;
    }

    function renderBars(spans) {
      const el = document.getElementById('lwBars');
      if (!spans || spans.length === 0) {
        el.innerHTML = '<div class="lw-empty">Waiting for first span…</div>';
        return;
      }
      const byId = {};
      spans.forEach(s => { byId[s.id] = s; });

      const now = Date.now();
      const starts = spans.map(s => s.startedAt);
      const ends = spans.map(s => s.startedAt + (s.durationMs ?? (now - s.startedAt)));
      const minT = Math.min(...starts);
      const maxT = Math.max(...ends);
      const range = Math.max(maxT - minT, 1);

      el.innerHTML = spans.map(s => {
        const isRunning = s.durationMs == null;
        const effectiveDur = s.durationMs ?? (now - s.startedAt);
        const left = ((s.startedAt - minT) / range) * 100;
        const width = Math.max((effectiveDur / range) * 100, 0.5);
        const isTool = s.attributes && (s.attributes.toolName || s.attributes.toolId);
        const kind = isTool ? 'tool' : (s.kind || 'span');
        const statusClass = s.status === 'error' ? ' status-error' : '';
        const runningClass = isRunning ? ' running' : '';
        const depth = nestingDepth(s, byId);
        const indent = '\\u00A0\\u00A0'.repeat(depth);
        return '<div class="lw-row">' +
          '<div class="lw-label" title="' + esc(s.name) + '">' + indent + esc(s.name) + '</div>' +
          '<div class="lw-bar-track">' +
            '<div class="lw-bar kind-' + kind + statusClass + runningClass +
            '" style="left:' + left.toFixed(2) + '%;width:' + width.toFixed(2) + '%">' +
            '<span class="lw-duration">' + fmtDur(s.durationMs) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    function updateMetrics() {
      const job = latestJob;
      const spans = latestSpans;
      document.querySelector('[data-metric-spans]').textContent = spans.length;
      const toolCount = spans.filter(s => s.attributes && (s.attributes.toolName || s.attributes.toolId)).length;
      document.querySelector('[data-metric-tools]').textContent = toolCount;

      const now = (job && job.finishedAt) ? job.finishedAt : Date.now();
      const elapsed = now - STARTED_AT;
      document.querySelector('[data-metric-elapsed]').textContent = fmtDur(elapsed);

      const root = spans.find(s => !s.parentId);
      if (root && root.attributes) {
        const inT = root.attributes.inputTokens;
        const outT = root.attributes.outputTokens;
        if (inT != null || outT != null) {
          document.querySelector('[data-metric-tokens]').textContent =
            (inT?.toLocaleString() ?? '—') + ' / ' + (outT?.toLocaleString() ?? '—');
        }
      }
      if (job) {
        document.querySelector('[data-live-status]').textContent = job.status;
        document.querySelector('[data-live-status]').className = 'live-status ' + job.status;
        if (job.exitCode != null) {
          document.querySelector('[data-metric-exit]').textContent = String(job.exitCode);
        }
      }
    }

    function renderLogs(logTail) {
      const el = document.getElementById('liveLogs');
      if (!logTail || logTail.length === 0) return;
      const html = logTail.map(l =>
        l.stream === 'stderr'
          ? '<span class="stderr">' + esc(l.line) + '</span>'
          : esc(l.line)
      ).join('\\n');
      el.innerHTML = html;
      el.scrollTop = el.scrollHeight;
    }

    async function tick() {
      if (stopped) return;
      try {
        const res = await fetch('/api/benchmark/cells/live/' + TRACE_ID);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        latestJob = data.job;
        latestSpans = data.spans || [];
        renderBars(latestSpans);
        renderLogs(latestJob.logTail);
        updateMetrics();
        if (latestJob.status === 'done' || latestJob.status === 'error') {
          stopped = true;
          return;
        }
      } catch (err) {
        console.warn('poll failed', err);
      }
      setTimeout(tick, 2000);
    }

    async function killLive(ev, traceId) {
      ev.preventDefault();
      if (!confirm('Kill this benchmark cell?')) return false;
      try {
        await fetch('/api/benchmark/cells/live/' + traceId + '/kill', { method: 'POST' });
      } catch (e) { console.error(e); }
      return false;
    }

    tick();
    // Update elapsed every second even without a poll tick, so the counter looks alive.
    setInterval(() => { if (!stopped) updateMetrics(); }, 1000);
  </script>
</body>
</html>`;
}
