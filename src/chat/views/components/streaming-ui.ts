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
      augmentIndexLinks(bubble);
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

  // Show response metadata (context usage) below the last bot message
  function showResponseMeta(meta) {
    // Store for inspector panel
    if (meta.conversationId) {
      lastResponseMeta[meta.conversationId] = meta;
      updateInspectorContextUsage(meta);
      updateInspectorToolUsage(meta);
      renderLastResponseCard(meta);
      loadToolUsageStats(); // Refresh aggregate stats
    }

    // Find the last bot message to attach metadata to
    var msgs = chatMessages.querySelectorAll('.msg-bot');
    var lastBot = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    if (!lastBot) return;

    // Remove any existing meta bar on this message
    var existing = lastBot.querySelector('.msg-response-meta');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.className = 'msg-response-meta';

    var parts = [];

    // Context usage: prefer contextTokens (last turn) over inputTokens (cumulative)
    var ctxTokens = meta.contextTokens || meta.inputTokens;
    if (ctxTokens) {
      if (meta.contextWindow) {
        parts.push('ctx ' + fmtNum(ctxTokens) + ' / ' + fmtNum(meta.contextWindow));
      } else {
        parts.push(fmtNum(ctxTokens) + ' in');
      }
    }
    if (meta.outputTokens) {
      parts.push(fmtNum(meta.outputTokens) + ' out');
    }

    // Duration
    if (meta.durationMs) {
      var secs = meta.durationMs / 1000;
      parts.push(secs >= 10 ? Math.round(secs) + 's' : secs.toFixed(1) + 's');
    }

    // Cost (skip if zero — e.g. local models)
    if (meta.costUsd && meta.costUsd > 0) {
      parts.push('$' + meta.costUsd.toFixed(4));
    }

    bar.textContent = parts.join('  \\u00b7  ');
    lastBot.appendChild(bar);
  }

  // ── Load tool calls from trace ───────────────────────────────────────

  // Load tool calls from a persisted trace and render as a collapsed tool-activity container
  function loadToolCallsFromTrace(messageDom, traceId) {
    fetch('/api/traces/' + traceId)
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
