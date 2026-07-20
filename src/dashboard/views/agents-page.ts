import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { botSelectorStyles, botSelectorHtml } from "./components/bot-selector.ts";
import {
  tracesPromptModalStyles,
  tracesPromptModalHtml,
  tracesPromptModalScript,
} from "./components/traces-prompt-modal.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import {
  pageHeaderHtml,
  pageHeaderScript,
  pageHeaderStyles,
} from "./components/page-header.ts";
import { summaryTilesHtml, summaryTilesScript } from "./components/summary-tiles.ts";
import { statusChipsScript } from "./components/status-chips.ts";

/**
 * `/agents` — unified live-agent dashboard (dashboard redesign PR 4). Rebuilt on
 * the PR 1 shared primitives (page header + persisted help panel, summary tiles,
 * unified status/kind chips) with a two-column live zone and a recently-finished
 * feed. Three data planes, unchanged from the MVP:
 *   - Running: live cards from the `agent_runs` SSE event, stacked in the LEFT
 *     column. Each snapshot re-renders the zone's innerHTML (pulse/shimmer CSS
 *     restart ~1/s, matching `request-progress-ui.ts`); between snapshots an
 *     in-place rAF tick advances elapsed timers + estimate bar widths without a
 *     re-render (the two-tier pattern). ALL of the #248–#259 observability is
 *     preserved: tool mini-log, usage line, truthful connector·model chip,
 *     ETA/paced bars, Trace + Prompt + Models + Open links.
 *   - Up next: scheduled tasks + watchers from `/api/agents/overview`, rendered
 *     as a countdown timeline in the RIGHT column (force-queued watchers show
 *     their `label` — "queued" — instead of a countdown).
 *   - Recently finished: the four-source Recent union — a feed card, 8 rows +
 *     "N more · show all" in-place expander, status-driven dots (failed rows loud
 *     red), a Cost column.
 *
 * The bot pills live in the header (right side); they filter all three planes
 * client-side (same `muninn-selected-bot` localStorage key as the other pages).
 */
