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

/** Returns all thread manager functions as a browser-compatible JS string. */
export function threadManagerScript(): string {
  return `
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

    fetch('/chat/threads', {
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

  // ── Thread list ─────────────────────────────────────────────────────────

  async function loadThreads(autoSelectThreadId) {
    if (!selectedUserId || !selectedBot) {
      threadList.innerHTML = '<div class="empty-state">Select a bot</div>';
      return;
    }

    try {
      var res = await fetch('/chat/threads/' + encodeURIComponent(selectedUserId) + '/' + encodeURIComponent(selectedBot));
      var data = await res.json();
      threads = data.threads || [];
    } catch {
      threads = [];
    }

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
      // Select the most recently active thread (first in the list, already sorted by activity)
      if (threads.length > 0) {
        selectThread(threads[0].id);
      } else {
        renderThreadList();
      }
    } else {
      renderThreadList();
    }
  }

  function renderThreadList() {
    if (threads.length === 0) {
      threadList.innerHTML = '<div class="empty-state">No threads</div>';
      return;
    }

    threadList.innerHTML = threads.map(function(t) {
      var isActive = t.id && t.id === activeThreadId;
      var isPeer = t.name && t.name.indexOf('peer:') === 0;
      var iconClass = isPeer ? 'thread-item-icon peer' : 'thread-item-icon';
      // Satellite antenna for peer threads, # for main, bullet otherwise.
      var icon = isPeer ? '📡' : (t.name === 'main' ? '#' : '&bull;');
      var displayName = isPeer ? t.name.slice('peer:'.length) : t.name;
      var meta = '';
      if (t.messageCount > 0) meta += t.messageCount + ' msgs';

      var deleteBtn = t.name !== 'main'
        ? '<button class="thread-item-delete" data-delete-id="' + escapeAttr(t.id || '') + '" title="Delete thread" tabindex="-1">&times;</button>'
        : '';

      return '<div class="thread-item' + (isActive ? ' active' : '') + (isPeer ? ' peer' : '') + '" data-id="' + escapeAttr(t.id || '') + '">'
        + '<div class="' + iconClass + '">' + icon + '</div>'
        + '<div class="thread-item-content">'
          + '<div class="thread-item-name">' + escapeHtml(displayName) + (isPeer ? ' <span class="thread-item-tag">peer</span>' : '') + '</div>'
          + (t.description ? '<div class="thread-item-desc">' + escapeHtml(t.description) + '</div>' : '')
          + (t.connectorName ? '<div class="thread-item-model">' + escapeHtml(t.connectorName) + '</div>' : '')
          + (meta ? '<div class="thread-item-meta">' + meta + '</div>' : '')
        + '</div>'
        + (t.updatedAt ? '<div class="thread-item-time">' + escapeHtml(timeAgo(t.updatedAt)) + '</div>' : '')
        + deleteBtn
        + '</div>';
    }).join('');

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
        fetch('/chat/threads/' + encodeURIComponent(threadId), { method: 'DELETE' })
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
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].id === threadId) { threadName = threads[i].name; threadDesc = threads[i].description || ''; break; }
    }
    chatHeader.querySelector('.chat-title').textContent =
      (selectedUsername || 'user') + ' \\u00b7 ' + selectedBot + ' \\u00b7 ' + threadName;
    document.getElementById('chatDescription').textContent = threadDesc;
    syncConnectorDropdown();

    // Highlight in sidebar
    renderThreadList();

    // Enable input
    chatInput.disabled = false;
    chatSend.disabled = false;

    // Load messages
    loadThreadMessages(threadId);

    // Update inspector
    updateInspector();
  }
  `;
}
