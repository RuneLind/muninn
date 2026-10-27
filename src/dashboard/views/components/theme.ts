/**
 * Shared theme controls — used by every page via `renderNav` (dashboard + chat).
 * The choices, in picker and `t`-cycle order:
 *
 *   - `system` (default) — no `data-theme` and no `data-palette` on <html>; the
 *     `prefers-color-scheme` media queries in SHARED_STYLES / chatStyles govern.
 *     True OS-follow with zero JS and zero flash.
 *   - `light` / `dark` — an explicit base; persisted in localStorage and applied
 *     as `<html data-theme="…">`, whose `html[data-theme=…]` selectors
 *     (specificity 0,1,1) outrank the media-query `:root` rules (0,1,0).
 *   - every palette in `palettes.ts` — a layer over a base: `data-theme` is set
 *     to the palette's base (so mermaid, wiki-visuals and every other "light or
 *     dark?" reader keep working unchanged) AND `data-palette` to its id, whose
 *     `html[data-palette=…]` block is emitted after the base blocks.
 *
 * The stored value under `muninn-theme` is the choice id: `light`, `dark` or a
 * palette id. Absent means system; an unknown value behaves like system but
 * stays stored — it may be a palette a newer build on the same origin wrote —
 * and only an explicit pick of System (menu or `t`) removes the key.
 */

import { PALETTES, paletteBaseMap } from "./palettes.ts";

export const THEME_KEY = "muninn-theme";

/** Every choice in picker / cycle order. */
export function themeChoices(): { id: string; label: string; glyph: string }[] {
  return [
    { id: "system", label: "System", glyph: "◐" },
    { id: "light", label: "Light", glyph: "☀" },
    { id: "dark", label: "Dark", glyph: "☾" },
    ...PALETTES.map((p) => ({ id: p.id, label: p.label, glyph: p.glyph })),
  ];
}

/** id → base for every explicit choice: the two bases map to themselves. */
export function themeBaseMap(): Record<string, "light" | "dark"> {
  return { light: "light", dark: "dark", ...paletteBaseMap() };
}

/**
 * Early script — injected as the first thing inside <body> by `renderNav`, so it
 * runs before the browser paints any body content (an inline sync script blocks
 * rendering of what follows it). Sets `data-theme` to the choice's base and,
 * for a palette, `data-palette` to its id; system and unknown values set
 * neither, so the prefers-color-scheme media query governs.
 */
export function themeInitScript(): string {
  return `
    (function() {
      try {
        var BASES = ${JSON.stringify(themeBaseMap())};
        var t = localStorage.getItem('${THEME_KEY}');
        if (!Object.prototype.hasOwnProperty.call(BASES, t)) {
          // One-time migration from the legacy chat-only key so an existing
          // explicit light/dark choice survives the move to the shared key.
          // Only when the shared key is absent: any stored value, even one this
          // build does not know, is a newer choice than the legacy key. Must
          // remove the legacy key either way, or picking 'system' (which clears
          // THEME_KEY) would resurrect it on the very next load.
          var legacy = localStorage.getItem('muninn-chat-theme');
          if (t === null && (legacy === 'light' || legacy === 'dark')) { t = legacy; localStorage.setItem('${THEME_KEY}', legacy); }
          localStorage.removeItem('muninn-chat-theme');
        }
        var root = document.documentElement;
        if (Object.prototype.hasOwnProperty.call(BASES, t)) root.dataset.theme = BASES[t];
        else delete root.dataset.theme;
        if (Object.prototype.hasOwnProperty.call(BASES, t) && t !== 'light' && t !== 'dark') root.dataset.palette = t;
        else delete root.dataset.palette;
      } catch (e) {}
    })();`;
}

/** Header picker: the ◐ button and its menu (rendered on the right of the nav). */
export function themeToggleHtml(): string {
  const items = themeChoices()
    .map(
      (c) =>
        `<button type="button" class="theme-menu-item" role="menuitemradio" aria-checked="false" data-theme-choice="${c.id}"><span class="theme-menu-glyph" aria-hidden="true">${c.glyph}</span>${c.label}</button>`,
    )
    .join("");
  return `<div class="theme-picker" id="themePicker"><button type="button" class="theme-toggle" id="themeToggle" title="Theme (t to cycle)" aria-label="Theme" aria-haspopup="menu" aria-expanded="false" aria-controls="themeMenu">◐</button><div class="theme-menu" id="themeMenu" role="menu" aria-label="Theme" hidden>${items}</div></div>`;
}

/**
 * End-of-header script: opens the menu, applies + persists a choice, keeps the
 * button glyph and title in sync, and binds the `t` shortcut (cycles the same
 * list in the same order). Guarded by `window.__themeToggle` so it only wires
 * once even if `renderNav` output is ever duplicated.
 */
