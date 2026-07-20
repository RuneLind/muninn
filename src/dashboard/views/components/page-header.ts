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
    .page-header { margin: 0 0 4px; }
    .ph-titlerow { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .ph-title { font-size: 18px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .ph-help-btn {
      width: 18px; height: 18px; border-radius: 50%;
      border: 1px solid var(--border-secondary); background: transparent;
      color: var(--text-muted); font-size: 11px; line-height: 1; cursor: pointer;
      padding: 0; font-family: inherit; flex-shrink: 0; align-self: center;
      transition: color 0.15s, border-color 0.15s;
    }
    .ph-help-btn:hover { color: var(--text-primary); border-color: var(--text-muted); }
    .ph-help-btn[aria-expanded="true"] { color: var(--accent-light); border-color: var(--accent); }
    .ph-meta { font-size: 12px; color: var(--text-dim); }
    .ph-help {
      background: var(--bg-panel); border: 1px solid var(--border-primary);
      border-radius: 10px; padding: 12px 16px; margin: 10px 0 4px;
      font-size: 13px; line-height: 1.55; color: var(--text-soft); max-width: 860px;
    }
    .ph-help[hidden] { display: none; }
  `;
}

/** Header markup. The help panel + toggle only render when `helpHtml` is given. */
export function pageHeaderHtml(opts: PageHeaderOptions): string {
  const meta = opts.metaHtml ? `<div class="ph-meta">${opts.metaHtml}</div>` : "";
  const toggle = opts.helpHtml
    ? `<button type="button" class="ph-help-btn" aria-expanded="false" aria-controls="phHelp" aria-label="What is this page?" title="What is this page?">?</button>`
    : "";
  const help = opts.helpHtml ? `<div class="ph-help" id="phHelp" hidden>${opts.helpHtml}</div>` : "";
  return `
    <div class="page-header">
      <div class="ph-titlerow">
        <h1 class="ph-title">${escapeHtml(opts.title)}</h1>
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
 * that replaces the header subtree. The "?" is a real `<button>`, so Enter/Space
 * are handled natively (no separate keydown handler — that would double-fire the
 * toggle on a button).
 */
export function pageHeaderScript(pageKey: string): string {
  const storageKey = JSON.stringify("muninn-help-" + pageKey);
  return `
    (function(){
      var STORAGE_KEY = ${storageKey};
      function setOpen(open){
        var panel = document.getElementById('phHelp');
        var btn = document.querySelector('.ph-help-btn');
        if (!panel || !btn) return;
        panel.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        try { localStorage.setItem(STORAGE_KEY, open ? '1' : '0'); } catch(e){}
      }
      function toggle(){
        var panel = document.getElementById('phHelp');
        if (panel) setOpen(panel.hidden);
      }
      document.addEventListener('click', function(e){
        var t = e.target;
        if (t && t.closest && t.closest('.ph-help-btn')) { e.preventDefault(); toggle(); }
      });
      try { if (localStorage.getItem(STORAGE_KEY) === '1') setOpen(true); } catch(e){}
    })();
  `;
}
