/** Traces waterfall — span visualization with bar chart and detail panel */
export function tracesWaterfallStyles(): string {
  return `
    /* Waterfall */
    .waterfall-container {
      display: none;
      padding: 16px 24px;
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      margin: 8px 0 16px;
    }
    .waterfall-container.visible { display: block; }
    .waterfall-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .waterfall-header h3 { font-size: 14px; color: var(--text-primary); }
    .waterfall-close {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 18px;
      padding: 4px;
    }
    .waterfall-close:hover { color: var(--text-primary); }

    .waterfall {
      position: relative;
      min-height: 40px;
    }
    .waterfall-row {
      display: grid;
      grid-template-columns: 200px 1fr;
      align-items: center;
      height: 28px;
      gap: 12px;
    }
    .waterfall-label {
      font-size: 12px;
      color: var(--text-soft);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .waterfall-bar-container {
      position: relative;
      height: 16px;
      background: color-mix(in srgb, white 3%, transparent);
      border-radius: 3px;
    }
    .waterfall-bar {
      position: absolute;
      height: 100%;
      border-radius: 3px;
      min-width: 2px;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .waterfall-bar:hover { opacity: 0.8; }
    .waterfall-bar.kind-root { background: var(--accent); }
    .waterfall-bar.kind-span { background: var(--status-cyan); }
    .waterfall-bar.kind-tool { background: var(--status-tool); }
    .waterfall-bar.kind-event { background: var(--status-warning); width: 3px !important; }
    .waterfall-bar.status-error { background: var(--status-error); }
    .waterfall-duration {
      position: absolute;
      right: -60px;
      top: 0;
      font-size: 10px;
      color: var(--text-dim);
      line-height: 16px;
      width: 55px;
    }
    .waterfall-input {
      position: absolute;
      left: calc(100% + 65px);
      top: 0;
      font-size: 10px;
      color: var(--text-faint);
      line-height: 16px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 300px;
    }

    /* Span Details — inline panel below the waterfall on narrow viewports.
       Promoted to a fixed right-side drawer at ≥1200px (see media query below). */
    .span-details {
      position: relative;
      margin-top: 16px;
      background: var(--bg-page);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      padding: 12px;
      font-size: 12px;
      display: none;
    }
    .span-details.visible { display: block; }
    .span-details h4 { color: var(--accent-light); margin-bottom: 8px; font-size: 13px; padding-right: 32px; }
    .span-details pre {
      background: var(--bg-panel);
      padding: 10px;
      border-radius: 4px;
      overflow-x: auto;
      color: var(--text-tertiary);
      font-size: 11px;
      line-height: 1.5;
    }
    .span-details-close {
      position: absolute;
      top: 8px;
      right: 10px;
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 20px;
      line-height: 1;
      padding: 4px 8px;
      border-radius: 4px;
      display: none;
    }
    .span-details-close:hover { color: var(--text-primary); background: color-mix(in srgb, white 5%, transparent); }

    @media (min-width: 1200px) {
      .span-details {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: clamp(560px, 55vw, 920px);
        margin: 0;
        z-index: 50;
        border-radius: 0;
        border: none;
        border-left: 1px solid var(--border-primary);
        padding: 20px 20px 24px;
        overflow-y: auto;
        background: var(--bg-page);
        box-shadow: -8px 0 24px rgba(0,0,0,0.35);
      }
      .span-details-close { display: block; }
      /* Title can be long inside a narrow drawer column; let it shrink hard
         and rely on the cell's title attribute for the full string. */
      .span-details .stt-cands td.stt-title { max-width: 220px; }
    }

    /* View Prompt button in waterfall header */
    .btn-view-prompt {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--accent-light);
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
      margin-right: 8px;
    }
    .btn-view-prompt:hover { background: color-mix(in srgb, var(--accent) 25%, transparent); border-color: var(--accent); }
  `;
}

export function tracesWaterfallHtml(): string {
  return `
    <div class="waterfall-container" id="waterfallContainer">
      <div class="waterfall-header">
        <h3 id="waterfallTitle">Trace Details</h3>
        <div>
          <button class="btn-view-prompt" id="btnViewPrompt" onclick="openPromptModal()">View Prompt</button>
          <button class="waterfall-close" onclick="closeWaterfall()">&times;</button>
        </div>
      </div>
      <div class="waterfall" id="waterfall"></div>
      <div class="span-details" id="spanDetails">
        <button class="span-details-close" onclick="closeSpanDetails()" title="Close (Esc)" aria-label="Close span detail">&times;</button>
        <h4 id="spanDetailsTitle"></h4>
        <div id="spanDetailsJson"></div>
      </div>
    </div>`;
}

