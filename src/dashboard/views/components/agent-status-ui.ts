/** Agent status indicator — shows current processing phase */
export function agentStatusStyles(): string {
  return `
    .agent-status {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #555;
      padding: 4px 10px;
      border-radius: 6px;
      background: transparent;
      transition: all 0.3s ease;
    }
    .agent-status.working {
      background: rgba(108, 99, 255, 0.1);
      border: 1px solid rgba(108, 99, 255, 0.2);
      color: #a5a0ff;
    }
    .agent-spinner {
      width: 14px; height: 14px;
      border: 2px solid transparent;
      border-top-color: #6c63ff;
      border-radius: 50%;
      display: none;
    }
    .agent-status.working .agent-spinner {
      display: block;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .agent-phase { font-weight: 500; }
    .agent-user { color: #666; }
  `;
}

export function agentStatusHtml(): string {
  return `
      <div class="agent-status" id="agentStatus">
        <div class="agent-spinner"></div>
        <span class="agent-phase" id="agentPhase">Idle</span>
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
      calling_claude: 'Calling Claude',
      saving_response: 'Saving response',
      sending_telegram: 'Sending to Telegram',
      synthesizing_voice: 'Synthesizing voice',
      running_task: 'Running scheduled task',
      checking_goals: 'Checking goals',
      running_watcher: 'Running watcher',
    };

    function updateAgentStatus(status) {
      const el = document.getElementById('agentStatus');
      const phaseEl = document.getElementById('agentPhase');
      const userEl = document.getElementById('agentUser');

      if (status.phase === 'idle') {
        el.classList.remove('working');
        phaseEl.textContent = 'Idle';
        userEl.textContent = '';
      } else {
        el.classList.add('working');
        phaseEl.textContent = phaseLabels[status.phase] || status.phase;
        userEl.textContent = status.username ? '(@' + status.username + ')' : '';
      }
    }
  `;
}
