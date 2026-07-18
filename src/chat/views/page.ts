import { SHARED_STYLES, renderNav } from "../../dashboard/views/shared-styles.ts";
import { agentStatusStyles, agentStatusHtml, agentStatusScript } from "../../dashboard/views/components/agent-status-ui.ts";
import { requestProgressStyles, requestProgressHtml, requestProgressScript } from "../../dashboard/views/components/request-progress-ui.ts";
import { botSelectorStyles, botSelectorHtml } from "../../dashboard/views/components/bot-selector.ts";
import { helpersClientScript } from "../../dashboard/views/components/helpers-client.ts";
import { docPanelStyles, docPanelHtml, docPanelScript, MARKED_CDN_SCRIPT } from "../../dashboard/views/components/doc-panel.ts";
import { chatStyles } from "./components/chat-styles.ts";
import { webFormatClientScript } from "./components/web-format-client.ts";
import { inspectorPanelScript } from "./components/inspector-panel.ts";
import { streamingUiScript } from "./components/streaming-ui.ts";
import { connectorSelectorScript } from "./components/connector-selector.ts";
import { researchCardScript } from "./components/research-card.ts";
import { threadManagerScript } from "./components/thread-manager.ts";
import { knowledgeLinksScript } from "./components/knowledge-links.ts";

