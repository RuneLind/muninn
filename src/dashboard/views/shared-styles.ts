/** Shared CSS for all dashboard pages — base reset, header, and nav */
export const SHARED_STYLES = `
    :root {
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
      --chat-assistant-bg: #1a3a2a;
      --chat-assistant-text: #c8f5d8;
    }

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
`;

/** Shared header HTML with nav links */
export function renderNav(
  activePage: "dashboard" | "traces" | "search" | "knowledge" | "logs" | "mcp-debug" | "chat",
  options?: { headerLeftExtra?: string; headerRight?: string },
): string {
  return `
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
      <h1><span>J</span>arvis</h1>
      <nav>
        <a href="/" class="nav-link${activePage === "dashboard" ? " active" : ""}">Dashboard</a>
        <a href="/traces" class="nav-link${activePage === "traces" ? " active" : ""}">Traces</a>
        <a href="/search" class="nav-link${activePage === "search" ? " active" : ""}">Search</a>
        <a href="/knowledge" class="nav-link${activePage === "knowledge" ? " active" : ""}">Knowledge</a>
        <a href="/logs" class="nav-link${activePage === "logs" ? " active" : ""}">Logs</a>
        <a href="/mcp-debug" class="nav-link${activePage === "mcp-debug" ? " active" : ""}">MCP Debug</a>
        <a href="/simulator" class="nav-link${activePage === "chat" ? " active" : ""}">Chat</a>
      </nav>
${options?.headerLeftExtra ?? ""}
    </div>
${options?.headerRight ?? ""}
  </header>`;
}
