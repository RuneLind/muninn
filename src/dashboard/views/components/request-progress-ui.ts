/** Live request progress panel — mini-waterfall showing tool timing + parallelism */

export function requestProgressStyles(): string {
  return `
    .request-progress {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border-primary);
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.35s ease, padding 0.35s ease, opacity 0.3s ease;
      opacity: 0;
      padding: 0 24px;
    }
    .request-progress.visible {
      max-height: 400px;
      opacity: 1;
      padding: 12px 24px;
    }
    .request-progress.completed {
      border-left: 3px solid var(--status-success);
    }
    .rp-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .rp-header-left {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .rp-phase {
      font-size: 12px;
      font-weight: 500;
      color: var(--accent-light);
    }
    .rp-elapsed {
      font-size: 11px;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
    }
    .rp-bot {
      font-size: 11px;
      color: var(--text-faint);
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .rp-user {
      font-size: 11px;
      color: var(--text-faint);
    }
    .rp-dismiss {
      background: none;
      border: none;
      color: var(--text-faint);
      cursor: pointer;
      font-size: 16px;
      padding: 2px 6px;
      border-radius: 4px;
      line-height: 1;
      transition: color 0.15s, background 0.15s;
    }
    .rp-dismiss:hover {
      color: var(--text-tertiary);
      background: rgba(255,255,255,0.06);
    }

    /* Mini-waterfall */
    .rp-waterfall {
      margin: 6px 0;
    }
    .rp-wf-row {
      display: grid;
      grid-template-columns: 140px 1fr;
      align-items: center;
      gap: 8px;
      height: 22px;
      margin-bottom: 2px;
    }
    .rp-wf-label {
      font-size: 11px;
      color: var(--text-soft);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-align: right;
    }
    .rp-wf-track {
      position: relative;
      height: 14px;
      background: rgba(255,255,255,0.02);
      border-radius: 3px;
    }
    .rp-wf-bar {
      position: absolute;
      top: 1px;
      height: 12px;
      border-radius: 2px;
      background: var(--status-tool);
      min-width: 3px;
      transition: left 0.12s linear, width 0.12s linear;
    }
    .rp-wf-bar.active {
      animation: rp-bar-pulse 1.5s ease-in-out infinite;
    }
    .rp-wf-bar.done {
      background: color-mix(in srgb, var(--status-tool) 50%, transparent);
    }
    @keyframes rp-bar-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .rp-wf-meta {
      position: absolute;
      top: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      line-height: 14px;
      pointer-events: none;
    }
    .rp-wf-dur {
      font-size: 10px;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
      width: 50px;
      text-align: right;
      flex-shrink: 0;
    }
    .rp-wf-input {
      font-size: 10px;
      color: var(--text-faint);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 600px;
    }

    /* Now marker */
    .rp-wf-now {
      position: absolute;
      top: 0;
      width: 1px;
      height: 100%;
      background: color-mix(in srgb, var(--accent) 40%, transparent);
      z-index: 1;
      transition: left 0.12s linear;
    }

    /* Summary */
    .rp-summary {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 6px;
    }
    .rp-summary-stat {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .rp-summary-val {
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }
    .rp-trace-link {
      color: var(--accent);
      text-decoration: none;
      font-size: 11px;
    }
    .rp-trace-link:hover {
      text-decoration: underline;
    }
  `;
}

export function requestProgressHtml(): string {
  return `<div class="request-progress" id="requestProgress"></div>`;
}