export function themeToggleScript(): string {
  return `
  (function() {
    if (window.__themeToggle) return;
    window.__themeToggle = true;
    var KEY = '${THEME_KEY}';
    var CHOICES = ${JSON.stringify(themeChoices())};
    var BASES = ${JSON.stringify(themeBaseMap())};
    var root = document.documentElement;
    var btn = document.getElementById('themeToggle');
    var menu = document.getElementById('themeMenu');
    function byId(id) { for (var i = 0; i < CHOICES.length; i++) if (CHOICES[i].id === id) return CHOICES[i]; return null; }
    function current() {
      try { var t = localStorage.getItem(KEY); return (t !== 'system' && byId(t)) ? t : 'system'; }
      catch (e) { return 'system'; }
    }
    // persist: an explicit pick writes (or, for System, removes) the key. The
    // load-time sync does not, so an unknown value stays stored.
    function apply(id, persist) {
      if (!byId(id)) id = 'system';
      if (id === 'system') {
        delete root.dataset.theme; delete root.dataset.palette;
        if (persist) try { localStorage.removeItem(KEY); } catch (e) {}
      } else {
        root.dataset.theme = BASES[id];
        if (id === 'light' || id === 'dark') delete root.dataset.palette; else root.dataset.palette = id;
        if (persist) try { localStorage.setItem(KEY, id); } catch (e) {}
      }
      var c = byId(id);
      if (btn) {
        btn.textContent = c.glyph;
        btn.title = 'Theme: ' + (id === 'system' ? 'follow system' : c.label) + ' (t to cycle)';
        btn.setAttribute('aria-label', 'Theme: ' + c.label);
      }
      if (menu) menu.querySelectorAll('[data-theme-choice]').forEach(function(item) {
        item.setAttribute('aria-checked', item.getAttribute('data-theme-choice') === id ? 'true' : 'false');
      });
    }
    function cycle() {
      var c = current(), i = 0;
      for (var j = 0; j < CHOICES.length; j++) if (CHOICES[j].id === c) i = j;
      apply(CHOICES[(i + 1) % CHOICES.length].id, true);
    }
    function items() { return menu ? Array.prototype.slice.call(menu.querySelectorAll('[data-theme-choice]')) : []; }
    function isOpen() { return !!menu && !menu.hidden; }
    function openMenu() {
      if (!menu || !btn) return;
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      var list = items(), cur = current();
      var target = list.filter(function(it) { return it.getAttribute('data-theme-choice') === cur; })[0] || list[0];
      if (target) target.focus();
    }
    function closeMenu(refocus) {
      if (!menu || !btn || menu.hidden) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }
    apply(current(), false); // sync the button glyph on load
    // No stopPropagation on these clicks: the document-level closers (Tools ▾
    // and this menu's own) must see them, so opening one popover closes the other.
    if (btn) btn.addEventListener('click', function() {
      if (isOpen()) closeMenu(false); else openMenu();
    });
    if (btn) btn.addEventListener('keydown', function(e) {
      if (!isOpen() && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); openMenu(); }
    });
    if (menu) {
      menu.addEventListener('click', function(e) {
        var item = e.target.closest('[data-theme-choice]');
        if (!item) return;
        apply(item.getAttribute('data-theme-choice'), true);
        closeMenu(true);
      });
      // A press in the menu's padding or gap would move focus to <body>; keep it.
      menu.addEventListener('mousedown', function(e) {
        if (!e.target.closest('[data-theme-choice]')) e.preventDefault();
      });
    }
    // Menu keys while it is open. Window capture, so an Escape taken here
    // reaches no document-level handler. The menu owns the keys only when
    // focus is in the picker or on <body> (a stray click); elsewhere a key
    // belongs to the focused control, and Escape only closes the menu.
    window.addEventListener('keydown', function(e) {
      if (!isOpen()) return;
      var picker = document.getElementById('themePicker');
      var a = document.activeElement;
      var ours = !a || a === document.body || (!!picker && picker.contains(a));
      var list = items(), i = list.indexOf(a);
      if (e.key === 'Escape') {
        // A wiki peek card is opened over the menu, so it takes this Escape
        // (its own window-capture listener, registered later).
        if (document.querySelector('.wiki-ref-peek')) return;
        if (!ours) { closeMenu(false); return; }
        e.preventDefault(); e.stopPropagation(); closeMenu(true);
      }
      else if (!ours) return;
      else if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); list[i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
      // Tab from an item, or Shift+Tab from ◐, leaves the picker; Tab from ◐ enters the menu.
      else if (e.key === 'Tab' && (i >= 0 || (a === btn && e.shiftKey))) closeMenu(false);
    }, true);
    document.addEventListener('click', function(e) {
      var picker = document.getElementById('themePicker');
      if (isOpen() && picker && !picker.contains(e.target)) closeMenu(false);
    });
    document.addEventListener('keydown', function(e) {
      if (e.key === 't' && !e.ctrlKey && !e.metaKey && !e.altKey &&
          !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) &&
          !e.target.isContentEditable) {
        closeMenu(isOpen()); // an open menu closes, focus back on ◐
        cycle();
      }
    });
  })();`;
}