export async function renderChatPage(): Promise<string> {
  const [webFormatScript, helpersScript] = await Promise.all([
    webFormatClientScript(),
    helpersClientScript(),
  ]);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn Chat</title>
  <style>
    ${SHARED_STYLES}
    ${agentStatusStyles()}
    ${requestProgressStyles()}
    ${botSelectorStyles()}
    ${chatStyles()}
    ${docPanelStyles("docSlideIn")}
  </style>
</head>
<body>
  ${renderNav("chat", { headerLeftExtra: agentStatusHtml() + botSelectorHtml() })}

  <div class="sim-layout">
    <!-- Left: Threads sidebar -->
    <div class="sim-sidebar">
      <div class="sidebar-user-selector" id="userSelectorContainer" style="display:none">
        <label>User</label>
        <select id="userSelector"></select>
      </div>
      <div class="sidebar-connector" id="connectorSelector" style="display:none">
        <label>Model</label>
        <select id="connectorDropdown"></select>
      </div>
      <div class="sidebar-header">
        <h3>Threads</h3>
        <button class="new-thread-btn" id="newThreadBtn">+ New Thread</button>
      </div>
      <div class="thread-list" id="threadList">
        <div class="empty-state">Select a bot</div>
      </div>
    </div>

    <!-- Center: Chat view -->
    <div class="sim-chat">
      <div class="chat-header" id="chatHeader">
        <div class="chat-header-left">
          <span class="chat-title">Select a thread</span>
          <div class="chat-description" id="chatDescription"></div>
        </div>
        <button class="chat-header-pill auto-respond-pill" id="autoRespondPill" hidden></button>
        <span class="chat-status" id="chatStatus"></span>
      </div>
      <div class="chat-body">
        ${requestProgressHtml()}
        <div class="chat-messages" id="chatMessages">
          <div class="empty-state">Select a thread from the sidebar</div>
        </div>
      </div>
      <div class="chat-input">
        <textarea id="chatInput" placeholder="Type a message..." rows="1" disabled></textarea>
        <button id="chatSend" disabled>Send</button>
      </div>
    </div>

    <!-- Right: Inspector (Details / Agents tabs) -->
    <div class="sim-inspector">
      <div class="ins-tabs" id="inspectorTabs"></div>
      <div class="ins-body">
        <div id="inspectorDetailsTab">
          <div id="inspectorContent">
            <div class="empty-state">Select a thread</div>
          </div>
          <div id="inspectorMcpStatus"></div>
          <div id="inspectorToolUsage"></div>
          <div id="inspectorContext"></div>
        </div>
        <div id="inspectorAgents" style="display:none"></div>
      </div>
    </div>
  </div>

  <!-- Thread creation modal -->
  <div class="thread-modal-backdrop" id="threadModalBackdrop">
    <div class="thread-modal" onclick="event.stopPropagation()">
      <div class="thread-modal-header">
        <h3>New Thread</h3>
        <button class="thread-modal-close" id="threadModalClose">&times;</button>
      </div>
      <div class="thread-modal-body">
        <div class="thread-form-group">
          <label>Name *</label>
          <input type="text" id="threadModalName" placeholder="Thread name" maxlength="50">
        </div>
        <div class="thread-form-group">
          <label>Description</label>
          <input type="text" id="threadModalDesc" placeholder="Optional description">
        </div>
        <div class="thread-form-group">
          <label>Connector</label>
          <select id="threadModalConnector">
            <option value="">Bot default</option>
          </select>
          <div class="thread-form-hint" id="threadConnectorHint"></div>
        </div>
      </div>
      <div class="thread-modal-footer">
        <button class="thread-modal-cancel" id="threadModalCancel">Cancel</button>
        <button class="thread-modal-save" id="threadModalSave">Create</button>
      </div>
    </div>
  </div>

  ${docPanelHtml()}

  ${MARKED_CDN_SCRIPT}
  <script>
    ${helpersScript}
    ${agentStatusScript()}
    ${requestProgressScript()}
    ${webFormatScript}
    ${CHAT_SSE_SCRIPT}
    ${CHAT_SCRIPT}
  </script>
</body>
</html>`;
}

/** Minimal SSE connection — subscribes to agent_status + request_progress events */
const CHAT_SSE_SCRIPT = `
(function() {
  var autoDismissTimer = null;
  var autoDismissInner = null;

  function clearAutoDismissTimers() {
    clearTimeout(autoDismissTimer);
    clearTimeout(autoDismissInner);
    autoDismissTimer = null;
    autoDismissInner = null;
  }

  function connectSSE() {
    var conn = sseClient('/api/events', {
      agent_status: function(e) {
        updateAgentStatus(JSON.parse(e.data));
      },

      request_progress: function(e) {
        var data = JSON.parse(e.data);
        updateRequestProgress(data);
        // Auto-dismiss completed progress after 8s
        if (data && data.completed) {
          clearAutoDismissTimers();
          autoDismissTimer = setTimeout(function() {
            var panel = document.getElementById('requestProgress');
            if (panel && panel.classList.contains('completed')) {
              panel.classList.add('auto-dismiss');
              autoDismissInner = setTimeout(function() {
                panel.classList.remove('visible', 'completed', 'auto-dismiss');
                panel.innerHTML = '';
              }, 350);
            }
          }, 8000);
        } else if (data) {
          clearAutoDismissTimers();
          var panel = document.getElementById('requestProgress');
          if (panel) panel.classList.remove('auto-dismiss');
        }
      },

      onerror: function() {
        conn.close();
        setTimeout(connectSSE, 3000);
      },
    });
  }

  // Wrap dismissRequestProgress to also clear auto-dismiss timers
  var _origDismiss = dismissRequestProgress;
  dismissRequestProgress = function() {
    clearAutoDismissTimers();
    _origDismiss();
  };

  connectSSE();
})();
`;

const CHAT_SCRIPT = `
(function() {
  // Avatar color from name
  var _avatarPalette = [
    '#6c63ff', '#7c6cef', '#5b8def', '#4da8da', '#4ade80',
    '#34d399', '#f59e0b', '#f97316', '#ef4444', '#ec4899',
    '#a78bfa', '#8b5cf6', '#06b6d4', '#14b8a6', '#84cc16',
  ];
  function avatarColor(name) {
    var h = 0;
    for (var i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
    return _avatarPalette[Math.abs(h) % _avatarPalette.length];
  }
  function avatarStyle(name) {
    var c = avatarColor(name);
    return 'background:' + c + ';box-shadow:0 0 0 1px rgba(255,255,255,0.08),inset 0 1px 0 rgba(255,255,255,0.15)';
  }

  // State
  var conversations = {};       // Still needed for WS routing
  var activeConvId = null;      // 1:1 with selected user+bot binding
  var activeThreadId = null;    // Currently selected thread
  var isResearchThread = false; // True when active thread has a research card
  var researchIssueKey = null;  // Extracted issue key (e.g. "MELOSYS-7546")
  var reportExists = false;     // Whether a saved report file exists for current issue
  var devRun = null;            // Last-fetched dev_run state ({ run, handoffs }) — drives the live run card + phase affordances (replaces the positional reply counter)
  var devRunEvents = {};        // Phase C: per-run discovery notes, keyed by runId → [event] (deduped by id). KEPT SEPARATE from devRun — a dev_run roll-up replaces devRun with {run,handoffs} and would drop a merged events field.
  var inspectorTab = 'details'; // Active inspector tab: 'details' | 'agents'
  var inspectorUserPickedTab = false;    // True once the user clicks a tab / the View agents handle (suppresses auto-focus)
  var inspectorAgentsAutoFocused = false; // Latch: the Agents tab auto-focuses once, the first time it appears on a thread
  var inspectorAgentsHasNew = false;      // True when a note arrived while the Agents tab was inactive (drives the "new" dot)
  var pendingHandoffRoles = []; // Roles (['build'] or ['build','test']) awaiting the bot's agent recommendation after Start Building; empty = none pending
  var pendingOrchestrate = false; // True between Run-e2e (verify) click and the bot's reply (suppresses a duplicate orchestrate confirm)
  var awaitingSpecReview = false; // True between Generate Spec click and the bot's domain-spec reply (shows the review gate)
  var specGenerated = false;    // True once a domain spec has been generated this thread (enables Save Spec)
  var specApproved = false;     // True once the domain spec is approved (gates the build+test fan-out for spec-loop bots)
  var threads = [];             // Thread list for current user+bot
  var bots = [];
  // Suppress waterfall until we know the selected bot's config
  window._suppressWaterfall = true;
  var activeToolContainer = null;  // Current tool-activity container for live tool events
  var activeToolCount = 0;         // Tool count in the active container
  var connectors = [];  // Available connectors from DB
  var ws = null;
  var deepLinkHandled = false;
  var inspectorContextKey = null;
  var lastResponseMeta = {};    // Per-conversationId last response_meta
  var liveSnapshot = {};        // Per-conversationId in-flight token + tool aggregation (cleared on user msg + response_meta)

  function renderLiveSnapshot(convId) {
    if (convId !== activeConvId) return;
    var snap = liveSnapshot[convId];
    if (!snap) return;
    var meta = {
      inputTokens: snap.inputTokens,
      outputTokens: snap.outputTokens,
      model: snap.model,
    };
    // Build a real toolCalls array carrying structured displayNames so
    // renderLastResponseCard renders the per-tool breakdown live (same as
    // the post-response card, just without per-call durations yet).
    if (snap.tools && snap.tools.length > 0) {
      meta.toolCalls = snap.tools;
    }
    renderLastResponseCard(meta);
  }
  var selectedBot = '';         // From bot pills (localStorage-synced)
  var selectedUserId = null;    // Resolved from config for selected bot
  var selectedUsername = null;   // Display name

  // Bot selector init (synced with dashboard/traces/logs via localStorage)
  try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch {}

  var SKIP_EXTRACTIONS_KEY = 'muninn-skip-extractions';
  function getSkipExtractions() {
    try { return localStorage.getItem(SKIP_EXTRACTIONS_KEY) === '1'; } catch { return false; }
  }
  function setSkipExtractions(on) {
    try { localStorage.setItem(SKIP_EXTRACTIONS_KEY, on ? '1' : '0'); } catch {}
  }

  // DOM refs
  var threadList = document.getElementById('threadList');
  var chatMessages = document.getElementById('chatMessages');
  var chatInput = document.getElementById('chatInput');
  var chatSend = document.getElementById('chatSend');
  var chatHeader = document.getElementById('chatHeader');
  var chatStatus = document.getElementById('chatStatus');
  var inspectorToolUsage = document.getElementById('inspectorToolUsage');
  var inspectorContent = document.getElementById('inspectorContent');
  var inspectorContext = document.getElementById('inspectorContext');
  var inspectorMcpStatus = document.getElementById('inspectorMcpStatus');
  var mcpStatusByBot = {};
  var mcpStatusFetchedAt = {}; // bot name → epoch ms of last fetch/WS update
  var mcpStatusRefreshing = false;
  var mcpExpandState = {}; // key: "<bot>::<server>" → boolean (user toggle); absent = use default

  // ── Inspector panel functions (from inspector-panel.ts) ──
  ${inspectorPanelScript()}

  // ── Streaming UI functions (from streaming-ui.ts) ──
  ${streamingUiScript()}

  // ── Connector selector functions (from connector-selector.ts) ──
  ${connectorSelectorScript()}

  // ── Research card functions (from research-card.ts) ──
  ${researchCardScript()}

  async function loadBotList() {
    try {
      var res = await fetch('/chat/bots').then(function(r) { return r.json(); });
      bots = res.bots || [];
      connectors = res.connectors || [];

      var container = document.getElementById('botSelector');
      var botNames = bots.map(function(b) { return b.name; });

      // No "All Bots" pill — a bot must always be selected
      container.innerHTML = bots.map(function(b) {
        var tip = b.connector || 'claude-cli';
        if (b.model) tip += ' · ' + b.model;
        return '<button class="bot-pill' + (selectedBot === b.name ? ' active' : '') + '" data-bot="' + escapeAttr(b.name) + '" title="' + escapeAttr(tip) + '">' + escapeHtml(b.name.charAt(0).toUpperCase() + b.name.slice(1)) + '</button>';
      }).join('');

      return botNames;
    } catch { return []; }
  }

  async function selectBot(name, autoSelectThreadId) {
    selectedBot = name;
    try { localStorage.setItem('muninn-selected-bot', name); } catch {}

    // Set global waterfall suppression flag for this bot
    var bot = bots.find(function(b) { return b.name === name; });
    window._suppressWaterfall = bot && bot.showWaterfall === false;
    // Dismiss any visible waterfall when switching to a no-waterfall bot
    if (window._suppressWaterfall) dismissRequestProgress();
    document.querySelectorAll('.bot-pill').forEach(function(p) {
      p.classList.toggle('active', p.dataset.bot === name);
    });

    // Load users for this bot and populate selector
    await loadUsersForBot(name);

    // Update connector dropdown (bot default label changes per bot)
    await populateConnectorDropdown();

    // Resolve or create conversation for this user+bot
    await resolveConversation();

    // Clear thread selection, load threads, clear chat
    activeThreadId = null;
    clearChat();
    await loadThreads(autoSelectThreadId);
  }

  async function loadUsersForBot(botName) {
    var container = document.getElementById('userSelectorContainer');
    var selector = document.getElementById('userSelector');

    // Fetch users and default user from DB in parallel (allSettled so one failure doesn't kill both)
    var merged = [];
    var dbDefaultUserId = null;
    try {
      var results = await Promise.allSettled([
        fetch('/api/users?bot=' + encodeURIComponent(botName)).then(function(r) { return r.json(); }),
        fetch('/chat/bot-preferences/' + encodeURIComponent(botName) + '/default-user').then(function(r) { return r.json(); }),
      ]);
      if (results[0].status === 'fulfilled') {
        (results[0].value.users || []).forEach(function(u) {
          merged.push({ id: u.userId, name: u.username || u.userId });
        });
      }
      if (results[1].status === 'fulfilled') {
        dbDefaultUserId = results[1].value.userId || null;
      }
    } catch {}

    if (merged.length === 0) {
      container.style.display = 'none';
      selectedUserId = null;
      selectedUsername = null;
      return;
    }

    container.style.display = 'flex';

    // Priority: URL deep-link user (set in localStorage by handleDeepLink) > DB default > first user
    var urlUserId = null;
    try { urlUserId = localStorage.getItem('muninn-chat-user-' + botName); } catch {}
    var preferredId = urlUserId || dbDefaultUserId;

    selector.innerHTML = merged.map(function(u) {
      return '<option value="' + escapeAttr(u.id) + '"' +
        (u.id === preferredId ? ' selected' : '') +
        '>' + escapeHtml(u.name) + '</option>';
    }).join('');

    // Select preferred or first
    var match = preferredId && merged.find(function(u) { return u.id === preferredId; });
    var active = match || merged[0];
    selector.value = active.id;
    selectedUserId = active.id;
    selectedUsername = active.name;

    // Cache in localStorage for deep-link handoff within same page load
    try { localStorage.setItem('muninn-chat-user-' + botName, active.id); } catch {}
  }

  function syncDefaultUser(botName, userId) {
    if (!botName || !userId) return;
    fetch('/chat/bot-preferences/' + encodeURIComponent(botName) + '/default-user', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: userId }),
    }).catch(function() {});
  }


  async function resolveConversation() {
    if (!selectedBot || !selectedUserId) {
      activeConvId = null;
      return;
    }
    // Always use a 'web' type conversation so messages get web HTML formatting.
    // Other platform conversations (telegram_dm, slack_*) may exist from hydration
    // but should not be used for the web chat UI.
    var convs = Object.values(conversations);
    for (var i = 0; i < convs.length; i++) {
      if (convs[i].userId === selectedUserId && convs[i].botName === selectedBot && convs[i].type === 'web') {
        activeConvId = convs[i].id;
        return;
      }
    }
    // Create a web conversation if not found
    activeConvId = null;
    try {
      var res = await fetch('/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'web', botName: selectedBot, userId: selectedUserId, username: selectedUsername || 'user' }),
      });
      var data = await res.json();
      if (data.conversation) {
        conversations[data.conversation.id] = data.conversation;
        activeConvId = data.conversation.id;
      }
    } catch {}
  }

  document.getElementById('botSelector').addEventListener('click', function(e) {
    var pill = e.target.closest('.bot-pill');
    if (pill) selectBot(pill.dataset.bot);
  });

  // User selector change
  document.getElementById('userSelector').addEventListener('change', async function(e) {
    var userId = e.target.value;
    var opt = e.target.selectedOptions[0];
    selectedUserId = userId;
    selectedUsername = opt ? opt.textContent : userId;
    try { localStorage.setItem('muninn-chat-user-' + selectedBot, userId); } catch {}
    syncDefaultUser(selectedBot, userId);
    // Re-resolve conversation, threads, and connector preference for new user
    await resolveConversation();
    activeThreadId = null;
    clearChat();
    await loadThreads();
    await populateConnectorDropdown();
  });

  // ── Thread manager functions (from thread-manager.ts) ──
  ${threadManagerScript()}

  function clearChat() {
    chatMessages.innerHTML = '<div class="empty-state">Select a thread from the sidebar</div>';
    chatInput.disabled = true;
    chatSend.disabled = true;
    chatHeader.querySelector('.chat-title').textContent = 'Select a thread';
    document.getElementById('chatDescription').textContent = '';
    var arPill = document.getElementById('autoRespondPill');
    if (arPill) { arPill.hidden = true; arPill.classList.remove('paused'); }
    connectorDropdown.value = selectedConnectorId;
    setChatStatusText('');
    // Reset streaming state so stale text doesn't leak into next thread
    streamingRawText = '';
    streamingRafPending = false;
  }

  // WebSocket connection
  function connectWs() {
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(protocol + '//' + location.host + '/chat/ws');
    ws.onmessage = function(e) {
      try { handleWsEvent(JSON.parse(e.data)); }
      catch (err) { console.warn('Failed to parse WS message:', err); }
    };
    ws.onclose = function() { setTimeout(connectWs, 2000); };
  }

  async function handleWsEvent(event) {
    if (event.type === 'snapshot') {
      for (var i = 0; i < event.conversations.length; i++) {
        var conv = event.conversations[i];
        conversations[conv.id] = conv;
      }
      // After snapshot, resolve conversation if bot is selected
      if (selectedBot) await resolveConversation();
      if (!deepLinkHandled) {
        deepLinkHandled = true;
        await handleDeepLink();
      }
      return;
    }

    if (event.type === 'conversation_created') {
      conversations[event.conversation.id] = event.conversation;
      // If this matches our current user+bot, set as active
      if (event.conversation.userId === selectedUserId && event.conversation.botName === selectedBot) {
        activeConvId = event.conversation.id;
      }
      return;
    }

    if (event.type === 'message') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.messages.push(event.message);
        // Reset the in-flight live snapshot so tools/tokens from a prior
        // response don't bleed into the next turn.
        if (event.message.sender === 'user') {
          delete liveSnapshot[event.conversationId];
        }
        if (event.conversationId === activeConvId) {
          // Only append if the message belongs to the active thread
          var msgThread = event.message.threadId || null;
          if (!activeThreadId || msgThread === activeThreadId) {
            if (event.message.sender === 'bot') {
              collapseToolActivity();
              removeIntermediates();
              removeStreamingBubble();
              setChatStatusText('');
              conv.status = '';
            }
            appendMessage(event.message, conv.type, true);
          }
          updateInspector();
        }
        // Update in-memory thread message count so sidebar stays current
        var msgThreadId = event.message.threadId || null;
        var countTarget = msgThreadId;
        // Messages with null threadId belong to "main" thread
        if (!countTarget) {
          for (var mi = 0; mi < threads.length; mi++) {
            if (threads[mi].name === 'main') { countTarget = threads[mi].id; break; }
          }
        }
        if (countTarget) {
          for (var ti = 0; ti < threads.length; ti++) {
            if (threads[ti].id === countTarget) {
              threads[ti].messageCount = (threads[ti].messageCount || 0) + 1;
              break;
            }
          }
        }
        renderThreadList();
      }
      return;
    }

    if (event.type === 'text_delta') {
      if (event.conversationId !== activeConvId) return;
      var deltaThread = event.threadId || null;
      if (activeThreadId && deltaThread !== activeThreadId) return;
      // Dismiss waterfall when text is streaming — it slides back on next tool call
      dismissRequestProgress();
      appendStreamingDelta(event.delta);
      return;
    }

    if (event.type === 'stream_clear') {
      if (event.conversationId !== activeConvId) return;
      var clearThread = event.threadId || null;
      if (activeThreadId && clearThread !== activeThreadId) return;
      // If there's actual streamed text being promoted to an intermediate message,
      // collapse the tool container so the next tool batch creates a new container
      // below the promoted text (preserving chronological order).
      if (streamingRawText.trim() && activeToolContainer) {
        collapseToolActivity();
      }
      promoteStreamingBubble();
      return;
    }

    if (event.type === 'intent') {
      if (event.conversationId !== activeConvId) return;
      var intentThread = event.threadId || null;
      if (activeThreadId && intentThread !== activeThreadId) return;
      showIntentBubble(event.text);
      return;
    }

    if (event.type === 'tool_status') {
      if (event.conversationId !== activeConvId) return;
      var tsThread = event.threadId || null;
      if (activeThreadId && tsThread !== activeThreadId) return;
      appendToolStatus(event.text);
      // Append a structured tool call entry so the inspector aggregates live.
      // displayName is sent by the server (falls back to event.name or text).
      var displayName = event.displayName || event.name || event.text || 'tool';
      var name = event.name || displayName;
      liveSnapshot[event.conversationId] = liveSnapshot[event.conversationId] || {};
      var snap = liveSnapshot[event.conversationId];
      snap.tools = snap.tools || [];
      snap.tools.push({ name: name, displayName: displayName, durationMs: 0 });
      renderLiveSnapshot(event.conversationId);
      return;
    }

    if (event.type === 'tool_end') {
      if (event.conversationId !== activeConvId) return;
      var teThread = event.threadId || null;
      if (activeThreadId && teThread !== activeThreadId) return;
      // Match the most recent unfilled entry with this displayName and stamp
      // its tokensEstimate. Tool calls are sequential per turn so the latest
      // entry without a tokensEstimate is the right target.
      var snapEnd = liveSnapshot[event.conversationId];
      if (snapEnd && snapEnd.tools) {
        for (var ti = snapEnd.tools.length - 1; ti >= 0; ti--) {
          var entry = snapEnd.tools[ti];
          if (entry.displayName === event.displayName && entry.tokensEstimate == null) {
            entry.tokensEstimate = event.tokensEstimate;
            break;
          }
        }
        renderLiveSnapshot(event.conversationId);
      }
      return;
    }

    if (event.type === 'usage_progress') {
      if (event.conversationId !== activeConvId) return;
      var upThread = event.threadId || null;
      if (activeThreadId && upThread !== activeThreadId) return;
      // Merge per-turn token usage into the live snapshot — tool count
      // is tracked separately as tool_status events fire.
      liveSnapshot[event.conversationId] = liveSnapshot[event.conversationId] || {};
      liveSnapshot[event.conversationId].inputTokens = event.inputTokens;
      liveSnapshot[event.conversationId].outputTokens = event.outputTokens;
      liveSnapshot[event.conversationId].model = event.model;
      renderLiveSnapshot(event.conversationId);
      return;
    }

    if (event.type === 'response_meta') {
      if (event.conversationId !== activeConvId) return;
      var rmThread = event.threadId || null;
      if (activeThreadId && rmThread !== activeThreadId) return;
      // Final meta wins — drop the live snapshot so the next turn starts fresh
      delete liveSnapshot[event.conversationId];
      showResponseMeta(event);
      return;
    }

    if (event.type === 'mcp_status') {
      // Cache by bot name; only render if it matches the selected bot
      mcpStatusByBot[event.botName] = event.servers;
      mcpStatusFetchedAt[event.botName] = Date.now();
      if (event.botName === selectedBot) renderMcpStatus(event.servers, false);
      return;
    }

    if (event.type === 'dev_run') {
      // Phase 5: a background dev_run roll-up (handoff interpreter / stale sweep)
      // — update the live run card without a refresh. onDevRunEvent filters to the
      // active research thread + never spawns phase buttons mid-turn.
      onDevRunEvent(event);
      return;
    }

    if (event.type === 'dev_run_event') {
      // Phase C: a non-terminal progress note from a working peer. Append it to
      // the inspector Agents tab's live discoveries timeline. Strictly additive —
      // notes never recompute run status or touch the verified terminal/green
      // pipeline. onDevRunEventLine filters to the active research thread + run.
      onDevRunEventLine(event);
      return;
    }

    if (event.type === 'status') {
      var conv = conversations[event.conversationId];
      if (conv) {
        conv.status = event.status;
        if (event.conversationId === activeConvId) {
          setChatStatusText(event.status || '');
          if (!event.status) {
            collapseToolActivity();
            removeIntermediates();
            removeStreamingBubble();
            dismissRequestProgress();
          }
          updateTypingIndicator(event.status);
        }
      }
      return;
    }
  }

  // Deep-link: /chat?bot=jarvis&thread=<id>&user=<userId>
  async function handleDeepLink() {
    var params = new URLSearchParams(window.location.search);
    var botName = params.get('bot');
    var threadParam = params.get('thread');
    var userParam = params.get('user');
    if (!botName) return;

    // If a user is specified in the URL, pre-set it before selectBot loads users
    if (userParam) {
      try { localStorage.setItem('muninn-chat-user-' + botName, userParam); } catch {}
    }

    await selectBot(botName, threadParam || undefined);

    // Check for pending research message (e.g. from Chrome extension)
    if (threadParam && activeConvId && activeThreadId) {
      // Stamp connector from sidebar selection only if the thread has none.
      // Threads created via the Jira plugin already carry the user's chosen
      // connector — overwriting here would silently swap the model.
      if (selectedConnectorId) {
        await stampConnectorOnThread(activeThreadId, selectedConnectorId, true);
      }
      try {
        var pendingRes = await fetch('/chat/pending/' + encodeURIComponent(threadParam));
        var pendingData = await pendingRes.json();
        if (pendingData.text) {
          chatInput.value = pendingData.text;
          sendMessage();
        }
      } catch {}
    }
  }

  // Send message (optional connector override for routing through a specific AI backend)
  var pendingConnector = null;
  async function sendMessage() {
    if (!activeConvId || !activeThreadId || !chatInput.value.trim()) return;

    // Dismiss research action buttons when sending any message
    var researchActions = chatMessages.querySelector('.research-actions');
    if (researchActions) researchActions.remove();

    // Stamp connector from sidebar selection only if the thread has none.
    // The thread's own connector wins over the sidebar default — explicit
    // overrides go through the dropdown change handler instead.
    if (selectedConnectorId) {
      await stampConnectorOnThread(activeThreadId, selectedConnectorId, true);
    }

    var text = chatInput.value.trim();
    chatInput.value = '';
    chatInput.style.height = 'auto';
    var payload = { text: text, threadId: activeThreadId };
    if (pendingConnector) {
      payload.connector = pendingConnector;
      pendingConnector = null;
    }
    if (getSkipExtractions()) {
      payload.skipExtractions = true;
    }
    await fetch('/chat/conversations/' + activeConvId + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  // Load messages filtered by thread from DB
  async function loadThreadMessages(threadId) {
    if (!activeConvId) return;
    activeThreadId = threadId || null;
    // Reset streaming, research, and tool activity state when switching threads
    streamingRawText = '';
    streamingRafPending = false;
    activeToolContainer = null;
    activeToolCount = 0;
    isResearchThread = false;
    researchIssueKey = null;
    reportExists = false;
    devRun = null;
    devRunEvents = {};
    inspectorTab = 'details';
    inspectorUserPickedTab = false;
    inspectorAgentsAutoFocused = false;
    inspectorAgentsHasNew = false;
    pendingHandoffRoles = [];
    pendingOrchestrate = false;
    awaitingSpecReview = false;
    specGenerated = false;
    specApproved = false;
    try {
      var url = '/chat/conversations/' + activeConvId + '/messages';
      if (threadId) url += '?thread=' + encodeURIComponent(threadId);
      var res = await fetch(url);
      var data = await res.json();
      var msgs = data.messages || [];

      var conv = conversations[activeConvId];
      chatMessages.innerHTML = '';

      // Cross-platform banner for non-web conversations
      if (conv && conv.type !== 'web') {
        var banner = document.createElement('div');
        banner.className = 'cross-platform-banner';
        banner.textContent = 'Conversation from ' + typePlatformLabel(conv.type) + ' \\u2014 replies sent via web';
        chatMessages.appendChild(banner);
      }

      for (var i = 0; i < msgs.length; i++) {
        appendMessage(msgs[i], conv ? conv.type : 'web', false);
      }
      // Phase 5: after replaying history, render the research affordance off
      // dev_run state (not a positional reply counter). Per-message rendering is
      // skipped during replay (isLive=false) so this single fetch+render decides
      // the final affordance — the live run card if handoffs exist, else the
      // phase-appropriate research actions.
      if (isResearchThread) {
        fetchDevRun(function() { renderRunAffordance(); });
      }
      scrollToBottom();
    } catch {
      chatMessages.innerHTML = '<div class="empty-state">Failed to load messages</div>';
    }
  }

  function typePlatformLabel(type) {
    switch(type) {
      case 'telegram_dm': return 'Telegram';
      case 'slack_dm': return 'Slack DM';
      case 'slack_channel': return 'Slack Channel';
      case 'slack_assistant': return 'Slack Assistant';
      case 'web': return 'Web';
      default: return type;
    }
  }

  function peerLabelForMessage(msg) {
    if (msg.threadId) {
      var pBot = bots.find(function(b) { return b.name === selectedBot; });
      for (var i = 0; i < threads.length; i++) {
        if (threads[i].id === msg.threadId && threads[i].name && threads[i].name.indexOf('peer:') === 0) {
          return peerDisplayName(threads[i].name, pBot);
        }
      }
    }
    if (msg.fromPeerId) return msg.fromPeerId;
    return 'peer';
  }

  // Build a message header band: identity dot · name · model · time.
  // Uses the shared formatTime() (24h HH:MM:SS) from helpers-client.
  function buildMsgHead(opts) {
    var head = document.createElement('div');
    head.className = 'msg-head';
    var nameSpan = '<span class="msg-head-name">' + escapeHtml(opts.name) + '</span>';
    var timeSpan = '<span class="msg-head-time">' + escapeHtml(formatTime(opts.timestamp)) + '</span>';
    if (opts.isPeer) {
      head.innerHTML =
        '<span style="color:var(--accent-light)">\\u2726</span>'
        + nameSpan
        + '<span class="msg-peer-tag">peer</span>'
        + timeSpan;
    } else {
      var hasModel = !!opts.model;
      head.innerHTML =
        '<span class="msg-head-dot" style="background:' + escapeAttr(opts.dotColor) + '"></span>'
        + nameSpan
        + '<span class="msg-head-sep"' + (hasModel ? '' : ' style="display:none"') + '>\\u00b7</span>'
        + '<span class="msg-head-model">' + escapeHtml(opts.model || '') + '</span>'
        + timeSpan;
    }
    return head;
  }

  // Human-readable label for a research action prompt (\`<!-- prompt:<type> -->\`).
  // Mirrors the research-action button labels in research-card.ts.
  function promptLabel(type) {
    if (type === 'investigate') return 'Investigate Code';
    if (type === 'deepAnalysis') return 'Deep Analysis';
    if (type === 'specGeneration') return 'Generate Test Spec';
    if (type === 'specDomain') return 'Generate Spec';
    if (type === 'orchestrate') return 'Run e2e (verify)';
    if (type === 'resend') return 'Re-send handoff';
    var s = type.replace(/([a-z])([A-Z])/g, '$1 $2');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function appendMessage(msg, convType, isLive) {
    var existing = chatMessages.querySelector('.typing-indicator');
    if (existing && msg.sender === 'bot') existing.remove();

    var isWeb = convType === 'web';
    var isTg = convType.startsWith('telegram');
    var platformClass = isWeb ? ' web web-content' : (isTg ? ' telegram' : ' slack');

    // Research card messages render as a standalone card (no header/body wrapper)
    var isResearchMsg = msg.sender === 'user' && msg.text.indexOf(RESEARCH_MARKER) === 0;
    if (isResearchMsg) {
      isResearchThread = true;
      devRun = null;
      pendingHandoffRoles = [];
      pendingOrchestrate = false;
      awaitingSpecReview = false;
      specGenerated = false;
      specApproved = false;
      var rdiv = document.createElement('div');
      rdiv.className = 'msg msg-research-card';
      var parsed = parseResearchContent(msg.text);
      rdiv.innerHTML = renderResearchCard(parsed);
      if (parsed.issueKey) {
        researchIssueKey = parsed.issueKey;
        checkReportExists(selectedBot, parsed.issueKey);
        checkSpecStatus(selectedBot, parsed.issueKey);
      }
      chatMessages.appendChild(rdiv);
      scrollToBottom();
      return;
    }

    // Research-action prompts (Investigate Code, Deep Analysis, …) render as a
    // labeled card matching the Jira Research card — body formatted as markdown,
    // not the old raw-text italic blob.
    var promptMatch = msg.sender === 'user' ? msg.text.match(/^<!-- prompt:(\\w+) -->/) : null;
    if (promptMatch) {
      var pBody = msg.text.replace(/^<!-- prompt:\\w+ -->/, '').trim();
      var pdiv = document.createElement('div');
      pdiv.className = 'msg msg-research-card msg-prompt-card';
      pdiv.innerHTML = '<div class="research-card-header">' +
        '<span class="research-card-label">' + escapeHtml(promptLabel(promptMatch[1])) + '</span>' +
        '</div>' +
        '<div class="research-card-body web-content">' + sanitizeHtml(formatWebHtml(pBody), true) + '</div>';
      chatMessages.appendChild(pdiv);
      scrollToBottom();
      return;
    }

    var div = document.createElement('div');
    var body = document.createElement('div');
    var headName = '';
    var dotColor = '';
    var headModel = '';
    var isPeerMsg = msg.sender === 'peer';

    if (msg.sender === 'bot') {
      div.className = 'msg msg-bot';
      body.className = 'msg-body' + platformClass;
      if (isWeb || isTg) {
        body.innerHTML = sanitizeHtml(msg.text, isWeb);
        if (isWeb) enhanceCodeTabs(body);
        augmentIndexLinks(body);
        augmentIssueLinks(body);
      } else {
        body.innerHTML = renderSlackMrkdwn(msg.text);
      }
      headName = selectedBot;
      dotColor = avatarColor(selectedBot);
      headModel = msg.model || '';
    } else if (isPeerMsg) {
      div.className = 'msg msg-peer';
      // Peer (hivemind) text arrives as raw markdown — it's never the
      // assistant role, so the server-side formatWebHtml pass skips it.
      // Format it here like bot messages so it renders as rich HTML.
      body.className = 'msg-body web-content';
      body.innerHTML = sanitizeHtml(formatWebHtml(msg.text), true);
      enhanceCodeTabs(body);
      augmentIndexLinks(body);
      augmentIssueLinks(body);
      headName = peerLabelForMessage(msg);
    } else {
      div.className = 'msg msg-user';
      body.className = 'msg-body';
      body.textContent = msg.text;
      headName = selectedUsername || 'You';
      dotColor = avatarColor(selectedUsername || 'user');
    }

    div.appendChild(buildMsgHead({ name: headName, dotColor: dotColor, model: headModel, isPeer: isPeerMsg, timestamp: msg.timestamp }));
    div.appendChild(body);

    chatMessages.appendChild(div);

    // Load tool calls from trace for bots with showWaterfall=false
    if (msg.sender === 'bot' && msg.traceId) {
      var bot = bots.find(function(b) { return b.name === selectedBot; });
      if (bot && bot.showWaterfall === false) {
        loadToolCallsFromTrace(div, msg.traceId);
      }
    }

    // Replayed web history: attach the 👍/👎 feedback control using the DB message
    // id (msg.id is the real row id on replay). Live turns get theirs from
    // showResponseMeta instead, because say() rendered them with a throwaway id.
    if (msg.sender === 'bot' && isWeb && !isLive && msg.id) {
      attachFeedbackControls(div, msg.id);
    }

    // Show action buttons after a LIVE bot reply in a research thread. (Replayed
    // history skips this — loadThreadMessages does one fetch+render at the end.)
    // Two client-transient gates take precedence over run-state rendering:
    //  - a pending Start Building handoff: the reply is the agent recommendation,
    //    so show the role-aware Confirm Handoff row.
    //  - awaiting a domain-spec review: the reply is the spec, show the gate.
    // Otherwise re-fetch the dev_run and render off run state (live run card if
    // handoffs exist, else the phase-appropriate research actions).
    if (isResearchThread && msg.sender === 'bot' && isLive) {
      if (pendingHandoffRoles.length) {
        var handoffRoles = pendingHandoffRoles;
        pendingHandoffRoles = [];
        showHandoffConfirm(handoffRoles);
      } else if (awaitingSpecReview) {
        awaitingSpecReview = false;
        specGenerated = true;
        showSpecReview();
      } else {
        // A fresh bot reply settles any in-flight orchestrate request, so the
        // verify gate re-shows if the run is still parked at ready_to_verify
        // (e.g. the delegate didn't land); a successful delegate moves it to
        // verifying and the gate stays hidden.
        pendingOrchestrate = false;
        fetchDevRun(function() { renderRunAffordance(); });
      }
    }

    scrollToBottom();
  }

  // Remove all intermediate messages (called before final message or on status clear)
  function removeIntermediates() {
    var intermediates = chatMessages.querySelectorAll('.msg-intermediate');
    for (var i = 0; i < intermediates.length; i++) {
      intermediates[i].remove();
    }
  }

  function scrollToBottom() {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Knowledge link functions (from knowledge-links.ts) ──
  ${knowledgeLinksScript()}

  ${docPanelScript()}

  // Event listeners
  chatSend.onclick = sendMessage;
  chatInput.onkeydown = function(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };
  chatInput.oninput = function() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  };

  // Init
  async function init() {
    var botNames = await loadBotList();
    connectWs();
    loadKnowledgeUrlMaps();

    // Skip auto-select when deep link params are present — handleDeepLink()
    // will call selectBot() after the WS snapshot with the correct user pre-set.
    var hasDeepLink = new URLSearchParams(window.location.search).has('bot');
    if (!hasDeepLink) {
      // Auto-select: use stored bot if valid, otherwise first bot
      var initialBot = selectedBot && botNames.indexOf(selectedBot) !== -1 ? selectedBot : (botNames[0] || '');
      if (initialBot) selectBot(initialBot);
    }
  }
  init();
})();
`;
