import { themeInitScript, themeToggleHtml, themeToggleScript } from "./components/theme.ts";

/** Dark palette — the default, and the forced value under html[data-theme="dark"]. */
const DARK_TOKENS = `
      /* Backgrounds */
      --bg-page: #0a0a0f;
      --bg-panel: #12121a;
      --bg-surface: #1a1a2e;
      --bg-deep: #0f0f17;
      --bg-inset: #0d0d14;
      --bg-gradient-end: #16162a;

      /* Borders */
      --border-primary: #1e1e2e;
      --border-secondary: #2a2a3e;
      --border-subtle: #1a1a28;
      --scrollbar-thumb: #2a2a3a;

      /* Text */
      --text-primary: #fff;
      --text-secondary: #e0e0e0;
      --text-tertiary: #ccc;
      --text-soft: #aaa;
      --text-muted: #888;
      --text-dim: #666;
      --text-faint: #555;
      --text-disabled: #444;

      /* Accent (brand purple) */
      --accent: #6c63ff;
      --accent-hover: #5a52e0;
      --accent-light: #a5a0ff;

      /* Status colors */
      --status-success: #4ade80;
      --status-error: #f87171;
      --status-warning: #fbbf24;
      --status-info: #60a5fa;
      --status-tool: #f59e0b;
      --status-cyan: #22d3ee;
      --status-magenta: #c084fc;

      /* Tinted backgrounds (for badges, events) */
      --tint-success: #1a3a2a;
      --tint-error: #3a1a1a;
      --tint-warning: #2a2a1a;
      --tint-info: #1e3a5f;
      --tint-purple: #1e1e3e;
      --tint-magenta: #2a1a3a;
      --tint-cyan: #1a2e3a;
      --tint-neutral: #1a1a1a;

      /* Accent text variants */
      --accent-muted: #8b8bcd;

      /* Chat bubbles */
      --chat-user-bg: #1e3a5f;
      --chat-user-text: #c8ddf5;
      --chat-assistant-bg: #1a1d25;
      --chat-assistant-text: #d8d8dc;
`;

/**
 * Light palette — applied under `@media (prefers-color-scheme: light)` (system
 * follow) and forced under `html[data-theme="light"]`. Status colors are darkened
 * vs the dark ramp so they stay legible on light backgrounds; tints flip to pale
 * fills. Mirrors the chat page's light theme so the two surfaces match.
 */
const LIGHT_TOKENS = `
      /* Backgrounds */
      --bg-page: #f3f4f7;
      --bg-panel: #ffffff;
      --bg-surface: #f1f2f6;
      --bg-deep: #eceef3;
      --bg-inset: #eceef3;
      --bg-gradient-end: #e8eaf2;

      /* Borders */
      --border-primary: #e2e4ea;
      --border-secondary: #d2d5de;
      --border-subtle: #edeef2;
      --scrollbar-thumb: #cfd2db;

      /* Text */
      --text-primary: #14151a;
      --text-secondary: #3a3d47;
      --text-tertiary: #4a4d57;
      --text-soft: #5a5e68;
      --text-muted: #6c707d;
      --text-dim: #80848f;
      --text-faint: #9aa0ad;
      --text-disabled: #b8bcc6;

      /* Accent (brand purple) */
      --accent: #6357f0;
      --accent-hover: #5247d8;
      --accent-light: #5247d8;

      /* Status colors */
      --status-success: #16a34a;
      --status-error: #dc2626;
      --status-warning: #d97706;
      --status-info: #2563eb;
      --status-tool: #c2620a;
      --status-cyan: #0891b2;
      --status-magenta: #9333ea;

      /* Tinted backgrounds (for badges, events) */
      --tint-success: #dcfce7;
      --tint-error: #fee2e2;
      --tint-warning: #fef3c7;
      --tint-info: #dbeafe;
      --tint-purple: #e7e7fb;
      --tint-magenta: #f3e8ff;
      --tint-cyan: #cffafe;
      --tint-neutral: #eceef3;

      /* Accent text variants */
      --accent-muted: #6b6f9a;

      /* Chat bubbles */
      --chat-user-bg: #dbeafe;
      --chat-user-text: #1e3a5f;
      --chat-assistant-bg: #f1f2f6;
      --chat-assistant-text: #3a3d47;
`;

