/** The `/summaries` doc panel's 🔎 Find links section: CSS (server-rendered,
 *  since the bundle tree-shakes anything its entry never references) and the
 *  standalone client bundle. */

import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const sumLinksClientScript = makeBundledClientScript("sum-links-browser.ts", import.meta.dir);

export function sumLinksStyles(): string {
  return `
    .sum-links {
      margin: 0 0 20px;
      padding: 12px 16px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-surface);
      font-size: 14px;
    }
    .sum-links[hidden] { display: none; }
    .sum-links-head { display: flex; align-items: center; gap: 8px; }
    .sum-links-title { font-weight: 600; color: var(--text-primary); }
    .sum-links-close {
      margin-left: auto; font: inherit; font-size: 16px; line-height: 1; cursor: pointer;
      background: none; border: none; color: var(--text-secondary);
    }
    .sum-links-note { margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
    .sum-links-list { list-style: none; margin: 8px 0 0; padding: 0; }
    .sum-links-row { padding: 4px 0; color: var(--text-primary); }
    .sum-links-row label { cursor: pointer; }
    .sum-links-state { font-size: 12px; color: var(--text-secondary); }
    .sum-links-results { list-style: none; margin: 4px 0 0 24px; padding: 0; }
    .sum-links-result { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; padding: 2px 0; }
    .sum-links-result a { color: var(--accent-light); overflow-wrap: anywhere; }
    .sum-links-detail { font-size: 12px; color: var(--text-secondary); }
    .sum-links-host { font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono, monospace); }
    .sum-links-label {
      font-size: 11px; padding: 0 7px; border-radius: 999px; white-space: nowrap;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-secondary);
    }
    .sum-links-actions { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .sum-links-btn {
      font: inherit; font-size: 12px; cursor: pointer; background: none; color: var(--text-secondary);
      border: 1px solid var(--border-secondary); border-radius: 6px; padding: 2px 10px;
    }
    .sum-links-btn:hover:not([disabled]) { border-color: var(--accent); color: var(--text-primary); }
    .sum-links-btn[disabled] { cursor: default; opacity: 0.6; }
    /* --accent-hover fill: white on dark --accent is 4.32:1 (the fact-check write-back precedent). */
    .sum-links-btn.primary { background: var(--accent-hover); border-color: var(--accent); color: #fff; }
    .sum-links-saved { font-size: 12px; font-weight: 600; color: color-mix(in srgb, var(--status-success) 70%, var(--text-primary)); }
    .sum-links-msg { margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
    .sum-links-msg.error { color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary)); }
  `;
}
