/** Layout styles — section-based layout with detail panel and activity drawer */
export function layoutStyles(): string {
  return `
    /* Section content area */
    .section-content {
      min-height: calc(100vh - 300px);
      padding-bottom: 60px; /* space for activity drawer */
    }

    /* Dual-panel layout within a tab (side-by-side) */
    .section-dual {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }

    /* Panels */
    .panel {
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      overflow: hidden;
    }
    .panel-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .panel-header .count {
      background: var(--border-primary);
      color: var(--text-muted);
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }
    .panel-body {
      padding: 8px;
      overflow-y: auto;
    }
    .panel-body::-webkit-scrollbar { width: 4px; }
    .panel-body::-webkit-scrollbar-track { background: transparent; }
    .panel-body::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }
    .panel-empty {
      padding: 24px;
      text-align: center;
      color: var(--text-disabled);
      font-size: 13px;
    }

    /* Tags */
    .tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: var(--bg-surface);
      color: var(--accent-muted);
      border: 1px solid var(--border-secondary);
    }
    .time-ago { font-size: 10px; color: var(--text-disabled); }

    /* Master-detail layout (shared by users, threads) */
    .md-layout {
      display: flex;
      height: calc(100vh - 180px);
      background: var(--bg-deep);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      overflow: hidden;
    }
    .md-master {
      width: 280px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      background: var(--bg-panel);
      border-right: 1px solid var(--border-primary);
    }
    .md-master-header {
      padding: 14px 16px;
      border-bottom: 1px solid var(--border-primary);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      flex-shrink: 0;
    }
    .md-master-body {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }
    .md-master-body::-webkit-scrollbar { width: 4px; }
    .md-master-body::-webkit-scrollbar-track { background: transparent; }
    .md-master-body::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }
    .md-detail {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .md-detail::-webkit-scrollbar { width: 4px; }
    .md-detail::-webkit-scrollbar-track { background: transparent; }
    .md-detail::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }
    .md-detail-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-disabled);
      font-size: 14px;
    }

    /* Master row (compact list item — shared) */
    .md-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
      border-left: 3px solid transparent;
    }
    .md-row:hover {
      background: color-mix(in srgb, var(--accent) 4%, transparent);
    }
    .md-row.selected {
      background: color-mix(in srgb, var(--accent) 8%, transparent);
      border-left-color: var(--accent);
    }
    .md-row-info { flex: 1; min-width: 0; }
    .md-row-name {
      font-size: 13px;
      color: var(--text-tertiary);
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .md-row-meta {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 2px;
      font-size: 10px;
      color: var(--text-faint);
    }

    /* User-specific row styles */
    .user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), var(--status-success));
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      color: var(--text-primary);
      flex-shrink: 0;
    }
    .user-platform-badge {
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 8px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .user-platform-badge.telegram { background: #1a2a3e; color: #54a9eb; }
    .user-platform-badge.slack_dm,
    .user-platform-badge.slack_channel,
    .user-platform-badge.slack_assistant { background: #2a1a3e; color: #e0a0ff; }


    /* Thread-specific row styles */
    .thread-icon {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--bg-surface);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      flex-shrink: 0;
      color: var(--text-dim);
    }
    .thread-active-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--status-success);
      flex-shrink: 0;
    }

    /* Inline detail content + sub-tabs (shared) */
    .md-detail-content { display: flex; flex-direction: column; height: 100%; }
    .md-detail-header { padding: 20px 24px 0; flex-shrink: 0; }
    .md-detail-tabs {
      display: flex;
      gap: 0;
      padding: 0 24px;
      border-bottom: 1px solid var(--border-primary);
      flex-shrink: 0;
      overflow-x: auto;
    }
    .md-detail-tabs::-webkit-scrollbar { height: 0; }
    .md-detail-tab {
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-faint);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s;
      white-space: nowrap;
      background: none;
      border-top: none;
      border-left: none;
      border-right: none;
    }
    .md-detail-tab:hover { color: var(--accent-light); }
    .md-detail-tab.active {
      color: var(--text-tertiary);
      border-bottom-color: var(--accent);
    }
    .md-detail-tab .md-tab-count {
      display: inline-block;
      margin-left: 4px;
      padding: 0 5px;
      border-radius: 6px;
      font-size: 10px;
      font-weight: 400;
      background: var(--border-primary);
      color: var(--text-faint);
    }
    .md-detail-tab.active .md-tab-count {
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      color: var(--accent-light);
    }
    .md-detail-body {
      flex: 1;
      overflow-y: auto;
      padding: 16px 24px;
    }
    .md-detail-body::-webkit-scrollbar { width: 4px; }
    .md-detail-body::-webkit-scrollbar-track { background: transparent; }
    .md-detail-body::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 2px; }
    .md-detail-section { display: none; }
    .md-detail-section.active { display: block; }

    /* Thread detail header */
    .thread-detail-info {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
    }
    .thread-detail-icon {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: var(--bg-surface);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      color: var(--text-muted);
    }
    .thread-detail-name {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .thread-detail-user {
      font-size: 11px;
      color: var(--text-dim);
      margin-top: 2px;
    }

    /* Responsive */
    @media (max-width: 900px) {
      .stats-bar { grid-template-columns: repeat(3, 1fr); }
      .section-dual { grid-template-columns: 1fr; }
      .md-layout { flex-direction: column; height: auto; }
      .md-master { width: 100%; max-height: 300px; border-right: none; border-bottom: 1px solid var(--border-primary); }
      .md-detail { min-height: 400px; }
    }
    @media (max-width: 500px) {
      .stats-bar { grid-template-columns: repeat(2, 1fr); }
    }
  `;
}
