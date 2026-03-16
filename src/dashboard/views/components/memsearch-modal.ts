/** MemSearch modal — memory detail overlay */

export function memsearchModalStyles(): string {
  return `
    /* Detail Modal */
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.7);
      z-index: 1000;
      align-items: center;
      justify-content: center;
    }
    .modal-backdrop.visible { display: flex; }
    .modal {
      background: var(--bg-panel);
      border: 1px solid var(--border-secondary);
      border-radius: 12px;
      width: 90vw;
      max-width: 700px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border-primary);
    }
    .modal-header h3 { font-size: 14px; color: var(--text-primary); }
    .modal-close {
      background: none;
      border: none;
      color: var(--text-dim);
      cursor: pointer;
      font-size: 20px;
      padding: 4px 8px;
    }
    .modal-close:hover { color: var(--text-primary); }
    .modal-body {
      flex: 1;
      overflow: auto;
      padding: 16px 20px;
    }
    .modal-field { margin-bottom: 16px; }
    .modal-field-label {
      color: var(--text-dim);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .modal-field-value {
      color: var(--text-tertiary);
      font-size: 13px;
      line-height: 1.6;
    }
    .modal-field-value pre {
      background: var(--bg-page);
      padding: 12px;
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.5;
    }
    .modal-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
  `;
}

export function memsearchModalHtml(): string {
  return `
  <div class="modal-backdrop" id="modalBackdrop" onclick="closeModal(event)">
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h3 id="modalTitle">Memory Detail</h3>
        <button class="modal-close" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>`;
}

export function memsearchModalScript(): string {
  return `
    function closeModal(event) {
      if (event && event.target !== event.currentTarget) return;
      document.getElementById('modalBackdrop').classList.remove('visible');
    }

    // Escape closes modal
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  `;
}
