/** The `/summaries` doc panel's Fact check section + Latest rail badge: CSS
 *  (server-rendered, since the bundle tree-shakes anything the browser entry
 *  never references) and the standalone client bundle. */

import { makeBundledClientScript } from "./bundle-browser-iife.ts";
import { FACTCHECK_CONF_CHIP_CSS } from "./factcheck-conf-chip-styles.ts";

export const sumFactcheckClientScript = makeBundledClientScript("sum-factcheck-browser.ts", import.meta.dir);

export function sumFactcheckStyles(): string {
  return `
    .sum-fc {
      margin: 0 0 20px;
      padding: 12px 16px;
      border: 1px solid var(--border-primary);
      border-radius: 8px;
      background: var(--bg-surface);
      font-size: 14px;
    }
    .sum-fc[hidden] { display: none; }
    /* The chrome opts out of selection; the answer and its sources stay
       selectable, since quoting a verdict or copying a source is the point. */
    .sum-fc-head, .sum-fc-progress, .sum-fc-wait, .sum-fc-err { user-select: none; }
    .sum-fc-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .sum-fc-title { font-weight: 600; color: var(--text-primary); }
    .sum-fc-chips { display: inline-flex; gap: 6px; }
    .sum-fc-chip {
      font-size: 12px; padding: 1px 8px; border-radius: 999px;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-secondary); white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .sum-fc-meta { font-size: 12px; color: var(--text-secondary); }
    .sum-fc-stale {
      font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 999px;
      /* Darkened toward --text-primary: plain --status-warning on its own
         tint measured 2.48:1 in the light theme. */
      color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary));
      border: 1px solid color-mix(in srgb, var(--status-warning) 45%, transparent);
      background: color-mix(in srgb, var(--status-warning) 14%, transparent);
    }
    .sum-fc-recheck {
      margin-left: auto; font: inherit; font-size: 12px; cursor: pointer;
      background: none; color: var(--text-secondary);
      border: 1px solid var(--border-secondary); border-radius: 6px; padding: 2px 10px;
    }
    .sum-fc-recheck:hover:not([disabled]), .sum-fc-txbtn:hover:not([disabled]) { border-color: var(--accent); color: var(--text-primary); }
    .sum-fc-txbtn {
      font: inherit; font-size: 12px; cursor: pointer; background: none; color: var(--text-secondary);
      border: 1px solid var(--border-secondary); border-radius: 6px; padding: 2px 10px;
    }
    .sum-fc-recheck[disabled], .sum-fc-txbtn[disabled] { cursor: default; opacity: 0.7; }
    .sum-fc-progress { list-style: none; margin: 10px 0 0; padding: 0; }
    .sum-fc-progress li { display: flex; gap: 8px; padding: 2px 0; color: var(--text-secondary); }
    .sum-fc-progress li.pending { color: var(--text-muted); }
    .sum-fc-wait, .sum-fc-lede { margin-top: 10px; color: var(--text-muted); font-size: 13px; }
    .sum-fc-err { margin-top: 10px; color: var(--status-error); font-size: 13px; }
    .sum-fc-answer { margin-top: 10px; color: var(--text-secondary); line-height: 1.6; white-space: pre-wrap; }
    .sum-fc-answer h4 { margin: 14px 0 4px; font-size: 14px; color: var(--text-primary); white-space: normal; }
    .sum-fc-answer a { color: var(--accent-light); }
    /* The transcript check (server-rendered by sum-transcript-render.ts). */
    .sum-fc-tx { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-secondary); }
    .sum-fc-tx-head { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .sum-fc-tx-cut { margin-top: 4px; font-size: 12px; color: var(--text-secondary); }
    .sum-fc-tx-list { list-style: none; margin: 6px 0 0; padding: 0; }
    .sum-fc-tx-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; padding: 3px 0; color: var(--text-secondary); }
    .sum-fc-tchip {
      font-size: 11px; padding: 0 7px; border-radius: 999px; white-space: nowrap;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-secondary);
    }
    .sum-fc-tchip[data-tverdict="supported"] {
      color: color-mix(in srgb, var(--status-success) 60%, var(--text-primary));
      border-color: color-mix(in srgb, var(--status-success) 45%, transparent);
    }
    .sum-fc-tchip[data-tverdict="contradicts transcript"] {
      color: color-mix(in srgb, var(--status-error) 60%, var(--text-primary));
      border-color: color-mix(in srgb, var(--status-error) 45%, transparent);
    }
    .sum-fc-tchip[data-tverdict="not in transcript"] {
      color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary));
      border-color: color-mix(in srgb, var(--status-warning) 45%, transparent);
    }
    .sum-fc-tx-read { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .sum-fc-tx-note { flex-basis: 100%; padding-left: 24px; font-size: 12px; color: var(--text-secondary); }
    /* ➕ Add / ✎ Integrate (sum-factcheck-writeback-client.ts). */
    .sum-fc-wb { margin-top: 12px; }
    .sum-fc-int-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
    .sum-fc-wb-btn {
      font: inherit; font-size: 12px; cursor: pointer; background: none; color: var(--text-secondary);
      border: 1px solid var(--border-secondary); border-radius: 6px; padding: 3px 10px;
    }
    .sum-fc-wb-btn:hover { border-color: var(--accent); color: var(--text-primary); }
    .sum-fc-wb-btn:disabled { opacity: 0.55; cursor: default; }
    .sum-fc-wb-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .sum-fc-wb-done { font-size: 12px; font-weight: 600; color: color-mix(in srgb, var(--status-success) 70%, var(--text-primary)); }
    .sum-fc-wb-msg { margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
    .sum-fc-wb-msg.error { color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary)); }
    .sum-fc-int { margin-top: 4px; padding: 10px 12px; border: 1px solid var(--border-secondary); border-radius: 8px; background: var(--bg-card); white-space: normal; }
    .sum-fc-int-head { font-weight: 600; color: var(--text-primary); font-size: 13px; }
    .sum-fc-int-note { font-size: 12px; color: var(--text-secondary); margin-top: 4px; }
    .sum-fc-int-edit { border-top: 1px solid var(--border-secondary); padding: 8px 0; margin-top: 8px; }
    .sum-fc-int-row { display: flex; align-items: baseline; gap: 8px; cursor: pointer; flex-wrap: wrap; color: var(--text-primary); font-size: 13px; }
    .sum-fc-int-reason { font-size: 12px; color: var(--text-secondary); margin: 2px 0 0 24px; }
    .sum-fc-int-ctx { font-size: 12px; color: var(--text-muted); margin: 4px 0; }
    .sum-fc-int-diff { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin: 4px 0; }
    .sum-fc-int-diff .d-add { display: block; white-space: pre-wrap; color: color-mix(in srgb, var(--status-success) 65%, var(--text-primary)); background: color-mix(in srgb, var(--status-success) 12%, transparent); }
    .sum-fc-int-diff .d-del { display: block; white-space: pre-wrap; color: color-mix(in srgb, var(--status-error) 65%, var(--text-primary)); background: color-mix(in srgb, var(--status-error) 12%, transparent); }
    .sum-fc-int-diff .d-ctx { display: block; white-space: pre-wrap; color: var(--text-muted); }
    .sum-fc-int-dropped { margin-top: 8px; font-size: 12px; color: var(--text-muted); }
    .sum-fc-int-dropped summary { cursor: pointer; }
    .sum-fc-int-drop { display: flex; gap: 8px; padding: 2px 0; }
    .sum-fc-int-drop-reason { flex-shrink: 0; color: color-mix(in srgb, var(--status-warning) 55%, var(--text-primary)); }
    .sum-fc-int-drop-quote { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
${FACTCHECK_CONF_CHIP_CSS}
    /* The Latest rail badge. */
    .sum-fc-badge { flex-shrink: 0; font-size: 10px; font-weight: 600; }
    .sum-fc-badge.ok { color: color-mix(in srgb, var(--status-success) 70%, var(--text-primary)); }
    .sum-fc-badge.bad { color: color-mix(in srgb, var(--status-error) 70%, var(--text-primary)); }
  `;
}
