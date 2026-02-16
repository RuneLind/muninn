/** Main grid layout, panel, and column styles */
export function layoutStyles(): string {
  return `
    /* Main Grid */
    .main-grid {
      display: grid;
      grid-template-columns: 380px 1fr;
      gap: 16px;
      padding: 0 24px 24px;
      min-height: calc(100vh - 200px);
    }

    /* Panels */
    .panel {
      background: #12121a;
      border: 1px solid #1e1e2e;
      border-radius: 10px;
      overflow: hidden;
    }
    .panel-header {
      padding: 14px 16px;
      border-bottom: 1px solid #1e1e2e;
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
      color: #ccc;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .panel-header .count {
      background: #1e1e2e;
      color: #888;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }
    .panel-body {
      padding: 8px;
      max-height: 320px;
      overflow-y: auto;
    }
    .panel-body::-webkit-scrollbar { width: 4px; }
    .panel-body::-webkit-scrollbar-track { background: transparent; }
    .panel-body::-webkit-scrollbar-thumb { background: #2a2a3a; border-radius: 2px; }
    .panel-empty {
      padding: 24px;
      text-align: center;
      color: #444;
      font-size: 13px;
    }

    /* Left column stacking */
    .left-col { display: flex; flex-direction: column; gap: 16px; }
    .right-col { display: flex; flex-direction: column; gap: 16px; }

    /* Tags */
    .tag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 8px;
      background: #1a1a2e;
      color: #8b8bcd;
      border: 1px solid #2a2a3e;
    }
    .time-ago { font-size: 10px; color: #444; }

    /* Responsive */
    @media (max-width: 900px) {
      .stats-bar { grid-template-columns: repeat(3, 1fr); }
      .main-grid { grid-template-columns: 1fr; }
    }
    @media (max-width: 500px) {
      .stats-bar { grid-template-columns: repeat(2, 1fr); }
    }
  `;
}
