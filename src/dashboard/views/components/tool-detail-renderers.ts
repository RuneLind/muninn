/**
 * Per-tool detail renderers for the trace waterfall right-side panel.
 *
 * Dispatched from traces-waterfall.ts via `renderToolDetail(span)`. Order:
 *   1. v1 search trace (Huginn/Yggdrasil search) — delegated to renderSearchTrace
 *   2. Tool-specific renderers picked by toolName regex
 *   3. Smart generic fallback (Input + Output sections, raw JSON toggle)
 *
 * All renderers are pure: same attrs in → same HTML out. State for the raw
 * toggle lives on `window.__tdrState`.
 *
 * Adding a new renderer:
 *   - Define `function tdrRenderMyTool(attrs) { return tdrPanel(...); }`
 *   - Add a regex entry to the dispatcher in `tdrPickRenderer`
 *   - Use the helpers (`tdrPanel`, `tdrSection`, `tdrChip`, `tdrCode`, ...) for visual consistency
 */

export function toolDetailRenderersStyles(): string {
  return `
    /* Tool detail panels — generic chrome shared by all renderers */
    .tdr-panel { display: flex; flex-direction: column; gap: 14px; }
    .tdr-section h5 {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-dim);
      margin: 0 0 6px;
    }
    .tdr-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }

    .tdr-chip {
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
    .tdr-chip .tdr-chip-type { color: var(--text-dim); font-size: 10px; }
    .tdr-chip-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .tdr-chip-warn {
      background: color-mix(in srgb, var(--status-warning) 15%, transparent);
      color: var(--status-warning);
      border-color: color-mix(in srgb, var(--status-warning) 35%, transparent);
    }
    .tdr-chip-err {
      background: color-mix(in srgb, var(--status-error) 15%, transparent);
      color: var(--status-error);
      border-color: color-mix(in srgb, var(--status-error) 35%, transparent);
    }
    .tdr-chip-muted {
      background: var(--bg-inset);
      color: var(--text-dim);
      border-color: var(--border-subtle);
    }
    .tdr-chip-success {
      background: color-mix(in srgb, var(--status-success) 12%, transparent);
      color: var(--status-success);
      border-color: color-mix(in srgb, var(--status-success) 30%, transparent);
    }

    .tdr-title {
      font-size: 13px;
      color: var(--text-primary);
      font-weight: 500;
      line-height: 1.4;
    }
    .tdr-subtle { color: var(--text-dim); font-size: 11px; }

    .tdr-code, .tdr-text {
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 8px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11px;
      color: var(--text-soft);
      white-space: pre;
      overflow-x: auto;
      max-height: 320px;
      overflow-y: auto;
      line-height: 1.45;
    }
    .tdr-text { white-space: pre-wrap; word-break: break-word; }
    .tdr-code .tdr-line-mark {
      background: color-mix(in srgb, var(--status-warning) 18%, transparent);
      display: inline-block;
      width: 100%;
    }

    .tdr-kv {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 4px 12px;
      font-size: 11px;
    }
    .tdr-kv .tdr-k { color: var(--text-dim); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .tdr-kv .tdr-v { color: var(--text-soft); word-break: break-word; }

    .tdr-empty { color: var(--text-dim); font-size: 11px; font-style: italic; }
    .tdr-error {
      background: color-mix(in srgb, var(--status-error) 8%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
      color: var(--status-error);
      padding: 8px 10px;
      border-radius: 4px;
      font-size: 12px;
    }

    .tdr-list { display: flex; flex-direction: column; gap: 4px; font-size: 11px; }
    .tdr-list-item {
      display: flex;
      gap: 8px;
      padding: 4px 6px;
      border-radius: 3px;
      align-items: baseline;
    }
    .tdr-list-item:hover { background: var(--bg-inset); }
    .tdr-list-item .tdr-li-meta { color: var(--text-dim); font-size: 10px; }
    .tdr-list-item .tdr-li-main { color: var(--text-soft); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

    .tdr-match {
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .tdr-match-head {
      background: var(--bg-panel);
      padding: 4px 8px;
      font-size: 11px;
      color: var(--text-soft);
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      border-bottom: 1px solid var(--border-subtle);
    }
    .tdr-match-head .tdr-line-no { color: var(--text-dim); margin-left: 6px; }

    .tdr-toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 4px;
    }
    .tdr-toolbar button {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      color: var(--text-soft);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .tdr-toolbar button:hover { color: var(--text-primary); }
    .tdr-raw-toggle { margin-left: auto; }
    .tdr-raw-pre {
      background: var(--bg-inset);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      padding: 10px;
      font-size: 11px;
      color: var(--text-soft);
      max-height: 500px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }
  `;
}

