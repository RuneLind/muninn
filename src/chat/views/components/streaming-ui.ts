// Streaming UI functions — exported as a JS string for browser injection via streamingUiScript().
// Injected INSIDE the CHAT_SCRIPT IIFE — has access to IIFE-scoped variables
// (chatMessages, chatStatus, activeConvId, conversations, scrollToBottom, formatWebHtml,
//  sanitizeHtml, escapeHtml, fmtNum, activeToolContainer, activeToolCount, bots, selectedBot,
//  lastResponseMeta, updateInspectorContextUsage, updateInspectorToolUsage, loadToolUsageStats,
//  augmentIndexLinks, fmtMs, toggleToolActivity, streamingRawText, streamingRafPending, etc.).

/** Returns all streaming UI functions as a browser-compatible JS string. */
export function streamingUiScript(): string {
  return `
  // ── Streaming state ──────────────────────────────────────────────────
  var streamingRawText = '';
  var streamingRafPending = false;

  // ── Typing indicator ─────────────────────────────────────────────────

  function updateTypingIndicator(status) {
    var existing = chatMessages.querySelector('.typing-indicator');
    if (existing) existing.remove();
    if (status && status.length > 0) {
      var indicator = document.createElement('div');
      indicator.className = 'typing-indicator';
      indicator.innerHTML = '<span></span><span></span><span></span>';
      chatMessages.appendChild(indicator);
      scrollToBottom();
    }
  }

  // ── Streaming bubble helpers ─────────────────────────────────────────

  function appendStreamingDelta(delta) {
    var bubble = chatMessages.querySelector('.msg-streaming');
    var conv = conversations[activeConvId];
    var isWeb = conv && conv.type === 'web';
    if (!bubble) {
      var typing = chatMessages.querySelector('.typing-indicator');
      if (typing) typing.remove();
      bubble = document.createElement('div');
      bubble.className = 'msg-streaming' + (isWeb ? ' web web-content' : '');
      chatMessages.appendChild(bubble);
    }
    if (isWeb) {
      streamingRawText += delta;
      if (!streamingRafPending) {
        streamingRafPending = true;
        requestAnimationFrame(function() {
          streamingRafPending = false;
          var b = chatMessages.querySelector('.msg-streaming');
          if (b) b.innerHTML = sanitizeHtml(formatWebHtml(streamingRawText), true);
          scrollToBottom();
        });
      }
    } else {
      streamingRawText += delta;
      bubble.textContent += delta;
      scrollToBottom();
    }
  }

  // Promote streaming bubble to a permanent intermediate message (kept visible during tool calls)
  function promoteStreamingBubble() {
    var bubble = chatMessages.querySelector('.msg-streaming');
    if (!bubble || !streamingRawText.trim()) {
      // Nothing meaningful to promote — just clean up
      if (bubble) bubble.remove();
      streamingRawText = '';
      streamingRafPending = false;
      return;
    }
    var conv = conversations[activeConvId];
    var isWeb = bubble.classList.contains('web');
    // Finalize HTML content
    if (isWeb) {
      bubble.innerHTML = sanitizeHtml(formatWebHtml(streamingRawText), true);
      enhanceCodeTabs(bubble); enhanceCodeBlocks(bubble);
      augmentIndexLinks(bubble);
      augmentIssueLinks(bubble);
    }
    // Convert from streaming to permanent intermediate message with platform class
    bubble.classList.remove('msg-streaming');
    bubble.classList.add('msg', 'msg-bot', 'msg-intermediate');
    if (!isWeb && conv) {
      var isTg = conv.type.startsWith('telegram');
      bubble.classList.add(isTg ? 'telegram' : 'slack');
    }
    streamingRawText = '';
    streamingRafPending = false;
  }

  function removeStreamingBubble() {
    var bubble = chatMessages.querySelector('.msg-streaming');
    if (bubble) bubble.remove();
    streamingRawText = '';
    streamingRafPending = false;
  }

  // ── Tool activity container ──────────────────────────────────────────

  // Create or get the active tool-activity container for live tool events
  function getOrCreateToolContainer() {
    if (activeToolContainer) return activeToolContainer;
    var container = document.createElement('div');
    container.className = 'tool-activity';
    var header = document.createElement('div');
    header.className = 'tool-activity-header';
    header.onclick = function() { toggleToolActivity(container); };
    var label = document.createElement('span');
    label.className = 'tool-activity-label';
    label.textContent = 'Working...';
    var toggle = document.createElement('span');
    toggle.className = 'tool-activity-toggle';
    toggle.textContent = '\\u25BC';
    header.appendChild(label);
    header.appendChild(toggle);
    var body = document.createElement('div');
    body.className = 'tool-activity-body';
    container.appendChild(header);
    container.appendChild(body);
    chatMessages.appendChild(container);
    activeToolContainer = container;
    activeToolCount = 0;
    return container;
  }

  function toggleToolActivity(container) {
    container.classList.toggle('collapsed');
    var toggle = container.querySelector('.tool-activity-toggle');
    if (toggle) toggle.textContent = container.classList.contains('collapsed') ? '\\u25B6' : '\\u25BC';
  }

  function collapseToolActivity() {
    if (!activeToolContainer) return;
    activeToolContainer.classList.add('collapsed');
    var toggle = activeToolContainer.querySelector('.tool-activity-toggle');
    if (toggle) toggle.textContent = '\\u25B6';
    // Update label with summary
    var label = activeToolContainer.querySelector('.tool-activity-label');
    if (label) {
      label.textContent = 'Used ' + activeToolCount + ' tool' + (activeToolCount !== 1 ? 's' : '');
    }
    activeToolContainer = null;
    activeToolCount = 0;
  }

  // ── Intent + tool status ─────────────────────────────────────────────

  // Show or update an intent bubble (what the AI plans to do)
  function showIntentBubble(text) {
    var container = getOrCreateToolContainer();
    var body = container.querySelector('.tool-activity-body');
    var existing = body.querySelector('.msg-intent');
    if (existing) {
      existing.textContent = text;
    } else {
      var bubble = document.createElement('div');
      bubble.className = 'msg-intent';
      bubble.textContent = text;
      body.appendChild(bubble);
    }
    scrollToBottom();
  }

  // Set the chat header status text with label/detail styling
  function setChatStatusText(text) {
    if (!text) {
      chatStatus.innerHTML = '';
      return;
    }
    var colonIdx = text.indexOf(': ');
    if (colonIdx > 0 && colonIdx < 60) {
      chatStatus.innerHTML =
        '<span class="status-label">' + escapeHtml(text.slice(0, colonIdx)) + ': </span>' +
        '<span class="status-detail">' + escapeHtml(text.slice(colonIdx + 2)) + '</span>';
    } else {
      chatStatus.textContent = text;
    }
  }

  // Build a tool-status line DOM element from text
  function createToolStatusLine(text) {
    var line = document.createElement('div');
    line.className = 'msg-tool-status';
    var colonIdx = text.indexOf(': ');
    if (colonIdx > 0 && colonIdx < 60) {
      var labelSpan = document.createElement('span');
      labelSpan.className = 'tool-label';
      labelSpan.textContent = text.slice(0, colonIdx) + ': ';
      var detailSpan = document.createElement('span');
      detailSpan.className = 'tool-detail';
      detailSpan.textContent = text.slice(colonIdx + 2);
      line.appendChild(labelSpan);
      line.appendChild(detailSpan);
    } else {
      line.textContent = text;
    }
    return line;
  }

  // Append a tool status line to the active tool-activity container
  function appendToolStatus(text) {
    var container = getOrCreateToolContainer();
    var body = container.querySelector('.tool-activity-body');
    body.appendChild(createToolStatusLine(text));
    activeToolCount++;
    // Update header label with running count
    var label = container.querySelector('.tool-activity-label');
    if (label) label.textContent = 'Using ' + activeToolCount + ' tool' + (activeToolCount !== 1 ? 's' : '') + '...';
    scrollToBottom();
  }

  // ── Response metadata ────────────────────────────────────────────────

  // Apply response metadata: update the inspector and stamp the model into the
  // last bot message's header. Per-turn token/duration now live in the inspector
  // ("Last response") and the header pill, so no per-message meta bar is rendered.
  // The bubble a response_meta describes.
  //
  // **By the id the server echoes, never by position.** The server mints a
  // throwaway client id for every bubble it renders (ChatState.appendBotMessage)
  // and hands the last one back on the meta event; appendMessage stamps it as
  // data-client-id. Picking "the last .msg-bot" instead is wrong whenever two
  // turns are in flight in one thread — sendMessage has no in-flight guard, and
  // a reloaded tab cannot know a turn is running, so an ordinary message sent
  // during a 60–600 s Jira draft turn produced two metas that both resolved to
  // whichever reply happened to be last, landing the draft's binding on an
  // unrelated message.
  //
  // The positional fallback stays for the one case NO id can cover: a meta from
  // a turn whose bubble this tab never rendered at all, where "the last one" is
  // still the best guess and was the whole behaviour before.
  function botMessageForMeta(meta) {
    if (meta.clientMessageId) {
      var byId = chatMessages.querySelector(
        '.msg-bot:not(.msg-intermediate)[data-client-id="' + cssAttrValue(meta.clientMessageId) + '"]'
      );
      if (byId) return byId;
    }
    // REPLAYED history stamps the DB row id into data-client-id (appendMessage),
    // and a meta for such a turn names a throwaway client id this tab never
    // rendered — the second-tab and reconnect case. The row id still addresses
    // the bubble, so this is an id lookup, not a guess.
    if (meta.messageId) {
      var byRowId = chatMessages.querySelector(
        '.msg-bot:not(.msg-intermediate)[data-client-id="' + cssAttrValue(meta.messageId) + '"]'
      );
      if (byRowId) return byRowId;
    }
    var msgs = chatMessages.querySelectorAll('.msg-bot:not(.msg-intermediate)');
    var last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    // …and the guess is REFUSED when it would steal a bubble another meta has
    // already bound. data-message-id is what attachJiraCard resolves its host
    // through, so re-pointing it lands a draft's card under an unrelated reply —
    // exactly the failure two turns in flight in one thread produced.
    if (last && last.dataset && last.dataset.messageId && meta.messageId
        && last.dataset.messageId !== meta.messageId) return null;
    return last;
  }

  // Ids are server-minted UUIDs, so this never has anything to escape in
  // practice — it exists so a malformed one throws nothing and matches nothing
  // rather than making the whole selector invalid (which would throw and skip
  // the model stamp AND the feedback row).
  function cssAttrValue(value) {
    return String(value).replace(/["\\\\]/g, '\\\\$&');
  }

  function showResponseMeta(meta) {
    // Store for inspector panel
    if (meta.conversationId) {
      lastResponseMeta[meta.conversationId] = meta;
      updateInspectorContextUsage(meta);
      updateInspectorToolUsage();
      renderLastResponseCard(meta);
      loadToolUsageStats(); // Refresh aggregate stats
    }

    var target = botMessageForMeta(meta);

    // Stamp the model into that bot message's header. Live turns learn their
    // model here because the say() callback fires before result.model is known.
    if (meta.model && target) {
      var modelEl = target.querySelector('.msg-head-model');
      if (modelEl && !modelEl.textContent) {
        modelEl.textContent = meta.model;
        var sepEl = target.querySelector('.msg-head-sep');
        if (sepEl) sepEl.style.display = '';
      }
    }

    // Attach the 👍/👎 feedback control to the just-finalized bot message. A live
    // turn only learns its DB message id here (the say() callback rendered the
    // bubble with a throwaway client id), so this is where web feedback becomes
    // possible for live replies. Web conversations only.
    if (meta.messageId && target) {
      var conv = conversations[meta.conversationId];
      if (conv && conv.type === 'web') attachFeedbackControls(target, meta.messageId);
    }

    // A finished turn may BE a Jira draft, or may have run beside one. Either
    // way the listing is the authority — see refreshJiraCards/adoptJiraCardRow.
    refreshJiraCards();
  }

  // ── Response feedback (👍/👎) ─────────────────────────────────────────

  // Attach a lightweight thumbs-up/down control to a finalized bot message. The
  // vote persists per (message, user, source=web); clicking the active button
  // again clears it. Capture-only — no analytics UI consumes it yet.
  function attachFeedbackControls(botDiv, messageId) {
    if (!botDiv || !messageId) return;
    // The DB message id, stamped on the NODE — the only messageId → DOM lookup
    // in the page. attachJiraCard resolves its bubble through it, and cannot do
    // that work from in here: this function early-returns the moment a feedback
    // row exists, so a card arriving after the row (the ordinary case — the
    // draft finishes minutes later) would never be reached.
    //
    // **An existing DIFFERENT id is never overwritten.** The stamp used to run
    // ahead of the idempotency return below, so a caller that resolved the wrong
    // bubble re-pointed a binding that was already correct — and the draft card
    // then attached under someone else's reply.
    if (botDiv.dataset) {
      if (botDiv.dataset.messageId && botDiv.dataset.messageId !== messageId) return;
      botDiv.dataset.messageId = messageId;
    }
    if (botDiv.querySelector('.msg-feedback')) return; // idempotent
    var wrap = document.createElement('div');
    wrap.className = 'msg-feedback';
    var up = document.createElement('button');
    up.type = 'button';
    up.className = 'msg-feedback-btn';
    up.title = 'Good response';
    up.textContent = '\\uD83D\\uDC4D';
    var down = document.createElement('button');
    down.type = 'button';
    down.className = 'msg-feedback-btn';
    down.title = 'Bad response';
    down.textContent = '\\uD83D\\uDC4E';
    function send(value) {
      authedFetch('/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: messageId, value: value })
      }).catch(function() { /* best-effort */ });
    }
    function choose(btn, value) {
      var wasActive = btn.classList.contains('active');
      up.classList.remove('active');
      down.classList.remove('active');
      if (wasActive) {
        send(null); // toggle off clears the vote
      } else {
        btn.classList.add('active');
        send(value);
      }
    }
    up.onclick = function() { choose(up, 1); };
    down.onclick = function() { choose(down, -1); };
    wrap.appendChild(up);
    wrap.appendChild(down);
    botDiv.appendChild(wrap);
    // «🧾 Lag Jira-sak» rides the SAME row, and deliberately the same attach
    // point rather than a second hook: this function is the one place both paths
    // that finalize a web bot message meet (replayed history by row id, and the
    // live turn, which only learns its message id at response_meta time). It
    // renders itself only on the Jira bot with a known thread — see
    // jiraEntryVisible.
    appendJiraEntryControl(wrap);
  }

  // ── Load tool calls from trace ───────────────────────────────────────

  // Load tool calls from a persisted trace and render as a collapsed tool-activity container
  function loadToolCallsFromTrace(messageDom, traceId) {
    authedFetch('/api/traces/' + traceId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var spans = data.spans || [];
        var toolSpans = spans.filter(function(s) {
          return s.parentId && s.attributes && s.attributes.toolName;
        });
        if (toolSpans.length === 0) return;

        // Build collapsed tool-activity container
        var container = document.createElement('div');
        container.className = 'tool-activity collapsed';
        var header = document.createElement('div');
        header.className = 'tool-activity-header';
        header.onclick = function() { toggleToolActivity(container); };
        var label = document.createElement('span');
        label.className = 'tool-activity-label';
        // Calculate total duration from root span
        var rootSpan = spans.find(function(s) { return !s.parentId; });
        var durText = rootSpan && rootSpan.durationMs ? ' \\u00b7 ' + fmtMs(rootSpan.durationMs) : '';
        label.textContent = 'Used ' + toolSpans.length + ' tool' + (toolSpans.length !== 1 ? 's' : '') + durText;
        var toggle = document.createElement('span');
        toggle.className = 'tool-activity-toggle';
        toggle.textContent = '\\u25B6';
        header.appendChild(label);
        header.appendChild(toggle);
        var body = document.createElement('div');
        body.className = 'tool-activity-body';

        for (var i = 0; i < toolSpans.length; i++) {
          var s = toolSpans[i];
          // Use human-friendly statusText if available, fall back to raw span name
          var text = (s.attributes && s.attributes.statusText) || s.name;
          if (s.durationMs) text += ' \\u00b7 ' + fmtMs(s.durationMs);
          body.appendChild(createToolStatusLine(text));
        }

        container.appendChild(header);
        container.appendChild(body);

        // Insert before the bot message (between user query and bot response)
        chatMessages.insertBefore(container, messageDom);
      })
      .catch(function() { /* silent — tool calls are supplementary */ });
  }
  `;
}