export async function renderAgentsPage(): Promise<string> {
  const helpers = await helpersClientScript();

  // The former `.intro` paragraph, verbatim, now behind the "?" toggle. The
  // Spend approximation is spelled out here — the tile itself is a hint.
  const helpHtml = `Every AI job muninn is running or has scheduled — chat turns, scheduled tasks, watchers, and
      background pipelines — in one live view. The <strong>Running</strong> zone updates over SSE;
      <strong>Up next</strong> and <strong>Recently finished</strong> refresh from
      <code>/api/agents/overview</code>. Filter by bot with the pills in the header.
      <br><br>
      <strong>Spend · last hr</strong> is a client-side approximation over the finished rows that carry a
      cost: <code>recent</code> is capped at 40 rows (not a strict time window) and <code>costUsd</code> is
      absent on extractor / gardener / subscription-connector runs, so a busy hour undercounts. It reads
      <em>—</em> when no finished row carries a cost — the common case on subscription connectors.`;

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
    ${pageHeaderStyles()}

    .page { padding: 22px 28px 56px; max-width: 1560px; margin: 0 auto; }
    .pghdr-help code { background: var(--bg-surface); padding: 1px 5px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

    .empty-msg { color: var(--text-faint); padding: 18px; text-align: center; font-size: 13px; }
    .err-note { color: var(--status-warning); font-size: 12px; margin: 8px 0; }

    /* Section / column titles (uppercase eyebrow + count). */
    .zone-title {
      font-size: 11px; font-weight: 600; letter-spacing: 0.7px; text-transform: uppercase;
      color: var(--text-soft); margin-bottom: 10px; display: flex; align-items: center; gap: 8px;
    }
    .zone-title .zc { color: var(--text-faint); font-weight: 500; font-size: 11px; }

    /* --- Two-column live zone: running cards LEFT, up-next timeline RIGHT ----- */
    .two-col { display: grid; grid-template-columns: minmax(360px, 440px) 1fr; gap: 14px; align-items: start; margin-bottom: 22px; }
    @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }

    /* --- Running cards (stacked in the left column) ------------------------- */
    .run-col { display: flex; flex-direction: column; gap: 14px; }
    .run-card {
      background: var(--bg-panel); border: 1px solid color-mix(in srgb, var(--status-success) 25%, transparent);
      border-radius: 12px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
    }
    .run-card.done { opacity: 0.6; border-color: var(--border-primary); }
    /* .pulse-dot + keyframes live in shared-styles.ts; only the done override is
       card-specific (it stops the ring via --pulse-anim). */
    .run-card.done .pulse-dot { background: var(--text-dim); --pulse-anim: none; }
    .run-card.done .pulse-dot::after { opacity: 0; }

    .run-top { display: flex; align-items: center; gap: 10px; }
    /* Job-kind chips are fixed 68px in the lists; inside a card they auto-width. */
    .run-card .kind-chip { width: auto; }
    .run-elapsed { font-size: 12px; color: var(--text-muted); font-variant-numeric: tabular-nums;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin-left: auto; }

    .run-title { font-size: 14px; font-weight: 600; color: var(--text-primary); line-height: 1.4;
      overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .run-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 11px; }
    .run-bot { font-size: 11px; color: var(--accent-light); background: color-mix(in srgb, var(--accent) 12%, transparent);
      padding: 2px 9px; border-radius: 10px; }
    /* Truthful backend + model that actually ran (connector · model). */
    .run-conn { font-size: 11px; color: var(--text-muted); }
    .run-conn code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text-secondary); }

    .run-bar-track { height: 4px; border-radius: 3px; background: var(--bg-surface); overflow: hidden; position: relative; }
    .run-bar-fill { height: 100%; border-radius: 3px; background: var(--accent); transition: width 0.2s linear; }
    /* Past the estimate: tint the shimmer amber so "running over est." reads at a glance. */
    .run-bar-track.over .shimmer-bar { background: linear-gradient(90deg, transparent, var(--status-warning), transparent); }
    .run-prog-label { font-size: 11px; color: var(--text-muted); }
    .run-eta { font-size: 11px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
    .run-eta.over { color: var(--status-warning); }

    .run-tools { display: flex; flex-direction: column; gap: 2px; max-height: 84px; overflow-y: auto; scrollbar-width: thin; }
    .run-tool { font-size: 11px; color: var(--text-soft); display: flex; gap: 6px; align-items: baseline; }
    .run-tool-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .run-tool-dur { color: var(--text-dim); font-variant-numeric: tabular-nums; margin-left: auto; flex-shrink: 0; }

    /* Token / turns / tools usage summary (live tokens + completion turns/tools). */
    .run-usage { font-size: 11px; color: var(--text-muted); font-variant-numeric: tabular-nums; display: flex; gap: 10px; flex-wrap: wrap; }
    .run-usage b { color: var(--text-secondary); font-weight: 600; }

    /* Footer: live "→ phase" (accent) on the left, action links on the right. */
    .run-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 2px; }
    .run-phase { font-size: 12px; color: var(--accent-light); }
    .run-links { display: flex; gap: 12px; flex-wrap: wrap; }
    .run-link { color: var(--accent); text-decoration: none; font-size: 12px; background: none; border: none;
      cursor: pointer; padding: 0; font-family: inherit; }
    .run-link:hover { text-decoration: underline; }

    /* --- Up next countdown timeline (right column) -------------------------- */
    .un-card, .rf-card { background: var(--bg-panel); border: 1px solid var(--border-primary); border-radius: 12px; padding: 6px 6px 8px; }
    .un-row { display: flex; align-items: center; padding: 7px 12px; border-radius: 8px; }
    .un-when { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--text-soft);
      width: 88px; flex-shrink: 0; text-align: right; padding-right: 16px; font-variant-numeric: tabular-nums; }
    .un-when.soon { color: var(--status-success); }
    .un-node { position: relative; width: 7px; height: 7px; border-radius: 50%;
      background: var(--border-secondary); flex-shrink: 0; margin-right: 16px; }
    .un-node.soon { background: var(--status-success); }
    .un-node .un-line { position: absolute; left: 3px; top: 11px; width: 1px; height: 22px; background: var(--border-primary); }
    .un-card .un-row:last-child .un-node .un-line { display: none; }
    .un-row .kind-chip { margin-right: 12px; }
    .un-name { font-size: 13px; color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .un-bot { font-size: 11px; color: var(--text-faint); flex-shrink: 0; margin-left: 8px; }

    /* --- Recently finished feed --------------------------------------------- */
    .rf-row { display: flex; align-items: center; gap: 12px; padding: 8px 12px; border-radius: 8px; }
    .rf-when { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-faint);
      width: 64px; flex-shrink: 0; text-align: right; font-variant-numeric: tabular-nums; }
    .rf-row .run-status { flex-shrink: 0; }
    .rf-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text-secondary); }
    .rf-name code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-muted); }
    .rf-toks { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-faint); margin-left: 6px; }
    .rf-bot { font-size: 11px; color: var(--text-faint); width: 64px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rf-dur { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-soft); width: 52px; text-align: right; flex-shrink: 0; }
    .rf-cost { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--text-muted); width: 52px; text-align: right; flex-shrink: 0; }
    .rf-trace { width: 40px; text-align: right; flex-shrink: 0; }
    /* Failed rows stay loud: red time + name (the status dot is already red). */
    .rf-row.failed .rf-when, .rf-row.failed .rf-name { color: var(--status-error); }
    .rf-more { padding: 9px 12px 5px; font-size: 11px; color: var(--text-faint); }
    .rf-showall { color: var(--accent); cursor: pointer; font-size: 11px; }
    .rf-showall:hover { text-decoration: underline; }
    .rf-showall:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
  </style>
