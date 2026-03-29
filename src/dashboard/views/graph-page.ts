import { SHARED_STYLES, renderNav } from "./shared-styles.ts";

export function renderGraphPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Muninn - Knowledge Graph</title>
  <style>
    ${SHARED_STYLES}

    body { overflow: hidden; }

    .graph-container {
      position: relative;
      width: 100%;
      height: calc(100vh - 57px);
    }

    #graph-canvas {
      width: 100%;
      height: 100%;
    }

    /* Loading overlay */
    .graph-loading {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-page);
      z-index: 10;
      transition: opacity 0.3s;
    }
    .graph-loading.hidden { opacity: 0; pointer-events: none; }
    .graph-loading .spinner {
      width: 40px; height: 40px;
      border: 3px solid var(--border-secondary);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Controls panel */
    .graph-controls {
      position: absolute;
      top: 16px;
      right: 16px;
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 12px;
      padding: 16px;
      width: 260px;
      z-index: 5;
      font-size: 13px;
    }
    .graph-controls h3 {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 12px;
    }
    .control-group {
      margin-bottom: 12px;
    }
    .control-group:last-child { margin-bottom: 0; }
    .control-group label {
      display: flex;
      justify-content: space-between;
      color: var(--text-soft);
      margin-bottom: 4px;
      font-size: 12px;
    }
    .control-group label span { color: var(--accent-light); font-weight: 600; }
    .control-group input[type="range"] {
      width: 100%;
      accent-color: var(--accent);
    }

    /* Category filter chips */
    .category-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .cat-chip {
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s;
      user-select: none;
    }
    .cat-chip.active { opacity: 1; }
    .cat-chip.inactive { opacity: 0.35; }

    /* Stats */
    .graph-stats {
      position: absolute;
      bottom: 16px;
      left: 16px;
      background: var(--bg-panel);
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      padding: 8px 14px;
      font-size: 12px;
      color: var(--text-muted);
      z-index: 5;
    }
    .graph-stats span { color: var(--accent-light); font-weight: 600; }

    /* Detail panel (slide-in from right) */
    .detail-panel {
      position: absolute;
      top: 0;
      right: -380px;
      width: 360px;
      height: 100%;
      background: var(--bg-panel);
      border-left: 1px solid var(--border-primary);
      padding: 20px;
      z-index: 20;
      transition: right 0.25s ease;
      overflow-y: auto;
    }
    .detail-panel.open { right: 0; }
    .detail-panel h3 {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 8px;
      line-height: 1.3;
    }
    .detail-panel .meta {
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
    }
    .detail-panel .meta a {
      color: var(--accent-light);
      text-decoration: none;
    }
    .detail-panel .meta a:hover { text-decoration: underline; }
    .detail-panel .cat-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      margin-right: 4px;
    }
    .detail-close {
      position: absolute;
      top: 16px;
      right: 16px;
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
    }
    .detail-close:hover { color: var(--text-primary); }
    .connections-list {
      margin-top: 16px;
    }
    .connections-list h4 {
      font-size: 12px;
      text-transform: uppercase;
      color: var(--text-dim);
      margin-bottom: 8px;
      letter-spacing: 0.5px;
    }
    .conn-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      margin-bottom: 4px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .conn-item:hover { background: var(--bg-surface); }
    .conn-item .conn-title {
      flex: 1;
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .conn-item .conn-score {
      font-size: 11px;
      color: var(--accent-light);
      font-weight: 600;
      white-space: nowrap;
    }
    .conn-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  ${renderNav("graph")}
  <div class="graph-container">
    <div class="graph-loading" id="loading">
      <div class="spinner"></div>
    </div>

    <div id="graph-canvas"></div>

    <div class="graph-controls">
      <h3>Controls</h3>
      <div class="control-group">
        <label>Min similarity <span id="sim-val">0.65</span></label>
        <input type="range" id="sim-slider" min="0.40" max="0.95" step="0.05" value="0.65">
      </div>
      <div class="control-group">
        <label>Connections per node <span id="topk-val">5</span></label>
        <input type="range" id="topk-slider" min="1" max="15" step="1" value="5">
      </div>
      <div class="control-group">
        <label>Categories</label>
        <div class="category-chips" id="cat-chips"></div>
      </div>
    </div>

    <div class="graph-stats" id="stats"></div>

    <div class="detail-panel" id="detail-panel">
      <button class="detail-close" id="detail-close">&times;</button>
      <div id="detail-content"></div>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/force-graph@1/dist/force-graph.min.js"></script>
  <script>
  (function() {
    // Category colors
    const CAT_COLORS = {
      'ai/claude-code': '#6c63ff',
      'ai/claude':      '#8b7fff',
      'ai/openclaw':    '#a59bff',
      'ai/general':     '#9590ff',
      'ai/rag':         '#7c74ff',
      'ai':             '#6c63ff',
      'health':         '#4ade80',
      'tech':           '#22d3ee',
      'career':         '#60a5fa',
      'entertainment':  '#fbbf24',
      'coding':         '#c084fc',
      'parenting':      '#f59e0b',
    };
    function catColor(cat) {
      if (CAT_COLORS[cat]) return CAT_COLORS[cat];
      // Check prefix match (e.g., ai/something -> ai)
      const prefix = cat.split('/')[0];
      return CAT_COLORS[prefix] || '#888';
    }

    let graphData = null;
    let graph = null;
    let activeCategories = new Set();
    let highlightNodes = new Set();
    let highlightLinks = new Set();
    let hoverNode = null;
    let hoverClearTimer = null;

    const loading = document.getElementById('loading');
    const statsEl = document.getElementById('stats');
    const catChipsEl = document.getElementById('cat-chips');
    const simSlider = document.getElementById('sim-slider');
    const topkSlider = document.getElementById('topk-slider');
    const simVal = document.getElementById('sim-val');
    const topkVal = document.getElementById('topk-val');
    const detailPanel = document.getElementById('detail-panel');
    const detailContent = document.getElementById('detail-content');
    const detailClose = document.getElementById('detail-close');

    async function fetchGraph() {
      const sim = simSlider.value;
      const topK = topkSlider.value;
      const res = await fetch('/api/graph/similarity?collection=youtube-summaries&min_similarity=' + sim + '&top_k=' + topK);
      return await res.json();
    }

    function buildCategoryChips(nodes) {
      const cats = new Set(nodes.map(n => n.category));
      catChipsEl.innerHTML = '';
      cats.forEach(cat => {
        activeCategories.add(cat);
        const chip = document.createElement('span');
        chip.className = 'cat-chip active';
        chip.textContent = cat;
        chip.style.background = catColor(cat) + '25';
        chip.style.color = catColor(cat);
        chip.style.borderColor = catColor(cat) + '50';
        chip.dataset.cat = cat;
        chip.onclick = () => toggleCategory(cat, chip);
        catChipsEl.appendChild(chip);
      });
    }

    function toggleCategory(cat, chip) {
      if (activeCategories.has(cat)) {
        activeCategories.delete(cat);
        chip.className = 'cat-chip inactive';
      } else {
        activeCategories.add(cat);
        chip.className = 'cat-chip active';
        chip.style.borderColor = catColor(cat) + '50';
      }
      applyFilters();
    }

    function applyFilters() {
      if (!graphData || !graph) return;
      const visibleIds = new Set(
        graphData.nodes.filter(n => activeCategories.has(n.category)).map(n => n.id)
      );
      const filtered = {
        nodes: graphData.nodes.filter(n => visibleIds.has(n.id)),
        links: graphData.edges
          .filter(e => visibleIds.has(e.source) && visibleIds.has(e.target))
          .map(e => ({ source: e.source, target: e.target, similarity: e.similarity })),
      };
      graph.graphData(filtered);
      updateStats(filtered.nodes.length, filtered.links.length);
    }

    function updateStats(nodes, edges) {
      statsEl.innerHTML = '<span>' + nodes + '</span> videos &middot; <span>' + edges + '</span> connections';
    }

    function getNeighborData(nodeId) {
      if (!graphData) return [];
      return graphData.edges
        .filter(e => e.source === nodeId || e.target === nodeId)
        .map(e => {
          const otherId = e.source === nodeId ? e.target : e.source;
          const other = graphData.nodes.find(n => n.id === otherId);
          return { node: other, similarity: e.similarity };
        })
        .filter(d => d.node && activeCategories.has(d.node.category))
        .sort((a, b) => b.similarity - a.similarity);
    }

    function showDetail(node) {
      const neighbors = getNeighborData(node.id);
      let html = '<h3>' + esc(node.title) + '</h3>';
      html += '<div class="meta">';
      html += '<span class="cat-badge" style="background:' + catColor(node.category) + '25;color:' + catColor(node.category) + '">' + esc(node.category) + '</span>';
      if (node.date) html += ' &middot; ' + esc(node.date);
      html += '<br><a href="' + esc(node.url) + '" target="_blank">Watch on YouTube &rarr;</a>';
      html += '</div>';

      if (neighbors.length > 0) {
        html += '<div class="connections-list">';
        html += '<h4>Connected Videos (' + neighbors.length + ')</h4>';
        neighbors.forEach(d => {
          html += '<div class="conn-item" data-id="' + esc(d.node.id) + '">';
          html += '<span class="conn-dot" style="background:' + catColor(d.node.category) + '"></span>';
          html += '<span class="conn-title">' + esc(d.node.title) + '</span>';
          html += '<span class="conn-score">' + (d.similarity * 100).toFixed(0) + '%</span>';
          html += '</div>';
        });
        html += '</div>';
      }
      detailContent.innerHTML = html;
      detailPanel.classList.add('open');

      // Click on connected item -> navigate to that node
      detailContent.querySelectorAll('.conn-item').forEach(el => {
        el.addEventListener('click', () => {
          const targetId = el.dataset.id;
          const targetNode = graphData.nodes.find(n => n.id === targetId);
          if (targetNode && graph) {
            graph.centerAt(targetNode.x, targetNode.y, 500);
            graph.zoom(3, 500);
            setTimeout(() => showDetail(targetNode), 550);
          }
        });
      });
    }

    function esc(s) {
      if (!s) return '';
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    detailClose.onclick = () => detailPanel.classList.remove('open');

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        detailPanel.classList.remove('open');
        hoverNode = null;
        highlightNodes.clear();
        highlightLinks.clear();
        clearTimeout(hoverClearTimer);
      }
    });

    async function init() {
      try {
        graphData = await fetchGraph();
      } catch(e) {
        loading.innerHTML = '<div style="color:var(--status-error)">Failed to load graph data</div>';
        return;
      }
      loading.classList.add('hidden');

      if (!graphData.nodes || graphData.nodes.length === 0) {
        loading.classList.remove('hidden');
        loading.innerHTML = '<div style="color:var(--text-muted)">No YouTube documents found</div>';
        return;
      }

      buildCategoryChips(graphData.nodes);

      const container = document.getElementById('graph-canvas');
      graph = ForceGraph()(container)
        .graphData({
          nodes: graphData.nodes.map(n => ({ ...n })),
          links: graphData.edges.map(e => ({ source: e.source, target: e.target, similarity: e.similarity })),
        })
        .nodeId('id')
        .nodeLabel(n => n.title + '\\n' + n.category)
        .nodeColor(n => {
          if (highlightNodes.size > 0) {
            return highlightNodes.has(n) ? catColor(n.category) : catColor(n.category) + '20';
          }
          return catColor(n.category);
        })
        .nodeVal(n => {
          if (highlightNodes.size > 0 && highlightNodes.has(n)) return 8;
          return 4;
        })
        .linkSource('source')
        .linkTarget('target')
        .linkWidth(link => {
          if (highlightLinks.has(link)) return 2;
          return 0.5;
        })
        .linkColor(link => {
          if (highlightLinks.has(link)) return 'rgba(108, 99, 255, 0.6)';
          return 'rgba(108, 99, 255, 0.08)';
        })
        .linkDirectionalParticles(link => highlightLinks.has(link) ? 2 : 0)
        .linkDirectionalParticleWidth(2)
        .linkDirectionalParticleColor(() => '#6c63ff')
        .backgroundColor('#0a0a0f')
        .d3AlphaDecay(0.03)
        .d3VelocityDecay(0.3)
        .warmupTicks(80)
        .cooldownTicks(Infinity)
        .cooldownTime(Infinity)
        .nodeRelSize(6)
        .onNodeHover(node => {
          clearTimeout(hoverClearTimer);
          if (node) {
            hoverNode = node;
            highlightNodes.clear();
            highlightLinks.clear();
            highlightNodes.add(node);
            const currentData = graph.graphData();
            currentData.links.forEach(link => {
              const src = typeof link.source === 'object' ? link.source : currentData.nodes.find(n => n.id === link.source);
              const tgt = typeof link.target === 'object' ? link.target : currentData.nodes.find(n => n.id === link.target);
              if (src === node || tgt === node) {
                highlightLinks.add(link);
                if (src) highlightNodes.add(src);
                if (tgt) highlightNodes.add(tgt);
              }
            });
          } else {
            // Short delay to bridge micro-gaps when cursor barely leaves a node
            hoverClearTimer = setTimeout(() => {
              hoverNode = null;
              highlightNodes.clear();
              highlightLinks.clear();
            }, 40);
          }
          container.style.cursor = node ? 'pointer' : 'default';
        })
        .onNodeClick(node => {
          showDetail(node);
        })
        .onBackgroundClick(() => {
          detailPanel.classList.remove('open');
        });

      updateStats(graphData.nodes.length, graphData.edges.length);

      // Zoom to fit after warmup
      setTimeout(() => graph.zoomToFit(400, 60), 500);
    }

    // Slider controls — debounced re-fetch
    let debounceTimer = null;
    function onSliderChange() {
      simVal.textContent = simSlider.value;
      topkVal.textContent = topkSlider.value;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        loading.classList.remove('hidden');
        loading.innerHTML = '<div class="spinner"></div>';
        try {
          graphData = await fetchGraph();
          buildCategoryChips(graphData.nodes);
          const visibleIds = new Set(
            graphData.nodes.filter(n => activeCategories.has(n.category)).map(n => n.id)
          );
          graph.graphData({
            nodes: graphData.nodes.filter(n => visibleIds.has(n.id)),
            links: graphData.edges
              .filter(e => visibleIds.has(e.source) && visibleIds.has(e.target))
              .map(e => ({ source: e.source, target: e.target, similarity: e.similarity })),
          });
          updateStats(
            graphData.nodes.filter(n => visibleIds.has(n.id)).length,
            graphData.edges.filter(e => visibleIds.has(e.source) && visibleIds.has(e.target)).length,
          );
          loading.classList.add('hidden');
          setTimeout(() => graph.zoomToFit(400, 60), 300);
        } catch(e) {
          loading.innerHTML = '<div style="color:var(--status-error)">Failed to reload</div>';
        }
      }, 500);
    }
    simSlider.addEventListener('input', onSliderChange);
    topkSlider.addEventListener('input', onSliderChange);

    init();
  })();
  </script>
</body>
</html>`;
}
