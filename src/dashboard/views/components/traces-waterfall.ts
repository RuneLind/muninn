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
      grid-template-columns: 300px 1fr;
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
    /* Collapse-toggle chevron on parent rows that have synthesized stage
       children (search trace stages). The spacer variant keeps non-collapsible
       rows aligned with collapsible ones so the chip column stays straight. */
    .waterfall-toggle {
      display: inline-block;
      width: 16px;
      text-align: center;
      color: var(--text-soft);
      font-size: 14px;
      line-height: 16px;
      cursor: pointer;
      user-select: none;
      margin-right: 4px;
    }
    .waterfall-toggle:hover { color: var(--text-primary); }
    .waterfall-toggle-spacer { cursor: default; visibility: hidden; }
    /* Chip-rendered labels for tool spans with discoverable collections.
       Verb + first-collection + (+N) — color stable per collection name (HSL hash). */
    .wf-chip {
      display: inline-block;
      padding: 0 6px;
      margin-right: 4px;
      border-radius: 3px;
      font-size: 10px;
      line-height: 16px;
      vertical-align: middle;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .wf-verb { font-weight: 600; }
    .wf-verb-search { background: color-mix(in srgb, var(--status-tool) 18%, transparent); color: var(--status-tool); border: 1px solid color-mix(in srgb, var(--status-tool) 40%, transparent); }
    .wf-verb-get    { background: color-mix(in srgb, var(--status-info) 18%, transparent); color: var(--status-info); border: 1px solid color-mix(in srgb, var(--status-info) 40%, transparent); }
    .wf-verb-list   { background: color-mix(in srgb, var(--status-cyan) 18%, transparent); color: var(--status-cyan); border: 1px solid color-mix(in srgb, var(--status-cyan) 40%, transparent); }
    .wf-verb-read   { background: color-mix(in srgb, var(--status-cyan) 14%, transparent); color: var(--status-cyan); border: 1px solid color-mix(in srgb, var(--status-cyan) 35%, transparent); }
    .wf-verb-symbol { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent-light); border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
    .wf-verb-other  { background: color-mix(in srgb, white 6%, transparent); color: var(--text-soft); border: 1px solid color-mix(in srgb, white 12%, transparent); }
    /* Generic extra chip — used for ids, path tails, and patterns alongside
       a repo/kind chip so the row carries the most distinguishing info. */
    .wf-chip.wf-extra {
      background: color-mix(in srgb, white 5%, transparent);
      color: var(--text-soft);
      border: 1px solid color-mix(in srgb, white 10%, transparent);
      max-width: 200px;
    }
    .wf-chip.wf-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .wf-coll-more {
      background: color-mix(in srgb, white 5%, transparent);
      color: var(--text-dim);
      border: 1px solid color-mix(in srgb, white 10%, transparent);
    }
    /* Counts chip — kept/fetched candidate count for search tool spans. The
       low-conf variant flips to the warning palette so a "you got nothing
       useful" search is visible without expanding the trace panel. */
    .wf-chip.wf-counts {
      background: color-mix(in srgb, white 6%, transparent);
      color: var(--text-soft);
      border: 1px solid color-mix(in srgb, white 12%, transparent);
      font-variant-numeric: tabular-nums;
    }
    .wf-chip.wf-counts.wf-low-conf {
      background: color-mix(in srgb, var(--status-warning) 14%, transparent);
      color: var(--status-warning);
      border-color: color-mix(in srgb, var(--status-warning) 35%, transparent);
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
    let waterfallSpans = []; // sorted in tree order (parent before children)
    let waterfallSpanById = {};
    let waterfallChildrenByParent = {};
    let collapsedSpanIds = new Set();

    // Build id-to-span / parent-to-children indices and return spans flattened
    // in tree order (parent immediately before its children, siblings by
    // startedAt). The flat order matters because the DB sort by startedAt is
    // unstable when a synthesized stage span starts at offset 0 from its tool
    // parent, so without this the child can render above the parent.
    function buildWaterfallState(spans) {
      const spanById = {};
      const childrenByParent = {};
      spans.forEach(s => {
        spanById[s.id] = s;
        if (s.parentId) {
          if (!childrenByParent[s.parentId]) childrenByParent[s.parentId] = [];
          childrenByParent[s.parentId].push(s);
        }
      });
      const byStart = (a, b) => a.startedAt - b.startedAt;
      const roots = spans.filter(s => !s.parentId || !spanById[s.parentId]).sort(byStart);
      Object.keys(childrenByParent).forEach(k => childrenByParent[k].sort(byStart));

      const sorted = [];
      const visited = new Set();
      function visit(s) {
        if (visited.has(s.id)) return; // cycle guard
        visited.add(s.id);
        sorted.push(s);
        const kids = childrenByParent[s.id];
        if (kids) kids.forEach(visit);
      }
      roots.forEach(visit);
      // Append any unreachable nodes so a malformed tree doesn't silently drop spans.
      // Surface the count to the operator console — an orphan means a parent_id
      // pointed at a span that wasn't returned (deleted? cross-trace?) and would
      // otherwise render unexplained at the bottom of the waterfall.
      var orphans = 0;
      spans.forEach(s => {
        if (!visited.has(s.id)) { sorted.push(s); orphans++; }
      });
      if (orphans > 0) {
        console.warn('[trace] ' + orphans + ' orphan span(s) attached at root — parent_id missing from trace');
      }
      return { sorted, spanById, childrenByParent };
    }

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

        document.querySelectorAll('.trace-table tr').forEach(r => r.classList.remove('expanded'));
        const row = document.querySelector('tr[data-trace="' + traceId + '"]');
        if (row) row.classList.add('expanded');

        // Single index pass per trace load — renderWaterfall and the collapse
        // helpers all read from this cache, so chevron toggles don't re-walk.
        const built = buildWaterfallState(spans);
        waterfallSpans = built.sorted;
        waterfallSpanById = built.spanById;
        waterfallChildrenByParent = built.childrenByParent;

        // Auto-collapse parents whose children are synthesized stage spans
        // (index.fetch / boost.title / assemble). Same info is one click away
        // in the search detail panel.
        collapsedSpanIds = new Set();
        waterfallSpans.forEach(s => {
          if (spanHasCollapsibleChildren(s.id)) collapsedSpanIds.add(s.id);
        });

        renderWaterfall();
        document.getElementById('spanDetails').classList.remove('visible');
      } catch (e) { console.error('Failed to load waterfall', e); }
    }

    function spanHasCollapsibleChildren(spanId) {
      const kids = waterfallChildrenByParent[spanId] || [];
      return kids.some(k => k.attributes && k.attributes.synthesized === true);
    }

    function toggleCollapse(spanId, event) {
      if (event) event.stopPropagation();
      if (collapsedSpanIds.has(spanId)) collapsedSpanIds.delete(spanId);
      else collapsedSpanIds.add(spanId);
      renderWaterfall();
    }

    // The AI span is recorded internally as "claude" regardless of which
    // connector handled the call. Render the label as "{connector}, {model}"
    // (e.g. "copilot-sdk, claude-sonnet-4-6") so the waterfall reflects what
    // actually ran.
    function isAiSpan(s) {
      if (!s || s.name !== 'claude') return false;
      const a = s.attributes || {};
      return !!(a.connector || a.model || a.requestedModel);
    }
    function aiSpanLabel(s) {
      const a = s.attributes || {};
      const conn = a.connector || 'claude-cli';
      const model = a.model || a.requestedModel || '';
      return model ? conn + ', ' + model : conn;
    }

    function renderWaterfall() {
      const spans = waterfallSpans;
      const el = document.getElementById('waterfall');
      if (spans.length === 0) { el.innerHTML = '<div class="empty">No spans</div>'; return; }

      // One DFS from each collapsed root marks every descendant — turns the
      // per-row ancestor walk into an O(1) Set lookup.
      const hiddenSpanIds = new Set();
      function hideDescendants(parentId) {
        const kids = waterfallChildrenByParent[parentId];
        if (!kids) return;
        for (const k of kids) {
          hiddenSpanIds.add(k.id);
          hideDescendants(k.id);
        }
      }
      collapsedSpanIds.forEach(hideDescendants);

      function nestingDepth(s) {
        let depth = 0;
        let current = s;
        while (current.parentId && waterfallSpanById[current.parentId]) {
          depth++;
          current = waterfallSpanById[current.parentId];
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
        // Original index i is preserved on visible rows so the click-to-detail
        // handler can index back into waterfallSpans regardless of how many
        // rows the collapse filter dropped.
        if (hiddenSpanIds.has(s.id)) return '';

        const left = ((s.startedAt - minTime) / totalRange) * 100;
        const width = s.kind === 'event' ? 0.3 : Math.max(((s.durationMs || 0) / totalRange) * 100, 0.3);
        const statusClass = s.status === 'error' ? ' status-error' : '';
        const depth = nestingDepth(s);
        const indent = '\\u00A0\\u00A0'.repeat(depth);
        const chip = isToolSpan(s) && typeof deriveSpanLabelHtml === 'function'
          ? deriveSpanLabelHtml(s)
          : null;
        const aiLabel = !chip && isAiSpan(s) ? aiSpanLabel(s) : null;
        const fallbackName = aiLabel || s.name;
        const labelInner = chip
          ? esc(indent) + chip.html
          : esc(indent + fallbackName);
        const labelTooltip = chip ? chip.tooltip : fallbackName;
        const collapsible = spanHasCollapsibleChildren(s.id);
        const isCollapsed = collapsedSpanIds.has(s.id);
        const toggleHtml = collapsible
          ? '<span class="waterfall-toggle" onclick="toggleCollapse(\\'' + s.id + '\\', event)" title="' +
            (isCollapsed ? 'Expand stage spans' : 'Collapse stage spans') + '">' +
            (isCollapsed ? '\\u25B8' : '\\u25BE') + '</span>'
          : '<span class="waterfall-toggle waterfall-toggle-spacer"></span>';
        const barKind = isToolSpan(s) ? 'tool' : s.kind;
        const inputLabel = isToolSpan(s) ? toolInputLabel(s.attributes && s.attributes.input) : '';
        const inputHtml = inputLabel ? '<span class="waterfall-input" title="' + esc(inputLabel) + '">' + esc(inputLabel) + '</span>' : '';
        return '<div class="waterfall-row">' +
          '<div class="waterfall-label" title="' + esc(labelTooltip) + '">' + toggleHtml + labelInner + '</div>' +
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
      const titleName = isAiSpan(span) ? aiSpanLabel(span) : span.name;
      document.getElementById('spanDetailsTitle').textContent =
        titleName + ' (' + span.kind + ', ' + span.status + ')';
      const host = document.getElementById('spanDetailsJson');
      // renderToolDetail picks the best panel for this span: v1 search trace
      // (delegates to renderSearchTrace), per-tool renderer (graph node, symbol
      // context, list_files, read_source, search_pattern), or smart generic
      // (Input + Output sections). Reset raw toggle on every span open so the
      // panel always opens in structured mode.
      if (typeof renderToolDetail === 'function') {
        if (window.__tdrState) {
          window.__tdrState.showRaw = false;
          window.__tdrState.showResponse = false;
        }
        host.innerHTML = renderToolDetail(span);
      } else {
        host.innerHTML = '<pre>' + esc(JSON.stringify(span.attributes || {}, null, 2)) + '</pre>';
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
