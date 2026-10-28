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
 * - Draft fix shows the model's edit (D8: update the text, or point to the
 *   home), each variant with Apply (one page write) and Send to Gardener (a
 *   Stale check card), PR 3. A fix already on a live card says so instead.
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
  /** The hit's line is in the frontmatter: no mark in the article (D21). */
  frontmatter?: boolean;
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
  /** PR 3 (D31): the fixes this page's live Stale check card holds. */
  inReview?: StaleInReviewView;
  error?: string;
}

/** The fixes a page's live Stale check card holds (`GET /api/wiki/stale?page=`). */
export interface StaleInReviewView {
  fixes: number;
  groupKey?: string;
  edits?: { kind: string; page: string; link: string; old: string }[];
}

/** The two numbers (D26): confirmed stale status lines, linking pages to check. */
export function staleCounts(r: StaleReportView | null | undefined): StalePageCounts {
  if (!r || r.error) return { staleLines: 0, toCheck: 0 };
  const staleLines = confirmedHits(r).length;
  const inReview = Number(r.inReview?.fixes) || 0;
  return { staleLines, toCheck: r.buckets?.counts?.toCheck ?? 0, ...(inReview ? { inReview } : {}) };
}

export interface StalePageCounts {
  staleLines: number;
  toCheck: number;
  /** PR 3 (D31): fixes waiting in the Gardener, shown as ⧗. */
  inReview?: number;
}

/** The two numbers in words (D26): «⚠ N stale status lines · M linking pages
 *  to check», or «✓ nothing stale». The tab's head, the article pill and the
 *  wiki home all read it. */
export function staleCountsText(c: StalePageCounts): string {
  if (!c.staleLines && !c.toCheck) return "✓ nothing stale";
  return `⚠ ${c.staleLines} stale status line${c.staleLines === 1 ? "" : "s"} · ${c.toCheck} linking page${c.toCheck === 1 ? "" : "s"} to check`;
}

/** The hits a reader sees: confirmed stale only (D11). */
export function confirmedHits(r: StaleReportView): StaleHitView[] {
  return (r.hits ?? []).filter((h) => h.confirmation !== undefined && h.confirmation !== "unconfirmed" && h.confirmation.verdict === "stale");
}

/** The STALE tab's own tooltip; the badge's counts are added to it, never put in its place (A12). */
export const STALE_TAB_TITLE = "What a change to this page may have made untrue elsewhere";

/** The tab's count badge: «N · M», or "" when both are 0. `tabTitle` is the
 *  tab's tooltip: {@link STALE_TAB_TITLE}, then the counts when there are any. */
export function staleTabBadge(r: StaleReportView | null | undefined): { text: string; title: string; tabTitle: string } {
  const { staleLines, toCheck } = staleCounts(r);
  if (!staleLines && !toCheck) return { text: "", title: "Nothing stale", tabTitle: STALE_TAB_TITLE };
  const title = `${staleLines} stale status line${staleLines === 1 ? "" : "s"} · ${toCheck} linking page${toCheck === 1 ? "" : "s"} to check`;
  return { text: `${staleLines} · ${toCheck}`, title, tabTitle: `${STALE_TAB_TITLE}\n${title}` };
}

/** What the client knows beyond the report: Check's state and what it left. */
export interface StaleBodyOpts {
  checking?: boolean;
  /** Check's live line while it runs, and its last line after. */
  progress?: string;
  /** Linking pages whose Check call failed, by relPath: shown on the row, never counted as checked. */
  rowErrors?: Record<string, string>;
  /** Pages the last Check left for the next one at its call limit. */
  capLeft?: number;
  /** Check's per-request call limit, for the cap line. */
  capCalls?: number;
  /** Open state of each `<details>` by its `data-stale-open` key, kept across re-renders. */
  open?: Record<string, boolean>;
}

/** The `open` attribute for a `<details>`: the reader's last state, else the default. */
const openAttr = (opts: StaleBodyOpts, key: string, byDefault: boolean) =>
  ` data-stale-open="${esc(key)}"${(opts.open?.[key] ?? byDefault) ? " open" : ""}`;

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

/** Which fix a Draft fix's buttons name: the data attributes the Apply and
 *  Send handlers post, and whether a live Stale check card already holds it. */
export interface StaleFixTarget {
  attrs: string;
  inReview?: boolean;
}

