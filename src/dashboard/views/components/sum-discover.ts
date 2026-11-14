/** The `/summaries` doc panel's ▶ Find on YouTube section: CSS (server-rendered)
 *  and the standalone client bundle (the `sum-links.ts` shape). */

import { makeBundledClientScript } from "./bundle-browser-iife.ts";

export const sumDiscoverClientScript = makeBundledClientScript("sum-discover-browser.ts", import.meta.dir);

export function sumDiscoverStyles(): string {
  return `
    .sum-discover {
      margin: 0 0 20px;
      padding: 12px 16px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-surface);
      font-size: 14px;
    }
    .sum-discover[hidden] { display: none; }
    .sum-discover-head { display: flex; align-items: center; gap: 8px; }
    .sum-discover-heading { font-weight: 600; color: var(--text-primary); }
    .sum-discover-close {
      margin-left: auto; font: inherit; font-size: 16px; line-height: 1; cursor: pointer;
      background: none; border: none; color: var(--text-secondary);
    }
    .sum-discover-note { margin-top: 8px; font-size: 13px; color: var(--text-secondary); overflow-wrap: anywhere; }
    .sum-discover-list { list-style: none; margin: 8px 0 0; padding: 0; }
    .sum-discover-row { padding: 6px 0; border-top: 1px solid var(--border-primary); }
    .sum-discover-row:first-child { border-top: none; }
    .sum-discover-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
    .sum-discover-title { color: var(--accent-light); overflow-wrap: anywhere; }
    .sum-discover-meta, .sum-discover-why { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
    .sum-discover-btn {
      font: inherit; font-size: 12px; cursor: pointer; background: none; color: var(--text-secondary);
      border: 1px solid var(--border-secondary); border-radius: 6px; padding: 2px 10px;
    }
    .sum-discover-btn:hover:not([disabled]) { border-color: var(--accent); color: var(--text-primary); }
    .sum-discover-btn[disabled] { cursor: default; opacity: 0.6; }
    .sum-discover-status { font-size: 12px; font-weight: 600; color: color-mix(in srgb, var(--status-success) 70%, var(--text-primary)); }
    .sum-discover-status.error, .sum-discover-msg.error { color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary)); }
    .sum-discover-status a { color: var(--accent-light); font-weight: 400; }
    .sum-discover-msg { margin-top: 8px; font-size: 13px; }
  `;
}
