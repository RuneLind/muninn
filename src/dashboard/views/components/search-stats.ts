/** Search page — stats bar showing collection/document/chunk/embedding counts */

export function searchStatsStyles(): string {
  return `
    /* Stats Bar */
    .stats-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      padding: 16px 24px;
    }
    .stat-card {
      background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-gradient-end) 100%);
      border: 1px solid var(--border-primary);
      border-radius: 10px;
      padding: 16px;
    }
    .stat-value { color: var(--text-primary); font-weight: 700; font-size: 24px; transition: font-size 0.2s; }
    .stat-value.text-value { font-size: 18px; }
    .stat-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 4px; }

    /* Error Banner */
  `;
}

export function searchStatsHtml(): string {
  return `
  <div class="stats-bar" id="statsBar">
    <div class="stat-card"><div class="stat-value" id="statCollections">-</div><div class="stat-label" id="statCollectionsLabel">Collections</div></div>
    <div class="stat-card"><div class="stat-value" id="statDocuments">-</div><div class="stat-label">Documents</div></div>
    <div class="stat-card"><div class="stat-value" id="statChunks">-</div><div class="stat-label">Chunks</div></div>
    <div class="stat-card"><div class="stat-value" id="statEmbeddings">-</div><div class="stat-label">Embeddings</div></div>
  </div>`;
}

export function searchStatsScript(): string {
  return `
    let allCollections = [];

    function updateStats(selectedName) {
      const colLabel = document.getElementById('statCollectionsLabel');
      const colValue = document.getElementById('statCollections');
      if (!selectedName) {
        // All collections — show totals
        let totalDocs = 0, totalChunks = 0, totalEmbeddings = 0;
        allCollections.forEach(c => {
          totalDocs += c.document_count || 0;
          totalChunks += c.chunk_count || 0;
          totalEmbeddings += c.embedding_count || 0;
        });
        colLabel.textContent = 'Collections';
        colValue.textContent = allCollections.length;
        colValue.title = '';
        colValue.classList.remove('text-value');
        document.getElementById('statDocuments').textContent = totalDocs.toLocaleString();
        document.getElementById('statChunks').textContent = totalChunks.toLocaleString();
        document.getElementById('statEmbeddings').textContent = totalEmbeddings.toLocaleString();
      } else {
        const c = allCollections.find(x => x.name === selectedName);
        if (!c) return;
        // Show updated time in place of collection count
        if (c.updatedTime) {
          const d = new Date(c.updatedTime);
          const relative = formatRelativeTime(d);
          colLabel.textContent = 'Updated';
          colValue.textContent = relative;
          colValue.title = d.toLocaleString();
          colValue.classList.add('text-value');
        } else {
          colLabel.textContent = 'Collection';
          colValue.textContent = '1';
          colValue.title = '';
          colValue.classList.remove('text-value');
        }
        document.getElementById('statDocuments').textContent = (c.document_count || 0).toLocaleString();
        document.getElementById('statChunks').textContent = (c.chunk_count || 0).toLocaleString();
        document.getElementById('statEmbeddings').textContent = (c.embedding_count || 0).toLocaleString();
      }
    }

    function formatRelativeTime(date) {
      const now = new Date();
      const diffMs = now - date;
      const diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return 'just now';
      if (diffMin < 60) return diffMin + 'm ago';
      const diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return diffHrs + 'h ago';
      const diffDays = Math.floor(diffHrs / 24);
      if (diffDays < 30) return diffDays + 'd ago';
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    async function loadCollections() {
      try {
        const res = await fetch('/api/search/collections');
        if (!res.ok) return;
        const data = await res.json();
        allCollections = data.collections || [];

        updateStats('');

        // Populate dropdown
        const select = document.getElementById('filterCollection');
        allCollections.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name + ' (' + (c.document_count || 0) + ' docs)';
          select.appendChild(opt);
        });

        // Update stats when collection changes
        select.addEventListener('change', () => updateStats(select.value));
      } catch (e) {
        console.error('Failed to load collections', e);
      }
    }
  `;
}
