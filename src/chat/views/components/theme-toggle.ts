/**
 * Chat-only light/dark theme toggle.
 *
 * Light mode is scoped to the chat page (the dashboard stays dark — see the
 * `[data-theme="light"]` block in chat-styles.ts). The chosen theme is persisted
 * under a chat-specific localStorage key, so it never leaks onto other pages.
 *
 * - `themeInitScript()` runs in <head> before paint to set data-theme from storage
 *   (avoids a dark→light flash for users who saved light). Default: dark.
 * - `themeToggleHtml()` is the header button (passed to renderNav via headerRight).
 * - `themeToggleScript()` wires the button + the `t` keyboard shortcut at end of body.
 */

const THEME_KEY = "muninn-chat-theme";

/** Early <head> script: applies the saved theme before first paint. */
export function themeInitScript(): string {
  return `
  <script>
    (function() {
      try {
        var t = localStorage.getItem('${THEME_KEY}');
        document.documentElement.dataset.theme = (t === 'light') ? 'light' : 'dark';
      } catch (e) {
        document.documentElement.dataset.theme = 'dark';
      }
    })();
  </script>`;
}

/** Header toggle button. */
export function themeToggleHtml(): string {
  return `<button class="theme-toggle" id="themeToggle" title="Toggle light / dark (t)" aria-label="Toggle light or dark theme">◐</button>`;
}

/** End-of-body script: click + `t` key flip the theme and persist it. */
export function themeToggleScript(): string {
  return `
  (function() {
    var root = document.documentElement;
    function setTheme(theme) {
      root.dataset.theme = theme;
      try { localStorage.setItem('${THEME_KEY}', theme); } catch (e) {}
    }
    function toggleTheme() {
      setTheme(root.dataset.theme === 'light' ? 'dark' : 'light');
    }
    var btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', toggleTheme);
    // 't' shortcut — skip when typing in a field
    document.addEventListener('keydown', function(e) {
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey &&
          !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) &&
          !e.target.isContentEditable) {
        toggleTheme();
      }
    });
  })();`;
}
