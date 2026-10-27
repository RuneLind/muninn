/**
 * The reader's STALE tab (plan muninn-wiki-drift-check, PR 2a): what a page
 * change may have made untrue, from `GET /api/wiki/stale?page=`. Pure and
 * DOM-free so a test can load it (`wiki-browser.ts` touches `document` at
 * import time); `wiki-browser.ts` fetches, renders this and wires the buttons.
 *
 * - The count (D26): confirmed stale status lines on the page, and its
 *   linking pages to check.
 * - Status lines: CONFIRMED stale hits only (D11) — an unconfirmed hit lives
 *   in the linter until the confirm loop has read it.
 * - Linking pages: the five buckets, To check open, each page's verdict when
 *   Check has one; the others folded.
 * - Draft fix shows the model's edit read-only (D8: update the text, or point
 *   to the home); Apply and Send to Gardener are PR 3.
 */
import { escHtml as esc } from "./escape.ts";

export interface StaleVerdictView {
  verdict: "stale" | "unsure" | "true" | "not-status" | "fixed";
  reason?: string;
  edit?: { old: string; new: string; home?: string } | null;
  checkedBy?: string;
}

export interface StaleHitView {
  line: number;
  target: string;
  said: string[];
  now: string;
  text: string;
  confirmation?: StaleVerdictView | "unconfirmed";
}

export interface StaleLinkingView {
  relPath: string;
  title: string;
  type?: string;
  bucket: "toCheck" | "mentions" | "pointers" | "history" | "changedSince";
  lastChangeMs?: number;
  passages: { line: number; text: string; claim?: string }[];
  verdict?: StaleVerdictView;
}

export interface StaleReportView {
  page?: { relPath: string; title: string };
  changed?: boolean;
  hits?: StaleHitView[];
  staleLines?: number;
  buckets?: { counts: Record<string, number>; linking: StaleLinkingView[] } | null;
  verdicts?: "unavailable";
  readonly?: "instance" | "root" | false;
  error?: string;
}

/** The two numbers (D26): confirmed stale status lines, linking pages to check. */
export function staleCounts(r: StaleReportView | null | undefined): { staleLines: number; toCheck: number } {
  if (!r || r.error) return { staleLines: 0, toCheck: 0 };
  const staleLines = confirmedHits(r).length;
  return { staleLines, toCheck: r.buckets?.counts?.toCheck ?? 0 };
}

/** The hits a reader sees: confirmed stale only (D11). */
export function confirmedHits(r: StaleReportView): StaleHitView[] {
  return (r.hits ?? []).filter((h) => h.confirmation !== undefined && h.confirmation !== "unconfirmed" && h.confirmation.verdict === "stale");
}

/** The tab's count badge: «N · M», or "" when both are 0. */
export function staleTabBadge(r: StaleReportView | null | undefined): { text: string; title: string } {
  const { staleLines, toCheck } = staleCounts(r);
  if (!staleLines && !toCheck) return { text: "", title: "Nothing stale" };
  return {
    text: `${staleLines} · ${toCheck}`,
    title: `${staleLines} stale status line${staleLines === 1 ? "" : "s"} · ${toCheck} linking page${toCheck === 1 ? "" : "s"} to check`,
  };
}

const BUCKET_LABEL: Record<StaleLinkingView["bucket"], string> = {
  toCheck: "To check",
  changedSince: "Changed since",
  mentions: "Mentions",
  pointers: "Pointers",
  history: "History",
};
const BUCKET_ORDER: StaleLinkingView["bucket"][] = ["toCheck", "changedSince", "mentions", "pointers", "history"];
const VERDICT_LABEL: Record<StaleVerdictView["verdict"], string> = {
  stale: "Out of date",
  unsure: "Unsure",
  true: "Still true",
  "not-status": "Not a status",
  fixed: "Fixed",
};

