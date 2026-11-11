/**
 * Batch review on `/wiki/gardener`: the ungrouped drafts are filed into
 * sections (`category` on the listing, `src/gardener/category.ts`), and each
 * section header approves or rejects the whole section one card at a time,
 * through the same per-card routes a click uses, so every server guard still runs.
 *
 * Its own module because `wiki-gardener-browser.ts` reads `window` at module
 * scope and cannot be unit-tested (the `wiki-gardener-group.ts` rule). Pure and
 * DOM-free.
 */

import { escHtml as esc } from "./escape.ts";

export type BatchSection = "other" | "entertainment";
export type BatchVerb = "approve" | "reject";

/** The listing fields a batch decision reads. */
export interface BatchCard {
  id: string;
  status: string;
  groupKey?: string | null;
  targetPath: string;
  category?: string | null;
  drifted?: string | null;
  factcheck?: { needsRedraft: boolean } | null;
  factcheckUnknown?: boolean;
}

/** Section order on the page: the cards a reviewer usually takes first lead. */
export const BATCH_SECTIONS: { key: BatchSection; label: string }[] = [
  { key: "other", label: "Everything else" },
  { key: "entertainment", label: "Entertainment — films and TV" },
];

/** True for a card the batch sections hold: an ungrouped draft. */
export function isBatchCard(p: BatchCard): boolean {
  return p.status === "draft" && !p.groupKey;
}

export function sectionOf(p: BatchCard): BatchSection {
  return p.category === "entertainment" ? "entertainment" : "other";
}

/**
 * Why a batch leaves this card for a human, or null when it takes it.
 *
 * Reject skips nothing. Approve skips a card the server would refuse or that
 * needs a decision: the fact-check lock (known or unknown), a drifted page
 * (Approve writes nothing and marks it stale), and two drafts for one page: the
 * second write would fail as "target path already exists" and burn its draft.
 * `samePage` is the set of target paths more than one draft holds.
 */
export function batchSkipReason(
  p: BatchCard,
  verb: BatchVerb,
  samePage: ReadonlySet<string>,
  redrafting: ReadonlySet<string>,
): string | null {
  if (redrafting.has(p.id)) return "redraft running";
  if (verb === "reject") return null;
  if (p.factcheck?.needsRedraft || p.factcheckUnknown) return "fact-check lock";
  if (p.drifted) return "page changed since drafting";
  if (samePage.has(p.targetPath)) return "another draft writes the same page";
  return null;
}

/** Target paths held by more than one batch card, across every section. */
export function samePageTargets(cards: readonly BatchCard[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const p of cards) {
    if (!isBatchCard(p)) continue;
    if (seen.has(p.targetPath)) dup.add(p.targetPath);
    seen.add(p.targetPath);
  }
  return dup;
}

/** The ids a batch takes, in list order, and the skipped count per reason. */
export function planBatch(
  cards: readonly BatchCard[],
  section: BatchSection,
  verb: BatchVerb,
  redrafting: ReadonlySet<string> = new Set(),
  /** Every card on the listing, for the same-page check: a filter can hide
   *  the other draft for a page, and its write still collides. */
  all: readonly BatchCard[] = cards,
): { ids: string[]; skipped: Map<string, number> } {
  const samePage = samePageTargets(all);
  const ids: string[] = [];
  const skipped = new Map<string, number>();
  for (const p of cards) {
    if (!isBatchCard(p) || sectionOf(p) !== section) continue;
    const reason = batchSkipReason(p, verb, samePage, redrafting);
    if (reason) skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    else ids.push(p.id);
  }
  return { ids, skipped };
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
}

export function batchProgressText(b: BatchProgress): string {
  const verbing = b.verb === "approve" ? "Approving" : "Rejecting";
  const verbed = b.verb === "approve" ? "approved" : "rejected";
  const failed = b.failed ? ` · ${b.failed} failed (see the cards)` : "";
  if (b.running) return `${verbing} ${b.done + 1} of ${b.total}…${failed}`;
  const ok = b.done - b.failed;
  return `${b.stopped ? "Stopped: " : ""}${ok} of ${b.total} ${verbed}${failed}`;
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
  redrafting?: ReadonlySet<string>;
  all?: readonly BatchCard[];
}): string {
  const { section, label, cards, count, progress, anyRunning } = opts;
  const approve = planBatch(cards, section, "approve", opts.redrafting, opts.all);
  const reject = planBatch(cards, section, "reject", opts.redrafting, opts.all);
  let html = `<div class="gard-batch-head" data-batch-section="${esc(section)}">`;
  html += `<span class="gard-batch-label">${esc(label)}</span>`;
  html += `<span class="gard-batch-count">${count} draft${count === 1 ? "" : "s"}</span>`;
  html += '<span class="gard-batch-actions">';
  if (progress?.running) {
    html += `<button class="gard-btn gard-batch-stop" data-batch-stop>${progress.stopped ? "Stopping…" : "Stop"}</button>`;
  } else {
    const dis = anyRunning ? " disabled" : "";
    if (approve.ids.length) {
      html += `<button class="gard-btn gard-approve" data-batch-action="approve" data-batch="${esc(section)}"${dis}>Approve all ${approve.ids.length}</button>`;
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
