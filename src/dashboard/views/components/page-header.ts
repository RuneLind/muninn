/**
 * Page header (dashboard redesign, PR 1) — a shared title block that PRs 2–4
 * mount on `/agents`, `/models` and `/indexing`.
 *
 * Layout: page title + a circular "?" help toggle + a one-line meta summary.
 * Each page's current `.intro` paragraph moves BEHIND the "?" toggle into a
 * collapsible help panel (the migration of the paragraphs themselves happens in
 * the later per-page PRs — PR 1 only ships the component).
 *
 * The open/closed state of the help panel is persisted per page in
 * `localStorage["muninn-help-" + pageKey]` ("1" = open).
 *
 * Component pattern: `pageHeaderStyles()` / `pageHeaderHtml()` / `pageHeaderScript()`.
 */

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

export interface PageHeaderOptions {
  /** Page title (plain text — escaped). */
  title: string;
  /** One-line meta summary to the right of the title. Trusted HTML (server-rendered). */
  metaHtml?: string;
  /** Help-panel body, revealed by the "?" toggle. Trusted HTML (server-rendered). */
  helpHtml?: string;
}

/** CSS for the page header. Injected by pages that render a `pageHeaderHtml`. */
export function pageHeaderStyles(): string {
  return `
    .pghdr { margin: 0 0 4px; }
    .pghdr-titlerow { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .pghdr-title { font-size: 18px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .pghdr-help-btn {
      width: 18px; height: 18px; border-radius: 50%;
      border: 1px solid var(--border-secondary); background: transparent;
      color: var(--text-muted); font-size: 11px; line-height: 1; cursor: pointer;
      padding: 0; font-family: inherit; flex-shrink: 0; align-self: center;
      transition: color 0.15s, border-color 0.15s;
    }
    .pghdr-help-btn:hover { color: var(--text-primary); border-color: var(--text-muted); }
    .pghdr-help-btn[aria-expanded="true"] { color: var(--accent-light); border-color: var(--accent); }
    .pghdr-meta { font-size: 12px; color: var(--text-dim); }
    .pghdr-help {
      background: var(--bg-panel); border: 1px solid var(--border-primary);
      border-radius: 10px; padding: 12px 16px; margin: 10px 0 4px;
      font-size: 13px; line-height: 1.55; color: var(--text-soft); max-width: 860px;
    }
    .pghdr-help[hidden] { display: none; }
  `;
}

/** Header markup. The help panel + toggle only render when `helpHtml` is given. */
export function pageHeaderHtml(opts: PageHeaderOptions): string {
  const meta = opts.metaHtml ? `<div class="pghdr-meta">${opts.metaHtml}</div>` : "";
  const toggle = opts.helpHtml
    ? `<button type="button" class="pghdr-help-btn" aria-expanded="false" aria-controls="pghdrHelp" aria-label="What is this page?" title="What is this page?">?</button>`
    : "";
  const help = opts.helpHtml ? `<div class="pghdr-help" id="pghdrHelp" hidden>${opts.helpHtml}</div>` : "";
  return `
    <div class="pghdr">
      <div class="pghdr-titlerow">
        <h1 class="pghdr-title">${escapeHtml(opts.title)}</h1>
        ${toggle}
        ${meta}
      </div>
      ${help}
    </div>`;
}

/**
 * Client script for the help toggle. `pageKey` scopes the persisted open state
 * to this page (`localStorage["muninn-help-<pageKey>"]`).
 *
 * The click handler is DELEGATED off `document` so it survives a page re-render
 * that replaces the header subtree, and the whole IIFE is guarded by
 * `window.__pageHeader` so double-injection is a no-op. The "?" is a real
 * `<button>`, so Enter/Space
 * are handled natively (no separate keydown handler — that would double-fire the
 * toggle on a button).
 */
export function pageHeaderScript(pageKey: string): string {
  const storageKey = JSON.stringify("muninn-help-" + pageKey);
  return `
    if (!window.__pageHeader) {
      window.__pageHeader = true;
      (function(){
        var STORAGE_KEY = ${storageKey};
        function setOpen(open){
          var panel = document.getElementById('pghdrHelp');
          var btn = document.querySelector('.pghdr-help-btn');
          if (!panel || !btn) return;
          panel.hidden = !open;
          btn.setAttribute('aria-expanded', open ? 'true' : 'false');
          try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0'); } catch(e){}
        }
        function toggle(){
          var panel = document.getElementById('pghdrHelp');
          if (panel) setOpen(panel.hidden);
        }
        document.addEventListener('click', function(e){
          var t = e.target;
          if (t && t.closest && t.closest('.pghdr-help-btn')) { e.preventDefault(); toggle(); }
        });
        function restore(){
          try { if (localStorage.getItem(STORAGE_KEY) === '1') setOpen(true); } catch(e){}
        }
        // Order-insensitive: if the panel isn't in the DOM yet (script injected
        // before the header markup), defer the restore until the document parses.
        if (document.getElementById('pghdrHelp')) {
          restore();
        } else if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', restore);
        } else {
          restore();
        }
      })();
    }
  `;
}