const stem = (relPath: string) => relPath.replace(/^.*\//, "").replace(/\.(md|mdx|html)$/i, "");

function pageLink(relPath: string, title: string): string {
  return `<span class="wiki-stale-link" data-page="${esc(stem(relPath))}" data-relpath="${esc(relPath)}">${esc(title)}</span>`;
}

/** The model's drafted fix, read-only: old → new, and the point-to-the-home variant (D8). */
export function draftFixHtml(edit: StaleVerdictView["edit"]): string {
  if (!edit) return "";
  const home = typeof edit.home === "string"
    ? `<div class="wiki-stale-fix-row"><span class="wiki-stale-fix-k">Point to the home</span><del>${esc(edit.old)}</del> → <ins>${edit.home ? esc(edit.home) : "<em>(removed)</em>"}</ins></div>`
    : "";
  return (
    `<details class="wiki-stale-fix"><summary>Draft fix</summary>` +
    `<div class="wiki-stale-fix-row"><span class="wiki-stale-fix-k">Update the text</span><del>${esc(edit.old)}</del> → <ins>${esc(edit.new)}</ins></div>` +
    home +
    `<div class="wiki-stale-fix-note">Read-only: Apply and Send to Gardener come later.</div></details>`
  );
}

function verdictHtml(v: StaleVerdictView | undefined): string {
  if (!v) return "";
  return (
    `<div class="wiki-stale-verdict v-${esc(v.verdict)}"><span class="wiki-stale-vlabel">${esc(VERDICT_LABEL[v.verdict] ?? v.verdict)}</span>` +
    (v.checkedBy === "reader" ? `<span class="wiki-stale-by">by a reader</span>` : "") +
    (v.reason ? ` <span class="wiki-stale-reason">${esc(v.reason)}</span>` : "") +
    `</div>` +
    (v.verdict === "stale" || v.verdict === "unsure" ? draftFixHtml(v.edit) : "")
  );
}

function verdictButtons(attrs: string): string {
  return (
    `<div class="wiki-stale-actions">` +
    `<button type="button" class="wiki-stale-btn" data-stale-verdict="true" ${attrs}>Still true</button>` +
    `<button type="button" class="wiki-stale-btn" data-stale-verdict="not-status" ${attrs}>Not a status</button>` +
    `</div>`
  );
}

/** The tab's body. `progress` is Check's live line while it runs. */
export function staleBodyHtml(r: StaleReportView | null, opts: { checking?: boolean; progress?: string } = {}): string {
  if (!r) return `<div class="wiki-conn-empty">Loading…</div>`;
  if (r.error) return `<div class="wiki-conn-empty">Stale check unavailable: ${esc(r.error)}</div>`;
  const page = r.page?.relPath ?? "";
  const { staleLines, toCheck } = staleCounts(r);
  let html =
    `<div class="wiki-stale-head" data-stale-lines="${staleLines}" data-stale-tocheck="${toCheck}">` +
    (staleLines || toCheck
      ? `⚠ ${staleLines} stale status line${staleLines === 1 ? "" : "s"} · ${toCheck} linking page${toCheck === 1 ? "" : "s"} to check`
      : "✓ nothing stale") +
    `</div>`;
  if (r.verdicts === "unavailable") html += `<div class="wiki-stale-note">Verdicts are unavailable right now, so no status line shows as confirmed.</div>`;

  const hits = confirmedHits(r);
  if (hits.length) {
    html += `<div class="wiki-conn-section"><div class="wiki-conn-title">Stale status lines (${hits.length})</div>`;
    for (const h of hits) {
      const c = h.confirmation as StaleVerdictView;
      html +=
        `<div class="wiki-stale-item" data-stale-hit="${h.line}">` +
        `<div class="wiki-stale-line"><span class="wiki-stale-ln">L${h.line}</span> ${esc(h.text)}</div>` +
        `<div class="wiki-stale-target">${pageLink(h.target, stem(h.target))} is <code>${esc(h.now)}</code></div>` +
        verdictHtml(c) +
        verdictButtons(`data-kind="status-line" data-stale-page="${esc(page)}" data-line="${h.line}" data-target="${esc(h.target)}"`) +
        `</div>`;
    }
    html += `</div>`;
  }

  if (!r.buckets) {
    html += `<div class="wiki-stale-note">Not changed in the last 14 days, so no linking pages to check.</div>`;
    return html;
  }
  const byBucket = new Map<string, StaleLinkingView[]>();
  for (const l of r.buckets.linking) byBucket.set(l.bucket, [...(byBucket.get(l.bucket) ?? []), l]);
  html += `<div class="wiki-conn-section"><div class="wiki-conn-title">Linking pages (${r.buckets.linking.length})</div>`;
  if (toCheck) {
    const done = (byBucket.get("toCheck") ?? []).filter((l) => l.verdict).length;
    html +=
      `<div class="wiki-stale-checkbar"><button type="button" class="wiki-stale-btn primary" id="wikiStaleCheckBtn" data-stale-check data-stale-page="${esc(page)}"${opts.checking ? " disabled" : ""}>` +
      `${opts.checking ? "Checking…" : done === toCheck ? "Check again" : `Check ${toCheck - done} page${toCheck - done === 1 ? "" : "s"}`}</button>` +
      `<span class="wiki-stale-progress" id="wikiStaleProgress">${esc(opts.progress ?? (done ? `${done} of ${toCheck} checked` : ""))}</span></div>`;
  }
  for (const b of BUCKET_ORDER) {
    const rows = byBucket.get(b) ?? [];
    if (!rows.length) continue;
    const open = b === "toCheck" ? " open" : "";
    html += `<details class="wiki-stale-bucket" data-bucket="${b}"${open}><summary>${BUCKET_LABEL[b]} (${rows.length})</summary>`;
    for (const l of rows) {
      html += `<div class="wiki-stale-item" data-stale-linking="${esc(l.relPath)}"><div class="wiki-stale-ltitle">${pageLink(l.relPath, l.title)}</div>`;
      if (b === "toCheck") {
        for (const p of l.passages.filter((x) => x.claim)) html += `<div class="wiki-stale-line"><span class="wiki-stale-ln">L${p.line}</span> ${esc(p.text)}</div>`;
        html += verdictHtml(l.verdict);
        if (l.verdict?.checkedBy !== "reader") html += verdictButtons(`data-kind="passage" data-stale-page="${esc(page)}" data-linking="${esc(l.relPath)}"`);
      }
      html += `</div>`;
    }
    html += `</details>`;
  }
  return html + `</div>`;
}

/** The tab's CSS, injected by `wiki-page.ts`. */
export function wikiStaleTabStyles(): string {
  return `
    .wiki-stale-count { margin-left: 5px; padding: 0 5px; border-radius: 8px; font-size: 10px; background: color-mix(in srgb, var(--status-warning) 22%, transparent); color: var(--text-primary); }
    .wiki-stale-count:empty { display: none; }
    .wiki-stale-head { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); padding: 4px 4px 10px; }
    .wiki-stale-note { font-size: 12px; color: var(--text-dim); padding: 4px; line-height: 1.5; }
    .wiki-stale-item { padding: 7px 8px; margin: 4px 0; border-radius: 6px; background: var(--bg-surface); border: 1px solid var(--border-primary); }
    .wiki-stale-line { font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin: 2px 0; overflow-wrap: anywhere; }
    .wiki-stale-ln { font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
    .wiki-stale-target, .wiki-stale-ltitle { font-size: 12px; color: var(--text-muted); margin: 2px 0; }
    .wiki-stale-link { color: var(--accent-light); cursor: pointer; }
    .wiki-stale-link:hover { text-decoration: underline; }
    .wiki-stale-verdict { font-size: 12px; margin: 4px 0; line-height: 1.45; color: var(--text-secondary); }
    .wiki-stale-vlabel { font-weight: 600; margin-right: 4px; }
    .wiki-stale-verdict.v-stale .wiki-stale-vlabel { color: var(--status-warning); }
    .wiki-stale-verdict.v-true .wiki-stale-vlabel, .wiki-stale-verdict.v-not-status .wiki-stale-vlabel { color: var(--status-success); }
    .wiki-stale-by { font-size: 10.5px; color: var(--text-faint); margin-right: 4px; }
    .wiki-stale-fix { font-size: 12px; margin: 4px 0; }
    .wiki-stale-fix summary { cursor: pointer; color: var(--accent-light); }
    .wiki-stale-fix-row { margin: 4px 0; overflow-wrap: anywhere; color: var(--text-secondary); }
    .wiki-stale-fix-k { display: block; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-faint); }
    .wiki-stale-fix del { color: var(--status-error); }
    .wiki-stale-fix ins { color: var(--status-success); text-decoration: none; }
    .wiki-stale-fix-note { font-size: 11px; color: var(--text-faint); }
    .wiki-stale-actions { display: flex; gap: 6px; margin-top: 5px; }
    .wiki-stale-btn { font: inherit; font-size: 11.5px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--border-secondary); background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; }
    .wiki-stale-btn:hover { border-color: var(--accent); color: var(--text-primary); }
    .wiki-stale-btn.primary { border-color: var(--accent); color: var(--accent-light); }
    .wiki-stale-btn[disabled] { opacity: 0.6; cursor: progress; }
    .wiki-stale-checkbar { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; }
    .wiki-stale-progress { font-size: 11.5px; color: var(--text-dim); }
    .wiki-stale-bucket { margin: 6px 0; }
    .wiki-stale-bucket > summary { font-size: 12px; font-weight: 600; color: var(--text-muted); cursor: pointer; padding: 3px 0; }
  `;
}
