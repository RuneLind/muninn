import { renderNav } from "../shared-styles.ts";
import { helpersClientScript } from "../components/helpers.ts";
import type { BenchmarkRunRow } from "../../../db/benchmark-runs.ts";
import type {
  DiscoveredIssue,
  DiscoveredTreatment,
} from "../../../benchmarks/treatment-discovery.ts";
import {
  BENCHMARK_STYLES,
  esc,
  rateClass,
  highlightedClass,
  fmtRate,
  shouldSuppressHighlighted,
  fmtTime,
} from "./shared.ts";

export async function renderBenchmarkListPage(
  runs: BenchmarkRunRow[],
  issues: DiscoveredIssue[] = [],
  treatments: DiscoveredTreatment[] = [],
): Promise<string> {
  const helpers = await helpersClientScript();
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
            <th>Model</th>
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
                      ? `${r.highlightedFound ?? 0}/${r.highlightedTotal}`
                      : "—"
                  }</span></td>`
                : "";
              const modelLabel = r.treatment?.model ?? r.modelSnapshotId ?? "—";
              const treatmentTooltip = r.treatment
                ? [
                    `connector: ${r.treatment.connector}`,
                    `model: ${r.treatment.model}`,
                    `mcpStack: ${r.treatment.mcpStack}`,
                    `promptId: ${r.treatment.promptId}`,
                    ...(r.treatment.baseUrl ? [`baseUrl: ${r.treatment.baseUrl}`] : []),
                  ].join("\n")
                : "no treatment recorded";
              return `<tr onclick="window.location='/benchmark/runs/${esc(r.id)}'">
                <td><span class="issue-key">${esc(r.issueKey)}</span></td>
                <td class="model-cell" title="${esc(treatmentTooltip)}">${esc(modelLabel)}</td>
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
        <div style="display: flex; gap: 6px;">
          <button type="button" onclick="openPreview()" style="background: var(--bg-deep); color: var(--text-soft); border: 1px solid var(--border-secondary);">Preview</button>
          <button type="submit">Run cell (live)</button>
        </div>
        <div class="hint">Preview shows the resolved prompt, MCP plan, and cost estimate without spending tokens. Run cell spawns run-cell.ts with a pre-allocated trace ID and redirects to the live waterfall.</div>
      </form>
      <div class="preview-panel" id="previewPanel">
        <div id="previewBody"></div>
      </div>`
    : `<div class="run-form" style="display:block; color: var(--text-faint); font-size: 12px;">
        No issues or treatments discovered in <code>benchmarks/issues</code> and <code>benchmarks/treatments</code>.
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn — Benchmark</title>
  <style>${BENCHMARK_STYLES}</style>
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
  <script>${helpers}${RUN_FORM_SCRIPT}</script>
</body>
</html>`;
}

const RUN_FORM_SCRIPT = `
async function startRunCell(ev) {
  ev.preventDefault();
  const issue = document.getElementById('run-issue').value;
  const treatmentEl = document.getElementById('run-treatment');
  const treatmentPath = treatmentEl.value;
  const button = ev.target.querySelector('button[type="submit"]');
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

async function openPreview() {
  const issue = document.getElementById('run-issue').value;
  const treatmentPath = document.getElementById('run-treatment').value;
  const panel = document.getElementById('previewPanel');
  const body = document.getElementById('previewBody');
  panel.classList.add('visible');
  body.innerHTML = '<p style="color: var(--text-dim); font-size: 12px;">Loading preview…</p>';
  try {
    const url = '/api/benchmark/preview?issueKey=' + encodeURIComponent(issue) +
                '&treatmentPath=' + encodeURIComponent(treatmentPath);
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || ('HTTP ' + res.status));
    }
    const preview = await res.json();
    body.innerHTML = renderPreview(preview);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    body.innerHTML = '<div class="preview-error">Failed to build preview: ' + esc(err.message) + '</div>';
  }
}

function closePreview() {
  document.getElementById('previewPanel').classList.remove('visible');
}

async function runFromPreview(issue, treatmentPath) {
  const btn = document.getElementById('previewRunBtn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
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
    btn.disabled = false;
    btn.textContent = 'Run this cell';
    alert('Failed to start cell: ' + err.message);
  }
}