export function tracesWaterfallScript(): string {
  return `
    let currentWaterfallTraceId = null;
    let waterfallSpans = []; // stored for click lookups

    async function loadWaterfall(traceId) {
      try {
        currentWaterfallTraceId = traceId;
        const res = await fetch('/api/traces/' + traceId);
        const { spans } = await res.json();
        if (spans.length === 0) return;

        const container = document.getElementById('waterfallContainer');
        container.classList.add('visible');

        const root = spans.find(s => !s.parentId) || spans[0];
        document.getElementById('waterfallTitle').textContent =
          root.name + ' (' + fmtDuration(root.durationMs) + ')';

        // Highlight the selected row
        document.querySelectorAll('.trace-table tr').forEach(r => r.classList.remove('expanded'));
        const row = document.querySelector('tr[data-trace="' + traceId + '"]');
        if (row) row.classList.add('expanded');

        renderWaterfall(spans);
        document.getElementById('spanDetails').classList.remove('visible');
      } catch (e) { console.error('Failed to load waterfall', e); }
    }

    function renderWaterfall(spans) {
      waterfallSpans = spans;
      const el = document.getElementById('waterfall');
      if (spans.length === 0) { el.innerHTML = '<div class="empty">No spans</div>'; return; }

      // Build parent lookup for nesting depth
      const spanById = {};
      spans.forEach(s => { spanById[s.id] = s; });

      function nestingDepth(s) {
        let depth = 0;
        let current = s;
        while (current.parentId && spanById[current.parentId]) {
          depth++;
          current = spanById[current.parentId];
        }
        return depth;
      }

      function isToolSpan(s) {
        return s.attributes && (s.attributes.toolName || s.attributes.toolId);
      }

      const minTime = Math.min(...spans.map(s => s.startedAt));
      const maxTime = Math.max(...spans.map(s => s.startedAt + (s.durationMs || 0)));
      const totalRange = Math.max(maxTime - minTime, 1);

      el.innerHTML = spans.map((s, i) => {
        const left = ((s.startedAt - minTime) / totalRange) * 100;
        const width = s.kind === 'event' ? 0.3 : Math.max(((s.durationMs || 0) / totalRange) * 100, 0.3);
        const statusClass = s.status === 'error' ? ' status-error' : '';
        const depth = nestingDepth(s);
        const indent = '\\u00A0\\u00A0'.repeat(depth);
        const label = indent + s.name;
        const barKind = isToolSpan(s) ? 'tool' : s.kind;
        const inputLabel = isToolSpan(s) ? toolInputLabel(s.attributes && s.attributes.input) : '';
        const inputHtml = inputLabel ? '<span class="waterfall-input" title="' + esc(inputLabel) + '">' + esc(inputLabel) + '</span>' : '';
        return '<div class="waterfall-row">' +
          '<div class="waterfall-label" title="' + esc(s.name) + '">' + esc(label) + '</div>' +
          '<div class="waterfall-bar-container">' +
            '<div class="waterfall-bar kind-' + barKind + statusClass + '" ' +
              'style="left:' + left + '%;width:' + width + '%"' +
              ' data-span-index="' + i + '">' +
              '<span class="waterfall-duration">' + fmtDuration(s.durationMs) + '</span>' +
              inputHtml +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // Event delegation for waterfall bar clicks
    document.getElementById('waterfall').addEventListener('click', function(event) {
      const bar = event.target.closest('[data-span-index]');
      if (!bar) return;
      event.stopPropagation();
      const span = waterfallSpans[parseInt(bar.dataset.spanIndex, 10)];
      if (!span) return;
      const details = document.getElementById('spanDetails');
      details.classList.add('visible');
      document.getElementById('spanDetailsTitle').textContent =
        span.name + ' (' + span.kind + ', ' + span.status + ')';
      const attrs = span.attributes || {};
      const host = document.getElementById('spanDetailsJson');
      // If the span carries a v1 Huginn search trace, render the structured panel.
      // Fall back to raw JSON for everything else (other span kinds, future schema
      // versions, or if the renderer module isn't loaded).
      if (attrs.searchTrace && typeof renderSearchTrace === 'function' &&
          attrs.searchTrace.schemaVersion === 1) {
        if (window.__sttState) window.__sttState.showRaw = false;
        host.innerHTML = renderSearchTrace(attrs.searchTrace);
      } else {
        host.innerHTML = '<pre>' + esc(JSON.stringify(attrs, null, 2)) + '</pre>';
      }
    });

    function closeWaterfall() {
      document.getElementById('waterfallContainer').classList.remove('visible');
      document.getElementById('spanDetails').classList.remove('visible');
      document.querySelectorAll('.trace-table tr').forEach(r => r.classList.remove('expanded'));
    }

    function closeSpanDetails() {
      document.getElementById('spanDetails').classList.remove('visible');
    }

    // Esc closes the drawer first if open, then the waterfall. Doesn't preventDefault
    // unless something was actually closed, so other shortcuts are unaffected.
    document.addEventListener('keydown', function(e) {
      if (e.key !== 'Escape') return;
      const det = document.getElementById('spanDetails');
      if (det && det.classList.contains('visible')) {
        e.preventDefault();
        closeSpanDetails();
        return;
      }
      const wf = document.getElementById('waterfallContainer');
      if (wf && wf.classList.contains('visible')) {
        e.preventDefault();
        closeWaterfall();
      }
    });
  `;
}
