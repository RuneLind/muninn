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
`;

/** Shared header HTML with nav links */
export function renderNav(
  activePage: "dashboard" | "traces" | "search" | "research" | "logs" | "mcp-debug" | "chat" | "summaries" | "serena" | "wiki" | "graph" | "benchmark" | "models" | "agents",
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
        <a href="/chat" class="nav-link${activePage === "chat" ? " active" : ""}">Chat</a>
        <a href="/mcp-debug" class="nav-link${activePage === "mcp-debug" ? " active" : ""}">MCP Debug</a>
        <a href="/research" class="nav-link${activePage === "research" ? " active" : ""}">Research</a>
        <a href="/search" class="nav-link${activePage === "search" ? " active" : ""}">Search</a>
        <a href="/summaries" class="nav-link${activePage === "summaries" ? " active" : ""}">Summaries</a>
        <a href="/serena" class="nav-link${activePage === "serena" ? " active" : ""}">Serena</a>
        <a href="/wiki" class="nav-link${activePage === "wiki" ? " active" : ""}">Wiki</a>
        <a href="/graph" class="nav-link${activePage === "graph" ? " active" : ""}">Graph</a>
        <a href="/benchmark" class="nav-link${activePage === "benchmark" ? " active" : ""}">Benchmark</a>
        <a href="/models" class="nav-link${activePage === "models" ? " active" : ""}">Models</a>
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
