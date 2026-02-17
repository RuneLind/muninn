/** Shared CSS for all dashboard pages — base reset, header, and nav */
export const SHARED_STYLES = `
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: #0a0a0f;
      color: #e0e0e0;
      min-height: 100vh;
    }

    /* Header */
    header {
      background: #12121a;
      border-bottom: 1px solid #1e1e2e;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { font-size: 20px; font-weight: 600; color: #fff; }
    header h1 span { color: #6c63ff; }
    .header-left { display: flex; align-items: center; gap: 16px; }
    .nav-link { color: #888; text-decoration: none; font-size: 13px; padding: 4px 10px; border-radius: 6px; transition: all 0.2s; }
    .nav-link:hover { color: #a5a0ff; background: rgba(108, 99, 255, 0.1); }
    .nav-link.active { color: #6c63ff; background: rgba(108, 99, 255, 0.15); }
`;

/** Shared header HTML with nav links */
export function renderNav(
  activePage: "dashboard" | "traces" | "search" | "knowledge" | "simulator",
  options?: { showSimulator?: boolean; headerLeftExtra?: string; headerRight?: string },
): string {
  const simulatorLink = options?.showSimulator
    ? `\n        <a href="/simulator" class="nav-link${activePage === "simulator" ? " active" : ""}">Simulator</a>`
    : "";
  return `
  <header>
    <div class="header-left">
      <h1><span>J</span>arvis</h1>
      <nav>
        <a href="/" class="nav-link${activePage === "dashboard" ? " active" : ""}">Dashboard</a>
        <a href="/traces" class="nav-link${activePage === "traces" ? " active" : ""}">Traces</a>
        <a href="/search" class="nav-link${activePage === "search" ? " active" : ""}">Search</a>
        <a href="/knowledge" class="nav-link${activePage === "knowledge" ? " active" : ""}">Knowledge</a>${simulatorLink}
      </nav>
${options?.headerLeftExtra ?? ""}
    </div>
${options?.headerRight ?? ""}
  </header>`;
}
