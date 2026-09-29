/**
 * The doc panel header's dropdown menus — `↻ Re-run ▾` and `⋯ More` — wired
 * by ONE function, so the two behave alike and never stay open together.
 *
 * Each had its own copy of the wiring, and the copies drifted: the Re-run
 * button stopped its click from propagating, so ⋯ More's click-away never saw
 * it, and neither open closed the other — both popups stayed up, overlapping,
 * and took two Escapes. Only ⋯ More kept its popup inside the viewport, so
 * Re-run opened off-screen left on a phone.
 *
 * `docPanelMenu(cfg)` wires one menu (button click, click-away, the arrow,
 * Home, End and Tab keys, the viewport shift) and returns its controller;
 * opening a menu closes every other one. Escape stays with the panel's own
 * keydown listener, which calls `closeDocPanelMenus(true)` before it closes
 * the panel. Injected once, at the top of the summaries library script.
 */
export function docPanelMenuScript(): string {
  return `
    // --- Header dropdown menus: one wiring (doc-panel-menu.ts) ---
    var _docPanelMenus = [];

    /** cfg: { btnId, popId, onOpen(menu) }. onOpen fills and focuses the
     *  popup; without it the first item takes focus. */
    function docPanelMenu(cfg) {
      var menu = {
        btn: function() { return document.getElementById(cfg.btnId); },
        pop: function() { return document.getElementById(cfg.popId); },
        isOpen: function() { var p = menu.pop(); return !!p && !p.hidden; },
        /** Every visible, enabled item, in DOM order: what the keys walk. */
        items: function() {
          var p = menu.pop();
          if (!p) return [];
          return Array.prototype.filter.call(p.querySelectorAll('.doc-panel-menu-item'), function(el) {
            return !el.hidden && !el.disabled;
          });
        },
        /** delta 0 focuses the first item; ±1 steps and wraps. */
        focusItem: function(delta) {
          var items = menu.items();
          if (!items.length) return;
          var at = items.indexOf(document.activeElement);
          items[at === -1 ? 0 : (at + delta + items.length) % items.length].focus();
        },
        /** The popup hangs from its button's right edge; on a narrow screen
         *  the wrapped header can put that edge anywhere, so shift it back
         *  inside. */
        place: function() {
          var p = menu.pop();
          if (!p || p.hidden) return;
          p.style.transform = '';
          var r = p.getBoundingClientRect();
          var margin = 8;
          var dx = 0;
          if (r.left < margin) dx = margin - r.left;
          else if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
          if (dx) p.style.transform = 'translateX(' + Math.round(dx) + 'px)';
        },
        open: function() {
          var p = menu.pop();
          if (!p) return;
          _docPanelMenus.forEach(function(m) { if (m !== menu) m.close(false); });
          p.hidden = false;
          var b = menu.btn();
          if (b) b.setAttribute('aria-expanded', 'true');
          menu.place();
          if (cfg.onOpen) cfg.onOpen(menu); else menu.focusItem(0);
        },
        /** True when it was open. restoreFocus puts focus on the button (an
         *  Escape, an item used); a click elsewhere keeps the focus it made. */
        close: function(restoreFocus) {
          var p = menu.pop();
          var b = menu.btn();
          if (b) b.setAttribute('aria-expanded', 'false');
          if (!p || p.hidden) return false;
          p.hidden = true;
          if (restoreFocus && b) b.focus();
          return true;
        },
      };
      _docPanelMenus.push(menu);
      var btn = menu.btn();
      var pop = menu.pop();
      if (btn) btn.addEventListener('click', function(e) {
        // Kept from the Re-run button: the page's other document-level click
        // listeners (the share dialog's click-away) never see this click.
        // The other menu is closed by open(), not by its click-away.
        e.stopPropagation();
        if (menu.isOpen()) menu.close(true); else menu.open();
      });
      document.addEventListener('click', function(e) {
        if (!menu.isOpen()) return;
        var p = menu.pop();
        var b = menu.btn();
        if (p.contains(e.target) || (b && b.contains(e.target))) return;
        menu.close(false);
      });
      if (pop) pop.addEventListener('keydown', function(e) {
        var items;
        if (e.key === 'ArrowDown') { e.preventDefault(); menu.focusItem(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); menu.focusItem(-1); }
        else if (e.key === 'Home') { e.preventDefault(); items = menu.items(); if (items.length) items[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); items = menu.items(); if (items.length) items[items.length - 1].focus(); }
        else if (e.key === 'Tab') menu.close(false);
      });
      return menu;
    }

    function docPanelMenuOpen() {
      return _docPanelMenus.some(function(m) { return m.isOpen(); });
    }

    /** Closes whichever menu is open; true when one was. */
    function closeDocPanelMenus(restoreFocus) {
      var any = false;
      _docPanelMenus.forEach(function(m) { if (m.close(restoreFocus)) any = true; });
      return any;
    }
  `;
}
