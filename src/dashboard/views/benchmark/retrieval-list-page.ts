import { renderNav } from "../shared-styles.ts";
import type { RetrievalRunRow } from "../../../db/benchmark-retrieval-runs.ts";
import { BENCHMARK_STYLES, esc, fmtTime } from "./shared.ts";
import { RETRIEVAL_TARGETS } from "../../../benchmarks/retrieval.ts";

function fmtPct(n: number | null | undefined): string {
  return n == null ? "—" : `${(n * 100).toFixed(0)}%`;
}

function fmtMrr(n: number | null | undefined): string {
  return n == null ? "—" : n.toFixed(3);
}

/**
 * Minimal list view of retrieval eval runs. No run-launch UI (the eval is
 * driven from the CLI); this is purely a regression-tracking read-out of the
 * headline metrics per run, with a per-target breakdown in the tooltip.
 */
export function renderRetrievalListPage(runs: RetrievalRunRow[]): string {
  const rowsHtml =
    runs.length === 0
      ? `<div class="empty-state">
          <p>No retrieval eval runs yet.</p>
          <p style="margin-top: 12px;">Run the eval from the CLI:</p>
          <p style="margin-top: 8px;"><code>bun scripts/retrieval-eval.ts</code></p>
        </div>`
      : `<table class="runs-table">
          <thead>
            <tr>
              <th>Started</th>
              <th>Target</th>
              <th>Queries</th>
              <th>Hit rate</th>
              <th>Recall@k</th>
              <th>MRR</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${runs
              .map((r) => {
                const o = r.metrics?.overall;
                const perTargetTip = r.metrics
                  ? RETRIEVAL_TARGETS.map((t) => {
                      const m = r.metrics!.perTarget[t];
                      return m
                        ? `${t}: hit ${fmtPct(m.hitRate)} · recall ${fmtPct(m.recallAtK)} · mrr ${fmtMrr(m.mrr)} (n=${m.queryCount})`
                        : null;
                    })
                      .filter(Boolean)
                      .join("\n")
                  : "no metrics recorded";
                return `<tr title="${esc(perTargetTip)}">
                  <td>${fmtTime(r.startedAt)}</td>
                  <td>${esc(r.targetFilter ?? "all")}</td>
                  <td class="num">${r.queryCount}</td>
                  <td class="num">${fmtPct(o?.hitRate)}</td>
                  <td class="num">${fmtPct(o?.recallAtK)}</td>
                  <td class="num">${fmtMrr(o?.mrr)}</td>
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
  <title>Muninn — Retrieval Eval</title>
  <style>${BENCHMARK_STYLES}</style>
</head>
<body>
  ${renderNav("benchmark")}
  <div class="bench-container">
    <div class="page-header">
      <h1>Retrieval Eval</h1>
      <p>Golden-set recall@k / hit-rate / MRR for huginn search, memory search, and the research flow. Hover a row for the per-target breakdown. · <a href="/benchmark" style="color: var(--accent);">← Jira benchmark</a></p>
    </div>
    ${rowsHtml}
  </div>
</body>
</html>`;
}