/** Shared CSS for all dashboard pages — base reset, header, and nav */
export const SHARED_STYLES = `
    :root {${DARK_TOKENS}    }

    /* System follow: honor the OS preference when no explicit override is set. */
    @media (prefers-color-scheme: light) {
      :root {${LIGHT_TOKENS}      }
    }

    /* Explicit overrides (set by the theme toggle). html[data-theme] has higher
       specificity than the media-query :root, so it wins regardless of OS setting. */
    html[data-theme="dark"] {${DARK_TOKENS}    }
    html[data-theme="light"] {${LIGHT_TOKENS}    }

    /* Theme toggle button (right of the nav, on every page) */
    .header-right { display: flex; align-items: center; gap: 12px; }
    .theme-toggle {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      cursor: pointer;
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1;
      font-family: inherit;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .theme-toggle:hover { color: var(--text-primary); border-color: var(--border-secondary); }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg-page);
      color: var(--text-secondary);
      min-height: 100vh;
    }

    /* Header */
    header {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border-primary);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { font-size: 20px; font-weight: 600; color: var(--text-primary); }
    header h1 span { color: var(--accent); }
    .header-left { display: flex; align-items: center; gap: 16px; }
    .nav-link { color: var(--text-muted); text-decoration: none; font-size: 13px; padding: 4px 10px; border-radius: 6px; transition: all 0.2s; }
    .nav-link:hover { color: var(--accent-light); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .nav-link.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }

    .error-banner {
      display: none;
      margin: 0 24px 12px;
      padding: 12px 16px;
      background: color-mix(in srgb, var(--status-error) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
      border-radius: 8px;
      color: var(--status-error);
      font-size: 13px;
    }
    .error-banner.visible { display: block; }
    .error-banner code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px; }

    /* --- Live-activity animation primitives (shared) ------------------------
       Promoted out of /agents so the chat + gardener live strips can adopt the
       same pulse-ring dot and shimmer bar later. Consumers set the color via the
       element's own background; the pulse can be stopped via --pulse-anim: none.
       Keyframes are global. */
    @keyframes pulse-ring {
      0%   { transform: scale(0.6); opacity: 0.6; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    @keyframes shimmer { 0% { left: -35%; } 100% { left: 100%; } }

    /* A small live dot with an expanding ring. Color follows its own background
       (override per-kind); a done/paused variant sets --pulse-anim: none. */
    .pulse-dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--status-success);
      position: relative; flex-shrink: 0;
    }
    .pulse-dot::after {
      content: ''; position: absolute; inset: -4px; border-radius: 50%;
      background: inherit; opacity: 0.5;
      animation: pulse-ring 1.6s ease-out infinite;
      animation-name: var(--pulse-anim, pulse-ring);
    }

    /* Indeterminate shimmer sweep — drop inside a clipped, positioned track. */
    .shimmer-bar {
      position: absolute; top: 0; left: 0; height: 100%; width: 35%; border-radius: 3px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      animation: shimmer 1.4s linear infinite;
    }

    /* --- Nav cluster separators (thin vertical rule between the 3 nav groups) --- */
    header nav { display: inline-flex; align-items: center; gap: 2px; flex-wrap: wrap; }
    .nav-sep {
      display: inline-block; width: 1px; height: 14px;
      background: var(--border-secondary); margin: 0 6px; align-self: center;
    }

    /* ========================================================================
       Shared dashboard-redesign primitives (PR 1). Consumed by /agents,
       /models and /indexing in PRs 2–4. Every tint is expressed through
       color-mix on a status/accent variable so the LIGHT palette works — the
       design prototypes hardcode the dark rgba values of these same tokens.
       ======================================================================== */

    /* --- Summary tiles (stat row under a page header) ------------------------
       tileHtml() (summary-tiles.ts client script) builds these. Attention rule:
       a tile gets a colored border ONLY when its tone says it needs attention;
       neutral (toneless) tiles stay quiet. The tone also colors the label. */
    .summary-tiles { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0 20px; }
    .s-tile {
      background: var(--bg-panel); border: 1px solid var(--border-primary);
      border-radius: 10px; padding: 11px 16px; min-width: 130px;
    }
    .s-tile-label { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 4px; }
    .s-tile-value { font-size: 16px; font-weight: 600; color: var(--text-primary); }
    .s-tile-sub   { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
    .s-tile-warning { border-color: color-mix(in srgb, var(--status-warning) 35%, transparent); }
    .s-tile-warning .s-tile-label { color: var(--status-warning); }
    .s-tile-success { border-color: color-mix(in srgb, var(--status-success) 30%, transparent); }
    .s-tile-success .s-tile-label { color: var(--status-success); }
    .s-tile-error   { border-color: color-mix(in srgb, var(--status-error) 35%, transparent); }
    .s-tile-error .s-tile-label { color: var(--status-error); }
    .s-tile-info    { border-color: color-mix(in srgb, var(--status-info) 30%, transparent); }
    .s-tile-info .s-tile-label { color: var(--status-info); }

    /* --- Unified status chips (9px geometry) --------------------------------
       Attention (STALE), origin/routing (full 11-value Origin union), job-kind
       (fixed 68px) and run-status. status-chips.ts renders these. */
    .dchip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 1px 7px; border-radius: 9px; line-height: 1.7;
      text-transform: uppercase; white-space: nowrap; vertical-align: middle;
    }
    /* Attention chip — shown ONLY when something is wrong. */
    .dchip-attn     { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
    /* Origin / routing chips (config env override default derived legacy fixed none pinned owner fallback). */
    .dchip-config,
    .dchip-pinned   { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-light); }
    .dchip-override,
    .dchip-owner    { background: color-mix(in srgb, var(--status-success) 14%, transparent); color: var(--status-success); }
    .dchip-env      { background: color-mix(in srgb, var(--status-info) 16%, transparent); color: var(--status-info); }
    /* derived adopts the design's neutral gray (was cyan) — decision from the plan. */
    .dchip-derived,
    .dchip-default  { background: var(--tint-neutral); color: var(--text-muted); }
    .dchip-fallback,
    .dchip-legacy   { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
    .dchip-fixed    { background: color-mix(in srgb, var(--status-magenta) 16%, transparent); color: var(--status-magenta); }
    .dchip-none     { background: var(--tint-neutral); color: var(--text-disabled); }

    /* Job-kind chips (Agents) — fixed 68px, centered. */
    .kind-chip {
      display: inline-flex; align-items: center; justify-content: center;
      width: 68px; text-align: center; flex-shrink: 0;
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 1px 7px; border-radius: 9px; line-height: 1.7;
      text-transform: uppercase; white-space: nowrap;
    }
    .kind-watcher { background: color-mix(in srgb, var(--status-info) 14%, transparent); color: var(--status-info); }
    .kind-task    { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-light); }
    .kind-capture { background: color-mix(in srgb, var(--status-magenta) 16%, transparent); color: var(--status-magenta); }
    .kind-digest  { background: color-mix(in srgb, var(--status-cyan) 13%, transparent); color: var(--status-cyan); }
    /* Remaining AgentKind chips (Agents page). GARDENER→success, EXTRACTOR→warning;
       chat/research/profile share a quiet neutral (the 4 hue slots above are the
       design-canonical kinds, error stays reserved for run-status failures). */
    .kind-gardener  { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
    .kind-extractor { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
    .kind-chat,
    .kind-research,
    .kind-profile   { background: var(--tint-neutral); color: var(--text-muted); }

    /* Run status — 7px colored dot + lowercase text (NOT an uppercase pill).
       Failure/staleness also tints the text. */
    .run-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-soft); white-space: nowrap; }
    .run-status .run-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-disabled); }
    .run-success .run-dot { background: var(--status-success); }
    .run-warning .run-dot { background: var(--status-warning); }
    .run-error   .run-dot { background: var(--status-error); }
    .run-info    .run-dot { background: var(--status-info); }
    .run-magenta .run-dot { background: var(--status-magenta); }
    .run-warning { color: var(--status-warning); }
    .run-error   { color: var(--status-error); }
    .run-info    { color: var(--status-info); }
    .run-magenta { color: var(--status-magenta); }
    /* running → pulsing dot (reuses the shared pulse-ring idiom; --pulse-anim: none stops it). */
    .run-info .run-dot { position: relative; }
    .run-info .run-dot::after {
      content: ''; position: absolute; inset: -3px; border-radius: 50%;
      background: inherit; opacity: 0.5;
      animation: pulse-ring 1.6s ease-out infinite;
      animation-name: var(--pulse-anim, pulse-ring);
    }

    /* Aging / stale relative-time text (design's #d0a94a) — a muted warning that
       works in both themes. */
    .text-aging { color: color-mix(in srgb, var(--status-warning) 65%, var(--text-muted)); }

    /* Expand caret — rotates 90° on open (shared by the PR 2–4 expandable rows). */
    .caret { display: inline-block; transition: transform 0.12s ease; color: var(--text-dim); font-size: 9px; }
    .caret.open { transform: rotate(90deg); }

    /* Row hover wash (accent 5%). */
    .hover-wash:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
`;

