// A wiki thread's page bar in /chat (Discuss v3 P4) — a browser JS string for
// injection INSIDE the CHAT_SCRIPT IIFE, after threadManagerScript().
//
// What the reader pane's Discuss tab had, so /chat can read the whole thread
// once the tab is gone (P6): the page named (title · wiki · «↩ Back to the
// page»), «Start over» (closes through the tab's route; /chat cannot open the
// next thread, D14), «Earlier discussions» (the page's closed threads, from the
// thread read's list-only form), an Explain question drawn as a chip from its
// ledger row, and «⌘ Continue in Claude Code» under the last answer.
//
// Relies on IIFE-scoped names declared elsewhere:
//   State:   threads, activeThreadId, activeConvId, conversations
//   DOM:     chatMessages, chatInput, chatSend
//   Helpers: escapeHtml, escapeAttr, authedFetch
//   Funcs:   findThread, isWikiThread, isClosedWikiThread, lookUpLinkedThread,
//            selectThread
// Every DOM lookup is inside a function, so a harness can load the script with
// no page around it.

import { EXPLAIN_QUESTION } from "../../../wiki/discuss-bounds.ts";

/** The routes the bar calls; the Discuss routes' own paths. */
export const CHAT_WIKI_THREAD_PATH = "/api/wiki/discuss/thread";
export const CHAT_WIKI_CLOSE_PATH = "/api/wiki/discuss/thread/close";
export const CHAT_WIKI_CONTINUE_PATH = "/api/wiki/discuss/continue";

/** What a closed wiki thread's box and bar say (D14). */
export const CHAT_WIKI_CLOSED_TEXT = "Closed with Start over: the page's next question starts a new discussion.";

