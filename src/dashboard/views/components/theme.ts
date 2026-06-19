/**
 * Shared light/dark/system theme controls — used by every page via `renderNav`
 * (dashboard + chat). Three modes:
 *
 *   - `system` (default) — no `data-theme` attribute on <html>; the
 *     `prefers-color-scheme` media queries in SHARED_STYLES / chatStyles govern.
 *     This is true OS-follow with zero JS and zero flash.
 *   - `light` / `dark` — an explicit user override; persisted in localStorage and
 *     applied as `<html data-theme="…">`, whose `html[data-theme=…]` selectors
 *     (specificity 0,1,1) outrank the media-query `:root` rules (0,1,0).
 *
 * The toggle cycles system → light → dark → system.
 */

const THEME_KEY = "muninn-theme";

/**
 * Early script — injected as the first thing inside <body> by `renderNav`, so it
 * runs before the browser paints any body content (an inline sync script blocks
 * rendering of what follows it). Only forces a theme when the user has an explicit
 * 'light'/'dark' preference; otherwise leaves `data-theme` unset so the
 * prefers-color-scheme media query governs (no flash for the system-follow default).
 */
export function themeInitScript(): string {
  return `
    (function() {
      try {
        var t = localStorage.getItem('${THEME_KEY}');
        if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
        else delete document.documentElement.dataset.theme;
      } catch (e) {}
    })();`;
}

/** Header toggle button (rendered on the right of the nav by `renderNav`). */
export function themeToggleHtml(): string {
  return `<button class="theme-toggle" id="themeToggle" title="Theme (t to cycle)" aria-label="Cycle theme: system, light, dark">◐</button>`;
}

/**
 * End-of-header script: cycles + persists the theme, keeps the button glyph in
 * sync, and binds the `t` shortcut. Guarded by `window.__themeToggle` so it only
 * wires once even if `renderNav` output is ever duplicated.
 */
export function themeToggleScript(): string {
  return `
  (function() {
    if (window.__themeToggle) return;
    window.__themeToggle = true;
    var KEY = '${THEME_KEY}';
    var root = document.documentElement;
    var ICONS = { system: '◐', light: '☀', dark: '☾' };
    var LABELS = { system: 'follow system', light: 'light', dark: 'dark' };
    function current() {
      try { var t = localStorage.getItem(KEY); return (t === 'light' || t === 'dark') ? t : 'system'; }
      catch (e) { return 'system'; }
    }
    function apply(mode) {
      if (mode === 'system') { delete root.dataset.theme; try { localStorage.removeItem(KEY); } catch (e) {} }
      else { root.dataset.theme = mode; try { localStorage.setItem(KEY, mode); } catch (e) {} }
      var btn = document.getElementById('themeToggle');
      if (btn) { btn.textContent = ICONS[mode]; btn.title = 'Theme: ' + LABELS[mode] + ' (t to cycle)'; }
    }
    function cycle() {
      var c = current();
      apply(c === 'system' ? 'light' : c === 'light' ? 'dark' : 'system');
    }
    apply(current()); // sync the button glyph on load
    var btn = document.getElementById('themeToggle');
    if (btn) btn.addEventListener('click', cycle);
    document.addEventListener('keydown', function(e) {
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey &&
          !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) &&
          !e.target.isContentEditable) {
        cycle();
      }
    });
  })();`;
}