</head>
<body>
  ${renderNav("agents", { headerRight: botSelectorHtml() })}

  <div class="page">
    ${pageHeaderHtml({
      title: "Agents",
      metaHtml: `<span id="agMeta">live over SSE</span>`,
      helpHtml,
    })}

    ${summaryTilesHtml("agTiles")}

    <div id="errBox"></div>

    <div class="two-col">
      <div>
        <div class="zone-title">Running <span class="zc" id="runningCount">0</span></div>
        <div class="run-col" id="runningZone"></div>
        <div class="empty-msg" id="runningEmpty">Nothing running right now.</div>
      </div>
      <div>
        <div class="zone-title">Up next <span class="zc" id="upNextCount">0</span></div>
        <div class="un-card" id="upNextCard"><div class="empty-msg">Loading…</div></div>
      </div>
    </div>

    <div class="zone-title">Recently finished <span class="zc" id="recentCount">0</span></div>
    <div class="rf-card" id="recentCard"><div class="empty-msg">Loading…</div></div>
  </div>

  ${tracesPromptModalHtml()}

  <script>
    ${helpers}
    ${summaryTilesScript()}
    ${statusChipsScript()}
    ${pageHeaderScript("agents")}
    ${tracesPromptModalScript()}
  </script>
  <script>
    // Prompt modal reuse: it reads these globals. We have no waterfall spans on
    // this page, so renderPromptStats finds nothing (fine); the traceId is set
    // per-card before openPromptModal() runs.
    var waterfallSpans = [];
    var currentWaterfallTraceId = null;

    var RECENT_SHOWN = 8;

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
    // AgentKind must be added to BOTH. Used for tile subs + running-card titles.
    var kindLabels = {
      chat: 'Chat', scheduled_task: 'Task', watcher: 'Watcher',
      gardener_drain: 'Gardener', capture: 'Capture', research: 'Research',
      digest: 'Wiki digest', extractor: 'Extractor', profile: 'Profile'
    };
    // Raw AgentKind → SHORT chip label; kindChip() (status-chips.ts) uppercases it
    // and maps to the shared .kind-* palette. Keep in sync with KIND_CHIP_CLASS.
    var KIND_SHORT = {
      chat: 'Chat', scheduled_task: 'Task', watcher: 'Watcher',
      gardener_drain: 'Gardener', capture: 'Capture', research: 'Research',
      digest: 'Digest', extractor: 'Extractor', profile: 'Profile'
    };
    function kindChipFor(kind) { return kindChip(KIND_SHORT[kind] || kind || 'chat'); }
    function isFailed(r) { return /^(error|failed)$/i.test(r.status || ''); }

    var selectedBot = '';
    try { selectedBot = localStorage.getItem('muninn-selected-bot') || ''; } catch (e) {}

    var lastRuns = [];       // last agent_runs snapshot
    var lastUpNext = [];     // last overview upNext (unfiltered)
    var lastRecent = [];     // last overview recent (unfiltered)
    var recentExpanded = false;
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

    // --- Bot selector (header pills) ---
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
      updateMeta();
      renderRunning(lastRuns);
      loadOverview();
    });

    function updateMeta() {
      var meta = document.getElementById('agMeta');
      if (meta) meta.textContent = 'live over SSE · ' + (selectedBot ? 'filtered to ' + selectedBot : 'all bots');
    }

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

    // --- Summary tiles (Running / Up next / Finished / Spend) ---------------
    // Spend is a CLIENT-SIDE approximation over finished rows that carry a cost
    // within the last hour (see the help panel). '—' when none carry cost.
    function computeSpend(rec, now) {
      var priced = rec.filter(function (r) { return r.costUsd != null && (now - r.finishedAt) <= 3600000; });
      if (priced.length === 0) return { value: '—', sub: 'no priced runs · last hr' };
      var total = priced.reduce(function (a, r) { return a + r.costUsd; }, 0);
      var durs = priced.filter(function (r) { return r.durationMs != null; });
      var avg = durs.length ? durs.reduce(function (a, r) { return a + r.durationMs; }, 0) / durs.length : null;
      var sub = '~' + priced.length + ' priced' + (avg != null ? ' · avg ' + fmtMs(avg) : '');
      return { value: fmtCost(total), sub: sub };
    }

    function renderTiles() {
      var el = document.getElementById('agTiles');
      if (!el) return;
      var now = Date.now();
      var runs = lastRuns.filter(function (r) { return matchesBot(r.botName) && !r.completed; });
      var up = lastUpNext.filter(function (r) { return matchesBot(r.bot); });
      var rec = lastRecent.filter(function (r) { return matchesBot(r.bot); });

      var runSub = 'idle';
      if (runs.length) {
        var r0 = runs[0];
        runSub = (kindLabels[r0.kind || 'chat'] || 'Run') + ' · ' + fmtMs(now - r0.startedAt) + ' elapsed';
      }
      var upSub = 'nothing scheduled';
      if (up.length) {
        var u0 = up[0];
        upSub = u0.name + ' · ' + (u0.label || fmtUntil(u0.nextRunAt));
      }
      var failed = rec.filter(isFailed).length;
      var sp = computeSpend(rec, now);

      var tiles = [
        { label: 'Running', value: runs.length, sub: runSub, tone: runs.length ? 'success' : undefined },
        { label: 'Up next', value: up.length, sub: upSub },
        { label: 'Finished', value: rec.length, sub: failed + ' failed recently', tone: failed ? 'error' : undefined },
        { label: 'Spend · last hr', value: sp.value, sub: sp.sub }
      ];
      el.innerHTML = tiles.map(tileHtml).join('');
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
        renderTiles();
        return;
      }
      empty.style.display = 'none';
      zone.innerHTML = visible.map(runCardHtml).join('');
      // Auto-scroll each mini-log to its newest entry after the re-render.
      zone.querySelectorAll('[data-log]').forEach(function (el) { el.scrollTop = el.scrollHeight; });
      if (visible.some(function (r) { return !r.completed; })) startAgentsRaf();
      else stopAgentsRaf();
      renderTiles();
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
      // (usage_progress → updateUsage); turns/tools land at completion.
      var usageParts = [];
      if (r.inputTokens != null) usageParts.push('<span><b>' + fmtTokens(r.inputTokens) + '</b> in</span>');
      if (r.outputTokens != null) usageParts.push('<span><b>' + fmtTokens(r.outputTokens) + '</b> out</span>');
      if (r.numTurns != null) usageParts.push('<span><b>' + r.numTurns + '</b> turn' + (r.numTurns !== 1 ? 's' : '') + '</span>');
      if (r.toolCount != null && r.toolCount > 0) usageParts.push('<span><b>' + r.toolCount + '</b> tool' + (r.toolCount !== 1 ? 's' : '') + '</span>');
      var usageLine = usageParts.length ? '<div class="run-usage">' + usageParts.join('') + '</div>' : '';

      // Live scrolling mini-log: recent tool steps (auto-scrolled to the newest in
      // renderRunning). The live phase moves to the card footer ("→ <phase>").
      var toolRows = (r.tools || []).slice(-6).map(function (t) {
        var dur = t.durationMs != null ? fmtMs(t.durationMs) : (!t.endedAt ? fmtMs(Date.now() - t.startedAt) : '');
        return '<div class="run-tool"><span class="run-tool-name">' + esc(t.displayName || t.name || '') + '</span>' +
          '<span class="run-tool-dur">' + dur + '</span></div>';
      });
      var tools = toolRows.join('');

      var links = [];
      if (r.traceId) links.push('<a class="run-link" href="/traces#' + escapeAttr(r.traceId) + '">Trace</a>');
      if (r.traceId) links.push('<button class="run-link" data-prompt="' + escapeAttr(r.traceId) + '">Prompt</button>');
      links.push('<a class="run-link" href="/models?bot=' + encodeURIComponent(r.botName || '') + '">Models</a>');
      if (r.sourcePage) links.push('<a class="run-link" href="' + escapeAttr(r.sourcePage) + '">Open</a>');

      // Footer: live phase (accent) + action links — the design's footer, ADDED
      // beneath the preserved observability blocks.
      var footPhase = done ? 'Completed' : (phase ? '→ ' + esc(phase) : '');
      var footHtml = '<div class="run-foot"><span class="run-phase">' + footPhase + '</span>' +
        (links.length ? '<div class="run-links">' + links.join('') + '</div>' : '') + '</div>';

      // Freeze the render-time expected (pace for gardener drains) so rAF ticks
      // count DOWN against it instead of recomputing pace from growing elapsed.
      var pacedAttr = (eta.expectedDurationMs != null) ? ' data-paced="' + eta.expectedDurationMs + '"' : '';

      return '<div class="run-card' + (done ? ' done' : '') + '" data-req="' + escapeAttr(r.requestId) + '"' + pacedAttr + '>' +
        '<div class="run-top">' +
          '<span class="pulse-dot"></span>' +
          kindChipFor(kind) +
          '<span class="run-elapsed" data-elapsed>' + fmtMs(eta.elapsedMs) + '</span>' +
        '</div>' +
        '<div class="run-title" title="' + escapeAttr(name) + '">' + esc(name) + '</div>' +
        '<div class="run-meta">' +
          (r.botName ? '<span class="run-bot">' + esc(r.botName) + '</span>' : '') +
          connChip(r) +
        '</div>' +
        '<div class="' + trackCls + '" data-track>' + barHtml + '</div>' +
        progLabel +
        etaLine +
        usageLine +
        (tools ? '<div class="run-tools" data-log>' + tools + '</div>' : '') +
        footHtml +
      '</div>';
    }

    // In-place rAF tick: advance elapsed timer + estimate bar width + ETA line
    // without a full re-render, so the pulse/shimmer CSS animations never restart.
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
        lastUpNext = data.upNext || [];
        lastRecent = data.recent || [];
        renderUpNext(lastUpNext);
        renderRecent(lastRecent);
        renderTiles();
      }).catch(function (e) {
        if (mySeq !== overviewSeq) return;
        document.getElementById('errBox').innerHTML =
          '<div class="err-note">Failed to load overview: ' + esc(String(e)) + '</div>';
      });
    }

    function renderUpNext(items) {
      var visible = items.filter(function (r) { return matchesBot(r.bot); });
      document.getElementById('upNextCount').textContent = visible.length;
      var card = document.getElementById('upNextCard');
      if (visible.length === 0) { card.innerHTML = '<div class="empty-msg">Nothing scheduled.</div>'; return; }
      var now = Date.now();
      card.innerHTML = visible.map(function (r) {
        // Preserve the label override: force-queued watchers render "queued for
        // next tick" / "due now" instead of a countdown (and read as imminent).
        var when = r.label || fmtUntil(r.nextRunAt);
        var soon = !!r.label || (r.nextRunAt - now) <= 1800000;
        var nameHtml = r.sourcePage
          ? '<a class="run-link" href="' + escapeAttr(r.sourcePage) + '">' + esc(r.name) + '</a>'
          : esc(r.name);
        return '<div class="un-row hover-wash">' +
          '<span class="un-when' + (soon ? ' soon' : '') + '">' + esc(when) + '</span>' +
          '<span class="un-node' + (soon ? ' soon' : '') + '"><span class="un-line"></span></span>' +
          kindChipFor(r.kind) +
          '<span class="un-name">' + nameHtml + '</span>' +
          '<span class="un-bot">' + (r.bot ? esc(r.bot) : '') + '</span>' +
        '</div>';
      }).join('');
    }

    function recentRowHtml(r) {
      var failed = isFailed(r);
      // Status-driven dot (not the prototype's hardcoded green): 'ok'/absent →
      // succeeded (green), error/failed → red, running → info. Empty label = dot only.
      var dotStatus = (r.status === 'ok' || !r.status) ? 'succeeded' : r.status;
      var dur = r.durationMs != null ? fmtMs(r.durationMs) : '';
      var toks = (r.inputTokens != null || r.outputTokens != null)
        ? '<span class="rf-toks">' + fmtTokens(r.inputTokens || 0) + ' in · ' + fmtTokens(r.outputTokens || 0) + ' out</span>'
        : '';
      var nameHtml = esc(r.name) + (r.model ? ' <code>' + esc(r.model) + '</code>' : '') + toks;
      var trace = r.traceId ? '<a class="run-link" href="/traces#' + escapeAttr(r.traceId) + '">Trace</a>' : '';
      return '<div class="rf-row hover-wash' + (failed ? ' failed' : '') + '">' +
        '<span class="rf-when">' + esc(timeAgo(r.finishedAt)) + '</span>' +
        runStatusChip(dotStatus, '') +
        kindChipFor(r.kind) +
        '<span class="rf-name">' + nameHtml + '</span>' +
        '<span class="rf-bot">' + (r.bot ? esc(r.bot) : '') + '</span>' +
        '<span class="rf-dur">' + esc(dur) + '</span>' +
        '<span class="rf-cost">' + esc(fmtCost(r.costUsd)) + '</span>' +
        '<span class="rf-trace">' + trace + '</span>' +
      '</div>';
    }

    function renderRecent(items) {
      var visible = items.filter(function (r) { return matchesBot(r.bot); });
      document.getElementById('recentCount').textContent = visible.length;
      var card = document.getElementById('recentCard');
      if (visible.length === 0) { card.innerHTML = '<div class="empty-msg">No recent runs.</div>'; return; }
      var shown = recentExpanded ? visible : visible.slice(0, RECENT_SHOWN);
      var rows = shown.map(recentRowHtml).join('');
      var more = '';
      if (visible.length > RECENT_SHOWN) {
        more = recentExpanded
          ? '<div class="rf-more"><span class="rf-showall" role="button" tabindex="0" aria-expanded="true">show less</span></div>'
          : '<div class="rf-more">' + (visible.length - RECENT_SHOWN) + ' more · ' +
            '<span class="rf-showall" role="button" tabindex="0" aria-expanded="false">show all</span></div>';
      }
      card.innerHTML = rows + more;
    }

    // Recently-finished expander — delegated click + keydown (the card subtree is
    // rebuilt on every overview poll; the boolean state survives the re-render).
    var recentCardEl = document.getElementById('recentCard');
    function toggleRecent() { recentExpanded = !recentExpanded; renderRecent(lastRecent); }
    recentCardEl.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('.rf-showall')) toggleRecent();
    });
    recentCardEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      if (!e.target.closest || !e.target.closest('.rf-showall')) return;
      e.preventDefault();
      toggleRecent();
    });

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

    updateMeta();
    loadOverview();
  </script>
</body>
</html>`;
}
