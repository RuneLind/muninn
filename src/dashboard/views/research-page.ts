import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { markdownContentStyles, docPanelStyles, docPanelHtml, docPanelScript, MARKED_CDN_SCRIPT } from "./components/doc-panel.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { clientCorpusJson, clientProfilesJson, DEFAULT_PROFILE } from "../../research/corpus.ts";

export async function renderResearchPage(): Promise<string> {
  const helpers = await helpersClientScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Research</title>
  <style>
    ${SHARED_STYLES}
    ${botSelectorStyles()}

    .page-content {
      max-width: 860px;
      margin: 0 auto;
      padding: 24px;
    }

    /* --- Ask box --- */
    .ask-box {
      display: flex;
      gap: 10px;
      align-items: stretch;
      margin-bottom: 8px;
    }
    .ask-input {
      flex: 1;
      padding: 12px 16px;
      border-radius: 10px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 15px;
      font-family: inherit;
      resize: none;
      line-height: 1.5;
      min-height: 48px;
    }
    .ask-input:focus { outline: none; border-color: var(--accent); }
    .ask-btn {
      padding: 0 22px;
      border-radius: 10px;
      border: none;
      background: var(--accent);
      color: #fff;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      transition: opacity 0.15s;
    }
    .ask-btn:hover { opacity: 0.9; }
    .ask-btn:disabled { opacity: 0.5; cursor: default; }
    .corpus-line {
      font-size: 12px;
      color: var(--text-dim);
      margin-bottom: 20px;
    }
    .corpus-line strong { color: var(--text-secondary); font-weight: 500; }

    /* --- Corpus profile toggle (AI & tech / Life) --- */
    .profile-toggle {
      display: flex;
      gap: 6px;
      align-items: center;
      margin-bottom: 6px;
    }
    .profile-chip {
      padding: 4px 12px;
      border-radius: 20px;
      border: 1px solid var(--border-primary);
      background: var(--bg-card);
      color: var(--text-secondary);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .profile-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .profile-chip.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
    }

    /* --- Conversation turns --- */
    /* The corpus Q&A is multi-turn: each ask appends a turn card; the running
       history stays visible above the composer (which sits at the bottom). */
    #turnsWrap { display: flex; flex-direction: column; gap: 4px; }
    .turn-card {
      padding-bottom: 18px;
      margin-bottom: 18px;
      border-bottom: 1px solid var(--border-primary);
    }
    .turn-card:last-child { border-bottom: none; }
    .turn-question {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
      line-height: 1.5;
      margin-bottom: 12px;
    }
    .turn-question::before { content: '› '; color: var(--accent); font-weight: 700; }

    /* --- Answer --- */
    .answer-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--text-dim);
      margin-bottom: 14px;
    }
    .answer-status .spinner {
      width: 13px; height: 13px;
      border: 2px solid var(--border-secondary);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: researchSpin 0.7s linear infinite;
    }
    @keyframes researchSpin { to { transform: rotate(360deg); } }
    .answer-status.done .spinner { display: none; }
    .answer-status.error { color: var(--status-error); }

    .answer-body {
      color: var(--text-secondary);
      line-height: 1.7;
      font-size: 15px;
    }
    .answer-body.streaming { white-space: pre-wrap; }
    ${markdownContentStyles(".answer-body")}

    .cite {
      display: inline-block;
      cursor: pointer;
      color: var(--accent-light);
      font-size: 0.78em;
      font-weight: 600;
      vertical-align: super;
      line-height: 0;
      padding: 0 1px;
    }
    .cite:hover { text-decoration: underline; }

    .sources-head {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-dim);
      margin: 26px 0 10px;
    }
    .sources-list { display: flex; flex-direction: column; gap: 4px; }
    .source-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      border-radius: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border-primary);
      cursor: pointer;
      transition: border-color 0.15s;
    }
    .source-row:hover { border-color: var(--accent); }
    .source-row.uncited { opacity: 0.55; }
    .source-num {
      flex-shrink: 0;
      width: 22px; height: 22px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 700;
    }
    .source-badge {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      padding: 2px 7px;
      border-radius: 5px;
      background: color-mix(in srgb, var(--accent) 18%, transparent);
      color: var(--accent-light);
    }
    .source-title {
      flex: 1;
      font-size: 13px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .source-rel { flex-shrink: 0; font-size: 11px; color: var(--text-dim); }
    .source-wiki {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
      text-decoration: none;
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
      color: var(--accent-light);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
    }
    .source-wiki:hover { border-color: var(--accent); }
    .source-shelf {
      flex-shrink: 0;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
      padding: 2px 7px;
      border-radius: 5px;
      border: 1px solid color-mix(in srgb, var(--status-success) 40%, transparent);
      color: var(--status-success);
      background: color-mix(in srgb, var(--status-success) 12%, transparent);
    }

    /* --- Composer (pinned under the conversation) --- */
    .composer-meta {
      display: flex;
      justify-content: flex-end;
      margin-top: 8px;
      min-height: 20px;
    }
    .newconv-btn {
      background: none;
      border: 1px solid var(--border-primary);
      color: var(--text-dim);
      padding: 5px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.15s;
    }
    .newconv-btn:hover { border-color: var(--accent); color: var(--text-secondary); }

    .empty-hint {
      color: var(--text-dim);
      font-size: 14px;
      text-align: center;
      padding: 48px 20px;
      line-height: 1.6;
    }
    .empty-hint .examples { margin-top: 14px; display: flex; flex-direction: column; gap: 6px; align-items: center; }
    .empty-hint .ex {
      cursor: pointer;
      color: var(--accent-light);
      font-size: 13px;
    }
    .empty-hint .ex:hover { text-decoration: underline; }

    /* --- Browse (folded) --- */
    .browse-details { margin-top: 8px; border-top: 1px solid var(--border-primary); padding-top: 14px; }
    .browse-details > summary {
      cursor: pointer;
      font-size: 13px;
      color: var(--text-dim);
      list-style: none;
      user-select: none;
    }
    .browse-details > summary::-webkit-details-marker { display: none; }
    .browse-details > summary:hover { color: var(--text-secondary); }
    .browse-details[open] > summary { color: var(--text-secondary); margin-bottom: 14px; }

    .collection-selector { margin-bottom: 16px; }
    .collection-selector select {
      padding: 8px 14px;
      border-radius: 8px;
      border: 1px solid var(--border-primary);
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
      min-width: 250px;
    }
    .collection-selector select:focus { outline: none; border-color: var(--accent); }
    .category-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
    .cat-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 14px; border-radius: 20px;
      border: 1px solid var(--border-primary);
      background: var(--bg-card); color: var(--text-secondary);
      font-size: 13px; cursor: pointer; transition: all 0.15s;
    }
    .cat-chip:hover { border-color: var(--accent); color: var(--text-primary); }
    .cat-chip.active {
      border-color: var(--accent);
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent-light);
    }
    .cat-chip .chip-count { font-size: 11px; color: var(--text-dim); font-weight: 600; }
    .cat-chip.active .chip-count { color: var(--accent-light); }
    .articles-grid { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
    .article-row {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 14px; border-radius: 8px;
      background: var(--bg-card); border: 1px solid var(--border-primary);
      cursor: pointer; text-decoration: none; transition: border-color 0.15s;
    }
    .article-row:hover { border-color: var(--accent); }
    .article-row-title {
      flex: 1; font-size: 13px; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .article-row-link { font-size: 12px; color: var(--text-dim); text-decoration: none; flex-shrink: 0; }
    .article-row-link:hover { color: var(--accent-light); }
    .browse-empty { color: var(--text-dim); font-size: 14px; text-align: center; padding: 40px; }

    ${docPanelStyles("researchSlideIn")}
  </style>
</head>
<body>
  ${renderNav("research", { headerLeftExtra: botSelectorHtml() })}

  <div class="error-banner" id="errorBanner">
    Knowledge API is not available. This feature requires an external knowledge/vector search server.
    Set <code>KNOWLEDGE_API_URL</code> in your <code>.env</code> file to connect.
  </div>

  <div class="page-content">
    <div class="profile-toggle" id="profileToggle"></div>
    <div class="corpus-line" id="corpusLine"></div>

    <div class="empty-hint" id="emptyHint">
      Ask a question and Muninn answers from the shelf — with citations you can open.
      Follow-ups carry the conversation, so you can drill down.
      <div class="examples">
        <span class="ex" onclick="askExample(this)">What changed in Claude Code's MCP support recently?</span>
        <span class="ex" onclick="askExample(this)">What is prompt caching and when should I use it?</span>
        <span class="ex" onclick="askExample(this)">Summarize recent Anthropic agent-building guidance.</span>
      </div>
    </div>

    <div id="turnsWrap"></div>

    <div class="ask-box">
      <textarea class="ask-input" id="askInput" rows="1" placeholder="Ask about Claude, Anthropic, or anything on the shelf…"></textarea>
      <button class="ask-btn" id="askBtn" onclick="askQuestion()">Ask</button>
    </div>
    <div class="composer-meta">
      <button class="newconv-btn" id="newConvBtn" onclick="newConversation()" style="display:none">＋ New conversation</button>
    </div>

    <details class="browse-details" id="browseDetails">
      <summary>Browse the corpus by collection ▾</summary>
      <div class="collection-selector">
        <select id="collectionSelect" onchange="loadCollection(this.value)">
          <option value="">Select a collection...</option>
        </select>
      </div>
      <div class="category-chips" id="tagChips"></div>
      <div class="articles-grid" id="documentsGrid"></div>
    </details>
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}
  <script>
    ${helpers}

    var CORPUS = ${clientCorpusJson()};
    var PROFILES = ${clientProfilesJson()};
    var DEFAULT_PROFILE = ${JSON.stringify(DEFAULT_PROFILE)};
    var selectedProfile = DEFAULT_PROFILE;
    var collections = [];
    var botCollectionNames = [];
    var allDocuments = [];
    var allTags = [];
    var activeTag = null;
    var selectedBot = '';

    // Q&A state — the conversation is multi-turn but stateless on the server: we
    // keep the committed turns here and replay a compact slice of them as context
    // on each follow-up (see compactHistory).
    var turns = [];           // committed turns: { question, answer, citations, cited }
    var active = null;        // refs for the in-flight turn card (or null)
    var currentSource = null; // active EventSource
    var browseLoaded = false; // the folded browse list loads lazily on first open

    var MAX_HISTORY_TURNS = 4;     // mirrors the server cap; keeps the GET URL bounded
    var HISTORY_ANSWER_CHARS = 700;

    // === Bot selector ===

    async function loadBotList() {
      try {
        var res = await fetch('/api/research/bots');
        if (!res.ok) return;
        var data = await res.json();
        var bots = data.bots || [];

        try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch {}
        // The selection is shared across pages, so it may point at a bot that
        // no longer exists (deleted folder / renamed). Drop it so the
        // default-to-first below picks a real one.
        if (selectedBot && !bots.some(function(b) { return b.name === selectedBot; })) selectedBot = '';

        var container = document.getElementById('botSelector');
        container.innerHTML = bots.map(function(b) {
          return '<button class="bot-pill' + (selectedBot === b.name ? ' active' : '') + '" data-bot="' + esc(b.name) + '">' + esc(b.name.charAt(0).toUpperCase() + b.name.slice(1)) + '</button>';
        }).join('');

        if (!selectedBot && bots.length > 0) {
          selectedBot = bots[0].name;
          var first = container.querySelector('[data-bot="' + selectedBot + '"]');
          if (first) first.classList.add('active');
        }

        container.addEventListener('click', function(e) {
          var pill = e.target.closest('.bot-pill');
          if (!pill) return;
          selectBot(pill.dataset.bot);
        });
      } catch (e) { console.error('Failed to load bot list', e); }
    }

    function selectBot(name) {
      selectedBot = name;
      try { localStorage.setItem('muninn-selected-bot', name); } catch {}
      document.querySelectorAll('#botSelector .bot-pill').forEach(function(p) {
        p.classList.toggle('active', p.dataset.bot === name);
      });
      // The browse list is bot-scoped — refresh it now if open, else let it
      // reload on the next open (don't leave the previous bot's collections).
      if (document.getElementById('browseDetails').open) {
        browseLoaded = true;
        loadBotCollections();
      } else {
        browseLoaded = false;
      }
    }

    // === Corpus profile (AI & tech / Life) ===

    // Restore the persisted profile, guarding against a stale value no longer in
    // the registry (falls back to the default).
    function initProfile() {
      try {
        var saved = localStorage.getItem('muninn-research-profile');
        if (saved && PROFILES[saved]) selectedProfile = saved;
      } catch (e) {}
      renderProfileToggle();
      renderCorpusLine();
    }

    function renderProfileToggle() {
      var el = document.getElementById('profileToggle');
      if (!el) return;
      el.innerHTML = Object.keys(PROFILES).map(function(name) {
        var active = name === selectedProfile ? ' active' : '';
        return '<span class="profile-chip' + active + '" data-profile="' + esc(name) + '">' + esc(PROFILES[name].label) + '</span>';
      }).join('');
      el.querySelectorAll('.profile-chip').forEach(function(chip) {
        chip.onclick = function() { selectProfile(chip.dataset.profile); };
      });
    }

    // Show which collection labels the active profile searches across, resolved
    // through CORPUS so citations and this line stay in sync.
    function renderCorpusLine() {
      var el = document.getElementById('corpusLine');
      if (!el) return;
      var prof = PROFILES[selectedProfile];
      var names = (prof && prof.collections) || [];
      var labels = names.map(function(name) {
        return (CORPUS[name] && CORPUS[name].label) || name;
      });
      el.innerHTML = 'Searches across <strong>' + esc(labels.join(' · ')) + '</strong>';
    }

    function selectProfile(name) {
      if (!PROFILES[name] || name === selectedProfile) return;
      selectedProfile = name;
      try { localStorage.setItem('muninn-research-profile', name); } catch (e) {}
      renderProfileToggle();
      renderCorpusLine();
    }

    // === Q&A ===

    function askExample(el) {
      document.getElementById('askInput').value = el.textContent.trim();
      askQuestion();
    }

    // Compact, bounded replay of the committed turns sent with each follow-up so
    // the server can answer in context without holding any conversation state.
    function compactHistory() {
      if (!turns.length) return '';
      var recent = turns.slice(-MAX_HISTORY_TURNS).map(function(t) {
        return { q: (t.question || '').slice(0, 500), a: (t.answer || '').slice(0, HISTORY_ANSWER_CHARS) };
      });
      return JSON.stringify(recent);
    }

    // Reflect conversation state in the composer: follow-up affordance + reset.
    function updateComposer() {
      var input = document.getElementById('askInput');
      var newBtn = document.getElementById('newConvBtn');
      if (turns.length > 0) {
        input.placeholder = 'Ask a follow-up…';
        newBtn.style.display = '';
      } else {
        input.placeholder = 'Ask about Claude, Anthropic, or anything on the shelf…';
        newBtn.style.display = 'none';
      }
    }

    function newConversation() {
      if (currentSource) { currentSource.close(); currentSource = null; }
      turns = [];
      active = null;
      document.getElementById('turnsWrap').innerHTML = '';
      document.getElementById('emptyHint').style.display = '';
      document.getElementById('askBtn').disabled = false;
      updateComposer();
      document.getElementById('askInput').focus();
    }

    // Create a turn card and stream the answer into it. Each SSE handler is bound
    // to the returned per-turn refs (not shared globals), so a superseded stream
    // can't write to a newer turn's card. The 'active' var holds these refs while
    // the turn is in flight so a new ask can drop the orphaned card (askQuestion).
    function startTurnCard(question) {
      var card = document.createElement('div');
      card.className = 'turn-card';
      card.innerHTML =
        '<div class="turn-question"></div>' +
        '<div class="answer-status"><span class="spinner"></span><span class="st">Searching the shelf…</span></div>' +
        '<div class="answer-body streaming"></div>' +
        '<div class="turn-sources"></div>';
      card.querySelector('.turn-question').textContent = question;
      document.getElementById('turnsWrap').appendChild(card);
      card.scrollIntoView({ block: 'start' });
      return {
        question: question,
        citations: [],
        buffer: '',
        card: card,
        statusWrap: card.querySelector('.answer-status'),
        statusEl: card.querySelector('.answer-status .st'),
        bodyEl: card.querySelector('.answer-body'),
        sourcesEl: card.querySelector('.turn-sources'),
      };
    }

    function setCardStatus(a, text, state) {
      a.statusWrap.className = 'answer-status' + (state ? ' ' + state : '');
      a.statusEl.textContent = text;
    }

    function askQuestion() {
      var input = document.getElementById('askInput');
      var q = input.value.trim();
      if (!q) return;

      // Supersede any in-flight turn. A new ask (reachable via Enter / an example
      // even while the Ask button is disabled) closes the prior stream — which
      // then fires no 'done', so its turn never commits. Drop its orphaned card
      // so it doesn't spin forever; it was never committed, so history is intact.
      if (currentSource) { currentSource.close(); currentSource = null; }
      if (active && active.card) { active.card.remove(); }
      active = null;

      document.getElementById('emptyHint').style.display = 'none';
      input.value = '';

      var a = startTurnCard(q);
      active = a;
      var btn = document.getElementById('askBtn');
      btn.disabled = true;

      var url = '/api/research/ask?q=' + encodeURIComponent(q);
      if (selectedBot) url += '&bot=' + encodeURIComponent(selectedBot);
      url += '&profile=' + encodeURIComponent(selectedProfile);
      var hist = compactHistory();
      if (hist) url += '&history=' + encodeURIComponent(hist);

      var conn = sseClient(url, {
        phase: function(e) {
          var d = JSON.parse(e.data);
          if (d.phase === 'searching') setCardStatus(a, 'Searching the shelf…', '');
          else if (d.phase === 'synthesizing') setCardStatus(a, 'Synthesizing answer…', '');
        },

        sources: function(e) {
          var d = JSON.parse(e.data);
          a.citations = d.citations || [];
          a.sourcesEl.innerHTML = sourcesHtml(a.citations, []);
          bindSources(a.sourcesEl, a.citations);
        },

        delta: function(e) {
          var d = JSON.parse(e.data);
          a.buffer += d.text || '';
          a.bodyEl.textContent = a.buffer;
          a.bodyEl.scrollIntoView({ block: 'nearest' });
        },

        done: function(e) {
          var d = JSON.parse(e.data);
          a.buffer = d.answer || a.buffer || '';
          a.bodyEl.className = 'answer-body';
          a.bodyEl.innerHTML = renderMarkdown(a.buffer);
          linkifyCitations(a.bodyEl, a.citations);
          a.sourcesEl.innerHTML = sourcesHtml(a.citations, d.cited || []);
          bindSources(a.sourcesEl, a.citations);
          var statusText;
          if (d.lowConfidence) statusText = 'No strong match — showing the closest sources';
          else if (d.noHits) statusText = 'No matching sources';
          else statusText = 'Answered from ' + a.citations.length + ' source' + (a.citations.length === 1 ? '' : 's');
          setCardStatus(a, statusText, 'done');
          // Commit the turn so the next ask carries it as context (only question +
          // answer are replayed — see compactHistory). We keep even a declined
          // (no-coverage) turn — the follow-up still benefits from knowing what was
          // asked. The rendered card already holds this turn's citations.
          turns.push({ question: a.question, answer: a.buffer });
          active = null;
          btn.disabled = false;
          updateComposer();
        },

        // App-level failure from the server (synthesis error, no bot, etc.). Named
        // 'app_error' not 'error' on purpose — EventSource reserves 'error' for
        // connection drops (see onerror below), so a server 'error' event would
        // be masked as "Connection lost" and hide the real message. The server's
        // 'end' sentinel still follows and closes the stream.
        app_error: function(e) {
          var msg = 'Something went wrong.';
          try { msg = JSON.parse(e.data).message || msg; } catch {}
          setCardStatus(a, msg, 'error');
          if (!a.buffer) { a.bodyEl.className = 'answer-body'; a.bodyEl.innerHTML = ''; }
          active = null;
          btn.disabled = false;
        },

        // Server sends an explicit 'end' sentinel after the stream is done.
        end: function() {
          if (currentSource !== conn) return; // a newer ask superseded this stream
          currentSource.close();
          currentSource = null;
          btn.disabled = false;
        },

        // Network-level failure (not an app 'error' event) — EventSource.onerror.
        // Terminal: close so EventSource does NOT silently auto-reconnect on a
        // transient mid-stream drop (readyState CONNECTING) and re-run the whole
        // — expensive — synthesis, appending a duplicate answer onto the buffer.
        // Normal completion goes through the 'end' sentinel, which nulls
        // currentSource first, so this guard returns early for a finished stream.
        onerror: function() {
          if (currentSource !== conn) return; // stale stream from a superseded ask
          conn.close();
          currentSource = null;
          active = null;
          btn.disabled = false;
          // Don't clobber a terminal status: 'done' (clean finish) or 'error' (a
          // server 'app_error' already put the real message on the card). Only an
          // in-flight turn — searching/synthesizing, no terminal class — is a
          // genuine drop worth labelling "Connection lost".
          if (!a.statusWrap.classList.contains('done') && !a.statusWrap.classList.contains('error')) {
            setCardStatus(a, 'Connection lost', 'error');
          }
        },
      });
      currentSource = conn;
    }

    // Walk text nodes and turn [n] markers into clickable citation chips, bound to
    // THIS turn's citations. Done on the rendered markdown DOM so we never inject
    // HTML into untrusted text.
    function linkifyCitations(root, citations) {
      var maxN = citations.length;
      if (maxN === 0) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var targets = [];
      var node;
      while ((node = walker.nextNode())) {
        if (/\\[\\d+\\]/.test(node.nodeValue)) targets.push(node);
      }
      targets.forEach(function(textNode) {
        var frag = document.createDocumentFragment();
        var text = textNode.nodeValue;
        var re = /\\[(\\d+)\\]/g;
        var last = 0;
        var m;
        while ((m = re.exec(text))) {
          var n = parseInt(m[1], 10);
          if (n < 1 || n > maxN) continue;
          if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
          var sup = document.createElement('sup');
          sup.className = 'cite';
          sup.textContent = '[' + n + ']';
          var c = citations[n - 1];
          sup.title = c ? c.title : '';
          sup.onclick = (function(cit) { return function() { if (cit) openDocPanel(cit.collection, cit.docId, cit.url || ''); }; })(c);
          frag.appendChild(sup);
          last = m.index + m[0].length;
        }
        if (last === 0) return; // no in-range markers replaced
        if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
        textNode.parentNode.replaceChild(frag, textNode);
      });
    }

    function sourcesHtml(citations, cited) {
      if (!citations.length) return '';
      var citedSet = {};
      (cited || []).forEach(function(n) { citedSet[n] = true; });
      var anyCited = (cited || []).length > 0;
      var rows = citations.map(function(c) {
        var uncited = anyCited && !citedSet[c.n] ? ' uncited' : '';
        var rel = (typeof c.relevance === 'number') ? (c.relevance.toFixed(2)) : '';
        // anthropic-summaries citations are docs you curated onto the Learning
        // Center shelf (Curate layer), so flag them apart from the raw firehose.
        var shelf = c.sourceId === 'anthropic'
          ? '<span class="source-shelf" title="A summary you curated onto your shelf">★ your shelf</span>'
          : '';
        // When the citation's collection maps to a registered wiki and its doc
        // resolves to a page (server-enriched: wikiName + pageName), offer an
        // in-reader link. stopPropagation so it doesn't also open the doc panel.
        var wikiLink = (c.wikiName && c.pageName)
          ? '<a class="source-wiki" href="/wiki?wiki=' + encodeURIComponent(c.wikiName) + '&page=' + encodeURIComponent(c.pageName) + '" onclick="event.stopPropagation()" title="Open in the wiki reader">📖 wiki</a>'
          : '';
        return '<div class="source-row' + uncited + '" data-n="' + c.n + '">' +
          '<span class="source-num">' + c.n + '</span>' +
          '<span class="source-badge">' + esc(c.badge || '') + '</span>' +
          '<span class="source-title">' + esc(c.title || c.docId) + '</span>' +
          shelf +
          wikiLink +
          (rel ? '<span class="source-rel">' + rel + '</span>' : '') +
        '</div>';
      }).join('');
      return '<div class="sources-head">Sources</div><div class="sources-list">' + rows + '</div>';
    }

    // Bind each rendered source row to its citation (by data-n) so clicks open the
    // right doc — the rows belong to a specific turn's citation list.
    function bindSources(container, citations) {
      container.querySelectorAll('.source-row').forEach(function(row) {
        var n = parseInt(row.getAttribute('data-n'), 10);
        row.onclick = function() {
          var c = citations[n - 1];
          if (c) openDocPanel(c.collection, c.docId, c.url || '');
        };
      });
    }

    // === Browse (folded, lazy) ===

    async function loadBotCollections() {
      botCollectionNames = [];
      if (selectedBot) {
        try {
          var res = await fetch('/api/research/bot-collections?bot=' + encodeURIComponent(selectedBot));
          if (res.ok) {
            var data = await res.json();
            botCollectionNames = data.collections || [];
          }
        } catch (e) { console.error('Failed to load bot collections', e); }
      }
      await loadCollections();
    }

    async function loadCollections() {
      try {
        var res = await fetch('/api/search/collections');
        if (!res.ok) { document.getElementById('errorBanner').classList.add('visible'); return; }
        document.getElementById('errorBanner').classList.remove('visible');
        var data = await res.json();
        collections = data.collections || [];

        var filtered = collections;
        if (botCollectionNames.length > 0) {
          filtered = collections.filter(function(c) { return botCollectionNames.indexOf(c.name) !== -1; });
        }

        var select = document.getElementById('collectionSelect');
        var prevVal = select.value;
        select.innerHTML = '<option value="">Select a collection...</option>';
        filtered.forEach(function(c) {
          var opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name + ' (' + c.document_count + ' docs)';
          select.appendChild(opt);
        });
        if (prevVal) { select.value = prevVal; }
      } catch (e) {
        console.error('Failed to load collections', e);
        document.getElementById('errorBanner').classList.add('visible');
      }
    }

    async function loadCollection(name) {
      if (!name) {
        document.getElementById('tagChips').innerHTML = '';
        document.getElementById('documentsGrid').innerHTML = '';
        return;
      }
      document.getElementById('tagChips').innerHTML = '<div style="color:var(--text-dim);font-size:13px;">Loading...</div>';
      document.getElementById('documentsGrid').innerHTML = '';
      activeTag = null;

      var [tagsRes, docsRes] = await Promise.all([
        fetch('/api/research/tags?collection=' + encodeURIComponent(name)).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
        fetch('/api/research/documents?collection=' + encodeURIComponent(name)).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; }),
      ]);

      allTags = [];
      if (tagsRes) {
        var collTags = tagsRes[name];
        if (collTags && collTags.tags) {
          allTags = Object.entries(collTags.tags).map(function(entry) {
            return { name: entry[0], count: entry[1] };
          }).sort(function(a, b) { return b.count - a.count; });
        }
      }

      allDocuments = (docsRes && docsRes.documents) ? docsRes.documents : [];
      renderTags();
      renderDocuments();
    }

    function renderTags() {
      var el = document.getElementById('tagChips');
      if (allTags.length === 0) { el.innerHTML = '<div style="color:var(--text-dim);font-size:13px;">No tags available</div>'; return; }
      el.innerHTML = allTags.map(function(t) {
        var active = activeTag === t.name ? ' active' : '';
        return '<span class="cat-chip' + active + '" onclick="toggleTag(this, \\'' + esc(t.name).replace(/'/g, "\\\\'") + '\\')">' + esc(t.name) + ' <span class="chip-count">' + t.count + '</span></span>';
      }).join('');
    }

    function toggleTag(chip, tag) {
      activeTag = activeTag === tag ? null : tag;
      renderTags();
      renderDocuments();
    }

    function renderDocuments() {
      var el = document.getElementById('documentsGrid');
      var docs = allDocuments;
      if (activeTag) {
        docs = docs.filter(function(d) { return d.id && d.id.toLowerCase().includes(activeTag.toLowerCase()); });
      }
      if (docs.length === 0) {
        el.innerHTML = '<div class="browse-empty">No documents' + (activeTag ? ' for tag "' + esc(activeTag) + '"' : '') + '</div>';
        return;
      }
      var collection = document.getElementById('collectionSelect').value;
      el.innerHTML = docs.map(function(d) {
        var title = d.id.split('/').pop().replace(/\\.md$/, '');
        var externalUrl = d.url || '';
        var linkHtml = externalUrl ? '<a class="article-row-link" href="' + esc(externalUrl) + '" target="_blank" onclick="event.stopPropagation()">Open &rarr;</a>' : '';
        return '<div class="article-row" onclick="openDoc(\\'' + esc(collection) + '\\', \\'' + esc(d.id).replace(/'/g, "\\\\'") + '\\', \\'' + esc(externalUrl).replace(/'/g, "\\\\'") + '\\')">' +
          '<span class="article-row-title">' + esc(title) + '</span>' + linkHtml + '</div>';
      }).join('');
    }

    function openDoc(collection, docId, url) {
      openDocPanel(collection, docId, url || '');
    }

    // === Doc panel ===
    ${docPanelScript()}

    // === Init ===

    document.getElementById('askInput').addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); askQuestion(); }
    });

    // Load the browse collections only when the section is first opened.
    document.getElementById('browseDetails').addEventListener('toggle', function() {
      if (this.open && !browseLoaded) { browseLoaded = true; loadBotCollections(); }
    });

    initProfile();

    (async function() {
      await loadBotList();
      var params = new URLSearchParams(window.location.search);
      var q = params.get('q');
      if (q) { document.getElementById('askInput').value = q; askQuestion(); }
    })();
  </script>
</body>
</html>`;
}
