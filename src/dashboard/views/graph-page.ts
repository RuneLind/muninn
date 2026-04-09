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

    .mode-btn {
      flex: 1;
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--border-primary);
      font-size: 11px;
      cursor: pointer;
    }
    .mode-btn.active { background: var(--accent); color: #fff; }
    .mode-btn.inactive { background: var(--bg-surface); color: var(--text-secondary); }

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
      <div class="control-group" id="graph-type-group" style="display:none;">
        <label>Graph type</label>
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button id="type-similarity" class="mode-btn active">Documents</button>
          <button id="type-author" class="mode-btn inactive">Authors</button>
        </div>
      </div>
      <div class="control-group" id="edge-type-group" style="display:none;">
        <label>Edge type</label>
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button id="edge-all" class="mode-btn active">All</button>
          <button id="edge-similarity" class="mode-btn inactive">Similarity</button>
          <button id="edge-wikilink" class="mode-btn inactive">Wikilinks</button>
        </div>
      </div>
      <div class="control-group" id="similarity-controls">
        <label>Min similarity <span id="sim-val">0.65</span></label>
        <input type="range" id="sim-slider" min="0.40" max="0.95" step="0.05" value="0.65">
      </div>
      <div class="control-group" id="topk-controls">
        <label>Connections per node <span id="topk-val">5</span></label>
        <input type="range" id="topk-slider" min="1" max="15" step="1" value="5">
      </div>
      <div class="control-group">
        <label>Color by</label>
        <div style="display:flex;gap:4px;margin-bottom:8px;">
          <button id="mode-category" class="mode-btn active">Category</button>
          <button id="mode-community" class="mode-btn inactive">Community</button>
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
    let colorMode = 'category';
    let communityData = [];
    let communityMap = new Map();
    let graphType = 'similarity'; // 'similarity' or 'author'
    let edgeFilter = 'all'; // 'all' | 'similarity' | 'wikilink'
    const AUTHOR_GRAPH_COLLECTIONS = ['x-feed'];
    const WIKILINK_COLLECTIONS = ['wiki', 'nav-wiki', 'capra-wiki'];

    function edgeType(e) { return e.type || 'similarity'; }
    function matchesEdgeFilter(e) { return edgeFilter === 'all' || edgeType(e) === edgeFilter; }

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
    const typeSimilarityBtn = document.getElementById('type-similarity');
    const typeAuthorBtn = document.getElementById('type-author');
    const similarityControls = document.getElementById('similarity-controls');
    const topkControls = document.getElementById('topk-controls');
    const graphTypeGroup = document.getElementById('graph-type-group');
    const edgeTypeGroup = document.getElementById('edge-type-group');
    const edgeAllBtn = document.getElementById('edge-all');
    const edgeSimilarityBtn = document.getElementById('edge-similarity');
    const edgeWikilinkBtn = document.getElementById('edge-wikilink');

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
      const coll = selectedCollection();
      if (graphType === 'author') {
        const res = await fetch('/api/graph/author?collection=' + encodeURIComponent(coll));
        return await res.json();
      }
      const sim = simSlider.value;
      const topK = topkSlider.value;
      const res = await fetch('/api/graph/similarity?collection=' + encodeURIComponent(coll) + '&min_similarity=' + sim + '&top_k=' + topK);
      return await res.json();
    }

    function createChip(label, key, color, title) {
      const chip = document.createElement('span');
      chip.className = 'cat-chip active';
      chip.textContent = label;
      if (title) chip.title = title;
      chip.style.background = color + '25';
      chip.style.color = color;
      chip.style.borderColor = color + '50';
      chip.dataset.cat = String(key);
      chip.onclick = () => toggleChip(key, chip);
      return chip;
    }

    function buildChips(nodes) {
      activeCategories.clear();
      catChipsEl.innerHTML = '';

      if (colorMode === 'community') {
        const comms = communityData
          .filter(c => c.size >= 2)
          .sort((a, b) => b.size - a.size);
        nodes.forEach(n => { if (n.community != null && n.community >= 0) activeCategories.add(n.community); });
        comms.forEach(info => {
          const label = (info.name || 'Cluster ' + info.id) + ' (' + info.size + ')';
          const title = info.representative_docs ? info.representative_docs.join(', ') : '';
          catChipsEl.appendChild(createChip(label, info.id, commColor(info.id), title));
        });
      } else {
        const cats = new Set(nodes.map(n => n.category));
        cats.forEach(cat => {
          activeCategories.add(cat);
          catChipsEl.appendChild(createChip(cat, cat, catColor(cat)));
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
          .filter(e => matchesEdgeFilter(e))
          .map(e => ({ source: e.source, target: e.target, similarity: e.similarity, type: edgeType(e) })),
      };
      graph.graphData(filtered);
      updateStats(filtered.nodes.length, filtered.links);
    }

    function updateStats(nodes, links) {
      const simCount = links.filter(l => l.type !== 'wikilink').length;
      const wikiCount = links.length - simCount;
      let s = '<span>' + nodes + '</span> documents &middot; ';
      if (wikiCount > 0) {
        s += '<span>' + simCount + '</span> similarity &middot; <span>' + wikiCount + '</span> wikilinks';
      } else {
        s += '<span>' + links.length + '</span> connections';
      }
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
        .filter(e => matchesEdgeFilter(e))
        .map(e => {
          const otherId = e.source === nodeId ? e.target : e.source;
          return { node: nodeMap.get(otherId), similarity: e.similarity, type: edgeType(e) };
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
        const info = communityMap.get(node.community);
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
          html += '<span class="conn-score">' + (d.type === 'wikilink' ? '&#8599; link' : (d.similarity * 100).toFixed(0) + '%') + '</span>';
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

    // Cluster force: pulls nodes in the same community toward their shared centroid
    function clusterForce(strength) {
      let nodes;
      function force(alpha) {
        if (colorMode !== 'community') return;
        const centroids = {};
        const counts = {};
        nodes.forEach(n => {
          const c = n.community;
          if (c == null || c < 0) return;
          if (!centroids[c]) { centroids[c] = {x: 0, y: 0}; counts[c] = 0; }
          centroids[c].x += n.x || 0;
          centroids[c].y += n.y || 0;
          counts[c]++;
        });
        Object.keys(centroids).forEach(c => {
          centroids[c].x /= counts[c];
          centroids[c].y /= counts[c];
        });
        nodes.forEach(n => {
          const c = n.community;
          if (c == null || c < 0 || !centroids[c]) return;
          n.vx += (centroids[c].x - n.x) * alpha * strength;
          n.vy += (centroids[c].y - n.y) * alpha * strength;
        });
      }
      force.initialize = (_nodes) => { nodes = _nodes; };
      return force;
    }

    // Convex hull: compute hull points for a set of 2D points
    function convexHull(points) {
      if (points.length < 3) return points;
      points = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (O, A, B) => (A[0]-O[0])*(B[1]-O[1]) - (A[1]-O[1])*(B[0]-O[0]);
      const lower = [];
      for (const p of points) { while (lower.length >= 2 && cross(lower[lower.length-2], lower[lower.length-1], p) <= 0) lower.pop(); lower.push(p); }
      const upper = [];
      for (const p of points.reverse()) { while (upper.length >= 2 && cross(upper[upper.length-2], upper[upper.length-1], p) <= 0) upper.pop(); upper.push(p); }
      return lower.slice(0,-1).concat(upper.slice(0,-1));
    }

    // Draw community hulls on the canvas
    function drawCommunityHulls(ctx, globalScale) {
      if (colorMode !== 'community' || !communityData.length) return;
      const currentNodes = graph ? graph.graphData().nodes : [];
      // Group nodes by community
      const groups = {};
      currentNodes.forEach(n => {
        const c = n.community;
        if (c == null || c < 0) return;
        if (!groups[c]) groups[c] = [];
        groups[c].push(n);
      });

      const padding = 20 / globalScale;
      Object.entries(groups).forEach(([commId, members]) => {
        if (members.length < 2) return;
        const points = members.map(n => [n.x, n.y]);
        const hull = convexHull(points);
        if (hull.length < 2) return;

        const color = commColor(Number(commId));
        const cx = members.reduce((s, n) => s + n.x, 0) / members.length;
        const cy = members.reduce((s, n) => s + n.y, 0) / members.length;

        ctx.beginPath();
        for (let i = 0; i < hull.length; i++) {
          const curr = hull[i];
          const dx = curr[0] - cx, dy = curr[1] - cy;
          const dist = Math.sqrt(dx*dx + dy*dy) || 1;
          const ox = curr[0] + (dx/dist) * padding;
          const oy = curr[1] + (dy/dist) * padding;
          if (i === 0) ctx.moveTo(ox, oy); else ctx.lineTo(ox, oy);
        }
        ctx.closePath();
        ctx.fillStyle = color + '12';
        ctx.fill();
        ctx.strokeStyle = color + '30';
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();

        const info = communityMap.get(Number(commId));
        if (info && globalScale > 0.2) {
          const label = info.name || 'Cluster ' + commId;
          const fontSize = Math.max(12, 16 / globalScale);
          ctx.font = 'bold ' + fontSize + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const textWidth = ctx.measureText(label).width;
          const pad = 4 / globalScale;
          ctx.fillStyle = 'rgba(10, 10, 15, 0.7)';
          ctx.fillRect(cx - textWidth/2 - pad, cy - (20/globalScale) - fontSize/2 - pad, textWidth + pad*2, fontSize + pad*2);
          ctx.fillStyle = color;
          ctx.fillText(label, cx, cy - (20 / globalScale));
        }
      });
    }

    async function init() {
      await fetchCollections();
      // Show graph type toggle if current collection supports author graph
      const coll = selectedCollection();
      if (AUTHOR_GRAPH_COLLECTIONS.includes(coll)) {
        graphTypeGroup.style.display = '';
      }
      edgeTypeGroup.style.display = WIKILINK_COLLECTIONS.includes(coll) ? '' : 'none';
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
      communityMap = new Map(communityData.map(c => [c.id, c]));
      buildChips(graphData.nodes);

      const container = document.getElementById('graph-canvas');
      graph = ForceGraph()(container)
        .graphData({
          nodes: graphData.nodes.map(n => ({ ...n })),
          links: graphData.edges
            .filter(e => matchesEdgeFilter(e))
            .map(e => ({ source: e.source, target: e.target, similarity: e.similarity, type: edgeType(e) })),
        })
        .nodeId('id')
        .nodeLabel(n => {
          const label = n.title + '\\n' + n.category;
          if (colorMode !== 'community' || n.community == null) return label;
          const info = communityMap.get(n.community);
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
          if (highlightNodes.size > 0 && highlightNodes.has(n)) return 3;
          if (searchMatches && searchMatches.has(n)) return 2;
          // Size author nodes by score (larger = higher score)
          if (graphType === 'author' && n.score != null) return 1 + n.score * 6;
          return 1;
        })
        .nodeCanvasObject((node, ctx, globalScale) => {
          const r = Math.sqrt(node.val || 1) * 3;
          const c = nodeColor(node);
          const isHighlighted = highlightNodes.size > 0 && highlightNodes.has(node);
          const isSearched = searchMatches && searchMatches.has(node);
          const isDimmed = (highlightNodes.size > 0 && !highlightNodes.has(node)) || (searchMatches && !searchMatches.has(node));

          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = isDimmed ? c + '20' : c;
          ctx.fill();
          if (isHighlighted || isSearched) {
            ctx.strokeStyle = c;
            ctx.lineWidth = 1.5 / globalScale;
            ctx.stroke();
          }

          const fontSize = 11 / globalScale;
          const labelThreshold = graphData.nodes.length > 200 ? 2.5 : graphData.nodes.length > 80 ? 1.5 : 0.6;
          if (globalScale > labelThreshold || isHighlighted) {
            ctx.font = (isHighlighted ? 'bold ' : '') + fontSize + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = isDimmed ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.85)';
            ctx.fillText(node.title, node.x, node.y + r + 2 / globalScale);
          }
        })
        .nodePointerAreaPaint((node, color, ctx) => {
          const r = Math.sqrt(node.val || 1) * 3 + 3;
          ctx.beginPath();
          ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
          ctx.fillStyle = color;
          ctx.fill();
        })
        .linkSource('source')
        .linkTarget('target')
        .linkWidth(link => {
          if (highlightLinks.has(link)) return 2;
          return link.type === 'wikilink' ? 1.2 : 0.5;
        })
        .linkColor(link => {
          const isWiki = link.type === 'wikilink';
          if (highlightLinks.has(link)) return isWiki ? 'rgba(245, 158, 11, 0.7)' : 'rgba(108, 99, 255, 0.6)';
          if (searchMatches) {
            const src = typeof link.source === 'object' ? link.source : null;
            const tgt = typeof link.target === 'object' ? link.target : null;
            if (src && tgt && (searchMatches.has(src) || searchMatches.has(tgt))) return isWiki ? 'rgba(245, 158, 11, 0.25)' : 'rgba(108, 99, 255, 0.12)';
            return isWiki ? 'rgba(245, 158, 11, 0.05)' : 'rgba(108, 99, 255, 0.02)';
          }
          if (colorMode === 'community') {
            const src = typeof link.source === 'object' ? link.source : null;
            const tgt = typeof link.target === 'object' ? link.target : null;
            if (src && tgt && src.community != null && src.community === tgt.community) {
              return commColor(src.community) + '20';
            }
            return isWiki ? 'rgba(245, 158, 11, 0.18)' : 'rgba(100, 100, 100, 0.06)';
          }
          return isWiki ? 'rgba(245, 158, 11, 0.25)' : 'rgba(108, 99, 255, 0.12)';
        })
        .linkLineDash(link => link.type === 'wikilink' ? [4, 2] : null)
        .linkDirectionalArrowLength(link => link.type === 'wikilink' ? 4 : 0)
        .linkDirectionalArrowRelPos(1)
        .linkDirectionalArrowColor(link => {
          const isWiki = link.type === 'wikilink';
          if (highlightLinks.has(link)) return isWiki ? 'rgba(245, 158, 11, 0.7)' : 'rgba(108, 99, 255, 0.6)';
          return isWiki ? 'rgba(245, 158, 11, 0.25)' : 'rgba(108, 99, 255, 0.12)';
        })
        .linkDirectionalParticles(link => highlightLinks.has(link) ? 2 : 0)
        .linkDirectionalParticleWidth(2)
        .linkDirectionalParticleColor(link => link.type === 'wikilink' ? '#f59e0b' : '#6c63ff')
        .backgroundColor('#0a0a0f')
        .d3AlphaDecay(0.03)
        .d3VelocityDecay(0.3)
        .warmupTicks(80)
        .cooldownTicks(Infinity)
        .cooldownTime(Infinity)
        .nodeRelSize(3)
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
        })
        .onRenderFramePost((ctx, globalScale) => {
          drawCommunityHulls(ctx, globalScale);
        });

      // Add cluster force (active only in community mode)
      graph.d3Force('cluster', clusterForce(0.08));

      updateStats(graphData.nodes.length, graphData.edges);

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
          communityMap = new Map(communityData.map(c => [c.id, c]));
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
      const coll = selectedCollection();
      const hasAuthor = AUTHOR_GRAPH_COLLECTIONS.includes(coll);
      const hasWikilinks = WIKILINK_COLLECTIONS.includes(coll);
      graphTypeGroup.style.display = hasAuthor ? '' : 'none';
      edgeTypeGroup.style.display = hasWikilinks ? '' : 'none';
      // Reset to similarity when switching away from author-capable collection
      if (!hasAuthor && graphType === 'author') {
        graphType = 'similarity';
        typeSimilarityBtn.className = 'mode-btn active';
        typeAuthorBtn.className = 'mode-btn inactive';
      }
      // Reset edge filter when switching away from wikilink-capable collection
      if (!hasWikilinks && edgeFilter !== 'all') {
        setEdgeFilter('all');
      }
      similarityControls.style.display = graphType === 'author' ? 'none' : '';
      topkControls.style.display = graphType === 'author' ? 'none' : '';
      history.replaceState(null, '', '?collection=' + encodeURIComponent(coll) + (graphType === 'author' ? '&type=author' : ''));
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

    const modeCatBtn = document.getElementById('mode-category');
    const modeCommBtn = document.getElementById('mode-community');
    function setColorMode(mode) {
      colorMode = mode;
      modeCatBtn.className = 'mode-btn ' + (mode === 'category' ? 'active' : 'inactive');
      modeCommBtn.className = 'mode-btn ' + (mode === 'community' ? 'active' : 'inactive');
      if (graphData) {
        buildChips(graphData.nodes);
        applyFilters();
      }
      if (graph) graph.d3ReheatSimulation();
    }
    modeCatBtn.onclick = () => setColorMode('category');
    modeCommBtn.onclick = () => setColorMode('community');

    // Graph type toggle (Documents vs Authors)
    function setGraphType(type) {
      graphType = type;
      typeSimilarityBtn.className = 'mode-btn ' + (type === 'similarity' ? 'active' : 'inactive');
      typeAuthorBtn.className = 'mode-btn ' + (type === 'author' ? 'active' : 'inactive');
      // Hide similarity-specific sliders for author graph
      similarityControls.style.display = type === 'author' ? 'none' : '';
      topkControls.style.display = type === 'author' ? 'none' : '';
      history.replaceState(null, '', '?collection=' + encodeURIComponent(selectedCollection()) + (type === 'author' ? '&type=author' : ''));
      onSliderChange();
    }
    typeSimilarityBtn.onclick = () => setGraphType('similarity');
    typeAuthorBtn.onclick = () => setGraphType('author');

    // Edge type filter toggle (wiki collections only)
    function setEdgeFilter(filter) {
      edgeFilter = filter;
      edgeAllBtn.className = 'mode-btn ' + (filter === 'all' ? 'active' : 'inactive');
      edgeSimilarityBtn.className = 'mode-btn ' + (filter === 'similarity' ? 'active' : 'inactive');
      edgeWikilinkBtn.className = 'mode-btn ' + (filter === 'wikilink' ? 'active' : 'inactive');
      if (graphData && graph) applyFilters();
    }
    edgeAllBtn.onclick = () => setEdgeFilter('all');
    edgeSimilarityBtn.onclick = () => setEdgeFilter('similarity');
    edgeWikilinkBtn.onclick = () => setEdgeFilter('wikilink');

    // Check URL for graph type and collection with author support
    const urlType = new URLSearchParams(window.location.search).get('type');
    if (urlType === 'author') {
      graphType = 'author';
      typeSimilarityBtn.className = 'mode-btn inactive';
      typeAuthorBtn.className = 'mode-btn active';
      similarityControls.style.display = 'none';
      topkControls.style.display = 'none';
    }

    init();
  })();
  </script>
</body>
</html>`;
}
