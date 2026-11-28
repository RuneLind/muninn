// Thread manager functions — exported as a browser-compatible JS string
// for injection INSIDE the CHAT_SCRIPT IIFE via ${threadManagerScript()}.
//
// Manages thread sidebar (load, render, select, delete) and the
// new-thread modal (open, close, submit).
//
// Relies on IIFE-scoped variables declared elsewhere:
//   State:   threads, activeThreadId, selectedBot, selectedUserId,
//            selectedUsername, selectedConnectorId, connectors, activeConvId
//   DOM:     threadList, chatInput, chatSend, chatHeader, chatMessages
//   Helpers: escapeHtml, escapeAttr, timeAgo
//   Funcs:   loadThreadMessages, updateInspector, syncConnectorDropdown,
//            clearChat, scrollToBottom, setChatStatusText
//
// Defines for the other scripts (threadKindScript): findThread, isWikiThread,
// isClosedWikiThread, wikiAnswerForThread. Uses wiki-thread-bar.ts's
// renderWikiBar and WIKI_CLOSED_TEXT (a closed wiki thread's placeholder).

import { EARLIER_EDIT_NOTE, STORED_EDIT_MARKER } from "../../../wiki/discuss-bounds.ts";

/**
 * What /chat knows of a thread's kind, over the IIFE's `threads`: a wiki
 * page's Discuss thread (`kind = 'wiki'`, Discuss v2) runs on the Discuss
 * engine only, so the connector selector, the stamp and «Lag Jira-sak» stay out
 * of it, and a closed one is read-only. Its own export so a harness can load it
 * without the rest of the thread manager.
 */
export function threadKindScript(): string {
  return `
  function findThread(threadId) {
    if (!threadId) return null;
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === threadId) return threads[i];
    }
    return null;
  }
  function isWikiThread(threadId) {
    var t = findThread(threadId);
    return !!t && t.kind === 'wiki';
  }
  function isClosedWikiThread(threadId) {
    var t = findThread(threadId);
    return !!t && t.kind === 'wiki' && !!t.closedAt;
  }
  // A stored wiki answer carries the edit marker in place of its edit block,
  // pointing to the page's Discuss tab. A closed thread has no Apply there, so
  // its answers say what «Earlier discussions» says. With html set, the text
  // is formatWebHtml output (a web conversation's assistant row); else markdown.
  var WIKI_STORED_EDIT_MARKER = ${JSON.stringify(STORED_EDIT_MARKER)};
  var WIKI_EARLIER_EDIT_NOTE = ${JSON.stringify(EARLIER_EDIT_NOTE)};
  function wikiAnswerForThread(threadId, text, html) {
    if (typeof text !== 'string' || !isClosedWikiThread(threadId)) return text;
    var marker = html ? formatWebHtml(WIKI_STORED_EDIT_MARKER) : WIKI_STORED_EDIT_MARKER;
    if (text.indexOf(marker) === -1) return text;
    return text.split(marker).join(html ? formatWebHtml(WIKI_EARLIER_EDIT_NOTE) : WIKI_EARLIER_EDIT_NOTE);
  }
  `;
}