/** One variant's Apply and Send buttons (PR 3). */
function fixButtons(target: StaleFixTarget | undefined, variant: "new" | "home", old: string): string {
  if (!target || target.inReview) return "";
  const attrs = `${target.attrs} data-variant="${variant}" data-old="${esc(old)}"`;
  return (
    `<span class="wiki-stale-fix-actions">` +
    `<button type="button" class="wiki-stale-btn" data-stale-apply ${attrs}>Apply</button>` +
    `<button type="button" class="wiki-stale-btn" data-stale-send ${attrs}>Send to Gardener</button>` +
    `</span>`
  );
}

/** The model's drafted fix (D8): old → new, and the point-to-the-home variant,
 *  each with Apply and Send to Gardener when `target` names it (PR 3). */
export function draftFixHtml(edit: StaleVerdictView["edit"], opts: StaleBodyOpts = {}, key = "", target?: StaleFixTarget): string {
  if (!edit) return "";
  const home = typeof edit.home === "string"
    ? `<div class="wiki-stale-fix-row"><span class="wiki-stale-fix-k">Point to the home</span><del>${esc(edit.old)}</del> → <ins>${edit.home ? esc(edit.home) : "<em>(removed)</em>"}</ins>${fixButtons(target, "home", edit.old)}</div>`
    : "";
  return (
    `<details class="wiki-stale-fix"${key ? openAttr(opts, key, false) : ""}><summary>Draft fix</summary>` +
    `<div class="wiki-stale-fix-row"><span class="wiki-stale-fix-k">Update the text</span><del>${esc(edit.old)}</del> → <ins>${esc(edit.new)}</ins>${fixButtons(target, "new", edit.old)}</div>` +
    home +
    (target?.inReview ? `<div class="wiki-stale-fix-note" data-stale-in-review>⧗ In review in the Gardener.</div>` : "") +
    `</details>`
  );
}

/** Is the fix with `old`, writing `page` after `link`, on the page's live card? */
const fixInReview = (r: StaleReportView, page: string, link: string, old: string | undefined) =>
  old !== undefined && (r.inReview?.edits ?? []).some((e) => e.page === page && e.link === link && e.old === old);

