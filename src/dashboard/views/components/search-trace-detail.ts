/**
 * Structured renderer for a Huginn searchTrace blob (schemaVersion 1).
 *
 * The trace lives on a tool span at `attributes.searchTrace`. When the user clicks
 * a `knowledge-search_knowledge` bar in the waterfall, traces-waterfall.ts calls
 * `renderSearchTrace(trace)` to swap in this structured view instead of a raw
 * JSON dump. Schema documented in huginn/docs/search-tracing-plan.md.
 *
 * The component is server-rendered HTML + inline JS (matches the rest of the
 * dashboard view system — no framework). Rendering is pure: same input → same
 * output, no fetches.
 */

export function searchTraceDetailStyles(): string {
  return `
    /* Search trace detail panel */
    .stt-panel { display: flex; flex-direction: column; gap: 14px; }
    .stt-section h5 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin: 0 0 6px;
    }
    .stt-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

    /* Query block */
    .stt-query {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      padding: 10px 12px;
      font-size: 12px;
      color: var(--text-secondary);
    }
    .stt-query .stt-label { color: var(--text-dim); margin-right: 6px; }
    .stt-query .stt-expansion { color: var(--accent-light); text-decoration: underline dotted; }

    /* Chips */
    .stt-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
      color: var(--accent-light);
      white-space: nowrap;
    }
    .stt-chip .stt-chip-type { color: var(--text-dim); font-size: 10px; }
    .stt-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      background: color-mix(in srgb, var(--status-cyan) 15%, transparent);
      color: var(--status-cyan);
      border: 1px solid color-mix(in srgb, var(--status-cyan) 30%, transparent);
    }
    .stt-badge.stt-warn {
      background: color-mix(in srgb, var(--status-warning) 15%, transparent);
      color: var(--status-warning);
      border-color: color-mix(in srgb, var(--status-warning) 35%, transparent);
    }
    .stt-badge.stt-err {
      background: color-mix(in srgb, var(--status-error) 15%, transparent);
      color: var(--status-error);
      border-color: color-mix(in srgb, var(--status-error) 35%, transparent);
    }

    /* Stage timing strip */
    .stt-strip {
      display: flex;
      width: 100%;
      height: 22px;
      border-radius: 4px;
      overflow: hidden;
      background: var(--bg-inset);
    }
    .stt-strip-seg {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: rgba(255,255,255,0.85);
      overflow: hidden;
      white-space: nowrap;
      padding: 0 4px;
    }
    .stt-strip-legend { display: flex; gap: 12px; font-size: 11px; color: var(--text-dim); margin-top: 4px; flex-wrap: wrap; }
    .stt-strip-legend span::before { content: ''; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }

    /* Stage colors */
    .stt-stage-indexFetch { background: #4f46e5; }
    .stt-stage-chunkLoad  { background: #0ea5e9; }
    .stt-stage-rerank     { background: #f59e0b; }
    .stt-stage-titleBoost { background: #ef4444; }
    .stt-stage-assembly   { background: #10b981; }

    .stt-leg-indexFetch::before { background: #4f46e5; }
    .stt-leg-chunkLoad::before  { background: #0ea5e9; }
    .stt-leg-rerank::before     { background: #f59e0b; }
    .stt-leg-titleBoost::before { background: #ef4444; }
    .stt-leg-assembly::before   { background: #10b981; }

    /* Confidence axis */
    .stt-conf {
      position: relative;
      height: 36px;
      background: var(--bg-inset);
      border-radius: 4px;
      margin-top: 6px;
    }
    .stt-conf-best { position: absolute; top: 0; bottom: 0; width: 3px; background: var(--status-cyan); }
    .stt-conf-thr  { position: absolute; top: 4px; bottom: 4px; width: 2px; background: var(--status-warning); }
    .stt-conf-noise{ position: absolute; top: 8px; bottom: 8px; width: 2px; background: var(--text-dim); }
    .stt-conf-label { position: absolute; bottom: -16px; font-size: 10px; color: var(--text-dim); transform: translateX(-50%); }

    /* Candidates table */
    .stt-cands {
      width: 100%;
      border-collapse: collapse;
      font-size: 11px;
      margin-top: 6px;
    }
    .stt-cands th, .stt-cands td {
      text-align: left;
      padding: 4px 6px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .stt-cands th {
      color: var(--text-dim);
      font-weight: normal;
      cursor: pointer;
      user-select: none;
    }
    .stt-cands th:hover { color: var(--text-soft); }
    .stt-cands td.stt-num { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-tertiary); }
    .stt-cands td.stt-title { max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .stt-cands tr.stt-disagree td { background: color-mix(in srgb, var(--status-warning) 8%, transparent); }
    .stt-cands tr.stt-dropped td { color: var(--text-dim); }
    .stt-status-kept { color: var(--status-success); }
    .stt-status-dropped { color: var(--status-error); }

    .stt-toolbar { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
    .stt-toolbar button {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      color: var(--text-soft);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .stt-toolbar button.stt-active { color: var(--accent-light); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
    .stt-toolbar button:hover { color: var(--text-primary); }
    .stt-raw-toggle { margin-left: auto; }
  `;
}