/** Returns all thread manager functions as a browser-compatible JS string. */
export function threadManagerScript(): string {
  return `
  ${threadKindScript()}
  // ── Thread modal DOM refs ───────────────────────────────────────────────

  var threadModal = document.getElementById('threadModalBackdrop');
  var threadModalName = document.getElementById('threadModalName');
  var threadModalDesc = document.getElementById('threadModalDesc');
  var threadModalConnector = document.getElementById('threadModalConnector');
  var threadConnectorHint = document.getElementById('threadConnectorHint');

  // ── Thread modal functions ──────────────────────────────────────────────

  function openThreadModal() {
    if (!selectedBot || !selectedUserId) return;
    threadModalName.value = '';
    threadModalDesc.value = '';
    // Populate connector dropdown
    threadModalConnector.innerHTML = '<option value="">Bot default</option>';
    connectors.forEach(function(c) {
      var label = c.name;
      if (c.model) label += ' (' + c.model + ')';
      var opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = label;
      threadModalConnector.appendChild(opt);
    });
    // Pre-fill from sidebar connector selection
    threadModalConnector.value = selectedConnectorId;
    threadModalConnector.dispatchEvent(new Event('change'));
    threadModal.classList.add('visible');
    threadModalName.focus();
  }

  function closeThreadModal() {
    threadModal.classList.remove('visible');
  }

  threadModalConnector.addEventListener('change', function() {
    var id = threadModalConnector.value;
    if (!id) { threadConnectorHint.textContent = ''; return; }
    var c = connectors.find(function(x) { return x.id === id; });
    if (c) {
      var hint = c.connectorType;
      if (c.model) hint += ' \\u00b7 ' + c.model;
      threadConnectorHint.textContent = hint;
    }
  });

  function submitThreadModal() {
    var name = threadModalName.value.trim();
    if (!name) { alert('Thread name is required'); return; }
    var desc = threadModalDesc.value.trim() || undefined;
    var connId = threadModalConnector.value || undefined;

    authedFetch('/chat/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: selectedUserId,
        botName: selectedBot,
        name: name,
        description: desc,
        connectorId: connId,
      }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) {
        alert('Failed to create thread: ' + data.error);
        return;
      }
      closeThreadModal();
      if (data.thread) {
        loadThreads(data.thread.id);
      }
    }).catch(function() { alert('Failed to create thread'); });
  }

  document.getElementById('newThreadBtn').onclick = openThreadModal;
  document.getElementById('threadModalClose').onclick = closeThreadModal;
  document.getElementById('threadModalCancel').onclick = closeThreadModal;
  document.getElementById('threadModalSave').onclick = submitThreadModal;
  threadModal.onclick = function(e) { if (e.target === threadModal) closeThreadModal(); };
  threadModalName.addEventListener('keydown', function(e) { if (e.key === 'Enter') submitThreadModal(); });

  // ── Peer thread label helper ────────────────────────────────────────────

  // Strip the \`peer:\` prefix and, when the active bot has at most one
  // configured hivemind namespace, the leading \`<ns>/\` segment too.
  // Returns the raw name unchanged when it isn't a peer thread.
  function peerDisplayName(threadName, bot) {
    if (!threadName || threadName.indexOf('peer:') !== 0) return threadName;
    var label = threadName.slice('peer:'.length);
    if (bot && bot.hivemindNamespaceCount <= 1) {
      var slashIdx = label.indexOf('/');
      if (slashIdx >= 0) label = label.slice(slashIdx + 1);
    }
    return label;
  }

  // ── Thread list ─────────────────────────────────────────────────────────

  async function loadThreads(autoSelectThreadId) {
    if (!selectedUserId || !selectedBot) {
      threadList.innerHTML = '<div class="empty-state">Select a bot</div>';
      return;
    }

    try {
      var res = await authedFetch('/chat/threads/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(selectedBot));
      var data = await res.json();
      threads = data.threads || [];
    } catch {
      threads = [];
    }
    if (autoSelectThreadId) await lookUpLinkedThread(autoSelectThreadId);

    // DB sorts by COALESCE(last_activity, created_at) DESC — most recent
    // activity on top, new threads without messages sort by creation time.

    // Threads should always exist (created during hydration), but handle edge case
    if (threads.length === 0) {
      threadList.innerHTML = '<div class="empty-state">No threads</div>';
      return;
    }

    // Auto-select (selectThread calls renderThreadList internally)
    if (autoSelectThreadId) {
      selectThread(autoSelectThreadId);
    } else if (!activeThreadId) {
      // Select the most recently active thread (first in the list, already sorted by
      // activity), a chat thread before a wiki page's Discuss thread
      var firstChat = threads.find(function(t) { return t.kind !== 'wiki'; });
      if (threads.length > 0) {
        selectThread((firstChat || threads[0]).id);
      } else {
        renderThreadList();
      }
    } else {
      renderThreadList();
    }
  }

  // A deep link can name a wiki thread the list leaves out (closed by «Start
  // over»). Looked up by id, it joins \`threads\` so isWikiThread knows it;
  // renderThreadList never lists a closed one. A chat thread the list leaves
  // out (\`slack:\`) stays unknown, as before.
  async function lookUpLinkedThread(threadId) {
    if (findThread(threadId)) return;
    try {
      var res = await authedFetch('/chat/threads/' + encodeURIComponent(threadId));
      if (!res.ok) return;
      var data = await res.json();
      if (data && data.thread && data.thread.id === threadId && data.thread.kind === 'wiki') threads.push(data.thread);
    } catch {}
  }

  function renderThreadList() {
    if (threads.length === 0) {
      threadList.innerHTML = '<div class="empty-state">No threads</div>';
      return;
    }

    var currentBot = bots.find(function(b) { return b.name === selectedBot; });

    // A wiki page's Discuss threads (Discuss v2) go under their own «Wiki»
    // heading after the chat threads; a closed one is never listed (the server
    // leaves it out, and this filter backs that up).
    var chatThreads = threads.filter(function(t) { return t.kind !== 'wiki'; });
    var wikiThreads = threads.filter(function(t) { return t.kind === 'wiki' && !t.closedAt; });

    function threadItemHtml(t) {
      var isActive = t.id && t.id === activeThreadId;
      var isPeer = t.name && t.name.indexOf('peer:') === 0;
      var isPaused = isPeer && t.autoRespondPaused === true;
      var displayName = isPeer ? peerDisplayName(t.name, currentBot) : t.name;

      var dotClass = 'thread-item-dot' + (isPeer ? ' peer' : '') + (isPaused ? ' paused' : '');

      var chips = '';
      if (t.connectorName) chips += '<span class="thread-chip">' + escapeHtml(t.connectorName) + '</span>';
      if (t.messageCount > 0) chips += '<span class="thread-chip count">' + t.messageCount + ' msgs</span>';

      var deleteBtn = t.name !== 'main'
        ? '<button class="thread-item-delete" data-delete-id="' + escapeAttr(t.id || '') + '" title="Delete thread" tabindex="-1">&times;</button>'
        : '';

      var classes = 'thread-item'
        + (t.kind === 'wiki' ? ' wiki' : '')
        + (isActive ? ' active' : '')
        + (isPeer ? ' peer' : '')
        + (isPaused ? ' paused' : '');

      return '<div class="' + classes + '" data-id="' + escapeAttr(t.id || '') + '">'
        + '<div class="thread-item-top">'
          + '<span class="' + dotClass + '"></span>'
          + '<span class="thread-item-name">' + escapeHtml(displayName) + (isPeer ? ' <span class="thread-item-tag">peer</span>' : '') + '</span>'
          + (t.updatedAt ? '<span class="thread-item-time">' + escapeHtml(timeAgo(t.updatedAt)) + '</span>' : '')
          + deleteBtn
        + '</div>'
        + (t.description ? '<div class="thread-item-desc">' + escapeHtml(t.description) + '</div>' : '')
        + (chips ? '<div class="thread-item-chips">' + chips + '</div>' : '')
        + '</div>';
    }

    threadList.innerHTML = chatThreads.map(threadItemHtml).join('')
      + (wikiThreads.length
        ? '<div class="thread-group-label" title="Discuss threads of wiki pages: each runs on its wiki agent">Wiki</div>'
          + wikiThreads.map(threadItemHtml).join('')
        : '');

    threadList.querySelectorAll('.thread-item').forEach(function(el) {
      el.onclick = function() {
        var tid = el.dataset.id;
        if (tid) selectThread(tid);
      };
    });

    threadList.querySelectorAll('.thread-item-delete').forEach(function(btn) {
      btn.onclick = function(e) {
        e.stopPropagation();
        var threadId = btn.dataset.deleteId;
        if (!threadId) return;
        var threadName = '';
        for (var i = 0; i < threads.length; i++) {
          if (threads[i].id === threadId) { threadName = threads[i].name; break; }
        }
        if (!confirm('Delete thread "' + threadName + '" and all its messages?')) return;
        authedFetch('/chat/threads/' + encodeURIComponent(threadId), { method: 'DELETE' })
          .then(function(res) {
            if (!res.ok) throw new Error('Failed to delete');
            threads = threads.filter(function(t) { return t.id !== threadId; });
            if (activeThreadId === threadId) {
              var mainThread = threads.find(function(t) { return t.name === 'main'; });
              if (mainThread) { selectThread(mainThread.id); }
              else { clearChat(); renderThreadList(); }
            } else {
              renderThreadList();
            }
          })
          .catch(function() { alert('Could not delete thread'); });
      };
    });
  }

  function selectThread(threadId) {
    activeThreadId = threadId;

    // Update header
    var threadName = 'main';
    var threadDesc = '';
    var activeThread = null;
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === threadId) {
        threadName = threads[i].name;
        threadDesc = threads[i].description || '';
        activeThread = threads[i];
        break;
      }
    }
    var headerThreadName = threadName;
    if (headerThreadName && headerThreadName.indexOf('peer:') === 0) {
      var hdrBot = bots.find(function(b) { return b.name === selectedBot; });
      headerThreadName = 'peer:' + peerDisplayName(headerThreadName, hdrBot);
    }
    var closedWiki = isClosedWikiThread(threadId);
    if (closedWiki) headerThreadName += ' (closed)';
    chatHeader.querySelector('.chat-title').textContent =
      (selectedUsername || 'user') + ' \\u00b7 ' + selectedBot + ' \\u00b7 ' + headerThreadName;
    document.getElementById('chatDescription').textContent = threadDesc;
    syncConnectorDropdown();
    renderAutoRespondPill(activeThread);

    // Highlight in sidebar
    renderThreadList();

    // Enable input; a closed wiki thread is read-only (its page starts a new one)
    chatInput.disabled = closedWiki;
    chatSend.disabled = closedWiki;
    chatInput.placeholder = closedWiki ? WIKI_CLOSED_TEXT : 'Type a message...';
    // A wiki thread's page bar (wiki-thread-bar.ts); the message read fills in its title.
    renderWikiBar(threadId, null, false);

    // Load messages
    loadThreadMessages(threadId);

    // Update inspector
    updateInspector();
  }

  // ── Auto-respond pill (peer threads only) ───────────────────────────────

  var autoRespondPill = document.getElementById('autoRespondPill');

  function renderAutoRespondPill(thread) {
    if (!thread || !thread.name || thread.name.indexOf('peer:') !== 0) {
      autoRespondPill.hidden = true;
      autoRespondPill.classList.remove('paused');
      return;
    }
    var paused = thread.autoRespondPaused === true;
    autoRespondPill.hidden = false;
    autoRespondPill.classList.toggle('paused', paused);
    if (paused) {
      var reason = thread.pauseReason ? ' \\u00b7 ' + thread.pauseReason : '';
      autoRespondPill.textContent = 'Auto-respond: PAUSED' + reason;
      autoRespondPill.title = 'Click to resume autorespond for this peer thread';
    } else {
      autoRespondPill.textContent = 'Auto-respond: ON';
      autoRespondPill.title = 'Click to pause autorespond for this peer thread';
    }
  }

  autoRespondPill.onclick = function() {
    if (!activeThreadId) return;
    var current = null;
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === activeThreadId) { current = threads[i]; break; }
    }
    if (!current) return;
    var nextPaused = current.autoRespondPaused !== true;
    autoRespondPill.disabled = true;
    authedFetch('/chat/threads/' + encodeURIComponent(activeThreadId) + '/auto-respond', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused: nextPaused }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.error) { alert('Failed to update: ' + data.error); return; }
      if (data.thread) {
        for (var i = 0; i < threads.length; i++) {
          if (threads[i].id === data.thread.id) { threads[i] = data.thread; break; }
        }
        renderAutoRespondPill(data.thread);
        renderThreadList();
      }
    }).catch(function() { alert('Failed to update auto-respond'); })
      .finally(function() { autoRespondPill.disabled = false; });
  };
  `;
}
