import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import {
  tracesPromptModalStyles,
  tracesPromptModalHtml,
  tracesPromptModalScript,
} from "./components/traces-prompt-modal.ts";
import { helpersClientScript } from "./components/helpers-client.ts";

/**
 * `/agents` — unified live-agent dashboard (PR 1 MVP). Three zones:
 *   - Running: live cards from the `agent_runs` SSE event. Each snapshot
 *     re-renders the zone's innerHTML, so the pulse/shimmer CSS animations DO
 *     restart ~1/s (an accepted tradeoff matching `request-progress-ui.ts`);
 *     between snapshots an in-place rAF tick advances the elapsed timers and
 *     active tool durations without a re-render (the two-tier pattern).
 *   - Up next: scheduled tasks + watchers from `/api/agents/overview`.
 *   - Recently finished: the four-source Recent union from the same endpoint.
 *
 * PR 1 renders elapsed-only progress (no ETA), no cancel button. The bot
 * selector filters all three zones client-side.
 */
export async function renderAgentsPage(): Promise<string> {
  const helpers = await helpersClientScript();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Agents</title>
  <style>
    ${SHARED_STYLES}
    ${botSelectorStyles()}
    ${tracesPromptModalStyles()}

    .page { padding: 16px 24px 48px; }
    .intro { color: var(--text-muted); font-size: 13px; margin-bottom: 18px; max-width: 860px; line-height: 1.5; }

    .zone { margin-bottom: 30px; }
    .zone h2 {
      font-size: 14px; color: var(--text-primary); font-weight: 600; margin-bottom: 10px;
      display: flex; align-items: center; gap: 8px;
    }
    .zone-count {
      font-size: 11px; color: var(--text-muted); background: var(--tint-neutral);
      padding: 1px 8px; border-radius: 10px; font-weight: 500;
    }
    .empty-msg { color: var(--text-faint); padding: 20px; text-align: center; font-size: 13px; }
    .err-note { color: var(--status-warning); font-size: 12px; margin: 8px 0; }

    /* --- Run cards --- */
    .runs { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 14px; }
    .run-card {
      background: var(--bg-panel); border: 1px solid var(--border-primary);
      border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px;
    }
    .run-card.done { opacity: 0.6; }
    .run-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    /* .pulse-dot + its keyframes now live in shared-styles.ts; only the done
       override is card-specific (it stops the ring via --pulse-anim). */
    .run-card.done .pulse-dot { background: var(--text-dim); --pulse-anim: none; }
    .run-card.done .pulse-dot::after { opacity: 0; }
    .kind-pill {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
      padding: 2px 8px; border-radius: 10px;
      background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-light);
    }
    .kind-chat        { background: color-mix(in srgb, var(--status-info) 16%, transparent); color: var(--status-info); }
    .kind-watcher     { background: color-mix(in srgb, var(--status-cyan) 16%, transparent); color: var(--status-cyan); }
    .kind-scheduled_task { background: color-mix(in srgb, var(--status-magenta) 16%, transparent); color: var(--status-magenta); }
    .kind-gardener_drain { background: color-mix(in srgb, var(--status-success) 18%, transparent); color: var(--status-success); }
    .kind-extractor   { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
    .run-name { font-size: 13px; color: var(--text-primary); font-weight: 500; flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .run-bot { font-size: 11px; color: var(--text-faint); background: color-mix(in srgb, var(--accent) 10%, transparent);
      padding: 1px 6px; border-radius: 4px; }
    /* Truthful backend + model that actually ran (connector · model). */
    .run-conn { font-size: 10px; color: var(--text-muted); background: var(--tint-neutral);
      padding: 1px 7px; border-radius: 10px; font-variant-numeric: tabular-nums; }
    .run-conn code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-secondary); }
    .run-phase { font-size: 11px; color: var(--accent-light); }
    .run-elapsed { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; margin-left: auto; }

    .run-bar-track { height: 6px; border-radius: 3px; background: rgba(128,128,128,0.15); overflow: hidden; position: relative; }
    .run-bar-fill {
      height: 100%; border-radius: 3px; background: var(--accent);
      transition: width 0.2s linear;
    }
    /* Past the estimate: tint the shimmer amber so "running over est." reads at a glance. */
    .run-bar-track.over .shimmer-bar {
      background: linear-gradient(90deg, transparent, var(--status-warning), transparent);
    }
    .run-prog-label { font-size: 11px; color: var(--text-muted); }
    .run-eta { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
    .run-eta.over { color: var(--status-warning); }

    .run-tools { display: flex; flex-direction: column; gap: 2px; max-height: 84px; overflow-y: auto; scrollbar-width: thin; }
    .run-tool { font-size: 11px; color: var(--text-soft); display: flex; gap: 6px; align-items: baseline; }
    .run-tool.phase { color: var(--accent-light); }
    .run-tool-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .run-tool-dur { color: var(--text-dim); font-variant-numeric: tabular-nums; margin-left: auto; flex-shrink: 0; }

    .run-links { display: flex; gap: 12px; flex-wrap: wrap; }
    .run-link { color: var(--accent); text-decoration: none; font-size: 11px; background: none; border: none;
      cursor: pointer; padding: 0; font-family: inherit; }
    .run-link:hover { text-decoration: underline; }

    /* --- Up next + recent lists --- */
    .list-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .list-table th { text-align: left; padding: 6px 12px; color: var(--text-dim); font-weight: 500;
      text-transform: uppercase; font-size: 11px; letter-spacing: 0.5px; border-bottom: 1px solid var(--border-primary); }
    .list-table td { padding: 7px 12px; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
    .list-table tr:hover td { background: color-mix(in srgb, var(--accent) 4%, transparent); }
    .list-table code { font-size: 12px; color: var(--text-secondary); }
    .when { color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .when.due { color: var(--status-warning); }
    .tag {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
      padding: 1px 7px; border-radius: 9px; background: var(--tint-neutral); color: var(--text-muted);
    }
    .status-error { color: var(--status-error); }
    .scroll { overflow-x: auto; }
    /* Token / turns / tools summary — Recent rows + completed Running cards. */
    .run-toks { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums;
      margin-left: 6px; white-space: nowrap; }
    .run-usage { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums;
      display: flex; gap: 10px; flex-wrap: wrap; }
    .run-usage b { color: var(--text-secondary); font-weight: 600; }
  </style>
</head>
<body>
  ${renderNav("agents", { headerLeftExtra: botSelectorHtml() })}

  <div class="page">
    <div class="intro">
      Every AI job muninn is running or has scheduled — chat turns, scheduled tasks, watchers, and
      background pipelines — in one live view. The <strong>Running</strong> zone updates over SSE;
      <strong>Up next</strong> and <strong>Recently finished</strong> refresh from
      <code>/api/agents/overview</code>. Filter by bot with the pills above.
    </div>

    <div id="errBox"></div>

    <div class="zone">
      <h2>Running <span class="zone-count" id="runningCount">0</span></h2>
      <div class="runs" id="runningZone"></div>
      <div class="empty-msg" id="runningEmpty">Nothing running right now.</div>
    </div>

    <div class="zone">
      <h2>Up next <span class="zone-count" id="upNextCount">0</span></h2>
      <div class="scroll"><table class="list-table">
        <thead><tr><th>When</th><th>Kind</th><th>Name</th><th>Bot</th></tr></thead>
        <tbody id="upNextBody"><tr><td colspan="4" class="empty-msg">Loading…</td></tr></tbody>
      </table></div>
    </div>

    <div class="zone">
      <h2>Recently finished <span class="zone-count" id="recentCount">0</span></h2>
      <div class="scroll"><table class="list-table">
        <thead><tr><th>Finished</th><th>Kind</th><th>Name</th><th>Bot</th><th>Duration</th><th></th></tr></thead>
        <tbody id="recentBody"><tr><td colspan="6" class="empty-msg">Loading…</td></tr></tbody>
      </table></div>
    </div>
  </div>

  ${tracesPromptModalHtml()}

  <script>
    ${helpers}
    ${tracesPromptModalScript()}
  </script>
  <script>
    // Prompt modal reuse: it reads these globals. We have no waterfall spans on
    // this page, so renderPromptStats finds nothing (fine); the traceId is set
    // per-card before openPromptModal() runs.
    var waterfallSpans = [];
    var currentWaterfallTraceId = null;

    var phaseLabels = {
      idle: 'Idle', receiving: 'Receiving', transcribing: 'Transcribing',
      building_prompt: 'Building prompt', calling_claude: 'Calling model',
      saving_response: 'Saving', sending_telegram: 'Sending', sending_slack: 'Sending',
      synthesizing_voice: 'Voice', running_task: 'Running task',
      checking_goals: 'Checking goals', running_watcher: 'Running watcher',
      // Research phases + gardener drain stages (mirror the server AgentPhase union).
      searching: 'Searching', synthesizing: 'Synthesizing',
      assembling: 'Assembling', harvesting: 'Harvesting', clustering: 'Clustering',
      resolving: 'Resolving', drafting: 'Drafting'
    };
    // Mirror of the server kindLabel() in dashboard/agents-overview.ts — a new
    // AgentKind must be added to BOTH.
    var kindLabels = {
      chat: 'Chat', scheduled_task: 'Task', watcher: 'Watcher',
      gardener_drain: 'Gardener', capture: 'Capture', research: 'Research',
      extractor: 'Extractor', profile: 'Profile'
    };

    var selectedBot = '';
    try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch (e) {}

    var lastRuns = [];       // last agent_runs snapshot
    var estimatesMap = {};   // identity -> expectedDurationMs (from /api/agents/overview)
    var processStartedAt = null;
    var agentsRaf = null;
    var agentsLastTick = 0;
    var AGENTS_TICK_MS = 100;

    function matchesBot(bot) { return !selectedBot || bot === selectedBot; }

    // --- ETA helpers (hand-mirror of src/dashboard/agent-eta.ts — keep in sync) ---
    function fmtDurationShort(ms) {
      var clamped = ms < 0 ? 0 : ms;
      var s = Math.round(clamped / 1000);
      if (s < 60) return s + 's';
      var m = Math.round(s / 60);
      if (m < 60) return m + 'm';
      var h = Math.floor(m / 60), rm = m % 60;
      return rm ? h + 'h ' + rm + 'm' : h + 'h';
    }
    function estimateIdentity(kind, name) { return (kind || 'chat') + '\\u0000' + (name || ''); }
    // Returns { elapsedMs, barMode, barPct?, etaLabel?, expectedDurationMs? }.
    // pacedExpectedMs FREEZES the pace across a snapshot: the render pass computes
    // pace once and stores it (data-paced); each rAF tick feeds it back so the
    // countdown decreases against a fixed expected instead of ballooning as live
    // elapsed grows while done is unchanged (mirror of src/dashboard/agent-eta.ts).
    function computeCardEta(r, historyExpectedMs, now, pacedExpectedMs) {
      var end = (r.completed && r.completedAt != null) ? r.completedAt : now;
      var elapsedMs = Math.max(0, end - r.startedAt);
      if (r.completed) return { elapsedMs: elapsedMs, barMode: 'done' };
      var kind = r.kind || 'chat';
      var p = r.progress;
      var hasDiscrete = !!(p && p.total > 0);
      var expected = kind === 'chat' ? undefined : (historyExpectedMs != null ? historyExpectedMs : undefined);
      if (kind === 'gardener_drain' && p && p.total > 0 && p.done > 0) {
        expected = (pacedExpectedMs != null && pacedExpectedMs > 0)
          ? pacedExpectedMs
          : Math.round((elapsedMs / p.done) * p.total);
      }
      var barMode, barPct;
      if (hasDiscrete) {
        barMode = 'determinate'; barPct = Math.min(100, Math.round((p.done / p.total) * 100));
      } else if (expected && expected > 0) {
        if (elapsedMs >= expected) { barMode = 'over'; }
        else { barMode = 'estimate'; barPct = Math.min(95, Math.round((elapsedMs / expected) * 100)); }
      } else { barMode = 'indeterminate'; }
      var etaLabel;
      if (expected && expected > 0) {
        var remaining = expected - elapsedMs;
        etaLabel = remaining > 0 ? '~' + fmtDurationShort(remaining) + ' left · est.' : 'running over est.';
      }
      var out = { elapsedMs: elapsedMs, barMode: barMode };
      if (barPct != null) out.barPct = barPct;
      if (etaLabel) out.etaLabel = etaLabel;
      if (expected) out.expectedDurationMs = expected;
      return out;
    }
    function historyEstimateFor(r) {
      var v = estimatesMap[estimateIdentity(r.kind || 'chat', r.name)];
      return v != null ? v : null;
    }

    // "time until" for future up-next slots (timeAgo only handles the past).
    function fmtUntil(ts) {
      var diff = ts - Date.now();
      if (diff <= 0) return 'due now';
      var mins = Math.round(diff / 60000);
      if (mins < 1) return 'in <1m';
      if (mins < 60) return 'in ' + mins + 'm';
      var hrs = Math.floor(mins / 60);
      if (hrs < 24) return 'in ' + hrs + 'h ' + (mins % 60) + 'm';
      var days = Math.floor(hrs / 24);
      if (days < 7) return 'in ' + days + 'd';
      return new Date(ts).toLocaleDateString();
    }

    // --- Bot selector ---
    (function initBotSelector() { loadBotList(); })();

    function loadBotList() {
      fetch('/api/bots').then(function (r) { return r.json(); }).then(function (res) {
        var container = document.getElementById('botSelector');
        var bots = res.bots || [];
        container.innerHTML =
          '<button class="bot-pill' + (!selectedBot ? ' active' : '') + '" data-bot="">All Bots</button>' +
          bots.map(function (b) {
            return '<button class="bot-pill' + (selectedBot === b ? ' active' : '') + '" data-bot="' + escapeAttr(b) + '">' +
              esc(b.charAt(0).toUpperCase() + b.slice(1)) + '</button>';
          }).join('');
      }).catch(function () {});
    }

    document.getElementById('botSelector').addEventListener('click', function (e) {
      var pill = e.target.closest('.bot-pill');
      if (!pill) return;
      selectedBot = pill.dataset.bot;
      try { localStorage.setItem('muninn-selected-bot', selectedBot); } catch (err) {}
      document.querySelectorAll('.bot-pill').forEach(function (p) {
        p.classList.toggle('active', p.dataset.bot === selectedBot);
      });
      renderRunning(lastRuns);
      loadOverview();
    });

    // Honest empty state: name when the process started, since the in-memory
    // completed-runs history (the ETA source for non-watcher kinds) resets then.
    function updateRunningEmpty() {
      var empty = document.getElementById('runningEmpty');
      if (!empty) return;
      empty.textContent = processStartedAt
        ? 'No live runs — process up since ' + new Date(processStartedAt).toLocaleString() +
          '; in-memory history resets on restart.'
        : 'Nothing running right now.';
    }

    // --- Running zone (live via SSE) ---
    function renderRunning(runs) {
      lastRuns = runs || [];
      var visible = lastRuns.filter(function (r) { return matchesBot(r.botName); });
      var zone = document.getElementById('runningZone');
      var empty = document.getElementById('runningEmpty');
      document.getElementById('runningCount').textContent = visible.length;
      if (visible.length === 0) {
        zone.innerHTML = '';
        updateRunningEmpty();
        empty.style.display = 'block';
        stopAgentsRaf();
        return;
      }
      empty.style.display = 'none';
      zone.innerHTML = visible.map(runCardHtml).join('');
      // Auto-scroll each mini-log to its newest entry after the re-render.
      zone.querySelectorAll('[data-log]').forEach(function (el) { el.scrollTop = el.scrollHeight; });
      if (visible.some(function (r) { return !r.completed; })) startAgentsRaf();
      else stopAgentsRaf();
    }

    // Build the bar HTML for a computeCardEta() model.
    function barHtmlFor(m) {
      if (m.barMode === 'determinate' || m.barMode === 'estimate') {
        return '<div class="run-bar-fill" data-bar style="width:' + (m.barPct || 0) + '%"></div>';
      }
      if (m.barMode === 'done') return '<div class="run-bar-fill" data-bar style="width:100%"></div>';
      // indeterminate + over both render the shimmer sweep (over adds the .over tint).
      return '<div class="shimmer-bar"></div>';
    }

    // Truthful "connector · model" chip. Both fields ship on the AgentRun over
    // the agent_runs SSE snapshot (set at startRequest time by the producer);
    // renders whatever subset is present, nothing when neither is.
    function connChip(r) {
      var label = r.connectorLabel || '';
      var model = r.model || '';
      if (!label && !model) return '';
      var inner = esc(label);
      if (model) inner += (label ? ' · ' : '') + '<code>' + esc(model) + '</code>';
      return '<span class="run-conn">' + inner + '</span>';
    }

    function runCardHtml(r) {
      var kind = r.kind || 'chat';
      var name = r.name || kindLabels[kind] || 'Run';
      var phase = phaseLabels[r.phase] || r.phase || '';
      // Gardener drain: the card title tracks the live stage ("Drain: Clustering"),
      // while the server-side run name stays the stable "Backlog drain" (Recent).
      if (kind === 'gardener_drain') name = 'Drain: ' + (phase || 'running');
      var done = !!r.completed;

      var eta = computeCardEta(r, historyEstimateFor(r), Date.now());
      var trackCls = 'run-bar-track' + (eta.barMode === 'over' ? ' over' : '');
      var barHtml = barHtmlFor(eta);

      var progLabel = '';
      if (r.progress && r.progress.total > 0) {
        progLabel = '<div class="run-prog-label">' + r.progress.done + ' / ' + r.progress.total +
          (r.progress.currentItem ? ' — ' + esc(r.progress.currentItem) : '') + '</div>';
      }
      var etaLine = eta.etaLabel
        ? '<div class="run-eta' + (eta.barMode === 'over' ? ' over' : '') + '" data-eta>' + esc(eta.etaLabel) + '</div>'
        : '<div class="run-eta" data-eta></div>';

      // Usage summary — in / out / turns / tools. Tokens update live over SSE
      // (usage_progress → updateUsage); turns/tools land at completion. Rendered
      // whenever any field is present (a completed watcher/chat card, or a live
      // run already reporting tokens).
      var usageParts = [];
      if (r.inputTokens != null) usageParts.push('<span><b>' + fmtTokens(r.inputTokens) + '</b> in</span>');
      if (r.outputTokens != null) usageParts.push('<span><b>' + fmtTokens(r.outputTokens) + '</b> out</span>');
      if (r.numTurns != null) usageParts.push('<span><b>' + r.numTurns + '</b> turn' + (r.numTurns !== 1 ? 's' : '') + '</span>');
      if (r.toolCount != null && r.toolCount > 0) usageParts.push('<span><b>' + r.toolCount + '</b> tool' + (r.toolCount !== 1 ? 's' : '') + '</span>');
      var usageLine = usageParts.length ? '<div class="run-usage">' + usageParts.join('') + '</div>' : '';

      // Live scrolling mini-log: recent tool steps (auto-scrolled to the newest in
      // renderRunning), with the current phase as a trailing "→ <phase>" line.
      var toolRows = (r.tools || []).slice(-6).map(function (t) {
        var dur = t.durationMs != null ? fmtMs(t.durationMs) : (!t.endedAt ? fmtMs(Date.now() - t.startedAt) : '');
        return '<div class="run-tool"><span class="run-tool-name">' + esc(t.displayName || t.name || '') + '</span>' +
          '<span class="run-tool-dur">' + dur + '</span></div>';
      });
      if (!done && phase) {
        toolRows.push('<div class="run-tool phase"><span class="run-tool-name">→ ' + esc(phase) + '</span></div>');
      }
      var tools = toolRows.join('');

      var links = [];
      if (r.traceId) links.push('<a class="run-link" href="/traces#' + escapeAttr(r.traceId) + '">Trace</a>');
      if (r.traceId) links.push('<button class="run-link" data-prompt="' + escapeAttr(r.traceId) + '">Prompt</button>');
      links.push('<a class="run-link" href="/models?bot=' + encodeURIComponent(r.botName || '') + '">Models</a>');
      if (r.sourcePage) links.push('<a class="run-link" href="' + escapeAttr(r.sourcePage) + '">Open</a>');

      // Freeze the render-time expected (pace for gardener drains) so rAF ticks
      // count DOWN against it instead of recomputing pace from growing elapsed.
      var pacedAttr = (eta.expectedDurationMs != null) ? ' data-paced="' + eta.expectedDurationMs + '"' : '';

      return '<div class="run-card' + (done ? ' done' : '') + '" data-req="' + escapeAttr(r.requestId) + '"' + pacedAttr + '>' +
        '<div class="run-top">' +
          '<span class="pulse-dot"></span>' +
          '<span class="kind-pill kind-' + esc(kind) + '">' + esc(kindLabels[kind] || kind) + '</span>' +
          '<span class="run-name" title="' + escapeAttr(name) + '">' + esc(name) + '</span>' +
          '<span class="run-elapsed" data-elapsed>' + fmtMs(eta.elapsedMs) + '</span>' +
        '</div>' +
        '<div class="run-top">' +
          (r.botName ? '<span class="run-bot">' + esc(r.botName) + '</span>' : '') +
          connChip(r) +
          '<span class="run-phase">' + esc(done ? 'Completed' : phase) + '</span>' +
        '</div>' +
        '<div class="' + trackCls + '" data-track>' + barHtml + '</div>' +
        progLabel +
        etaLine +
        usageLine +
        (tools ? '<div class="run-tools" data-log>' + tools + '</div>' : '') +
        (links.length ? '<div class="run-links">' + links.join('') + '</div>' : '') +
      '</div>';
    }

    // In-place rAF tick: advance elapsed timer + estimate bar width + ETA line
    // without a full re-render, so the pulse/shimmer CSS animations never restart.
    // A crossing into "running over est." between SSE snapshots is handled at the
    // next snapshot's re-render (which swaps the shimmer in); the tick keeps the
    // countdown honest until then.
    function tickAgents() {
      var now = Date.now();
      var visible = lastRuns.filter(function (r) { return matchesBot(r.botName); });
      for (var i = 0; i < visible.length; i++) {
        var r = visible[i];
        if (r.completed) continue;
        var card = document.querySelector('.run-card[data-req="' + r.requestId + '"]');
        if (!card) continue;
        var el = card.querySelector('[data-elapsed]');
        if (el) el.textContent = fmtMs(now - r.startedAt);
        var pacedAttr = card.getAttribute('data-paced');
        var paced = pacedAttr ? Number(pacedAttr) : null;
        var eta = computeCardEta(r, historyEstimateFor(r), now, paced);
        if (eta.barMode === 'estimate') {
          var bar = card.querySelector('[data-bar]');
          if (bar) bar.style.width = (eta.barPct || 0) + '%';
        }
        var etaEl = card.querySelector('[data-eta]');
        if (etaEl) {
          etaEl.textContent = eta.etaLabel || '';
          etaEl.classList.toggle('over', eta.barMode === 'over');
        }
      }
    }

    function startAgentsRaf() {
      if (agentsRaf) return;
      function loop(ts) {
        if (ts - agentsLastTick >= AGENTS_TICK_MS) { agentsLastTick = ts; tickAgents(); }
        agentsRaf = requestAnimationFrame(loop);
      }
      agentsRaf = requestAnimationFrame(loop);
    }
    function stopAgentsRaf() {
      if (agentsRaf) { cancelAnimationFrame(agentsRaf); agentsRaf = null; }
    }

    // Prompt modal open (delegated) — set the traceId the modal reads, then open.
    document.getElementById('runningZone').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-prompt]');
      if (!btn) return;
      currentWaterfallTraceId = btn.dataset.prompt;
      openPromptModal();
    });

    // --- Up next + recent (from /api/agents/overview) ---
    // Monotonic fetch-sequence guard: a slower earlier response must never
    // overwrite a newer render if two loads overlap.
    var overviewSeq = 0;
    function loadOverview() {
      var mySeq = ++overviewSeq;
      getJson('/api/agents/overview').then(function (data) {
        if (mySeq !== overviewSeq) return; // superseded by a newer load
        document.getElementById('errBox').innerHTML = (data.errors && data.errors.length)
          ? '<div class="err-note">Degraded sources: ' + esc(data.errors.join('; ')) + '</div>' : '';
        estimatesMap = data.estimates || {};
        if (data.processStartedAt) processStartedAt = data.processStartedAt;
        updateRunningEmpty();
        renderUpNext(data.upNext || []);
        renderRecent(data.recent || []);
      }).catch(function (e) {
        if (mySeq !== overviewSeq) return;
        document.getElementById('errBox').innerHTML =
          '<div class="err-note">Failed to load overview: ' + esc(String(e)) + '</div>';
      });
    }

    function renderUpNext(items) {
      var visible = items.filter(function (r) { return matchesBot(r.bot); });
      document.getElementById('upNextCount').textContent = visible.length;
      var body = document.getElementById('upNextBody');
      if (visible.length === 0) { body.innerHTML = '<tr><td colspan="4" class="empty-msg">Nothing scheduled.</td></tr>'; return; }
      var now = Date.now();
      body.innerHTML = visible.map(function (r) {
        var due = r.label || fmtUntil(r.nextRunAt);
        var whenCls = (r.nextRunAt <= now || r.label) ? 'when due' : 'when';
        return '<tr>' +
          '<td><span class="' + whenCls + '">' + esc(due) + '</span></td>' +
          '<td><span class="tag">' + esc(kindLabels[r.kind] || r.kind) + '</span></td>' +
          '<td>' + (r.sourcePage ? '<a class="run-link" href="' + escapeAttr(r.sourcePage) + '">' + esc(r.name) + '</a>' : esc(r.name)) + '</td>' +
          '<td>' + (r.bot ? '<code>' + esc(r.bot) + '</code>' : '') + '</td>' +
        '</tr>';
      }).join('');
    }

    function renderRecent(items) {
      var visible = items.filter(function (r) { return matchesBot(r.bot); });
      document.getElementById('recentCount').textContent = visible.length;
      var body = document.getElementById('recentBody');
      if (visible.length === 0) { body.innerHTML = '<tr><td colspan="6" class="empty-msg">No recent runs.</td></tr>'; return; }
      body.innerHTML = visible.map(function (r) {
        var dur = r.durationMs != null ? fmtMs(r.durationMs) : '';
        var statusCls = r.status === 'error' ? ' status-error' : '';
        var link = r.traceId ? '<a class="run-link" href="/traces#' + escapeAttr(r.traceId) + '">Trace</a>' : '';
        // Token counts (watcher spans + extractor/gardener haiku rows carry them).
        var toks = (r.inputTokens != null || r.outputTokens != null)
          ? '<span class="run-toks">' + fmtTokens(r.inputTokens || 0) + ' in · ' + fmtTokens(r.outputTokens || 0) + ' out</span>'
          : '';
        return '<tr>' +
          '<td><span class="when">' + esc(timeAgo(r.finishedAt)) + '</span></td>' +
          '<td><span class="tag' + statusCls + '">' + esc(kindLabels[r.kind] || r.kind) + '</span></td>' +
          '<td>' + esc(r.name) + (r.model ? ' <code>' + esc(r.model) + '</code>' : '') + toks + '</td>' +
          '<td>' + (r.bot ? '<code>' + esc(r.bot) + '</code>' : '') + '</td>' +
          '<td><span class="when">' + esc(dur) + '</span></td>' +
          '<td>' + link + '</td>' +
        '</tr>';
      }).join('');
    }

    // Signature of the currently-running requestIds, so we can refetch the
    // overview only when a run actually starts or finishes — not on every ~1/s
    // agent_runs snapshot (each of which hits /api/agents/overview → 4 DB queries).
    var lastRunningKey = '';
    function runningKey(runs) {
      return (runs || []).filter(function (r) { return !r.completed; })
        .map(function (r) { return r.requestId; }).sort().join(',');
    }

    // --- SSE wiring ---
    sseClient('/api/events', {
      agent_runs: function (ev) {
        try {
          var runs = JSON.parse(ev.data);
          renderRunning(runs);
          // Only a started/finished run (the running set changed) can shift
          // up-next/recent — skip the refetch on plain progress ticks.
          var key = runningKey(runs);
          if (key !== lastRunningKey) {
            lastRunningKey = key;
            loadOverview();
          }
        } catch (e) {}
      }
    });

    loadOverview();
  </script>
</body>
</html>`;
}