export function searchTraceDetailScript(): string {
  return `
    const STT_STAGES = ['indexFetch','chunkLoad','rerank','titleBoost','assembly'];
    const STT_STAGE_LABELS = {
      indexFetch: 'index.fetch', chunkLoad: 'chunk.load', rerank: 'rerank.ce',
      titleBoost: 'boost.title', assembly: 'assemble',
    };

    /** State for an open searchTrace panel — sort + filter for the candidates table. */
    window.__sttState = window.__sttState || {
      sortKey: 'final', sortDir: 'asc', filter: 'kept-top', showRaw: false, trace: null,
    };

    function renderSearchTrace(trace) {
      window.__sttState.trace = trace;
      if (window.__sttState.showRaw) {
        return '<pre class="stt-raw">' + esc(JSON.stringify(trace, null, 2)) + '</pre>' +
               '<div class="stt-toolbar"><button class="stt-active" onclick="sttToggleRaw()">Show structured</button></div>';
      }
      return '<div class="stt-panel">' +
        sttRenderQuery(trace.query || {}) +
        sttRenderCollections(trace.collections || []) +
        '<div class="stt-toolbar stt-raw-toggle"><button onclick="sttToggleRaw()">Show raw JSON</button></div>' +
      '</div>';
    }

    function sttToggleRaw() {
      window.__sttState.showRaw = !window.__sttState.showRaw;
      sttRerender();
    }
    function sttSetFilter(f) {
      window.__sttState.filter = f;
      sttRerender();
    }
    function sttSetSort(key) {
      const s = window.__sttState;
      if (s.sortKey === key) s.sortDir = s.sortDir === 'asc' ? 'desc' : 'asc';
      else { s.sortKey = key; s.sortDir = 'asc'; }
      sttRerender();
    }
    function sttRerender() {
      const host = document.getElementById('spanDetailsJson');
      if (host && window.__sttState.trace) host.innerHTML = renderSearchTrace(window.__sttState.trace);
    }

    function sttRenderQuery(q) {
      const entityChips = (q.detectedEntities || []).map(e =>
        '<span class="stt-chip"><span class="stt-chip-type">' + esc(e.type || '') + '</span>' + esc(e.label || e.id || '') + '</span>'
      ).join('');
      const flags = [];
      if (q.graphAnswered === true) flags.push('<span class="stt-badge">graph answered</span>');
      if (q.rerankerSkipped === true) flags.push('<span class="stt-badge stt-warn">reranker skipped' +
        (q.rerankerSkipReason ? ': ' + esc(q.rerankerSkipReason) : '') + '</span>');
      const expandedHtml = sttHighlightExpansion(q.raw || '', q.expanded || '', q.expansionTerms || []);
      const expansionChips = (q.expansionTerms || []).map(t => '<span class="stt-chip">+ ' + esc(t) + '</span>').join('');
      return '<div class="stt-section">' +
        '<h5>Query</h5>' +
        '<div class="stt-query">' +
          '<div><span class="stt-label">raw:</span>' + esc(q.raw || '') + '</div>' +
          (q.expanded && q.expanded !== q.raw ? '<div style="margin-top:4px"><span class="stt-label">expanded:</span>' + expandedHtml + '</div>' : '') +
          (entityChips ? '<div class="stt-row" style="margin-top:8px">' + entityChips + '</div>' : '') +
          (expansionChips ? '<div class="stt-row" style="margin-top:6px">' + expansionChips + '</div>' : '') +
          (flags.length ? '<div class="stt-row" style="margin-top:8px">' + flags.join('') + '</div>' : '') +
        '</div>' +
      '</div>';
    }

    function sttHighlightExpansion(raw, expanded, terms) {
      // Render expanded with the appended expansion terms wrapped for emphasis.
      let html = esc(expanded);
      for (const t of terms || []) {
        if (!t) continue;
        const re = new RegExp('(' + t.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&') + ')', 'g');
        html = html.replace(re, '<span class="stt-expansion">$1</span>');
      }
      return html;
    }

    function sttRenderCollections(collections) {
      if (!collections.length) return '';
      return collections.map((c, i) => sttRenderCollection(c, i)).join('');
    }

    function sttRenderCollection(c, idx) {
      const timings = c.timingsMs || {};
      const total = STT_STAGES.reduce((s, k) => s + (timings[k] > 0 ? timings[k] : 0), 0) || timings.total || 0;
      const stripSegs = STT_STAGES.filter(k => timings[k] > 0).map(k => {
        const pct = total > 0 ? (timings[k] / total) * 100 : 0;
        return '<div class="stt-strip-seg stt-stage-' + k + '" style="width:' + pct + '%" title="' + STT_STAGE_LABELS[k] + ' — ' + timings[k] + 'ms">' +
          (pct > 8 ? STT_STAGE_LABELS[k] + ' ' + timings[k] + 'ms' : '') +
        '</div>';
      }).join('');
      const legend = STT_STAGES.filter(k => timings[k] > 0).map(k =>
        '<span class="stt-leg-' + k + '">' + STT_STAGE_LABELS[k] + ' ' + timings[k] + 'ms</span>'
      ).join('');

      const conf = c.confidence || {};
      const confBlock = sttRenderConfidence(conf);
      const candTable = sttRenderCandidates(c.candidates || []);

      return '<div class="stt-section">' +
        '<h5>Collection — ' + esc(c.name || '?') + ' <span style="color:var(--text-faint);font-weight:normal;text-transform:none;letter-spacing:0">' +
          (c.indexer ? 'indexer=' + esc(c.indexer) : '') +
          (c.fetchK != null ? ' · fetchK=' + c.fetchK : '') +
          ' · candidates=' + (c.candidates || []).length +
          ' · ' + (timings.total != null ? timings.total + 'ms' : total + 'ms') +
        '</span></h5>' +
        '<div class="stt-strip">' + stripSegs + '</div>' +
        (legend ? '<div class="stt-strip-legend">' + legend + '</div>' : '') +
        confBlock +
        candTable +
      '</div>';
    }

    function sttRenderConfidence(conf) {
      if (!conf || conf.bestScore == null) return '';
      const best = conf.bestScore;
      const lcThr = conf.lowConfidenceThreshold;
      const nsThr = conf.noiseThreshold;
      // Map score range to 0..100 using min/max of the three values plus padding.
      const vals = [best, lcThr, nsThr].filter(v => typeof v === 'number');
      const lo = Math.min.apply(null, vals.concat([best - 0.2]));
      const hi = Math.max.apply(null, vals.concat([best + 0.2]));
      const range = hi - lo || 1;
      const pos = v => ((v - lo) / range) * 100;
      const lowBadge = conf.lowConfidence
        ? '<span class="stt-badge stt-err">low confidence</span>'
        : '<span class="stt-badge">confident</span>';
      const filt = conf.filteredCount != null && conf.filteredCount > 0
        ? '<span class="stt-badge stt-warn">' + conf.filteredCount + ' filtered</span>'
        : '';
      return '<div style="margin-top:10px">' +
        '<div class="stt-row">' + lowBadge + filt +
          '<span style="color:var(--text-dim);font-size:11px;margin-left:8px">best=' + best.toFixed(3) +
          (lcThr != null ? ', lowConfThr=' + lcThr : '') +
          (nsThr != null ? ', noiseThr=' + nsThr : '') + '</span>' +
        '</div>' +
        '<div class="stt-conf">' +
          (lcThr != null ? '<div class="stt-conf-thr"   style="left:' + pos(lcThr) + '%" title="lowConfThr=' + lcThr + '"></div>' : '') +
          (nsThr != null ? '<div class="stt-conf-noise" style="left:' + pos(nsThr) + '%" title="noiseThr=' + nsThr + '"></div>' : '') +
          '<div class="stt-conf-best"  style="left:' + pos(best) + '%" title="best=' + best.toFixed(3) + '"></div>' +
        '</div>' +
      '</div>';
    }

    function sttRenderCandidates(cands) {
      if (!cands.length) return '';
      const s = window.__sttState;
      const filtered = sttFilterCandidates(cands, s.filter);
      const sorted = sttSortCandidates(filtered, s.sortKey, s.sortDir);

      const filterBtn = (key, label) =>
        '<button class="' + (s.filter === key ? 'stt-active' : '') + '" onclick="sttSetFilter(\\'' + key + '\\')">' + label + '</button>';

      const header = '<thead><tr>' +
        ['#','title','FAISS','BM25','RRF','CE','Δboost','final','status'].map((h, i) => {
          const keys = [null,'title','faiss','bm25','rrf','ce','titleBoost','final','status'];
          const key = keys[i];
          const arrow = (key && s.sortKey === key) ? (s.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
          if (!key) return '<th>' + h + '</th>';
          return '<th onclick="sttSetSort(\\'' + key + '\\')">' + h + arrow + '</th>';
        }).join('') +
      '</tr></thead>';

      const rows = sorted.map((c, i) => {
        const stages = c.stages || {};
        const final = stages.final || {};
        const ce = stages.ce || {};
        const rrf = stages.rrf || {};
        const tb = stages.titleBoost || {};
        const disagree = (typeof rrf.rank === 'number' && typeof ce.rank === 'number' &&
                         Math.abs(rrf.rank - ce.rank) >= 10);
        const dropped = c.kept === false;
        const cls = (disagree ? 'stt-disagree ' : '') + (dropped ? 'stt-dropped' : '');
        const status = dropped
          ? '<span class="stt-status-dropped">drop' + (c.dropReason ? ': ' + esc(c.dropReason) : '') + '</span>'
          : '<span class="stt-status-kept">kept</span>';
        return '<tr class="' + cls + '">' +
          '<td class="stt-num">' + (i + 1) + '</td>' +
          '<td class="stt-title" title="' + esc(c.docTitle || c.documentId || '') + '">' + esc(c.docTitle || c.documentId || '') + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.faiss) + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.bm25) + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.rrf) + '</td>' +
          '<td class="stt-num">' + sttFmtRank(ce) + '</td>' +
          '<td class="stt-num">' + (tb.applied ? (typeof tb.delta === 'number' ? tb.delta.toFixed(2) : '✓') : '—') + '</td>' +
          '<td class="stt-num">' + sttFmtRank(final) + '</td>' +
          '<td>' + status + '</td>' +
        '</tr>';
      }).join('');

      return '<div style="margin-top:12px">' +
        '<div class="stt-toolbar">' +
          '<span>Candidates (' + filtered.length + '/' + cands.length + ')</span>' +
          filterBtn('kept-top', 'top 20 kept') +
          filterBtn('kept', 'all kept') +
          filterBtn('dropped', 'dropped only') +
          filterBtn('all', 'all') +
        '</div>' +
        '<table class="stt-cands">' + header + '<tbody>' + rows + '</tbody></table>' +
      '</div>';
    }

    function sttFmtRank(stage) {
      if (!stage || stage.rank == null) return '—';
      return stage.rank + (typeof stage.score === 'number' ? ' (' + stage.score.toFixed(2) + ')' : '');
    }

    function sttFilterCandidates(cands, mode) {
      if (mode === 'kept') return cands.filter(c => c.kept !== false);
      if (mode === 'dropped') return cands.filter(c => c.kept === false);
      if (mode === 'kept-top') return cands.filter(c => c.kept !== false).slice(0, 20);
      return cands;
    }

    function sttSortCandidates(cands, key, dir) {
      const mul = dir === 'asc' ? 1 : -1;
      const valFor = (c) => {
        if (key === 'title') return (c.docTitle || c.documentId || '').toLowerCase();
        if (key === 'titleBoost') {
          const tb = c.stages && c.stages.titleBoost;
          return tb && typeof tb.delta === 'number' ? tb.delta : Infinity;
        }
        if (key === 'status') return c.kept === false ? 1 : 0;
        const stage = c.stages && c.stages[key];
        return stage && typeof stage.rank === 'number' ? stage.rank : Infinity;
      };
      return cands.slice().sort((a, b) => {
        const va = valFor(a), vb = valFor(b);
        if (va < vb) return -1 * mul;
        if (va > vb) return 1 * mul;
        return 0;
      });
    }
  `;
}
