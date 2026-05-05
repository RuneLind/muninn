import { renderNav } from "../shared-styles.ts";
import type { BenchmarkRunRow } from "../../../db/benchmark-runs.ts";
import type { GoldClaim } from "../../../benchmarks/types.ts";
import { meanStddev, type RejudgeJobState } from "../../../benchmarks/rejudge.ts";
import {
  BENCHMARK_STYLES,
  esc,
  rateClass,
  highlightedClass,
  fmtRate,
  shouldSuppressHighlighted,
  fmtTime,
} from "./shared.ts";

export function renderBenchmarkDetailPage(
  run: BenchmarkRunRow,
  rejudgeChildren: BenchmarkRunRow[] = [],
  rejudgeJob: RejudgeJobState | null = null,
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
  // Error rows are eligible too — candidate.md is persisted before the judge
  // runs, so a judge-side failure still leaves a valid candidate to score.
  const canRejudge =
    run.parentRunId === null && (run.status === "done" || run.status === "error");
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
  <style>${BENCHMARK_STYLES}</style>
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
  job: RejudgeJobState | null,
  canRejudge: boolean,
): string {
  const doneChildren = children.filter((c) => c.status === "done" && c.hitRate !== null);
  const allHits: number[] = [];
  if (run.hitRate !== null && run.status === "done") allHits.push(run.hitRate);
  for (const c of doneChildren) if (c.hitRate !== null) allHits.push(c.hitRate);
  const stats = allHits.length > 0 ? meanStddev(allHits) : null;

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
    : run.status === "running"
      ? `<p class="subtitle" style="margin-top: 4px;">Re-judge will be available once this run finishes.</p>`
      : `<p class="subtitle" style="margin-top: 4px;">Re-judge is only available for parent runs.</p>`;

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
    if (document.visibilityState !== 'visible') {
      setTimeout(tick, 4000);
      return;
    }
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
