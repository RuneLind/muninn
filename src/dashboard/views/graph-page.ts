import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escScript } from "./components/helpers.ts";

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
        <label>Collection</label>
        <select id="collection-select" style="width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--border-primary);background:var(--bg-surface);color:var(--text-primary);font-size:12px;outline:none;">
          <option value="youtube-summaries">youtube-summaries</option>
        </select>
      </div>
      <div class="control-group">
        <input type="text" id="search-input" placeholder="Search documents..." autocomplete="off"
          style="width:100%;padding:6px 10px;border-radius:8px;border:1px solid var(--border-primary);background:var(--bg-surface);color:var(--text-primary);font-size:12px;outline:none;">
      </div>
      <div class="control-group">
        <label>Min similarity <span id="sim-val">0.65</span></label>
        <input type="range" id="sim-slider" min="0.40" max="0.95" step="0.05" value="0.65">
      </div>
      <div class="control-group">
        <label>Connections per node <span id="topk-val">5</span></label>
        <input type="range" id="topk-slider" min="1" max="15" step="1" value="5">
      </div>
      <div class="control-group">
        <label>Color by</label>
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button id="mode-category" class="mode-btn active" style="flex:1;padding:4px 8px;border-radius:6px;border:1px solid var(--border-primary);background:var(--accent);color:#fff;font-size:11px;cursor:pointer;">Category</button>
          <button id="mode-community" class="mode-btn" style="flex:1;padding:4px 8px;border-radius:6px;border:1px solid var(--border-primary);background:var(--bg-surface);color:var(--text-secondary);font-size:11px;cursor:pointer;">Community</button>
        </div>
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
    const generatedColors = {};
    function hashStr(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
      return Math.abs(h);
    }
    function catColor(cat) {
      if (CAT_COLORS[cat]) return CAT_COLORS[cat];
      const prefix = cat.split('/')[0];
      if (CAT_COLORS[prefix]) return CAT_COLORS[prefix];
      if (generatedColors[cat]) return generatedColors[cat];
      const hue = hashStr(cat) % 360;
      const sat = 55 + (hashStr(cat + '_s') % 25);
      const lum = 55 + (hashStr(cat + '_l') % 15);
      generatedColors[cat] = 'hsl(' + hue + ',' + sat + '%,' + lum + '%)';
      return generatedColors[cat];
    }

    // Community colors — distinct hues for up to 20 communities
    const COMM_PALETTE = [
      '#6c63ff', '#4ade80', '#f59e0b', '#ef4444', '#22d3ee',
      '#c084fc', '#fb923c', '#14b8a6', '#ec4899', '#84cc16',
      '#60a5fa', '#f43f5e', '#a3e635', '#e879f9', '#fbbf24',
      '#2dd4bf', '#818cf8', '#fb7185', '#34d399', '#fca5a1',
    ];
    function commColor(commId) {
      if (commId < 0) return '#555';
      return COMM_PALETTE[commId % COMM_PALETTE.length];
    }

    ${escScript()}

    let graphData = null;
    let nodeMap = new Map();
    let graph = null;
    let activeCategories = new Set();
    let highlightNodes = new Set();
    let highlightLinks = new Set();
    let hoverClearTimer = null;
    let lockedNode = null;
    let searchMatches = null; // null = no search active, Set = matched node objects
    let colorMode = 'category'; // 'category' or 'community'
    let communityData = []; // community summaries from API

    function buildNodeMap() {
      nodeMap.clear();
      if (graphData) graphData.nodes.forEach(n => nodeMap.set(n.id, n));
    }

    function nodeColor(node) {
      return colorMode === 'community' ? commColor(node.community ?? -1) : catColor(node.category);
    }

    function highlightNeighbors(node) {
      highlightNodes.clear();
      highlightLinks.clear();
      highlightNodes.add(node);
      const currentData = graph.graphData();
      currentData.links.forEach(link => {
        const src = typeof link.source === 'object' ? link.source : nodeMap.get(link.source);
        const tgt = typeof link.target === 'object' ? link.target : nodeMap.get(link.target);
        if (src === node || tgt === node) {
          highlightLinks.add(link);
          if (src) highlightNodes.add(src);
          if (tgt) highlightNodes.add(tgt);
        }
      });
    }

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
    const searchInput = document.getElementById('search-input');
    const collectionSelect = document.getElementById('collection-select');

    async function fetchCollections() {
      try {
        const res = await fetch('/api/graph/collections');
        const data = await res.json();
        if (data.collections) {
          collectionSelect.innerHTML = '';
          data.collections
            .sort((a, b) => a.name.localeCompare(b.name))
            .forEach(c => {
              const opt = document.createElement('option');
              opt.value = c.name;
              opt.textContent = c.name + ' (' + c.document_count + ')';
              collectionSelect.appendChild(opt);
            });
          const params = new URLSearchParams(location.search);
          const fromUrl = params.get('collection');
          if (fromUrl && [...collectionSelect.options].some(o => o.value === fromUrl)) {
            collectionSelect.value = fromUrl;
          } else {
            collectionSelect.value = 'youtube-summaries';
          }
        }
      } catch(e) {}
    }

    function selectedCollection() {
      return collectionSelect.value || 'youtube-summaries';
    }

    async function fetchGraph() {
      const sim = simSlider.value;
      const topK = topkSlider.value;
      const coll = selectedCollection();
      const res = await fetch('/api/graph/similarity?collection=' + encodeURIComponent(coll) + '&min_similarity=' + sim + '&top_k=' + topK);
      return await res.json();
    }

    function buildChips(nodes) {
      activeCategories.clear();
      catChipsEl.innerHTML = '';

      if (colorMode === 'community') {
        // Show community chips with names
        const comms = [...new Set(nodes.map(n => n.community ?? -1))].filter(c => c >= 0).sort((a, b) => a - b);
        comms.forEach(commId => {
          activeCategories.add(commId);
          const chip = document.createElement('span');
          chip.className = 'cat-chip active';
          const info = communityData.find(c => c.id === commId);
          const label = info ? (info.name || 'Cluster ' + commId) : 'Cluster ' + commId;
          chip.textContent = label + ' (' + (info ? info.size : '?') + ')';
          chip.title = info && info.representative_docs ? info.representative_docs.join(', ') : '';
          chip.style.background = commColor(commId) + '25';
          chip.style.color = commColor(commId);
          chip.style.borderColor = commColor(commId) + '50';
          chip.dataset.cat = String(commId);
          chip.onclick = () => toggleChip(commId, chip);
          catChipsEl.appendChild(chip);
        });
      } else {
        // Show category chips
        const cats = new Set(nodes.map(n => n.category));
        cats.forEach(cat => {
          activeCategories.add(cat);
          const chip = document.createElement('span');
          chip.className = 'cat-chip active';
          chip.textContent = cat;
          chip.style.background = catColor(cat) + '25';
          chip.style.color = catColor(cat);
          chip.style.borderColor = catColor(cat) + '50';
          chip.dataset.cat = cat;
          chip.onclick = () => toggleChip(cat, chip);
          catChipsEl.appendChild(chip);
        });
      }
    }

    function toggleChip(key, chip) {
      if (activeCategories.has(key)) {
        activeCategories.delete(key);
        chip.className = 'cat-chip inactive';
      } else {
        activeCategories.add(key);
        chip.className = 'cat-chip active';
        const c = colorMode === 'community' ? commColor(key) : catColor(key);
        chip.style.borderColor = c + '50';
      }
      applyFilters();
    }

    function applyFilters() {
      if (!graphData || !graph) return;
      highlightNodes.clear();
      highlightLinks.clear();
      lockedNode = null;
      const visibleIds = new Set(
        graphData.nodes.filter(n => {
          const key = colorMode === 'community' ? (n.community ?? -1) : n.category;
          return activeCategories.has(key);
        }).map(n => n.id)
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
      let s = '<span>' + nodes + '</span> documents &middot; <span>' + edges + '</span> connections';
      if (communityData.length > 0) {
        const names = communityData.map(c => c.name || ('Cluster ' + c.id));
        s += ' &middot; <span>' + communityData.length + '</span> communities: ' + names.join(', ');
      }
      statsEl.innerHTML = s;
    }

    function getNeighborData(nodeId) {
      if (!graphData) return [];
      return graphData.edges
        .filter(e => e.source === nodeId || e.target === nodeId)
        .map(e => {
          const otherId = e.source === nodeId ? e.target : e.source;
          return { node: nodeMap.get(otherId), similarity: e.similarity };
        })
        .filter(d => {
          if (!d.node) return false;
          const key = colorMode === 'community' ? (d.node.community ?? -1) : d.node.category;
          return activeCategories.has(key);
        })
        .sort((a, b) => b.similarity - a.similarity);
    }

    function showDetail(node) {
      const neighbors = getNeighborData(node.id);
      let html = '<h3>' + esc(node.title) + '</h3>';
      html += '<div class="meta">';
      html += '<span class="cat-badge" style="background:' + catColor(node.category) + '25;color:' + catColor(node.category) + '">' + esc(node.category) + '</span>';
      if (node.community != null && node.community >= 0) {
        const info = communityData.find(c => c.id === node.community);
        const commName = info ? (info.name || 'Cluster ' + node.community) : 'Cluster ' + node.community;
        html += ' <span class="cat-badge" style="background:' + commColor(node.community) + '25;color:' + commColor(node.community) + '">' + esc(commName) + '</span>';
      }
      if (node.date) html += ' &middot; ' + esc(node.date);
      if (node.url) html += '<br><a href="' + esc(node.url) + '" target="_blank">Open source &rarr;</a>';
      const coll = selectedCollection();
      html += '<br><a href="/search/document/' + encodeURIComponent(coll) + '/' + encodeURIComponent(node.id) + '" target="_blank">View article &rarr;</a>';
      html += '</div>';

      if (neighbors.length > 0) {
        html += '<div class="connections-list">';
        html += '<h4>Connected (' + neighbors.length + ')</h4>';
        neighbors.forEach(d => {
          const dotColor = colorMode === 'community' ? commColor(d.node.community ?? -1) : catColor(d.node.category);
          html += '<div class="conn-item" data-id="' + esc(d.node.id) + '">';
          html += '<span class="conn-dot" style="background:' + dotColor + '"></span>';
          html += '<span class="conn-title">' + esc(d.node.title) + '</span>';
          html += '<span class="conn-score">' + (d.similarity * 100).toFixed(0) + '%</span>';
          html += '</div>';
        });
        html += '</div>';
      }
      detailContent.innerHTML = html;
      detailPanel.classList.add('open');

      detailContent.querySelectorAll('.conn-item').forEach(el => {
        el.addEventListener('click', () => {
          const targetId = el.dataset.id;
          const targetNode = nodeMap.get(targetId);
          if (targetNode && graph) {
            graph.centerAt(targetNode.x, targetNode.y, 500);
            graph.zoom(3, 500);
            setTimeout(() => showDetail(targetNode), 550);
          }
        });
      });
    }

    function unlockGraph() {
      lockedNode = null;
      highlightNodes.clear();
      highlightLinks.clear();
      clearTimeout(hoverClearTimer);
      detailPanel.classList.remove('open');
    }

    detailClose.onclick = () => unlockGraph();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        unlockGraph();
        if (searchInput.value) {
          searchInput.value = '';
          searchMatches = null;
        }
      }
    });

    async function init() {
      await fetchCollections();
      try {
        graphData = await fetchGraph();
      } catch(e) {
        loading.innerHTML = '<div style="color:var(--status-error)">Failed to load graph data</div>';
        return;
      }
      loading.classList.add('hidden');

      if (!graphData.nodes || graphData.nodes.length === 0) {
        loading.classList.remove('hidden');
        loading.innerHTML = '<div style="color:var(--text-muted)">No documents found in this collection</div>';
        return;
      }

      buildNodeMap();
      communityData = graphData.communities || [];
      buildChips(graphData.nodes);

      const container = document.getElementById('graph-canvas');
      graph = ForceGraph()(container)
        .graphData({
          nodes: graphData.nodes.map(n => ({ ...n })),
          links: graphData.edges.map(e => ({ source: e.source, target: e.target, similarity: e.similarity })),
        })
        .nodeId('id')
        .nodeLabel(n => {
          const label = n.title + '\\n' + n.category;
          if (colorMode !== 'community' || n.community == null) return label;
          const info = communityData.find(c => c.id === n.community);
          const commName = info ? info.name : 'Cluster ' + n.community;
          return label + '\\n' + commName;
        })
        .nodeColor(n => {
          const c = nodeColor(n);
          const matched = !searchMatches || searchMatches.has(n);
          if (highlightNodes.size > 0) {
            return highlightNodes.has(n) ? c : c + '20';
          }
          return matched ? c : c + '15';
        })
        .nodeVal(n => {
          if (highlightNodes.size > 0 && highlightNodes.has(n)) return 8;
          if (searchMatches && searchMatches.has(n)) return 6;
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
          if (searchMatches) {
            const src = typeof link.source === 'object' ? link.source : null;
            const tgt = typeof link.target === 'object' ? link.target : null;
            if (src && tgt && (searchMatches.has(src) || searchMatches.has(tgt))) return 'rgba(108, 99, 255, 0.08)';
            return 'rgba(108, 99, 255, 0.02)';
          }
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
          if (lockedNode) {
            container.style.cursor = node ? 'pointer' : 'default';
            return;
          }
          clearTimeout(hoverClearTimer);
          if (node) {
            highlightNeighbors(node);
          } else {
            hoverClearTimer = setTimeout(() => {
              highlightNodes.clear();
              highlightLinks.clear();
            }, 40);
          }
          container.style.cursor = node ? 'pointer' : 'default';
        })
        .onNodeClick(node => {
          if (lockedNode === node) {
            unlockGraph();
            return;
          }
          lockedNode = node;
          highlightNeighbors(node);
          showDetail(node);
        })
        .onBackgroundClick(() => {
          unlockGraph();
        });

      updateStats(graphData.nodes.length, graphData.edges.length);

      setTimeout(() => graph.zoomToFit(400, 60), 500);
    }

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
          buildNodeMap();
          communityData = graphData.communities || [];
          buildChips(graphData.nodes);
          applyFilters();
          loading.classList.add('hidden');
          setTimeout(() => graph.zoomToFit(400, 60), 300);
        } catch(e) {
          loading.innerHTML = '<div style="color:var(--status-error)">Failed to reload</div>';
        }
      }, 500);
    }
    simSlider.addEventListener('input', onSliderChange);
    topkSlider.addEventListener('input', onSliderChange);
    collectionSelect.addEventListener('change', () => {
      history.replaceState(null, '', '?collection=' + encodeURIComponent(selectedCollection()));
      onSliderChange();
    });

    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        searchMatches = null;
      } else {
        const terms = q.split(/\\s+/);
        const currentNodes = graph ? graph.graphData().nodes : [];
        searchMatches = new Set(currentNodes.filter(n => {
          const text = ((n.title || '') + ' ' + (n.category || '') + ' ' + (n.tags || []).join(' ') + ' ' + (n.headings || []).join(' ') + ' ' + (n.summary || '')).toLowerCase();
          return terms.every(t => text.includes(t));
        }));
      }
    });

    // Mode switching: Category vs Community
    const modeCatBtn = document.getElementById('mode-category');
    const modeCommBtn = document.getElementById('mode-community');
    function setColorMode(mode) {
      colorMode = mode;
      modeCatBtn.style.background = mode === 'category' ? 'var(--accent)' : 'var(--bg-surface)';
      modeCatBtn.style.color = mode === 'category' ? '#fff' : 'var(--text-secondary)';
      modeCommBtn.style.background = mode === 'community' ? 'var(--accent)' : 'var(--bg-surface)';
      modeCommBtn.style.color = mode === 'community' ? '#fff' : 'var(--text-secondary)';
      if (graphData) {
        buildChips(graphData.nodes);
        applyFilters();
      }
    }
    modeCatBtn.onclick = () => setColorMode('category');
    modeCommBtn.onclick = () => setColorMode('community');

    init();
  })();
  </script>
</body>
</html>`;
}