export function toolDetailRenderersScript(): string {
  return `
    /* State for the open tool detail panel — only showRaw and attrs need
       to survive a re-render. Reset on every span open so the toggle starts
       in structured mode. */
    window.__tdrState = window.__tdrState || { showRaw: false, attrs: null };

    /* ============================================================
     * Dispatcher
     * ============================================================ */

    /** Top-level entry. Picks the most specific renderer that matches the
     *  span's toolName, falls back to a smart generic view (which is still
     *  much better than dumping raw JSON). */
    function renderToolDetail(span) {
      const attrs = (span && span.attributes) || {};
      window.__tdrState.attrs = attrs;
      // v1 search trace owns its own panel — delegate.
      if (attrs.searchTrace && typeof renderSearchTrace === 'function' &&
          attrs.searchTrace.schemaVersion === 1) {
        if (window.__sttState) window.__sttState.showRaw = false;
        return renderSearchTrace(attrs.searchTrace);
      }
      if (window.__tdrState.showRaw) {
        return tdrRawView(attrs);
      }
      var renderer = tdrPickRenderer(String(attrs.toolName || ''));
      try {
        return renderer ? renderer(attrs) : tdrRenderGeneric(attrs);
      } catch (e) {
        return tdrRenderError(e, attrs);
      }
    }

    function tdrPickRenderer(name) {
      if (!name) return null;
      if (/get_graph_node$/.test(name)) return tdrRenderGraphNode;
      if (/yggdrasil-symbol_context$/.test(name)) return tdrRenderSymbolContext;
      if (/yggdrasil-list_files$/.test(name))     return tdrRenderListFiles;
      if (/yggdrasil-read_source$/.test(name))    return tdrRenderReadSource;
      if (/yggdrasil-search_pattern$/.test(name)) return tdrRenderSearchPattern;
      return null;
    }

    function tdrToggleRaw() {
      window.__tdrState.showRaw = !window.__tdrState.showRaw;
      var host = document.getElementById('spanDetailsJson');
      if (host && window.__tdrState.attrs) {
        host.innerHTML = renderToolDetail({ attributes: window.__tdrState.attrs });
      }
    }

    /* ============================================================
     * Helpers — building blocks shared by all renderers
     * ============================================================ */

    function tdrPanel() {
      var parts = Array.prototype.slice.call(arguments).filter(function(p) { return p; });
      return '<div class="tdr-panel">' + parts.join('') + tdrRawButton() + '</div>';
    }
    function tdrSection(title, body) {
      if (!body) return '';
      return '<div class="tdr-section">' +
               (title ? '<h5>' + esc(title) + '</h5>' : '') +
               body +
             '</div>';
    }
    function tdrChip(type, value, cls) {
      if (value == null || value === '') return '';
      var classes = 'tdr-chip' + (cls ? ' ' + cls : '');
      return '<span class="' + classes + '">' +
               (type ? '<span class="tdr-chip-type">' + esc(type) + '</span>' : '') +
               esc(value) +
             '</span>';
    }
    function tdrChips(chips) {
      var html = chips.filter(function(c) { return c; }).join('');
      return html ? '<div class="tdr-row">' + html + '</div>' : '';
    }
    function tdrCode(text, opts) {
      opts = opts || {};
      var s = String(text == null ? '' : text);
      // Highlight a 1-based line number when caller passes opts.markLine
      if (typeof opts.markLine === 'number' && opts.markLine > 0) {
        var lines = s.split('\\n');
        var idx = opts.markLine - 1;
        if (lines[idx] != null) {
          lines[idx] = '<span class="tdr-line-mark">' + esc(lines[idx]) + '</span>';
        }
        // Re-escape only the unmarked lines
        var out = lines.map(function(ln, i) {
          return i === idx ? ln : esc(ln);
        }).join('\\n');
        return '<pre class="tdr-code">' + out + '</pre>';
      }
      return '<pre class="tdr-code">' + esc(s) + '</pre>';
    }
    function tdrText(text) {
      return '<pre class="tdr-text">' + esc(String(text == null ? '' : text)) + '</pre>';
    }
    function tdrEmpty(label) {
      return '<div class="tdr-empty">' + esc(label || 'none') + '</div>';
    }
    function tdrError(msg) {
      return '<div class="tdr-error">' + esc(msg) + '</div>';
    }

    function tdrRawButton() {
      return '<div class="tdr-toolbar tdr-raw-toggle">' +
               '<button onclick="tdrToggleRaw()">Show raw JSON</button>' +
             '</div>';
    }
    function tdrRawView(attrs) {
      return '<div class="tdr-panel">' +
               '<pre class="tdr-raw-pre">' + esc(JSON.stringify(attrs, null, 2)) + '</pre>' +
               '<div class="tdr-toolbar tdr-raw-toggle">' +
                 '<button onclick="tdrToggleRaw()">Show structured</button>' +
               '</div>' +
             '</div>';
    }
    function tdrRenderError(err, attrs) {
      var rawJson;
      try { rawJson = JSON.stringify(attrs, null, 2); }
      catch (e) { rawJson = '(could not serialize attrs: ' + (e && e.message ? e.message : String(e)) + ')'; }
      return '<div class="tdr-panel">' +
               tdrError('Renderer error: ' + (err && err.message ? err.message : String(err))) +
               '<pre class="tdr-raw-pre">' + esc(rawJson) + '</pre>' +
             '</div>';
    }

    /** Parse an attribute that's a JSON string (typical) OR already an object.
     *  Returns null when the input is empty or not parseable. */
    function tdrParseJson(v) {
      if (v == null || v === '') return null;
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch (e) { return null; }
    }

    /** Detect a yggdrasil-style "not found" / error string output. */
    function tdrIsErrorOutput(s) {
      if (typeof s !== 'string') return false;
      return /^(File not found:|No symbol found|Error:?)/i.test(s.trim());
    }

    /** Map known file extensions to a short language label for display. */
    function tdrLangForPath(path) {
      var m = /\\.([a-zA-Z0-9]+)$/.exec(path || '');
      if (!m) return '';
      var ext = m[1].toLowerCase();
      var map = { ts:'ts', tsx:'tsx', js:'js', jsx:'jsx', kt:'kotlin', java:'java',
                  py:'python', rs:'rust', go:'go', sql:'sql', md:'md',
                  json:'json', yaml:'yaml', yml:'yaml', xml:'xml', html:'html', css:'css' };
      return map[ext] || ext;
    }

    /* ============================================================
     * Renderer: knowledge-get_graph_node
     * Input:  { node_id: "epic:MELOSYS-7383" }
     * Output: plain text — title line, "Properties:", "Incoming:", "Outgoing:"
     *         sections with arrow-notation edges.
     * ============================================================ */

    function tdrRenderGraphNode(attrs) {
      var input = tdrParseJson(attrs.input) || {};
      var output = String(attrs.output || '');
      var nodeId = input.node_id || input.tag || '';
      var kind = '';
      var idx = nodeId.indexOf(':');
      if (idx > 0) kind = nodeId.slice(0, idx);

      // First non-empty line is usually the title (often markdown-bolded).
      var lines = output.split('\\n');
      var titleLine = '';
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].trim().length > 0) { titleLine = lines[i].trim(); break; }
      }
      // Strip surrounding ** if present.
      var titleClean = titleLine.replace(/^\\*\\*(.+?)\\*\\*\\s*/, '$1 ');

      var sections = tdrParseGraphSections(output);
      var headerChips = tdrChips([
        tdrChip('node', nodeId, 'tdr-chip-mono'),
        kind ? tdrChip('kind', kind) : '',
        sections.incoming.length ? tdrChip('in', sections.incoming.length, 'tdr-chip-muted') : '',
        sections.outgoing.length ? tdrChip('out', sections.outgoing.length, 'tdr-chip-muted') : '',
      ]);

      var titleHtml = titleClean
        ? '<div class="tdr-title">' + esc(titleClean) + '</div>'
        : '';

      var propsHtml = '';
      if (sections.properties.length) {
        var rows = sections.properties.map(function(p) {
          return '<div class="tdr-k">' + esc(p.key) + '</div>' +
                 '<div class="tdr-v">' + esc(p.value) + '</div>';
        }).join('');
        propsHtml = '<div class="tdr-kv">' + rows + '</div>';
      }

      var inHtml  = sections.incoming.length ? tdrRenderGraphEdges(sections.incoming) : '';
      var outHtml = sections.outgoing.length ? tdrRenderGraphEdges(sections.outgoing) : '';

      return tdrPanel(
        tdrSection('Node', headerChips + titleHtml),
        tdrSection('Properties', propsHtml),
        tdrSection('Incoming (' + sections.incoming.length + ')', inHtml),
        tdrSection('Outgoing (' + sections.outgoing.length + ')', outHtml),
        sections.other ? tdrSection('Raw output', tdrText(output)) : ''
      );
    }

    /** Light parser for the get_graph_node output text. Recognises:
     *  - "Properties:" section with "  key: value" rows
     *  - "Incoming (N):" section with "  <--rel-- NODE-ID: title" rows
     *  - "Outgoing (N):" section with "  --rel--> NODE-ID: title" rows
     *  Anything not recognised goes into 'other' (we surface it as raw text). */
    function tdrParseGraphSections(text) {
      var result = { properties: [], incoming: [], outgoing: [], other: false };
      var lines = String(text || '').split('\\n');
      var section = null; // 'props' | 'in' | 'out' | null
      var sawAny = false;
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();
        if (/^Properties:\\s*$/i.test(trimmed)) { section = 'props'; sawAny = true; continue; }
        if (/^Incoming\\b/i.test(trimmed))      { section = 'in';    sawAny = true; continue; }
        if (/^Outgoing\\b/i.test(trimmed))      { section = 'out';   sawAny = true; continue; }
        if (trimmed === '') { continue; }
        if (section === 'props') {
          var kv = /^\\s+([^:]+?):\\s*(.*)$/.exec(line);
          if (kv) result.properties.push({ key: kv[1].trim(), value: kv[2] });
          continue;
        }
        if (section === 'in') {
          var em = /^\\s*<--(.*?)--\\s*(.+)$/.exec(line);
          if (em) result.incoming.push({ rel: em[1].trim(), target: em[2].trim() });
          continue;
        }
        if (section === 'out') {
          var em2 = /^\\s*--(.*?)-->\\s*(.+)$/.exec(line);
          if (em2) result.outgoing.push({ rel: em2[1].trim(), target: em2[2].trim() });
          continue;
        }
      }
      if (!sawAny) result.other = true;
      return result;
    }

    function tdrRenderGraphEdges(edges) {
      var rows = edges.map(function(e) {
        // target is "ID: title" — split for nicer rendering
        var m = /^([A-Za-z0-9:_\\-]+)(?::\\s*(.*))?$/.exec(e.target);
        var id = m ? m[1] : e.target;
        var title = m && m[2] ? m[2] : '';
        return '<div class="tdr-list-item">' +
                 '<span class="tdr-li-meta">' + esc(e.rel) + '</span>' +
                 '<span class="tdr-li-main">' + esc(id) + '</span>' +
                 (title ? '<span class="tdr-subtle">' + esc(title) + '</span>' : '') +
               '</div>';
      }).join('');
      return '<div class="tdr-list">' + rows + '</div>';
    }

    /* ============================================================
     * Renderer: yggdrasil-symbol_context
     * Input:  { qualified_name, repo }
     * Output: { symbol: { name, qualified_name, kind, file, lines, signature, visibility },
     *           callers, callees, extends, implements, extended_by, implemented_by }
     *         OR error string ("No symbol found...")
     * ============================================================ */

    function tdrRenderSymbolContext(attrs) {
      var input = tdrParseJson(attrs.input) || {};
      var rawOut = attrs.output;
      if (typeof rawOut === 'string' && tdrIsErrorOutput(rawOut)) {
        return tdrPanel(
          tdrSection('Query', tdrChips([
            tdrChip('repo', input.repo, 'tdr-chip-muted'),
            tdrChip('symbol', input.qualified_name, 'tdr-chip-mono'),
          ])),
          tdrSection('Result', tdrError(rawOut))
        );
      }
      var out = tdrParseJson(rawOut);
      if (!out || !out.symbol) {
        return tdrPanel(
          tdrSection('Query', tdrChips([
            tdrChip('repo', input.repo, 'tdr-chip-muted'),
            tdrChip('symbol', input.qualified_name, 'tdr-chip-mono'),
          ])),
          tdrSection('Output', tdrText(typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut, null, 2)))
        );
      }
      var sym = out.symbol;
      var repo = input.repo || tdrInferRepoFromFile(sym.file) || '';

      var headerChips = tdrChips([
        tdrChip('repo', repo, 'tdr-chip-muted'),
        sym.kind ? tdrChip('kind', sym.kind) : '',
        sym.visibility ? tdrChip('vis', sym.visibility, 'tdr-chip-muted') : '',
      ]);
      var titleHtml = '<div class="tdr-title">' + esc(sym.qualified_name || sym.name || '') + '</div>';
      var fileLine = sym.file ? '<div class="tdr-subtle">' +
        esc(sym.file) + (sym.lines ? ' :' + esc(sym.lines) : '') +
        '</div>' : '';

      var sigHtml = sym.signature ? tdrCode(sym.signature) : '';

      var rels = [
        { title: 'Implements',     items: out.implements },
        { title: 'Extends',        items: out.extends },
        { title: 'Implemented by', items: out.implemented_by },
        { title: 'Extended by',    items: out.extended_by },
        { title: 'Callers',        items: out.callers },
        { title: 'Callees',        items: out.callees },
      ];
      var relsHtml = rels
        .filter(function(r) { return Array.isArray(r.items) && r.items.length > 0; })
        .map(function(r) { return tdrSection(r.title + ' (' + r.items.length + ')', tdrRenderSymbolRelations(r.items)); })
        .join('');

      return tdrPanel(
        tdrSection('Symbol', headerChips + titleHtml + fileLine),
        sigHtml ? tdrSection('Signature', sigHtml) : '',
        relsHtml || tdrSection('Relations', tdrEmpty('no callers, callees, or supertypes captured'))
      );
    }

    function tdrRenderSymbolRelations(items) {
      var rows = items.map(function(it) {
        var qn = it.qualified_name || it.name || '';
        var loc = it.file_path ? (it.repo_name ? it.repo_name + '/' : '') + it.file_path : '';
        return '<div class="tdr-list-item">' +
                 (it.kind ? '<span class="tdr-li-meta">' + esc(it.kind) + '</span>' : '') +
                 '<span class="tdr-li-main">' + esc(qn) + '</span>' +
                 (loc ? '<span class="tdr-subtle">' + esc(loc) + '</span>' : '') +
               '</div>';
      }).join('');
      return '<div class="tdr-list">' + rows + '</div>';
    }

    /** Extract the repo prefix from a yggdrasil file path like
     *  "melosys-api/saksflyt/src/main/...". The yggdrasil server emits files
     *  with the repo as the first path segment in symbol_context output, so
     *  this works as long as the convention holds. */
    function tdrInferRepoFromFile(file) {
      if (typeof file !== 'string' || !file) return '';
      var idx = file.indexOf('/');
      return idx > 0 ? file.slice(0, idx) : '';
    }

    /* ============================================================
     * Renderer: yggdrasil-list_files
     * Input:  { repo, path }
     * Output: { repo, total_files, truncated, files: [{ path, language }] }
     * ============================================================ */

    function tdrRenderListFiles(attrs) {
      var input = tdrParseJson(attrs.input) || {};
      var out = tdrParseJson(attrs.output) || {};
      var files = Array.isArray(out.files) ? out.files : [];
      var repo = out.repo || input.repo || '';
      var basePath = input.path || '';

      var headerChips = tdrChips([
        tdrChip('repo', repo, 'tdr-chip-muted'),
        tdrChip('path', basePath, 'tdr-chip-mono'),
        tdrChip('files', String(out.total_files != null ? out.total_files : files.length), 'tdr-chip-muted'),
        out.truncated ? tdrChip('', 'truncated', 'tdr-chip-warn') : '',
      ]);

      var listHtml = files.length ? tdrRenderFileList(files, basePath) : tdrEmpty('no files');

      return tdrPanel(
        tdrSection('Listing', headerChips),
        tdrSection('Files', listHtml)
      );
    }

    function tdrRenderFileList(files, basePath) {
      var prefix = basePath ? basePath.replace(/\\/+\$/, '') + '/' : '';
      var rows = files.map(function(f) {
        var rel = (typeof f.path === 'string' && prefix && f.path.indexOf(prefix) === 0)
          ? f.path.slice(prefix.length)
          : f.path;
        var lang = f.language || tdrLangForPath(f.path);
        return '<div class="tdr-list-item">' +
                 (lang ? '<span class="tdr-li-meta">' + esc(lang) + '</span>' : '') +
                 '<span class="tdr-li-main">' + esc(rel) + '</span>' +
               '</div>';
      }).join('');
      return '<div class="tdr-list">' + rows + '</div>';
    }

    /* ============================================================
     * Renderer: yggdrasil-read_source
     * Input:  { repo, path }
     * Output: file content as string OR error string ("File not found: ...")
     * ============================================================ */

    function tdrRenderReadSource(attrs) {
      var input = tdrParseJson(attrs.input) || {};
      var output = attrs.output;
      var headerChips = tdrChips([
        tdrChip('repo', input.repo, 'tdr-chip-muted'),
        tdrChip('path', input.path, 'tdr-chip-mono'),
        tdrChip('lang', tdrLangForPath(input.path), 'tdr-chip-muted'),
      ]);

      if (typeof output === 'string' && tdrIsErrorOutput(output)) {
        return tdrPanel(
          tdrSection('File', headerChips),
          tdrSection('Result', tdrError(output))
        );
      }
      var body = typeof output === 'string'
        ? tdrCode(output)
        : tdrEmpty('no content (TRACING_CAPTURE_TOOL_OUTPUTS may be off)');
      return tdrPanel(
        tdrSection('File', headerChips),
        tdrSection('Source', body)
      );
    }

    /* ============================================================
     * Renderer: yggdrasil-search_pattern
     * Input:  { pattern, repo, context_lines, max_results }
     * Output: { pattern, total_matches,
     *           matches: [{ repo, path, line, content, context_before, context_after }] }
     * ============================================================ */

    function tdrRenderSearchPattern(attrs) {
      var input = tdrParseJson(attrs.input) || {};
      var out = tdrParseJson(attrs.output) || {};
      var matches = Array.isArray(out.matches) ? out.matches : [];

      var headerChips = tdrChips([
        tdrChip('repo', input.repo, 'tdr-chip-muted'),
        tdrChip('pattern', input.pattern || out.pattern, 'tdr-chip-mono'),
        tdrChip('matches', String(out.total_matches != null ? out.total_matches : matches.length), 'tdr-chip-muted'),
        input.max_results != null ? tdrChip('max', input.max_results, 'tdr-chip-muted') : '',
      ]);

      var matchesHtml = matches.length
        ? matches.map(tdrRenderPatternMatch).join('')
        : tdrEmpty('no matches');

      return tdrPanel(
        tdrSection('Search', headerChips),
        tdrSection('Matches', matchesHtml)
      );
    }

    function tdrRenderPatternMatch(m) {
      var before = Array.isArray(m.context_before) ? m.context_before : [];
      var after  = Array.isArray(m.context_after)  ? m.context_after  : [];
      var hitLine = (m.content == null ? '' : String(m.content));
      var startLine = (typeof m.line === 'number' ? m.line : 0) - before.length;
      // Reconstruct a contiguous block: before + hit + after
      var block = before.concat([hitLine]).concat(after).join('\\n');
      var markIdx = before.length + 1; // 1-based for tdrCode
      var loc = (m.repo ? m.repo + '/' : '') + (m.path || '');
      return '<div class="tdr-match">' +
               '<div class="tdr-match-head">' +
                 esc(loc) +
                 (m.line != null ? '<span class="tdr-line-no">:' + esc(String(m.line)) + '</span>' : '') +
                 (startLine > 0 ? '<span class="tdr-line-no"> (lines ' + startLine + '–' + (startLine + before.length + after.length) + ')</span>' : '') +
               '</div>' +
               tdrCode(block, { markLine: markIdx }) +
             '</div>';
    }

    /* ============================================================
     * Generic fallback — Input + Output sections
     * ============================================================ */

    function tdrRenderGeneric(attrs) {
      var inputObj = tdrParseJson(attrs.input);
      var outputRaw = attrs.output;

      var headerChips = tdrChips([
        attrs.toolName ? tdrChip('tool', String(attrs.toolName), 'tdr-chip-muted') : '',
        attrs.statusText ? tdrChip('', String(attrs.statusText), 'tdr-chip-mono') : '',
      ]);

      var inputHtml;
      if (inputObj && typeof inputObj === 'object') {
        inputHtml = tdrRenderObjectKv(inputObj);
      } else if (attrs.input != null) {
        inputHtml = tdrText(String(attrs.input));
      } else {
        inputHtml = tdrEmpty('no input captured');
      }

      var outputHtml = '';
      if (outputRaw == null || outputRaw === '') {
        outputHtml = tdrEmpty('no output captured');
      } else if (typeof outputRaw === 'string') {
        var parsed = tdrParseJson(outputRaw);
        if (parsed && typeof parsed === 'object') {
          outputHtml = '<pre class="tdr-code">' + esc(JSON.stringify(parsed, null, 2)) + '</pre>';
        } else {
          outputHtml = tdrIsErrorOutput(outputRaw) ? tdrError(outputRaw) : tdrText(outputRaw);
        }
      } else {
        outputHtml = '<pre class="tdr-code">' + esc(JSON.stringify(outputRaw, null, 2)) + '</pre>';
      }

      return tdrPanel(
        headerChips ? tdrSection('Tool', headerChips) : '',
        tdrSection('Input', inputHtml),
        tdrSection('Output', outputHtml)
      );
    }

    /** Render an object as a 2-column key/value table. Scalars render inline,
     *  objects/arrays render as a fenced JSON block in the value column. */
    function tdrRenderObjectKv(obj) {
      var keys = Object.keys(obj);
      if (!keys.length) return tdrEmpty('{}');
      var rows = keys.map(function(k) {
        var v = obj[k];
        var vHtml;
        if (v == null) vHtml = '<span class="tdr-subtle">null</span>';
        else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          vHtml = '<span class="tdr-v">' + esc(String(v)) + '</span>';
        } else {
          vHtml = '<pre class="tdr-code" style="margin:0;max-height:160px">' + esc(JSON.stringify(v, null, 2)) + '</pre>';
        }
        return '<div class="tdr-k">' + esc(k) + '</div><div>' + vHtml + '</div>';
      }).join('');
      return '<div class="tdr-kv">' + rows + '</div>';
    }
  `;
}
