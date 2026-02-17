/** Memories panel — data setter only (rendering handled by knowledge-panel.ts) */
export function memoriesPanelStyles(): string {
  return ``;
}

export function memoriesPanelHtml(): string {
  return ``;
}

export function memoriesPanelScript(): string {
  return `
    let memoriesData = [];

    function renderMemories(memories) {
      memoriesData = memories;
    }
  `;
}
