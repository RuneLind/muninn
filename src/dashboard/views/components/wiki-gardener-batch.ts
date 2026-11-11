/**
 * Batch review on `/wiki/gardener`: the ungrouped drafts are filed into three
 * sections, AI and tech (outside `life/`), Life (`life/`, no film/TV tag) and
 * Entertainment (`category` on the listing, `src/gardener/category.ts`), and each
 * section header approves or rejects the whole section one card at a time,
 * through the same per-card routes a click uses, so every server guard still runs.
 *
 * Its own module because `wiki-gardener-browser.ts` reads `window` at module
 * scope and cannot be unit-tested (the `wiki-gardener-group.ts` rule). Pure and
 * DOM-free.
 */

import { escHtml as esc } from "./escape.ts";

export type BatchSection = "ai" | "life" | "entertainment";
export type BatchVerb = "approve" | "reject";

/** The listing fields a batch decision reads. */
export interface BatchCard {
  id: string;
  status: string;
  groupKey?: string | null;
  targetPath: string;
  mode?: string;
  createdAt?: number;
  resolvedAt?: number | null;
  category?: string | null;
  drifted?: string | null;
  factcheck?: { needsRedraft: boolean } | null;
  factcheckUnknown?: boolean;
}

/** Section order on the page: the cards a reviewer usually takes first lead.
 *  `chip` is the section filter's label. */
export const BATCH_SECTIONS: { key: BatchSection; label: string; chip: string }[] = [
  { key: "ai", label: "AI and tech", chip: "AI" },
  { key: "life", label: "Life", chip: "Life" },
  { key: "entertainment", label: "Entertainment — films and TV", chip: "Entertainment" },
];

/** True when any row on the listing, in any status, targets `life/`: the wiki
 *  has a life domain (jarvis), so the three sections and their chips apply. A
 *  wiki without one (mimir, racewiki) files everything under the first section. */
export function hasLifeDomain(cards: readonly BatchCard[]): boolean {
  return cards.some((p) => p.targetPath.startsWith("life/"));
}

/** A section's header label: "Drafts" for the first section on a wiki with no
 *  life domain. Read off every row, so it does not flip mid-session. */
export function sectionLabel(key: BatchSection, cards: readonly BatchCard[]): string {
  if (key === "ai" && !hasLifeDomain(cards)) return "Drafts";
  return BATCH_SECTIONS.find((s) => s.key === key)!.label;
}

/** Draft count per section, for the section chips. */
export function sectionCounts(cards: readonly BatchCard[]): Record<BatchSection, number> {
  const counts: Record<BatchSection, number> = { ai: 0, life: 0, entertainment: 0 };
  for (const p of cards) if (isBatchCard(p)) counts[sectionOf(p)]++;
  return counts;
}

/** True for a card the batch sections hold: an ungrouped draft. */
export function isBatchCard(p: BatchCard): boolean {
  return p.status === "draft" && !p.groupKey;
}

export function sectionOf(p: BatchCard): BatchSection {
  if (p.category === "entertainment") return "entertainment";
  return p.targetPath.startsWith("life/") ? "life" : "ai";
}

/**
 * Why a batch leaves this card for a human, or null when it takes it.
 *
 * Reject skips nothing. Approve skips a card the server would refuse or that
 * needs a decision: the fact-check lock (known or unknown), a drifted page
 * (Approve writes nothing and marks it stale), two drafts for one page, and a
 * create draft for a page an applied row wrote AFTER the draft was made. Those
 * last two would fail as "target path already exists" (or a moved base hash)
 * and burn the draft. The listing flags a written page as `drifted` only for
 * update rows and only on a reload, so a twin approved in this tab is caught
 * here or not at all. A page applied before the draft was made does not block
 * it: the drafter saw no page there, so it was deleted or moved since.
 * `busy` holds the ids a Redraft or a single click is still working on.
 */
