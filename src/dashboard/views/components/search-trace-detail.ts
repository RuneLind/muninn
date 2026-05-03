import { STAGE_KEYS, STAGE_NAMES } from "../../../core/search-trace-spans.ts";

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
    /* Marker on entity chips that were also re-injected as expansion terms.
       Replaces the separate "+ X" duplicate chip — hover the chip for details. */
    .stt-chip .stt-chip-plus {
      margin-left: 4px;
      padding: 0 4px;
      font-size: 10px;
      color: var(--accent-light);
      border-left: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
    }
    .stt-chip-reinjected {
      background: color-mix(in srgb, var(--accent) 18%, transparent);
    }
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

    /* Stage colors — huginn */
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

    /* Stage colors — yggdrasil */
    .stt-stage-embedding { background: #6366f1; }
    .stt-stage-fts       { background: #0ea5e9; }
    .stt-stage-semantic  { background: #8b5cf6; }
    .stt-stage-name      { background: #f59e0b; }
    .stt-stage-rrf       { background: #10b981; }

    .stt-leg-embedding::before { background: #6366f1; }
    .stt-leg-fts::before       { background: #0ea5e9; }
    .stt-leg-semantic::before  { background: #8b5cf6; }
    .stt-leg-name::before      { background: #f59e0b; }
    .stt-leg-rrf::before       { background: #10b981; }

    /* Confidence axis. Reserve room below the bar for inline marker labels
       so they don't overlap the axis row underneath. */
    .stt-conf {
      position: relative;
      height: 36px;
      background: var(--bg-inset);
      border-radius: 4px;
      margin-top: 6px;
      margin-bottom: 22px;
    }
    .stt-conf-best { position: absolute; top: 0; bottom: 0; width: 3px; background: var(--status-cyan); }
    .stt-conf-thr  { position: absolute; top: 4px; bottom: 4px; width: 2px; background: var(--status-warning); }
    .stt-conf-noise{ position: absolute; top: 8px; bottom: 8px; width: 2px; background: var(--text-dim); }
    /* Inline marker labels — sit just under the bar, anchored to the marker.
       translateX(-50%) centers under the line; left/right edge variants flip
       the anchor so labels at 0% / 100% don't overflow the bar. */
    .stt-conf-mark-label {
      position: absolute;
      top: 38px;
      font-size: 10px;
      color: var(--text-dim);
      transform: translateX(-50%);
      white-space: nowrap;
      pointer-events: none;
    }
    .stt-conf-mark-label.stt-anchor-left  { transform: translateX(0); }
    .stt-conf-mark-label.stt-anchor-right { transform: translateX(-100%); }
    .stt-conf-mark-label.stt-mk-best  { color: var(--status-cyan); }
    .stt-conf-mark-label.stt-mk-thr   { color: var(--status-warning); }
    .stt-conf-mark-label.stt-mk-noise { color: var(--text-soft); }
    /* Vertical stack offset when two thresholds collide (lowConfThr == noiseThr) —
       move the second label down a row so they don't write over each other. */
    .stt-conf-mark-label.stt-stack-1 { top: 52px; }
    .stt-conf-label { position: absolute; bottom: -16px; font-size: 10px; color: var(--text-dim); transform: translateX(-50%); }
    /* Plain-English interpretation sentence under the legend. */
    .stt-conf-summary {
      font-size: 11px;
      color: var(--text-soft);
      margin-top: 6px;
      line-height: 1.4;
    }
    .stt-conf-summary.stt-good { color: var(--status-success); }
    .stt-conf-summary.stt-bad  { color: var(--status-error); }
    .stt-conf-summary .stt-margin { color: var(--text-dim); font-variant-numeric: tabular-nums; }
    .stt-conf-legend {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      font-size: 10px;
      color: var(--text-dim);
      margin-top: 4px;
    }
    .stt-conf-legend span::before {
      content: '';
      display: inline-block;
      width: 8px;
      height: 8px;
      margin-right: 4px;
      vertical-align: middle;
      border-radius: 1px;
    }
    .stt-conf-leg-best::before  { background: var(--status-cyan); }
    .stt-conf-leg-thr::before   { background: var(--status-warning); }
    .stt-conf-leg-noise::before { background: var(--text-dim); }

    /* Inline help icon — tooltip-only, no popover */
    .stt-help {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      border: 1px solid var(--border-primary);
      color: var(--text-dim);
      font-size: 9px;
      font-weight: 600;
      cursor: help;
      margin-left: 6px;
      user-select: none;
    }
    .stt-help:hover { color: var(--text-soft); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }


    /* Candidates table — wrapper allows horizontal scroll when the panel is
       too narrow for all 9 columns (rank stages + Δboost + status). */
    .stt-cands-wrap {
      width: 100%;
      overflow-x: auto;
      margin-top: 6px;
    }
    .stt-cands {
      border-collapse: collapse;
      font-size: 11px;
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
    .stt-cands td.stt-sym {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      color: var(--text-faint);
      font-size: 10px;
    }
    .stt-cands tr.stt-disagree td { background: color-mix(in srgb, var(--status-warning) 8%, transparent); }
    .stt-cands tr.stt-dropped td { color: var(--text-dim); }
    .stt-status-kept { color: var(--status-success); }
    .stt-status-dropped { color: var(--status-error); }
    .stt-qf {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      color: var(--text-soft);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      min-width: 200px;
    }
    .stt-qf:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 40%, transparent); }

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
    const STT_STAGES = ${JSON.stringify(STAGE_KEYS)};
    const STT_STAGE_LABELS = ${JSON.stringify(STAGE_NAMES)};

    /** State for an open searchTrace panel — sort + filter for the candidates table. */
    window.__sttState = window.__sttState || {
      sortKey: 'final', sortDir: 'asc', filter: 'kept-top', showRaw: false, trace: null,
    };

    function renderSearchTrace(trace) {
      // New trace identity → reset sort/filter/qFilter so leftover state from
      // the previous span (which may have been a different shape) doesn't
      // silently flip ordering or hide rows.
      if (window.__sttState.trace !== trace) {
        window.__sttState.sortKey = 'final';
        window.__sttState.sortDir = 'asc';
        window.__sttState.filter = 'kept-top';
        window.__sttState.qFilter = '';
        window.__sttState.trace = trace;
      }
      if (window.__sttState.showRaw) {
        return '<pre class="stt-raw">' + esc(JSON.stringify(trace, null, 2)) + '</pre>' +
               '<div class="stt-toolbar"><button class="stt-active" onclick="sttToggleRaw()">Show structured</button></div>';
      }
      if (sttIsYggdrasilTrace(trace)) {
        return sttRenderYggdrasilPanel(trace);
      }
      return '<div class="stt-panel">' +
        sttRenderQuery(trace.query || {}) +
        sttRenderCollections(trace.collections || []) +
        '<div class="stt-toolbar stt-raw-toggle"><button onclick="sttToggleRaw()">Show raw JSON</button></div>' +
      '</div>';
    }

    function sttIsYggdrasilTrace(trace) {
      return !!(trace && typeof trace.tool === 'string' &&
                !Array.isArray(trace.collections) &&
                Array.isArray(trace.candidates));
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
      const entities = q.detectedEntities || [];
      const expansionTerms = q.expansionTerms || [];
      // Build a case-insensitive set of expansion terms so we can mark entity
      // chips that were also re-injected as expansion terms — and drop the
      // duplicate "+ X" chip below. Same-text-different-case treated as same.
      const expSet = new Set();
      for (const t of expansionTerms) {
        if (typeof t === 'string') expSet.add(t.toLowerCase());
      }
      const entitySet = new Set();
      for (const e of entities) {
        const lbl = e && (e.label || e.id);
        if (typeof lbl === 'string') entitySet.add(lbl.toLowerCase());
      }

      const entityBaseTip = 'Detected as a graph entity in the raw query — used for graph-aware retrieval and graph context enrichment.';
      const entityReinjectedTip = entityBaseTip + ' Also re-injected into the query as an expansion term (see the "+" marker).';
      const entityChips = entities.map(e => {
        const lbl = e.label || e.id || '';
        const reinjected = typeof lbl === 'string' && expSet.has(lbl.toLowerCase());
        const cls = reinjected ? 'stt-chip stt-chip-reinjected' : 'stt-chip';
        const tip = reinjected ? entityReinjectedTip : entityBaseTip;
        const titleAttr = ' title="' + esc(tip) + '"';
        const plus = reinjected ? '<span class="stt-chip-plus" aria-hidden="true">+</span>' : '';
        return '<span class="' + cls + '"' + titleAttr + '>' +
          '<span class="stt-chip-type">' + esc(e.type || '') + '</span>' + esc(lbl) + plus +
        '</span>';
      }).join('');

      const flags = [];
      if (q.graphAnswered === true) flags.push('<span class="stt-badge">graph answered</span>');
      if (q.rerankerSkipped === true) flags.push('<span class="stt-badge stt-warn">reranker skipped' +
        (q.rerankerSkipReason ? ': ' + esc(q.rerankerSkipReason) : '') + '</span>');
      // Pass entity labels in too so a substring expansion term doesn't
      // chew into a longer entity that wasn't itself in the expansion list
      // (e.g. "EØS" matching inside "EU/EØS" — EU/EØS is a Concept entity
      // but not always in expansionTerms). Exclude entities that ARE in
      // expansionTerms — otherwise they'd block their own standalone
      // occurrence from being highlighted.
      const blockSpans = entities
        .map(e => (e && (e.label || e.id)) || '')
        .filter(s => typeof s === 'string' && s.length > 0 && !expSet.has(s.toLowerCase()));
      const expandedHtml = sttHighlightExpansion(q.expanded || '', expansionTerms, blockSpans);
      // Hide "+ X" chips for terms that already show up as entity chips above —
      // those chips already carry the "+" indicator. Reduces visual triplication
      // (entity + plus-chip + highlighted-in-expanded → entity-with-plus-marker).
      const remainingExpansion = expansionTerms.filter(t =>
        typeof t === 'string' && !entitySet.has(t.toLowerCase())
      );
      const expansionTip = 'Expansion term appended to the raw query before retrieval. Comes from graph expansion of detected entities (synonyms, related concepts, and tag co-occurrence).';
      const expansionChips = remainingExpansion.map(t =>
        '<span class="stt-chip" title="' + esc(expansionTip) + '">+ ' + esc(t) + '</span>'
      ).join('');
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

    /** Wrap appended expansion terms in <span class="stt-expansion"> for visual
     *  emphasis. Three pitfalls handled here:
     *    1. Substring matches inside an expansion term: e.g. "EØS" naively
     *       matched inside "EU/EØS" when both are in the expansion list. Sort
     *       longer-first and skip ranges that overlap an already-wrapped span.
     *    2. Substring matches inside a detected entity that isn't itself in
     *       the expansion list: same problem, but the longer "EU/EØS" comes
     *       from blockSpans (entity labels) instead. We claim those ranges
     *       up front without wrapping them — they just block.
     *    3. Word-boundary on Unicode: \\b doesn't fire around "Ø" / "æ", so
     *       we avoid \\b entirely and require a non-letter neighbor on each
     *       side (or string edge), defined as anything outside the Unicode
     *       letter class. */
    function sttHighlightExpansion(expanded, terms, blockSpans) {
      const escaped = esc(expanded);
      if ((!terms || terms.length === 0) && (!blockSpans || blockSpans.length === 0)) return escaped;
      // Longer-first so "EU/EØS" matches before "EØS" can chew into it.
      const sortedTerms = (terms || [])
        .filter(t => typeof t === 'string' && t.length > 0)
        .slice()
        .sort(function (a, b) { return b.length - a.length; });
      const sortedBlocks = (blockSpans || [])
        .filter(t => typeof t === 'string' && t.length > 0)
        .slice()
        .sort(function (a, b) { return b.length - a.length; });
      // Two parallel span lists. "wrapped" ones get a <span> around them in
      // the final pass; "blocked" ones don't render anything but still reserve
      // their range so substring matches can't claim them.
      const wrapped = [];
      const blocked = [];
      const overlapsAny = function (start, end, list) {
        for (let i = 0; i < list.length; i++) {
          if (start < list[i].end && end > list[i].start) return true;
        }
        return false;
      };
      const isLetter = function (ch) {
        if (!ch) return false;
        return /\\p{L}/u.test(ch);
      };
      const claim = function (term, list, alsoBlockedBy) {
        const escTerm = esc(term).replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        const re = new RegExp(escTerm, 'g');
        let m;
        while ((m = re.exec(escaped)) !== null) {
          const start = m.index;
          const end = start + m[0].length;
          const before = start > 0 ? escaped.charAt(start - 1) : '';
          const after = end < escaped.length ? escaped.charAt(end) : '';
          if (isLetter(before) || isLetter(after)) continue;
          if (overlapsAny(start, end, list)) continue;
          if (alsoBlockedBy && overlapsAny(start, end, alsoBlockedBy)) continue;
          list.push({ start: start, end: end });
        }
      };
      // Block longer entity labels first so they reserve their ranges before
      // the (potentially shorter) expansion terms try to claim subranges.
      for (const t of sortedBlocks) claim(t, blocked, null);
      for (const t of sortedTerms) claim(t, wrapped, blocked);
      if (wrapped.length === 0) return escaped;
      wrapped.sort(function (a, b) { return a.start - b.start; });
      // Same wording as the "+ X" chip tooltip — these underlines are the
      // very same expansion terms shown in their query position.
      const wrapTip = 'Expansion term appended to the raw query before retrieval. Comes from graph expansion of detected entities.';
      const titleAttr = ' title="' + esc(wrapTip) + '"';
      let out = '';
      let cursor = 0;
      for (const s of wrapped) {
        out += escaped.slice(cursor, s.start) +
               '<span class="stt-expansion"' + titleAttr + '>' + escaped.slice(s.start, s.end) + '</span>';
        cursor = s.end;
      }
      out += escaped.slice(cursor);
      return out;
    }

    function sttRenderCollections(collections) {
      if (!collections.length) return '';
      return collections.map((c, i) => sttRenderCollection(c, i)).join('');
    }

    function sttBuildTimingsStrip(timings, keys, labels) {
      let sum = 0;
      for (const k of keys) if (timings[k] > 0) sum += timings[k];
      const total = sum || timings.total || 0;
      let segs = '';
      let legend = '';
      for (const k of keys) {
        const ms = timings[k];
        if (!(ms > 0)) continue;
        const pct = total > 0 ? (ms / total) * 100 : 0;
        segs += '<div class="stt-strip-seg stt-stage-' + k + '" style="width:' + pct + '%" title="' + labels[k] + ' — ' + ms + 'ms">' +
          (pct > 8 ? labels[k] + ' ' + ms + 'ms' : '') + '</div>';
        legend += '<span class="stt-leg-' + k + '">' + labels[k] + ' ' + ms + 'ms</span>';
      }
      return { segs, legend, total };
    }

    function sttRenderCollection(c, idx) {
      const timings = c.timingsMs || {};
      const strip = sttBuildTimingsStrip(timings, STT_STAGES, STT_STAGE_LABELS);

      const conf = c.confidence || {};
      const confBlock = sttRenderConfidence(conf);
      const candTable = sttRenderCandidates(c.candidates || []);

      return '<div class="stt-section">' +
        '<h5>Collection — ' + esc(c.name || '?') + ' <span style="color:var(--text-faint);font-weight:normal;text-transform:none;letter-spacing:0">' +
          (c.indexer ? 'indexer=' + esc(c.indexer) : '') +
          (c.fetchK != null ? ' · fetchK=' + c.fetchK : '') +
          ' · candidates=' + (c.candidates || []).length +
          ' · ' + (timings.total != null ? timings.total + 'ms' : strip.total + 'ms') +
        '</span></h5>' +
        '<div class="stt-strip">' + strip.segs + '</div>' +
        (strip.legend ? '<div class="stt-strip-legend">' + strip.legend + '</div>' : '') +
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

      // Sign convention: CE scores are negative-distance-like — more negative
      // means more relevant. So lowConfidence = bestScore > threshold (less
      // negative than the cutoff). The badge tooltip explains this so a reader
      // who hovers the badge doesn't have to chase the wiki.
      const badgeTip = conf.lowConfidence
        ? 'lowConfidence=true: best score (' + best.toFixed(3) + ') is greater than (less negative than) the threshold (' + (lcThr != null ? lcThr : '?') + '). CE scores: more negative = more relevant.'
        : 'lowConfidence=false: best score (' + best.toFixed(3) + ') is less than (more negative than) the threshold (' + (lcThr != null ? lcThr : '?') + '). CE scores: more negative = more relevant.';
      const lowBadge = conf.lowConfidence
        ? '<span class="stt-badge stt-err" title="' + esc(badgeTip) + '">low confidence</span>'
        : '<span class="stt-badge" title="' + esc(badgeTip) + '">confident</span>';
      const filtTip = 'Documents whose best chunk score was greater than (less negative than) noiseThreshold and got dropped from the response.';
      const filt = conf.filteredCount != null && conf.filteredCount > 0
        ? '<span class="stt-badge stt-warn" title="' + esc(filtTip) + '">' + conf.filteredCount + ' filtered</span>'
        : '';

      const helpTip = [
        'Confidence axis — interpreting the markers',
        '',
        'CE scores are negative; more negative = more relevant (treat them like a distance, lower is better).',
        '',
        'best = best CE score across surviving documents (per-doc score = min over chunks).',
        'noiseThr = drop docs with best chunk score > noiseThr.',
        'lowConfThr = flag the whole result as low-confidence if best surviving score > lowConfThr.',
        '',
        'On the bar: "best" left of the thresholds = good; right of them = drop / low confidence.',
      ].join('\\n');

      // One descriptor per marker — drives the legend, the inline label under
      // the bar, and the marker's own hover tooltip from a single source.
      // When lowConfThr and noiseThr land on top of each other (the common
      // case when both are -0.1), push the second label one row down so they
      // don't render on top of each other.
      const sameThr = (lcThr != null && nsThr != null && Math.abs(lcThr - nsThr) < 1e-9);
      const markers = [
        { kind: 'best', value: best, displayValue: best.toFixed(2), legendValue: best.toFixed(3),
          label: 'best', tip: 'best CE score = ' + best.toFixed(3) + ' (lower / more negative = more relevant)' },
      ];
      if (lcThr != null) markers.push({ kind: 'thr', value: lcThr, displayValue: lcThr, legendValue: lcThr,
        label: 'lowConfThr', tip: 'lowConfidenceThreshold = ' + lcThr + ' — flag low-confidence if best score is greater than (less negative than) this' });
      if (nsThr != null) markers.push({ kind: 'noise', value: nsThr, displayValue: nsThr, legendValue: nsThr,
        label: 'noiseThr', tip: 'noiseThreshold = ' + nsThr + ' — drop docs whose best chunk score is greater than (less negative than) this',
        stackBelow: sameThr });

      // Anchor inline marker labels so they don't overflow the bar at the edges.
      // < 5%  → align to the marker's left edge; > 95% → align to the right edge;
      // otherwise center under the line.
      const anchorClass = (p) => p < 5 ? ' stt-anchor-left' : (p > 95 ? ' stt-anchor-right' : '');

      const legend = markers.map(m =>
        '<span class="stt-conf-leg-' + m.kind + '" title="' + esc(m.tip) + '">' +
          m.label + ' ' + m.legendValue +
        '</span>'
      ).join('');

      const inlineLabels = markers.map(m =>
        '<div class="stt-conf-mark-label stt-mk-' + m.kind + anchorClass(pos(m.value)) +
          (m.stackBelow ? ' stt-stack-1' : '') +
        '" style="left:' + pos(m.value) + '%">' + m.label + ' ' + m.displayValue + '</div>'
      ).join('');

      // Plain-English interpretation. Pick the threshold to compare against:
      // prefer lowConfThr (it's what flips the badge), fall back to noiseThr.
      const cmpThr = lcThr != null ? lcThr : nsThr;
      let summaryHtml = '';
      if (cmpThr != null) {
        const margin = cmpThr - best; // positive when best is more negative than threshold
        const marginAbs = Math.abs(margin).toFixed(3);
        const filteredNote = (conf.filteredCount != null && conf.filteredCount > 0)
          ? ' — ' + conf.filteredCount + ' candidate' + (conf.filteredCount === 1 ? '' : 's') + ' dropped at the noise cutoff'
          : ' — no noise filtering';
        if (margin > 0) {
          // best is more negative than threshold → confident
          const strength = margin > 1 ? 'strong match' : (margin > 0.3 ? 'solid match' : 'borderline match');
          summaryHtml = '<div class="stt-conf-summary stt-good">' +
            esc(strength) + ' — best score <span class="stt-margin">' + marginAbs +
            '</span> below the cutoff' + esc(filteredNote) + '.</div>';
        } else if (margin < 0) {
          summaryHtml = '<div class="stt-conf-summary stt-bad">' +
            'weak match — best score <span class="stt-margin">' + marginAbs +
            '</span> above the cutoff (flagged as low confidence)' + esc(filteredNote) + '.</div>';
        } else {
          summaryHtml = '<div class="stt-conf-summary">' +
            'best score sits exactly at the cutoff' + esc(filteredNote) + '.</div>';
        }
      }

      return '<div style="margin-top:10px">' +
        '<div class="stt-row">' + lowBadge + filt +
          '<span class="stt-help" title="' + esc(helpTip) + '">?</span>' +
          '<span style="color:var(--text-dim);font-size:11px;margin-left:8px">best=' + best.toFixed(3) +
          (lcThr != null ? ', lowConfThr=' + lcThr : '') +
          (nsThr != null ? ', noiseThr=' + nsThr : '') + '</span>' +
        '</div>' +
        '<div class="stt-conf">' +
          markers.map(m =>
            '<div class="stt-conf-' + m.kind + '" style="left:' + pos(m.value) + '%" title="' + esc(m.tip) + '"></div>'
          ).join('') +
          inlineLabels +
        '</div>' +
        '<div class="stt-conf-legend">' + legend + '</div>' +
        summaryHtml +
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
        '<div class="stt-cands-wrap"><table class="stt-cands">' + header + '<tbody>' + rows + '</tbody></table></div>' +
      '</div>';
    }

    function sttFmtRank(stage) {
      if (!stage || stage.rank == null) return '—';
      // yggdrasil emits name.score as a string ("1.0") in some cases —
      // coerce before formatting so the cell doesn't render "undefined".
      var n = null;
      if (typeof stage.score === 'number' && isFinite(stage.score)) n = stage.score;
      else if (typeof stage.score === 'string') {
        var parsed = parseFloat(stage.score);
        if (isFinite(parsed)) n = parsed;
      }
      return stage.rank + (n != null ? ' (' + n.toFixed(2) + ')' : '');
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

    /* --- Yggdrasil branch (code-intelligence search) ---------------------- */

    const STT_YGG_STAGES = ['fts','semantic','name','rrf','final'];
    const STT_YGG_TIMING_KEYS = ['embedding','fts','semantic','name','rrf'];
    const STT_YGG_SORT_KEYS = STT_YGG_STAGES.concat(['qualifiedName','kind']);
    const STT_YGG_LABELS = {
      embedding: 'embed', fts: 'FTS', semantic: 'semantic',
      name: 'name', rrf: 'RRF', final: 'final',
    };

    function sttRenderYggdrasilPanel(trace) {
      return '<div class="stt-panel">' +
        sttRenderYggHeader(trace.query || {}) +
        sttRenderYggTimings(trace.timingsMs || {}) +
        sttRenderYggCandidates(trace.candidates || []) +
        '<div class="stt-toolbar stt-raw-toggle"><button onclick="sttToggleRaw()">Show raw JSON</button></div>' +
      '</div>';
    }

    function sttRenderYggHeader(q) {
      var filterChips = '';
      if (q.filters && typeof q.filters === 'object') {
        var keys = Object.keys(q.filters);
        for (var i = 0; i < keys.length; i++) {
          var v = q.filters[keys[i]];
          if (v == null) continue;
          filterChips += '<span class="stt-chip"><span class="stt-chip-type">' +
            esc(keys[i]) + '</span>' + esc(String(v)) + '</span>';
        }
      }
      return '<div class="stt-section">' +
        '<h5>Query <span class="stt-badge">tool: search</span></h5>' +
        '<div class="stt-query">' +
          '<div><span class="stt-label">raw:</span>' + esc(q.raw || '') + '</div>' +
          (filterChips ? '<div class="stt-row" style="margin-top:8px">' + filterChips + '</div>' : '') +
        '</div>' +
      '</div>';
    }

    function sttRenderYggTimings(timings) {
      const strip = sttBuildTimingsStrip(timings, STT_YGG_TIMING_KEYS, STT_YGG_LABELS);
      if (!strip.segs) return '';
      const totalLabel = timings.total != null ? timings.total : strip.total;
      return '<div class="stt-section">' +
        '<h5>Timings <span style="color:var(--text-faint);font-weight:normal;text-transform:none;letter-spacing:0">total=' + totalLabel + 'ms</span></h5>' +
        '<div class="stt-strip">' + strip.segs + '</div>' +
        (strip.legend ? '<div class="stt-strip-legend">' + strip.legend + '</div>' : '') +
      '</div>';
    }

    function sttRenderYggCandidates(cands) {
      if (!cands.length) return '';
      const s = window.__sttState;
      const qf = ((s.qFilter || '') + '').trim().toLowerCase();
      let filtered = cands;
      if (qf) {
        filtered = cands.filter(c => (c.qualifiedName || '').toLowerCase().indexOf(qf) !== -1);
      }
      const visible = s.filter === 'all'
        ? filtered.slice()
        : filtered.filter(c => c.stages && c.stages.final).slice(0, 20);

      const sortKey = STT_YGG_SORT_KEYS.indexOf(s.sortKey) !== -1 ? s.sortKey : 'final';
      const mul = s.sortDir === 'asc' ? 1 : -1;
      const valFor = (c) => {
        if (sortKey === 'qualifiedName') return (c.qualifiedName || '').toLowerCase();
        if (sortKey === 'kind') return c.kind || '';
        const stage = c.stages && c.stages[sortKey];
        return stage && typeof stage.rank === 'number' ? stage.rank : Infinity;
      };
      visible.sort((a, b) => {
        const va = valFor(a), vb = valFor(b);
        if (va < vb) return -1 * mul;
        if (va > vb) return 1 * mul;
        return 0;
      });

      const cols = [
        { key: null,            label: '#'             },
        { key: null,            label: 'symbol'        },
        { key: 'qualifiedName', label: 'qualifiedName' },
        { key: 'kind',          label: 'kind'          },
        { key: 'fts',           label: 'FTS'           },
        { key: 'semantic',      label: 'semantic'      },
        { key: 'name',          label: 'name'          },
        { key: 'rrf',           label: 'RRF'           },
        { key: 'final',         label: 'final'         },
      ];
      const header = '<thead><tr>' + cols.map(col => {
        if (!col.key) return '<th>' + esc(col.label) + '</th>';
        const arrow = s.sortKey === col.key ? (s.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
        return '<th onclick="sttSetSort(\\'' + col.key + '\\')">' + esc(col.label) + arrow + '</th>';
      }).join('') + '</tr></thead>';

      const rows = visible.map((c, i) => {
        const stages = c.stages || {};
        const symEsc = esc(c.symbolId || '');
        const qnEsc = esc(c.qualifiedName || '');
        const sym = c.symbolId ? c.symbolId.slice(0, 8) : '';
        return '<tr>' +
          '<td class="stt-num">' + (i + 1) + '</td>' +
          '<td class="stt-sym" title="' + symEsc + '">' + esc(sym) + '</td>' +
          '<td class="stt-title" title="' + qnEsc + '">' + qnEsc + '</td>' +
          '<td>' + (c.kind ? '<span class="stt-chip">' + esc(c.kind) + '</span>' : '') + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.fts) + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.semantic) + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.name) + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.rrf) + '</td>' +
          '<td class="stt-num">' + sttFmtRank(stages.final) + '</td>' +
        '</tr>';
      }).join('');

      const btn = (key, label) =>
        '<button class="' + (s.filter === key ? 'stt-active' : '') +
        '" onclick="sttSetFilter(\\'' + key + '\\')">' + label + '</button>';
      return '<div style="margin-top:12px">' +
        '<div class="stt-toolbar">' +
          '<span>Candidates (' + visible.length + '/' + cands.length + ')</span>' +
          btn('kept-top', 'top 20 final') +
          btn('all', 'all') +
          '<input class="stt-qf" type="text" placeholder="filter qualifiedName…" value="' + esc(s.qFilter || '') + '" oninput="sttSetQFilter(this.value)">' +
        '</div>' +
        '<div class="stt-cands-wrap"><table class="stt-cands">' + header + '<tbody>' + rows + '</tbody></table></div>' +
      '</div>';
    }

    function sttSetQFilter(v) {
      // Capture caret position before sttRerender swaps innerHTML — otherwise
      // the cursor jumps to the end on every keystroke and editing mid-string
      // becomes impossible.
      const prev = document.querySelector('.stt-qf');
      const start = prev ? prev.selectionStart : null;
      const end = prev ? prev.selectionEnd : null;
      window.__sttState.qFilter = v;
      sttRerender();
      const next = document.querySelector('.stt-qf');
      if (next) {
        next.focus();
        if (start != null && end != null) {
          try { next.setSelectionRange(start, end); } catch (e) {}
        }
      }
    }
  `;
}
