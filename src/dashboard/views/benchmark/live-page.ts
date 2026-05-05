import { renderNav } from "../shared-styles.ts";
import { escScript } from "../components/helpers.ts";
import type { LiveJob } from "../../../benchmarks/live-job.ts";
import { BENCHMARK_STYLES, esc, fmtTime } from "./shared.ts";

export function renderBenchmarkRunLivePage(job: LiveJob): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn — Live cell — ${esc(job.issueKey)}</title>
  <style>${BENCHMARK_STYLES}</style>
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

    ${escScript()}

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
      // Skip the fetch if the tab isn't visible — a backgrounded tab on a
      // 7-min cell would otherwise fire ~210 DB queries against the traces
      // table for nothing. visibilitychange wakes us back up.
      if (document.visibilityState !== 'visible') {
        setTimeout(tick, 2000);
        return;
      }
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

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !stopped) tick();
    });

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