export function wikiThreadBarScript(): string {
  return `
  var WIKI_EXPLAIN_QUESTION = ${JSON.stringify(EXPLAIN_QUESTION)};
  var WIKI_CLOSED_TEXT = ${JSON.stringify(CHAT_WIKI_CLOSED_TEXT)};
  // The page the active wiki thread's read named ({threadId, wiki, relPath,
  // traceKey, title}), and that read's newest turn id (Continue's turn).
  var activeWikiPage = null;
  var wikiLastTurnId = null;

  function wikiPageHref(wiki, relPath, turnId) {
    return '/wiki?wiki=' + encodeURIComponent(wiki || '') + '&relPath=' + encodeURIComponent(relPath || '')
      + (turnId ? '&turn=' + encodeURIComponent(turnId) : '');
  }

  // An Explain turn's user message as a chip linking to the page at its card
  // (\`&turn=\`, which the reader resolves once P5 lands; until then it opens
  // the page). From the joined ledger fields only: the stored text is never parsed.
  function wikiTurnChip(msg) {
    if (!msg || msg.sender !== 'user' || !msg.turn || msg.turn.question !== WIKI_EXPLAIN_QUESTION) return null;
    var page = activeWikiPage;
    if (!page || !page.relPath || (msg.threadId && msg.threadId !== page.threadId)) return null;
    var a = document.createElement('a');
    a.className = 'chat-explain-chip';
    a.href = wikiPageHref(page.wiki, page.relPath, msg.turn.id);
    a.dataset.explainTurn = msg.turn.id;
    var passage = typeof msg.turn.passage === 'string' ? msg.turn.passage.replace(/\\s+/g, ' ').trim() : '';
    a.textContent = '\\u2728 Explain' + (passage ? ' \\u00b7 \\u00ab' + passage + '\\u00bb' : '');
    if (passage) a.title = passage;
    return a;
  }

  // Called on every thread switch (page null until the read answers) and again
  // once the message read answers (fromRead: its \`wikiPage\`, or null when it
  // named none). Hidden on any other thread.
  function renderWikiBar(threadId, page, fromRead) {
    var bar = document.getElementById('chatWikiBar');
    if (!bar) return;
    var t = findThread(threadId);
    if (!t || t.kind !== 'wiki') {
      bar.hidden = true;
      bar.innerHTML = '';
      activeWikiPage = null;
      wikiLastTurnId = null;
      return;
    }
    var p = page || { wiki: t.wiki || '', relPath: t.relPath || null, traceKey: t.traceKey || null, title: null };
    activeWikiPage = { threadId: threadId, wiki: p.wiki, relPath: p.relPath, traceKey: p.traceKey, title: p.title };
    var closed = isClosedWikiThread(threadId);
    var name = p.relPath ? (p.title || p.relPath) : ('trace: ' + (p.traceKey || ''));
    var html = '<div class="chat-wiki-bar-row">'
      + '<span class="chat-wiki-page" data-wiki-page-title>' + escapeHtml(name) + '</span>'
      + '<span class="chat-wiki-name">' + escapeHtml(p.wiki || '') + '</span>'
      + (p.relPath ? '<a class="chat-wiki-back" data-wiki-back href="' + escapeAttr(wikiPageHref(p.wiki, p.relPath)) + '">\\u21a9 Back to the page</a>' : '')
      + (p.relPath && !closed ? '<button type="button" class="chat-wiki-btn" data-wiki-start-over>Start over</button>' : '')
      + '<span class="chat-wiki-earlier-slot" data-wiki-earlier-slot></span>'
      + '</div>'
      + (closed ? '<div class="chat-wiki-closed" data-wiki-closed>' + escapeHtml(WIKI_CLOSED_TEXT) + '</div>' : '')
      + '<div class="chat-wiki-error" data-wiki-bar-error hidden></div>';
    bar.innerHTML = html;
    bar.hidden = false;
    var so = bar.querySelector('[data-wiki-start-over]');
    if (so) so.onclick = function() { wikiStartOver(threadId); };
    // Once per switch: on the read's render, not the switch's first one.
    if (p.relPath && fromRead) loadWikiEarlier(threadId, t);
  }

  function wikiBarError(text) {
    var el = document.querySelector('#chatWikiBar [data-wiki-bar-error]');
    if (!el) return;
    el.textContent = text || '';
    el.hidden = !text;
  }

  // «Earlier discussions»: the page's closed threads for the thread's own user,
  // from the thread read's list-only form; each opens here, read-only.
  async function loadWikiEarlier(threadId, t) {
    var url = ${JSON.stringify(CHAT_WIKI_THREAD_PATH)} + '?closed=1&wiki=' + encodeURIComponent(t.wiki || '')
      + '&relPath=' + encodeURIComponent(t.relPath || '') + (t.userId ? '&userId=' + encodeURIComponent(t.userId) : '');
    var data = null;
    try {
      var res = await authedFetch(url);
      if (res.ok) data = await res.json();
    } catch {}
    if (activeThreadId !== threadId) return;
    var slot = document.querySelector('#chatWikiBar [data-wiki-earlier-slot]');
    if (!slot || !data || !Array.isArray(data.closed) || data.closed.length === 0) return;
    var total = typeof data.closedTotal === 'number' ? data.closedTotal : data.closed.length;
    var items = data.closed.map(function(c) {
      var when = c.closedAt ? new Date(c.closedAt).toLocaleString() : '';
      var current = c.id === threadId;
      return '<li><button type="button" class="chat-wiki-earlier-item' + (current ? ' current' : '') + '" data-wiki-earlier="' + escapeAttr(c.id) + '"'
        + (current ? ' aria-current="true"' : '') + '>' + escapeHtml((current ? 'This discussion' : 'Closed') + (when ? ' ' + when : '')) + '</button></li>';
    }).join('');
    var more = total > data.closed.length ? '<li class="chat-wiki-earlier-more">' + escapeHtml((total - data.closed.length) + ' older not shown') + '</li>' : '';
    slot.innerHTML = '<details class="chat-wiki-earlier" data-wiki-earlier-list><summary>Earlier discussions (' + total + ')</summary><ul>' + items + more + '</ul></details>';
    slot.querySelectorAll('[data-wiki-earlier]').forEach(function(btn) {
      btn.onclick = async function() {
        var id = btn.getAttribute('data-wiki-earlier');
        if (!id || id === activeThreadId) return;
        await lookUpLinkedThread(id);
        if (findThread(id)) selectThread(id);
      };
    });
  }

  // «Start over»: the tab's close route. The thread stays readable here, read-only;
  // the page's next Explain or question opens the new one (D14).
  async function wikiStartOver(threadId) {
    var conv = conversations[activeConvId];
    if (conv && conv.status) { wikiBarError('A turn is still running on this discussion; start over once it has ended.'); return; }
    var btn = document.querySelector('#chatWikiBar [data-wiki-start-over]');
    if (btn) btn.disabled = true;
    var error = '';
    try {
      var res = await authedFetch(${JSON.stringify(CHAT_WIKI_CLOSE_PATH)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: threadId }),
      });
      if (!res.ok) {
        var body = null;
        try { body = await res.json(); } catch {}
        error = body && typeof body.error === 'string' ? body.error : 'status ' + res.status;
      }
    } catch {
      error = 'the server did not answer';
    }
    // A thread closed elsewhere is just as closed here.
    if (error && !/no live wiki thread/.test(error)) {
      if (btn) btn.disabled = false;
      wikiBarError('Start over failed: ' + error + '.');
      return;
    }
    var t = findThread(threadId);
    if (t) t.closedAt = Date.now();
    if (activeThreadId === threadId) selectThread(threadId);
    else renderThreadList();
  }

  // The read's turns: the newest one is Continue's, and a live user bubble
  // that the read now knows as an Explain turn becomes its chip.
  function applyWikiTurns(threadId, msgs) {
    if (activeThreadId !== threadId) return;
    wikiLastTurnId = null;
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (!m || !m.turn) continue;
      wikiLastTurnId = m.turn.id;
      var bubble = chatMessages.querySelector('.msg-user[data-user-message-id="' + escapeAttr(m.id) + '"]');
      if (bubble && !bubble.querySelector('.chat-explain-chip')) {
        var chip = wikiTurnChip(m);
        var body = bubble.querySelector('.msg-body');
        if (chip && body) { body.textContent = ''; body.appendChild(chip); }
      }
    }
    placeWikiContinue();
  }

  // «⌘ Continue in Claude Code» under the last answer (D4), naming the newest turn.
  function placeWikiContinue() {
    var old = chatMessages.querySelector('.chat-wiki-continue');
    if (old) old.remove();
    if (!wikiLastTurnId || !isWikiThread(activeThreadId)) return;
    var bots = chatMessages.querySelectorAll('.msg-bot');
    var last = bots.length ? bots[bots.length - 1] : null;
    if (!last) return;
    var box = document.createElement('div');
    box.className = 'chat-wiki-continue';
    box.innerHTML = '<button type="button" class="chat-wiki-btn" data-chat-continue>\\u2318 Continue in Claude Code</button>'
      + '<span class="chat-wiki-cont-status" data-chat-continue-status></span>';
    var turnId = wikiLastTurnId;
    box.querySelector('[data-chat-continue]').onclick = function() { wikiContinue(box, turnId); };
    last.parentNode.insertBefore(box, last.nextSibling);
  }

  async function wikiCopyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch {}
    return false;
  }

  async function wikiContinue(box, turnId) {
    var btn = box.querySelector('[data-chat-continue]');
    var status = box.querySelector('[data-chat-continue-status]');
    if (btn.disabled) return;
    btn.disabled = true;
    status.textContent = 'Building the prompt\\u2026';
    var prompt = null;
    try {
      var res = await authedFetch(${JSON.stringify(CHAT_WIKI_CONTINUE_PATH)}, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ turnId: turnId }),
      });
      var data = null;
      try { data = await res.json(); } catch {}
      if (res.ok && data && typeof data.prompt === 'string') prompt = data.prompt;
      else status.textContent = data && typeof data.error === 'string' ? data.error + ' (' + res.status + ')' : 'The prompt could not be built (' + res.status + ').';
    } catch {
      status.textContent = 'The prompt could not be built: the server did not answer.';
    }
    btn.disabled = false;
    if (prompt === null) return;
    if (await wikiCopyText(prompt)) {
      status.textContent = 'Copied, ' + prompt.length + ' characters. Paste it into Claude Code.';
      return;
    }
    status.textContent = 'Copy failed. The prompt is below: copy it by hand.';
    var out = box.querySelector('textarea') || document.createElement('textarea');
    out.className = 'chat-wiki-cont-out';
    out.readOnly = true;
    out.value = prompt;
    box.appendChild(out);
    out.focus();
    out.select();
  }

  // A live answer on the active wiki thread: read the turns again for
  // Continue's turn and any new chip (live messages carry no turn).
  async function refreshWikiTurns(threadId) {
    if (!activeConvId || !threadId) return;
    try {
      var res = await authedFetch('/chat/conversations/' + activeConvId + '/messages?thread=' + encodeURIComponent(threadId));
      if (!res.ok) return;
      var data = await res.json();
      applyWikiTurns(threadId, data.messages || []);
    } catch {}
  }
  `;
}