export function requestProgressScript(): string {
  return `
    let rpAnimFrame = null;
    let rpLastProgress = null;
    let rpLastTickTime = 0;
    const RP_TICK_MS = 50;

    function updateRequestProgress(progress) {
      // Global flag: suppress waterfall panel for bots with showWaterfall=false
      // Set by chat page's selectBot() — checked here to avoid IIFE scope issues
      if (window._suppressWaterfall) {
        if (typeof updateAgentStatusFromProgress === 'function') {
          updateAgentStatusFromProgress(progress);
        }
        return;
      }

      const panel = document.getElementById('requestProgress');
      if (!panel) return;

      if (!progress) {
        panel.classList.remove('visible', 'completed');
        stopRpAnim();
        rpLastProgress = null;
        if (typeof updateAgentStatusFromProgress === 'function') {
          updateAgentStatusFromProgress(null);
        }
        return;
      }

      rpLastProgress = progress;
      panel.classList.add('visible');
      panel.classList.toggle('completed', !!progress.completed);

      // Full structural render on SSE events (new tools, phase changes, completion)
      renderRpPanel(progress);

      if (!progress.completed) {
        startRpAnim();
      } else {
        stopRpAnim();
      }

      if (typeof updateAgentStatusFromProgress === 'function') {
        updateAgentStatusFromProgress(progress);
      }
    }

    // Full innerHTML render — called on SSE events (structural changes)
    function renderRpPanel(progress) {
      const panel = document.getElementById('requestProgress');
      if (!panel) return;

      const now = Date.now();
      const elapsed = progress.completed && progress.completedAt
        ? fmtMs(progress.completedAt - progress.startedAt)
        : fmtMs(now - progress.startedAt);

      let phaseLabel = (typeof phaseLabels !== 'undefined' && phaseLabels[progress.phase]) || progress.phase;
      if (progress.phase === 'calling_claude' && progress.connectorLabel) {
        let connLabel = progress.connectorLabel;
        if (progress.model) connLabel += ' (' + progress.model + ')';
        phaseLabel = 'Calling ' + connLabel;
      }
      const toolCount = progress.toolCount ?? progress.tools.length;
      const userHtml = progress.username ? '<span class="rp-user">@' + escapeHtml(progress.username) + '</span>' : '';

      const reqStart = progress.startedAt;
      const reqEnd = progress.completed && progress.completedAt ? progress.completedAt : now;
      const totalDuration = Math.max(reqEnd - reqStart, 1);

      // Waterfall rows with data attributes for in-place tick updates
      let waterfallHtml = '';
      if (progress.tools.length > 0) {
        waterfallHtml = '<div class="rp-waterfall" id="rpWaterfall">';
        for (let i = 0; i < progress.tools.length; i++) {
          const t = progress.tools[i];
          const isActive = !t.endedAt;
          const toolStart = t.startedAt - reqStart;
          const toolEnd = t.endedAt ? (t.endedAt - reqStart) : (now - reqStart);
          const leftPct = (toolStart / totalDuration) * 100;
          const widthPct = Math.max((toolEnd - toolStart) / totalDuration * 100, 0.5);
          const barClass = isActive ? 'rp-wf-bar active' : 'rp-wf-bar done';
          const dur = t.durationMs != null ? fmtMs(t.durationMs) : (isActive ? fmtMs(now - t.startedAt) : '');

          const inputText = toolInputLabel(t.input);
          const rightEdgePct = leftPct + widthPct;
          const metaStyle = 'left:calc(' + rightEdgePct.toFixed(1) + '% + 4px)';
          waterfallHtml +=
            '<div class="rp-wf-row" data-rp-tool="' + i + '">' +
              '<span class="rp-wf-label" title="' + escapeHtml(t.displayName) + '">' + escapeHtml(t.displayName) + '</span>' +
              '<div class="rp-wf-track">' +
                '<div class="' + barClass + '" data-rp-bar style="left:' + leftPct.toFixed(1) + '%;width:' + widthPct.toFixed(1) + '%"></div>' +
                (!progress.completed ? '<div class="rp-wf-now" data-rp-now style="left:' + (((now - reqStart) / totalDuration) * 100).toFixed(1) + '%"></div>' : '') +
                '<div class="rp-wf-meta" data-rp-meta style="' + metaStyle + '">' +
                  '<span class="rp-wf-dur" data-rp-dur>' + dur + '</span>' +
                  (inputText ? '<span class="rp-wf-input" title="' + escapeHtml(inputText) + '">' + escapeHtml(inputText) + '</span>' : '') +
                '</div>' +
              '</div>' +
            '</div>';
        }
        waterfallHtml += '</div>';
      }

      // Summary (only on completion)
      let summaryHtml = '';
      if (progress.completed) {
        const parts = [];
        if (progress.inputTokens != null) {
          parts.push('<span class="rp-summary-stat"><span class="rp-summary-val">' + fmtTokens(progress.inputTokens) + '</span> in</span>');
        }
        if (progress.outputTokens != null) {
          parts.push('<span class="rp-summary-stat"><span class="rp-summary-val">' + fmtTokens(progress.outputTokens) + '</span> out</span>');
        }
        if (progress.numTurns != null) {
          parts.push('<span class="rp-summary-stat"><span class="rp-summary-val">' + progress.numTurns + '</span> turn' + (progress.numTurns !== 1 ? 's' : '') + '</span>');
        }
        if (toolCount > 0) {
          parts.push('<span class="rp-summary-stat"><span class="rp-summary-val">' + toolCount + '</span> tool' + (toolCount !== 1 ? 's' : '') + '</span>');
        }
        if (progress.traceId) {
          parts.push('<a class="rp-trace-link" href="/traces#' + escapeHtml(progress.traceId) + '">View trace</a>');
        }
        summaryHtml = '<div class="rp-summary">' + parts.join('') + '</div>';
      }

      panel.innerHTML =
        '<div class="rp-header">' +
          '<div class="rp-header-left">' +
            '<span class="rp-bot">' + escapeHtml(progress.botName) + '</span>' +
            '<span class="rp-phase">' + escapeHtml(phaseLabel) + '</span>' +
            userHtml +
            (toolCount > 0 && !progress.completed ? '<span class="rp-elapsed" id="rpToolCount">' + toolCount + ' tool' + (toolCount !== 1 ? 's' : '') + '</span>' : '') +
          '</div>' +
          '<div style="display:flex;align-items:center;gap:8px">' +
            '<span class="rp-elapsed" id="rpElapsed">' + elapsed + '</span>' +
            '<button class="rp-dismiss" onclick="dismissRequestProgress()" title="Dismiss">&times;</button>' +
          '</div>' +
        '</div>' +
        waterfallHtml +
        summaryHtml;
    }

    // In-place DOM updates — no innerHTML, preserves animations and transitions
    function tickRpPanel() {
      const progress = rpLastProgress;
      if (!progress || progress.completed) return;
      const now = Date.now();

      // Update elapsed time
      const elapsedEl = document.getElementById('rpElapsed');
      if (elapsedEl) {
        elapsedEl.textContent = fmtMs(now - progress.startedAt);
      }

      // Update bar positions and durations in place
      const reqStart = progress.startedAt;
      const totalDuration = Math.max(now - reqStart, 1);

      for (let i = 0; i < progress.tools.length; i++) {
        const t = progress.tools[i];
        const row = document.querySelector('[data-rp-tool="' + i + '"]');
        if (!row) continue;

        const bar = row.querySelector('[data-rp-bar]');
        const durEl = row.querySelector('[data-rp-dur]');
        const nowMarker = row.querySelector('[data-rp-now]');

        if (bar) {
          const isActive = !t.endedAt;
          const toolStart = t.startedAt - reqStart;
          const toolEnd = t.endedAt ? (t.endedAt - reqStart) : (now - reqStart);
          const leftPct = (toolStart / totalDuration) * 100;
          const widthPct = Math.max((toolEnd - toolStart) / totalDuration * 100, 0.5);
          bar.style.left = leftPct.toFixed(1) + '%';
          bar.style.width = widthPct.toFixed(1) + '%';

          const rightEdge = leftPct + widthPct;
          if (durEl) {
            durEl.textContent = t.durationMs != null ? fmtMs(t.durationMs) : (isActive ? fmtMs(now - t.startedAt) : '');
          }
          const metaEl = row.querySelector('[data-rp-meta]');
          if (metaEl) {
            metaEl.style.left = 'calc(' + rightEdge.toFixed(1) + '% + 4px)';
          }
        }

        if (nowMarker) {
          nowMarker.style.left = (((now - reqStart) / totalDuration) * 100).toFixed(1) + '%';
        }
      }
    }

    function dismissRequestProgress() {
      const panel = document.getElementById('requestProgress');
      if (panel) {
        panel.classList.remove('visible', 'completed');
        stopRpAnim();
        rpLastProgress = null;
      }
    }

    // requestAnimationFrame loop, throttled to ~20fps
    function startRpAnim() {
      if (rpAnimFrame) return;
      function loop(ts) {
        if (ts - rpLastTickTime >= RP_TICK_MS) {
          rpLastTickTime = ts;
          tickRpPanel();
        }
        rpAnimFrame = requestAnimationFrame(loop);
      }
      rpAnimFrame = requestAnimationFrame(loop);
    }

    function stopRpAnim() {
      if (rpAnimFrame) {
        cancelAnimationFrame(rpAnimFrame);
        rpAnimFrame = null;
      }
    }
  `;
}
