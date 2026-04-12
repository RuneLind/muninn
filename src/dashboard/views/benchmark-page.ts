import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import type { BenchmarkRunRow } from "../../db/benchmark-runs.ts";
import type { GoldClaim } from "../../benchmarks/types.ts";

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

function fmtTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function renderBenchmarkListPage(runs: BenchmarkRunRow[]): string {
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
            <th>Highlighted</th>
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
              return `<tr onclick="window.location='/benchmark/runs/${esc(r.id)}'">
                <td><span class="issue-key">${esc(r.issueKey)}</span></td>
                <td class="num"><span class="hit-rate ${hClass}">${fmtRate(r.hitRate)}</span></td>
                <td class="num"><span class="highlighted-rate ${hlClass}">${
                  r.highlightedTotal && r.highlightedTotal > 0
                    ? `${r.highlightedFound ?? 0}/${r.highlightedTotal}`
                    : "—"
                }</span></td>
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
    ${rowsHtml}
  </div>
</body>
</html>`;
}

export function renderBenchmarkDetailPage(run: BenchmarkRunRow): string {
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
          <div class="label">Highlighted rate</div>
          <div class="value ${hlClass === "full" ? "high" : hlClass === "partial" ? "med" : "low"}">${
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

    <div class="claims-list">
      ${claimsHtml || '<div class="empty-state"><p>No per-claim data on this run.</p></div>'}
    </div>
  </div>
</body>
</html>`;
}