export function batchSkipReason(
  p: BatchCard,
  verb: BatchVerb,
  pages: PageTargets,
  busy: ReadonlySet<string>,
): string | null {
  if (busy.has(p.id)) return "already in progress";
  if (verb === "reject") return null;
  if (p.factcheck?.needsRedraft || p.factcheckUnknown) return "fact-check lock";
  if (p.drifted) return "page changed since drafting";
  if (pages.sharedByDrafts.has(p.targetPath)) return "another draft writes the same page";
  const writtenAt = pages.written.get(p.targetPath);
  if (p.mode !== "update" && writtenAt !== undefined && writtenAt >= (p.createdAt ?? 0)) {
    return "page written since drafting";
  }
  return null;
}

export interface PageTargets {
  /** Target paths more than one batch card holds. */
  sharedByDrafts: Set<string>;
  /** Target paths an applied row wrote, with the latest time one did. */
  written: Map<string, number>;
}

export function pageTargets(cards: readonly BatchCard[]): PageTargets {
  const seen = new Set<string>();
  const sharedByDrafts = new Set<string>();
  const written = new Map<string, number>();
  for (const p of cards) {
    if (p.status === "applied") {
      const at = p.resolvedAt ?? Number.MAX_SAFE_INTEGER;
      written.set(p.targetPath, Math.max(at, written.get(p.targetPath) ?? 0));
    }
    if (!isBatchCard(p)) continue;
    if (seen.has(p.targetPath)) sharedByDrafts.add(p.targetPath);
    seen.add(p.targetPath);
  }
  return { sharedByDrafts, written };
}

/**
 * Why one card's answer ends the whole batch, or null. A 5xx, an `error`
 * outcome, a read-only 403 or a network failure stops it. Many of those are
 * faults every later card would share (no wikiDir, wiki not registered, a
 * read-only wiki, a disk error), and an `error` answer has already turned its
 * row terminal, so the batch stops rather than risk burning the section; some
 * 500s are one card's own (an unindexed target, path confinement), which costs
 * one more click. A 409 or a `stale` outcome is that card's own, and the batch
 * moves on.
 */
export function batchStopReason(r: { status: number; outcome: string; error: string }): string | null {
  if (r.status === 0 || r.status === 403 || r.status >= 500 || r.outcome === "error") {
    return r.error || `HTTP ${r.status}`;
  }
  return null;
}

/** The ids a batch takes, in list order, and the skipped count per reason. */
export function planBatch(
  cards: readonly BatchCard[],
  section: BatchSection,
  verb: BatchVerb,
  busy: ReadonlySet<string> = new Set(),
  /** Every card on the listing, for the same-page check: a filter can hide
   *  the other draft for a page, and its write still collides. */
  all: readonly BatchCard[] = cards,
): { ids: string[]; skipped: Map<string, number> } {
  const pages = pageTargets(all);
  const ids: string[] = [];
  const skipped = new Map<string, number>();
  for (const p of cards) {
    if (!isBatchCard(p) || sectionOf(p) !== section) continue;
    const reason = batchSkipReason(p, verb, pages, busy);
    if (reason) skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    else ids.push(p.id);
  }
  return { ids, skipped };
}

/**
 * The ids a batch planned at the click, narrowed by a fresh listing: a row no
 * longer a draft there or here, a row a single click or Redraft is now working
 * on, or a row the fresh listing now gives a skip reason (drifted, locked)
 * drops out. Never adds an id: a draft that arrived since the click is one the
 * reviewer did not see.
 */
export function narrowBatch(
  planned: readonly string[],
  local: readonly BatchCard[],
  fresh: readonly BatchCard[],
  verb: BatchVerb,
  busy: ReadonlySet<string>,
): string[] {
  const freshById = new Map(fresh.map((p) => [p.id, p]));
  const localById = new Map(local.map((p) => [p.id, p]));
  // Fresh rows for the page check, plus what this tab applied since the read
  // was answered. Applied rows only ever add to `written`.
  const pages = pageTargets([...fresh, ...local.filter((p) => p.status === "applied")]);
  return planned.filter((id) => {
    const f = freshById.get(id);
    if (!f || !isBatchCard(f) || localById.get(id)?.status !== "draft") return false;
    return batchSkipReason(f, verb, pages, busy) === null;
  });
}

