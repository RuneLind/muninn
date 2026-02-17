/** Tooltip — shared hover tooltip with delay and viewport-aware positioning */
export function tooltipStyles(): string {
  return `
    #tooltip {
      position: fixed;
      z-index: 200;
      background: #1a1a2e;
      border: 1px solid #2a2a3e;
      border-radius: 8px;
      padding: 10px 14px;
      max-width: 320px;
      font-size: 12px;
      color: #ccc;
      line-height: 1.5;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.15s;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    #tooltip.visible {
      opacity: 1;
    }
    .tip-label {
      color: #555;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .tip-value {
      color: #ddd;
    }
    .tip-badge {
      display: inline-block;
      font-size: 9px;
      padding: 1px 5px;
      border-radius: 3px;
      font-weight: 600;
      text-transform: uppercase;
      vertical-align: middle;
    }
    .tip-badge.active { background: #1a3a2a; color: #4ade80; }
    .tip-badge.completed { background: #1e1e3e; color: #6c63ff; }
    .tip-badge.cancelled { background: #1a1a1a; color: #666; }
    .tip-badge.personal { background: #1e1e3e; color: #6c63ff; }
    .tip-badge.shared { background: #1a3a2a; color: #4ade80; }
    .tip-preview {
      color: #999;
      font-style: italic;
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
    }
  `;
}

export function tooltipHtml(): string {
  return `<div id="tooltip"></div>`;
}

export function tooltipScript(): string {
  return `
    const tooltipEl = document.getElementById('tooltip');
    let tooltipTimer = null;
    let tooltipTarget = null;

    function showTooltip(target, html) {
      tooltipEl.innerHTML = html;
      tooltipEl.classList.add('visible');

      const rect = target.getBoundingClientRect();
      const tipRect = tooltipEl.getBoundingClientRect();

      // Position above by default
      let top = rect.top - tipRect.height - 8;
      let left = rect.left + (rect.width / 2) - (tipRect.width / 2);

      // Flip below if no room above
      if (top < 8) {
        top = rect.bottom + 8;
      }

      // Keep within viewport horizontally
      left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));

      tooltipEl.style.top = top + 'px';
      tooltipEl.style.left = left + 'px';
    }

    function hideTooltip() {
      clearTimeout(tooltipTimer);
      tooltipTimer = null;
      tooltipTarget = null;
      tooltipEl.classList.remove('visible');
    }

    // Delegated tooltip handlers
    document.addEventListener('mouseenter', (e) => {
      const target = e.target.closest('[data-tip]');
      if (!target) return;

      tooltipTarget = target;
      clearTimeout(tooltipTimer);

      tooltipTimer = setTimeout(() => {
        if (tooltipTarget !== target) return;
        try {
          const data = JSON.parse(target.dataset.tip);
          const html = renderTooltip(data);
          if (html) showTooltip(target, html);
        } catch {}
      }, 300);
    }, true);

    document.addEventListener('mouseleave', (e) => {
      const target = e.target.closest('[data-tip]');
      if (target) hideTooltip();
    }, true);

    function renderTooltip(data) {
      switch (data.type) {
        case 'goal':
          return '<span class="tip-badge ' + escapeAttr(data.status || '') + '">' + escapeHtml(data.status || '') + '</span>' +
            (data.deadline ? ' &middot; ' + deadlineText(data.deadline) : '') +
            (data.tags && data.tags.length ? '<br><span class="tip-label">Tags:</span> ' + data.tags.map(t => escapeHtml(t)).join(', ') : '');

        case 'task':
          return '<span class="tip-label">Type:</span> <span class="tip-value">' + escapeHtml(data.taskType || '') + '</span>' +
            '<br><span class="tip-label">Schedule:</span> <span class="tip-value">' + escapeHtml(data.schedule || '') + '</span>' +
            (data.nextRun ? '<br><span class="tip-label">Next:</span> <span class="tip-value">' + escapeHtml(data.nextRun) + '</span>' : '');

        case 'watcher':
          return '<span class="tip-label">Type:</span> <span class="tip-value">' + escapeHtml(data.watcherType || '') + '</span>' +
            '<br><span class="tip-label">Interval:</span> <span class="tip-value">' + escapeHtml(data.interval || '') + '</span>' +
            (data.lastRun ? '<br><span class="tip-label">Last run:</span> <span class="tip-value">' + escapeHtml(data.lastRun) + '</span>' : '');

        case 'memory':
          return '<div class="tip-preview">' + escapeHtml((data.text || '').slice(0, 120)) + '</div>' +
            '<div style="margin-top:4px"><span class="tip-badge ' + (data.scope || 'personal') + '">' + escapeHtml(data.scope || 'personal') + '</span> &middot; ' + escapeHtml(data.time || '') + '</div>';

        case 'thread':
          return '<span class="tip-label">Messages:</span> <span class="tip-value">' + (data.messageCount || 0) + '</span>' +
            (data.lastMessage ? '<br><div class="tip-preview" style="margin-top:4px">' + escapeHtml(data.lastMessage) + '</div>' : '');

        case 'user':
          return '<span class="tip-label">Platform:</span> <span class="tip-value">' + escapeHtml(data.platform || '') + '</span>' +
            '<br><span class="tip-label">Messages:</span> <span class="tip-value">' + (data.messageCount || 0) + '</span>' +
            (data.lastActive ? '<br><span class="tip-label">Last active:</span> <span class="tip-value">' + escapeHtml(data.lastActive) + '</span>' : '');

        case 'overview':
          return '<span class="tip-value">' + (data.count || 0) + ' ' + escapeHtml(data.label || 'items') + '</span>' +
            '<br><span style="color:#666;font-size:11px">Click to view</span>';

        default:
          return null;
      }
    }
  `;
}
