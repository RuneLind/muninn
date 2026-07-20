/**
 * Status chips (dashboard redesign, PR 1) — the one unified chip vocabulary for
 * `/agents`, `/models` and `/indexing`, replacing the per-page badge zoos.
 *
 * Four families, all sharing the 9px chip geometry (see `.dchip` / `.kind-chip`
 * / `.run-status` in SHARED_STYLES):
 *   - attention (STALE)         — shown ONLY when something is wrong
 *   - origin / routing          — the FULL 11-value {@link Origin} union
 *   - job-kind (WATCHER/TASK/…) — fixed 68px, centered
 *   - run-status               — 7px dot + lowercase text (not a pill)
 *
 * The CSS lives centrally in `shared-styles.ts`, so `statusChipsStyles()` returns
 * "" (kept for the three-export convention). Pages render chips either server-side
 * via the pure helpers below, or client-side via the globals installed by
 * `statusChipsScript()`.
 *
 * The `ORIGIN_CHIP_CLASS` record is typed `Record<Origin, string>` so the
 * compiler enforces that every origin the runtime can emit has a chip class —
 * this is the "chip class map, exported once" that `/models` migrates onto in a
 * later PR (dropping its local `.chip-*` definitions).
 */

import type { Origin } from "../../models-overview.ts";

/** Origin → chip modifier class. Exhaustive over the 11-value Origin union. */
export const ORIGIN_CHIP_CLASS: Record<Origin, string> = {
  config: "dchip-config",
  pinned: "dchip-pinned",
  override: "dchip-override",
  owner: "dchip-owner",
  env: "dchip-env",
  derived: "dchip-derived",
  default: "dchip-default",
  fallback: "dchip-fallback",
  legacy: "dchip-legacy",
  fixed: "dchip-fixed",
  none: "dchip-none",
};

/** AgentKind chip label → chip modifier class. Unknown kinds fall back to task. */
export const KIND_CHIP_CLASS: Record<string, string> = {
  WATCHER: "kind-watcher",
  TASK: "kind-task",
  CAPTURE: "kind-capture",
  DIGEST: "kind-digest",
};

/** Run-status → run-status modifier class + whether it tints the text. */
export type RunStatusTone = "success" | "warning" | "error";

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

/** Server-side origin chip (e.g. `<span class="dchip dchip-config">config</span>`). */
export function originChipHtml(origin: Origin): string {
  return `<span class="dchip ${ORIGIN_CHIP_CLASS[origin]}">${origin}</span>`;
}

/** Server-side attention chip (default label STALE). */
export function attentionChipHtml(label = "STALE"): string {
  return `<span class="dchip dchip-attn">${escapeHtml(label)}</span>`;
}

/** Server-side job-kind chip (fixed 68px). `kind` is the uppercase label. */
export function kindChipHtml(kind: string): string {
  const upper = String(kind).toUpperCase();
  const cls = KIND_CHIP_CLASS[upper] ?? "kind-task";
  return `<span class="kind-chip ${cls}">${escapeHtml(upper)}</span>`;
}

/** Server-side run-status (7px dot + lowercase text). */
export function runStatusHtml(tone: RunStatusTone | undefined, text: string): string {
  const cls = tone ? `run-${tone}` : "";
  return `<span class="run-status ${cls}"><span class="run-dot"></span>${escapeHtml(text)}</span>`;
}

/** Styles live centrally in SHARED_STYLES (shared-styles.ts). */
export function statusChipsStyles(): string {
  return "";
}

/**
 * Installs the client-side chip builders — hand-mirrors of the server helpers
 * above (they live in a template literal and cannot import). Globals:
 *   - `originChip(origin)` — origin lowercased, rendered uppercase via CSS
 *   - `attentionChip(label)` — default "STALE"
 *   - `kindChip(kind)` — uppercased, fixed 68px
 *   - `runStatusChip(status, text)` — success|succeeded / warning|stale / error|failed
 */
export function statusChipsScript(): string {
  return `
    if (!window.__statusChips) {
      window.__statusChips = true;
      var _e = window.esc || function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
      var KIND = { WATCHER:'kind-watcher', TASK:'kind-task', CAPTURE:'kind-capture', DIGEST:'kind-digest' };
      window.originChip = function(origin){
        var o = String(origin || '').toLowerCase();
        return '<span class="dchip dchip-' + _e(o) + '">' + _e(o) + '</span>';
      };
      window.attentionChip = function(label){
        return '<span class="dchip dchip-attn">' + _e(label || 'STALE') + '</span>';
      };
      window.kindChip = function(kind){
        var k = String(kind || '').toUpperCase();
        return '<span class="kind-chip ' + (KIND[k] || 'kind-task') + '">' + _e(k) + '</span>';
      };
      window.runStatusChip = function(status, text){
        var s = String(status || '').toLowerCase();
        var cls = (s === 'success' || s === 'succeeded') ? 'run-success'
                : (s === 'warning' || s === 'stale') ? 'run-warning'
                : (s === 'error' || s === 'failed') ? 'run-error' : '';
        return '<span class="run-status ' + cls + '"><span class="run-dot"></span>' + _e(text) + '</span>';
      };
    }
  `;
}
