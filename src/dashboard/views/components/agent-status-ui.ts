/** Agent status indicator — shows current processing phase */
export function agentStatusStyles(): string {
  return `
    .agent-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-faint);
      padding: 4px 10px;
      border-radius: 6px;
      background: transparent;
      transition: all 0.3s ease;
    }
    .agent-status.working {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent-light);
    }
    .agent-spinner {
      width: 14px; height: 14px;
      border: 2px solid transparent;
      border-top-color: var(--accent);
      border-radius: 50%;
      display: none;
    }
    .agent-status.working .agent-spinner {
      display: block;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .agent-phase { font-weight: 500; }
    .agent-detail { color: var(--accent-muted); font-size: 11px; }
    .agent-user { color: var(--text-dim); }
  `;
}

export function agentStatusHtml(): string {
  return `
      <div class="agent-status" id="agentStatus">
        <div class="agent-spinner"></div>
        <span class="agent-phase" id="agentPhase">Idle</span>
        <span class="agent-detail" id="agentDetail"></span>
        <span class="agent-user" id="agentUser"></span>
      </div>`;
}

export function agentStatusScript(): string {
  return `
    const phaseLabels = {
      idle: 'Idle',
      receiving: 'Receiving message',
      transcribing: 'Transcribing voice',
      building_prompt: 'Building prompt',
      calling_claude: 'Calling AI',
      saving_response: 'Saving response',
      sending_telegram: 'Sending to Telegram',
      sending_slack: 'Sending to Slack',
      synthesizing_voice: 'Synthesizing voice',
      running_task: 'Running scheduled task',
      checking_goals: 'Checking goals',
      running_watcher: 'Running watcher',
    };

    // Last known connector info — kept across status/progress events
    let _lastConnectorInfo = null;

    function connectorWithModel(info) {
      let label = info.connectorLabel || 'AI';
      if (info.model) label += ' (' + info.model + ')';
      return label;
    }

    function updateAgentStatus(status) {
      const el = document.getElementById('agentStatus');
      const phaseEl = document.getElementById('agentPhase');
      const detailEl = document.getElementById('agentDetail');
      const userEl = document.getElementById('agentUser');

      if (status.phase === 'idle') {
        el.classList.remove('working');
        phaseEl.textContent = 'Idle';
        // Show last connector+model info on idle (cleared when request auto-clears)
        if (_lastConnectorInfo) {
          detailEl.textContent = ' \u2014 ' + connectorWithModel(_lastConnectorInfo);
        }
        userEl.textContent = '';
      } else {
        el.classList.add('working');
        let label = phaseLabels[status.phase] || status.phase;
        // Use connector info for AI-calling phases
        if (status.phase === 'calling_claude' && _lastConnectorInfo && _lastConnectorInfo.connectorLabel) {
          label = 'Calling ' + connectorWithModel(_lastConnectorInfo);
        }
        phaseEl.textContent = label;
        detailEl.textContent = status.detail ? ' \u2014 ' + status.detail : '';
        userEl.textContent = status.username ? '(@' + status.username + ')' : '';
      }
    }

    function updateAgentStatusFromProgress(progress) {
      if (!progress) {
        // Request cleared — clear connector info
        _lastConnectorInfo = null;
        const detailEl = document.getElementById('agentDetail');
        if (detailEl) detailEl.textContent = '';
        return;
      }
      // Store connector info for use by updateAgentStatus
      if (progress.connectorLabel) {
        _lastConnectorInfo = { connectorLabel: progress.connectorLabel, model: progress.model };
      }
      // Re-render phase label with connector info
      const phaseEl = document.getElementById('agentPhase');
      const detailEl = document.getElementById('agentDetail');
      if (progress.completed) {
        if (phaseEl) phaseEl.textContent = 'Idle';
        if (detailEl && _lastConnectorInfo) {
          detailEl.textContent = ' \u2014 ' + connectorWithModel(_lastConnectorInfo);
        }
        return;
      }
      if (progress.phase === 'calling_claude' && _lastConnectorInfo) {
        if (phaseEl) phaseEl.textContent = 'Calling ' + connectorWithModel(_lastConnectorInfo);
      }
      if (!detailEl) return;
      const toolCount = progress.tools.length;
      if (toolCount > 0) {
        const lastTool = progress.tools[progress.tools.length - 1];
        const activeName = lastTool && !lastTool.endedAt ? lastTool.displayName : '';
        const countSuffix = toolCount > 1 ? ' (' + toolCount + ' tools)' : '';
        detailEl.textContent = activeName ? ' \u2014 ' + activeName + countSuffix : countSuffix;
      }
    }
`;
}