/** Shared header HTML with nav links */
export function renderNav(
  activePage: "dashboard" | "traces" | "search" | "research" | "logs" | "mcp-debug" | "chat" | "summaries" | "serena" | "wiki" | "graph" | "benchmark" | "models" | "indexing" | "agents",
  options?: { headerLeftExtra?: string; headerRight?: string },
): string {
  return `
  <script>${themeInitScript()}</script>
  <script>
    if (!window.__fullscreenNav) {
      window.__fullscreenNav = true;

      // Toggle fullscreen with 'f' (skip when typing in inputs)
      document.addEventListener('keydown', function(e) {
        if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey &&
            !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) &&
            !e.target.isContentEditable) {
          if (document.fullscreenElement) {
            document.exitFullscreen();
            sessionStorage.removeItem('fs');
          } else {
            document.documentElement.requestFullscreen();
            sessionStorage.setItem('fs', '1');
          }
        }
      });

      // Track exit via Escape or browser UI
      document.addEventListener('fullscreenchange', function() {
        if (!document.fullscreenElement) sessionStorage.removeItem('fs');
      });

      // Re-enter fullscreen after navigation if it was active
      if (sessionStorage.getItem('fs')) {
        document.documentElement.requestFullscreen().catch(function() {});
      }
    }
  </script>
  <header>
    <div class="header-left">
      <h1><span>M</span>uninn</h1>
      <nav>
        <a href="/" class="nav-link${activePage === "dashboard" ? " active" : ""}">Dashboard</a>
        <a href="/agents" class="nav-link${activePage === "agents" ? " active" : ""}">Agents</a>
        <a href="/traces" class="nav-link${activePage === "traces" ? " active" : ""}">Traces</a>
        <a href="/logs" class="nav-link${activePage === "logs" ? " active" : ""}">Logs</a>
        <span class="nav-sep" aria-hidden="true"></span>
        <a href="/chat" class="nav-link${activePage === "chat" ? " active" : ""}">Chat</a>
        <a href="/research" class="nav-link${activePage === "research" ? " active" : ""}">Research</a>
        <a href="/search" class="nav-link${activePage === "search" ? " active" : ""}">Search</a>
        <a href="/summaries" class="nav-link${activePage === "summaries" ? " active" : ""}">Summaries</a>
        <a href="/wiki" class="nav-link${activePage === "wiki" ? " active" : ""}">Wiki</a>
        <a href="/graph" class="nav-link${activePage === "graph" ? " active" : ""}">Graph</a>
        <span class="nav-sep" aria-hidden="true"></span>
        <a href="/mcp-debug" class="nav-link${activePage === "mcp-debug" ? " active" : ""}">MCP Debug</a>
        <a href="/serena" class="nav-link${activePage === "serena" ? " active" : ""}">Serena</a>
        <a href="/benchmark" class="nav-link${activePage === "benchmark" ? " active" : ""}">Benchmark</a>
        <a href="/models" class="nav-link${activePage === "models" ? " active" : ""}">Models</a>
        <a href="/indexing" class="nav-link${activePage === "indexing" ? " active" : ""}">Indexing</a>
      </nav>
${options?.headerLeftExtra ?? ""}
    </div>
    <div class="header-right">
${options?.headerRight ?? ""}
      ${themeToggleHtml()}
    </div>
  </header>
  <script>${themeToggleScript()}</script>`;
}