function verdictHtml(v: StaleVerdictView | undefined, opts: StaleBodyOpts, fixKey: string, target?: StaleFixTarget): string {
  if (!v) return "";
  return (
    `<div class="wiki-stale-verdict v-${esc(v.verdict)}"><span class="wiki-stale-vlabel">${esc(VERDICT_LABEL[v.verdict] ?? v.verdict)}</span>` +
    (v.checkedBy === "reader" ? `<span class="wiki-stale-by">by a reader</span>` : "") +
    (v.reason ? ` <span class="wiki-stale-reason">${esc(v.reason)}</span>` : "") +
    `</div>` +
    (v.verdict === "stale" || v.verdict === "unsure" ? draftFixHtml(v.edit, opts, fixKey, v.verdict === "stale" ? target : undefined) : "")
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

/**
 * The tab's two parts, built once per tab: the unsaved-verdict notice and the
 * report. A repaint replaces the report only, so the `role="alert"` node stays
 * the same one and a screen reader announces a notice when its text changes,
 * never again on a repaint (R2B4).
 */
export const STALE_SHELL_HTML = `<div class="wiki-stale-error wiki-stale-notice" role="alert" data-stale-notice></div><div data-stale-content></div>`;

/** The tab's report (the notice lives in {@link STALE_SHELL_HTML}). `progress` is Check's live line while it runs. */
export function staleBodyHtml(r: StaleReportView | null, opts: StaleBodyOpts = {}): string {
  if (!r) return `<div class="wiki-conn-empty">Loading…</div>`;
  if (r.error) return `<div class="wiki-conn-empty">Stale check unavailable: ${esc(r.error)}</div>`;
  const page = r.page?.relPath ?? "";
  const { staleLines, toCheck } = staleCounts(r);
  let html =
    `<div class="wiki-stale-head" data-stale-lines="${staleLines}" data-stale-tocheck="${toCheck}">` +
    esc(staleCountsText({ staleLines, toCheck })) +
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
        verdictHtml(c, opts, `fix:hit:${h.line}:${h.target}`, {
          attrs: `data-kind="status-line" data-stale-page="${esc(page)}" data-line="${h.line}" data-target="${esc(h.target)}"`,
          inReview: fixInReview(r, page, h.target, c.edit?.old),
        }) +
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
    const left = opts.capLeft ?? 0;
    html +=
      `<div class="wiki-stale-checkbar"><button type="button" class="wiki-stale-btn primary" id="wikiStaleCheckBtn" data-stale-check data-stale-page="${esc(page)}"${opts.checking ? " disabled" : ""}>` +
      `${opts.checking ? "Checking…" : done === toCheck ? "Check again" : `Check ${toCheck - done} page${toCheck - done === 1 ? "" : "s"}`}</button>` +
      `<span class="wiki-stale-progress" id="wikiStaleProgress">${esc(opts.progress ?? (done ? `${done} of ${toCheck} checked` : ""))}</span></div>` +
      (left > 0
        ? `<div class="wiki-stale-note wiki-stale-cap" data-stale-cap="${left}">Check makes at most ${opts.capCalls ?? 10} calls at a time: ${left} page${left === 1 ? "" : "s"} still to check. Check again for the rest.</div>`
        : "");
  }
  for (const b of BUCKET_ORDER) {
    const rows = byBucket.get(b) ?? [];
    if (!rows.length) continue;
    html += `<details class="wiki-stale-bucket" data-bucket="${b}"${openAttr(opts, `bucket:${b}`, b === "toCheck")}><summary>${BUCKET_LABEL[b]} (${rows.length})</summary>`;
    for (const l of rows) {
      html += `<div class="wiki-stale-item" data-stale-linking="${esc(l.relPath)}"><div class="wiki-stale-ltitle">${pageLink(l.relPath, l.title)}</div>`;
      if (b === "toCheck") {
        for (const p of l.passages.filter((x) => x.claim)) html += `<div class="wiki-stale-line"><span class="wiki-stale-ln">L${p.line}</span> ${esc(p.text)}</div>`;
        const failed = opts.rowErrors?.[l.relPath];
        if (failed) html += `<div class="wiki-stale-error" data-stale-row-error>Not checked: ${esc(failed)}</div>`;
        html += verdictHtml(l.verdict, opts, `fix:linking:${l.relPath}`, {
          attrs: `data-kind="passage" data-stale-page="${esc(page)}" data-linking="${esc(l.relPath)}"`,
          inReview: fixInReview(r, l.relPath, page, l.verdict?.edit?.old ?? undefined),
        });
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
    .wiki-stale-count { margin-left: 5px; padding: 0 5px; border-radius: 8px; font-size: 10px; white-space: nowrap; background: color-mix(in srgb, var(--status-warning) 22%, transparent); color: var(--text-primary); }
    .wiki-stale-count:empty { display: none; }
    .wiki-stale-head { font-size: 12.5px; font-weight: 600; color: var(--text-secondary); padding: 4px 4px 10px; }
    .wiki-stale-error { font-size: 12px; color: var(--status-error); padding: 3px 4px; line-height: 1.45; overflow-wrap: anywhere; }
    .wiki-stale-note { font-size: 12px; color: var(--text-dim); padding: 4px; line-height: 1.5; }
    .wiki-stale-notice:empty { padding: 0; }
    .wiki-stale-cap { color: var(--text-secondary); }
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
    .wiki-stale-fix-actions { display: inline-flex; gap: 6px; margin-left: 8px; vertical-align: middle; }
    .wiki-stale-actions { display: flex; gap: 6px; margin-top: 5px; }
    .wiki-stale-btn { font: inherit; font-size: 11.5px; padding: 3px 8px; border-radius: 5px; border: 1px solid var(--border-secondary); background: var(--bg-panel); color: var(--text-secondary); cursor: pointer; }
    .wiki-stale-btn:hover { border-color: var(--accent); color: var(--text-primary); }
    .wiki-stale-btn.primary { border-color: var(--accent); color: var(--accent-light); }
    .wiki-stale-btn[disabled] { opacity: 0.6; cursor: progress; }
    .wiki-stale-checkbar { display: flex; align-items: center; gap: 8px; margin: 4px 0 8px; }
    .wiki-stale-progress { font-size: 11.5px; color: var(--text-dim); }
    .wiki-stale-bucket { margin: 6px 0; }
    .wiki-stale-bucket > summary { font-size: 12px; font-weight: 600; color: var(--text-muted); cursor: pointer; padding: 3px 0; }
  `;
}