/** A running or finished batch, as the section header paints it. */
export interface BatchProgress {
  section: BatchSection;
  verb: BatchVerb;
  total: number;
  done: number;
  failed: number;
  running: boolean;
  stopped: boolean;
  /** The shared fault that ended the batch (`batchStopReason`). */
  haltedBy?: string;
  /** Re-reading the listing before the first post. */
  preparing?: boolean;
  /** A filter changed while it ran: its result is dropped when it ends. */
  viewChanged?: boolean;
}

export function batchProgressText(b: BatchProgress): string {
  const verbing = b.verb === "approve" ? "Approving" : "Rejecting";
  const verbed = b.verb === "approve" ? "approved" : "rejected";
  const failed = b.failed ? ` · ${b.failed} failed (see the cards)` : "";
  if (b.running && b.preparing) return `Checking the listing before ${verbing.toLowerCase()} ${b.total}…`;
  if (b.running) return `${verbing} ${b.done + 1} of ${b.total}…${failed}`;
  const ok = b.done - b.failed;
  const head = b.haltedBy ? `Stopped after an error (${b.haltedBy}): ` : b.stopped ? "Stopped: " : "";
  return `${head}${ok} of ${b.total} ${verbed}${failed}`;
}

function skippedText(skipped: Map<string, number>): string {
  if (!skipped.size) return "";
  const parts = [...skipped].map(([reason, n]) => `${n} ${reason}`);
  return `left for you: ${parts.join(", ")}`;
}

/**
 * One section header: the label and count, then Approve all (and, for the
 * entertainment section, Reject all), or the running batch's progress and Stop.
 * `anyRunning` disables every batch button while some batch runs.
 */
export function batchHeadHtml(opts: {
  section: BatchSection;
  label: string;
  cards: readonly BatchCard[];
  count: number;
  progress: BatchProgress | null;
  anyRunning: boolean;
  busy?: ReadonlySet<string>;
  all?: readonly BatchCard[];
}): string {
  const { section, label, cards, count, progress, anyRunning } = opts;
  const approve = planBatch(cards, section, "approve", opts.busy, opts.all);
  const reject = planBatch(cards, section, "reject", opts.busy, opts.all);
  let html = `<div class="gard-batch-head" data-batch-section="${esc(section)}">`;
  html += `<span class="gard-batch-label">${esc(label)}</span>`;
  html += `<span class="gard-batch-count">${count} draft${count === 1 ? "" : "s"}</span>`;
  html += '<span class="gard-batch-actions">';
  if (progress?.running) {
    html += `<button class="gard-btn gard-batch-stop" data-batch-stop>${progress.stopped ? "Stopping…" : "Stop"}</button>`;
  } else {
    const dis = anyRunning ? " disabled" : "";
    if (approve.ids.length) {
      // "N of M" when it leaves some for a human; the reason line says which.
      const left = [...approve.skipped.values()].reduce((a, b) => a + b, 0);
      const n = approve.ids.length;
      html += `<button class="gard-btn gard-approve" data-batch-action="approve" data-batch="${esc(section)}"${dis}>Approve all ${left ? `${n} of ${n + left}` : n}</button>`;
    }
    if (section === "entertainment" && reject.ids.length) {
      html += `<button class="gard-btn gard-reject" data-batch-action="reject" data-batch="${esc(section)}"${dis}>Reject all ${reject.ids.length}</button>`;
    }
  }
  html += "</span>";
  const notes = [progress ? batchProgressText(progress) : "", progress?.running ? "" : skippedText(approve.skipped)].filter(Boolean);
  if (notes.length) html += `<span class="gard-batch-note">${esc(notes.join(" · "))}</span>`;
  html += "</div>";
  return html;
}