function renderPreview(p) {
  const cost = p.cost;
  const costStr = '$' + cost.totalLowUsd.toFixed(2) + ' – $' + cost.totalHighUsd.toFixed(2);
  const repos = p.issue.repos.map(r => r.name + ' @ ' + (r.baseCommit || '(no baseCommit)').slice(0, 8)).join('<br>') || '(none)';
  const servers = p.mcp.servers.map(s =>
    '<div class="kv"><span class="k">' + esc(s.role) + '</span><span>' + esc(s.name) + ' — ' + esc(s.note) + '</span></div>'
  ).join('');
  const worktrees = p.mcp.worktrees.length
    ? p.mcp.worktrees.map(w => '<div class="kv"><span class="k">' + esc(w.repo) + '</span><span>' + esc(w.path) + '</span></div>').join('')
    : '<div style="color: var(--text-faint);">No code-intel stacks in this treatment — no worktrees will be indexed.</div>';
  const denyTags = p.mcp.disallowedTools.map(t => '<span class="tag deny">' + esc(t) + '</span>').join('');
  const warningsHtml = p.warnings.length
    ? '<div class="preview-warnings">⚠ ' + p.warnings.map(esc).join('<br>⚠ ') + '</div>'
    : '';

  return \`
    <h2>Preview — \${esc(p.issue.issueKey)}</h2>
    <p class="subtitle">
      \${esc(p.treatment.connector)} · \${esc(p.treatment.model)} · \${esc(p.treatment.mcpStack)} · \${esc(p.treatment.promptId)}
      · estimate \${costStr}
    </p>

    \${warningsHtml}

    <div class="preview-grid">
      <div class="preview-card">
        <div class="card-label">Issue</div>
        <div class="card-body">
          <div class="kv"><span class="k">key</span><span>\${esc(p.issue.issueKey)}</span></div>
          <div class="kv"><span class="k">title</span><span>\${esc(p.issue.title)}</span></div>
          <div class="kv"><span class="k">category</span><span>\${esc(p.issue.category)}</span></div>
          <div class="kv"><span class="k">gold</span><span>\${esc(p.issue.goldPath)}</span></div>
          <div class="kv"><span class="k">goldLines</span><span>\${p.issue.goldLineCount}</span></div>
          <div class="kv"><span class="k">highlighted</span><span>\${p.issue.highlightedCount}\${p.issue.highlightedCount < 3 ? ' (treated as binary flag)' : ''}</span></div>
        </div>
      </div>
      <div class="preview-card">
        <div class="card-label">Cost estimate</div>
        <div class="card-body">
          <div class="kv"><span class="k">analysis</span><span>$\${cost.analysisLowUsd.toFixed(2)} – $\${cost.analysisHighUsd.toFixed(2)}</span></div>
          <div class="kv"><span class="k">judge</span><span>$\${cost.judgeUsd.toFixed(2)}</span></div>
          <div class="kv"><span class="k">total</span><span>\${costStr}</span></div>
          <div style="margin-top: 8px; color: var(--text-faint); font-size: 10px;">\${esc(cost.note)}</div>
        </div>
      </div>
      <div class="preview-card">
        <div class="card-label">Repos / baseCommits</div>
        <div class="card-body">\${repos}</div>
      </div>
      <div class="preview-card">
        <div class="card-label">MCP plan — \${esc(p.mcp.stack)}</div>
        <div class="card-body">\${servers}</div>
      </div>
    </div>

    <div class="preview-section">
      <h3>Worktrees the code-intel stacks would index</h3>
      <div class="preview-card"><div class="card-body">\${worktrees}</div></div>
    </div>

    <div class="preview-section">
      <h3>Resolved user message</h3>
      <pre>\${esc(p.userMessage)}</pre>
    </div>

    <div class="preview-section">
      <h3>Resolved jiraAnalysis prompt\${p.promptVariantPath ? ' (from ' + esc(p.promptVariantPath) + ')' : ' (base bot default)'}</h3>
      <pre>\${esc(p.jiraAnalysisPrompt)}</pre>
    </div>

    <div class="preview-section">
      <h3>Gold excerpt (first \${p.issue.goldExcerpt.split('\\n').length} of \${p.issue.goldLineCount} lines)</h3>
      <pre>\${esc(p.issue.goldExcerpt)}</pre>
    </div>

    <div class="preview-section">
      <h3>Denied tools (Bug 11 harness fence, \${p.mcp.disallowedTools.length} entries)</h3>
      <div class="tags">\${denyTags}</div>
    </div>

    <div class="preview-actions">
      <button id="previewRunBtn" onclick="runFromPreview('\${esc(p.issue.issueKey)}', '\${esc(p.treatmentPath)}')">Run this cell</button>
      <button class="secondary" onclick="closePreview()">Close</button>
      <span class="hint">The preview is pure-reads — no tokens spent. Pressing Run this cell spawns the same subprocess as Run cell (live).</span>
    </div>
  \`;
}
`;
