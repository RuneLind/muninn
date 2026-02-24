/** Goals panel — data setter only (rendering handled by memory-panel.ts) */
export function goalsPanelStyles(): string {
  return ``;
}

export function goalsPanelHtml(): string {
  return ``;
}

export function goalsPanelScript(): string {
  return `
    let goalsData = [];

    function renderGoals(goals) {
      goalsData = goals;
    }
  `;
}
