/**
 * STALE CHECK FIXES → `wiki_proposals` rows (kind `stale-check`, plan
 * muninn-wiki-drift-check PR 3, D9/D19/D20).
 *
 * The reader's Send to Gardener on the STALE tab turns one drafted edit into
 * a card the existing gate renders and applies: one card per changed page (the
 * page whose tab sent it), one row per page the edits write, one Accept
 * (`applyWikiProposalGroup`). Mechanical like `lint`: the draft is the page's
 * own bytes with the edits applied, no model call anywhere on this path.
 *
 * **Send never edits an open group (D20).** In one transaction it retires
 * group n (status `stale`, D28) and inserts group n+1 holding the old rows
 * plus the new edit. Each row is redrafted by re-applying its edits to the
 * page's CURRENT bytes (`applyStaleEdits`, which recomputes the windows on the
 * live file); an old edit that no longer places is dropped and reported. Two
 * edits to one page merge into one row, keyed by the hash of its edit list. A
 * page another live group of any kind holds refuses the send.
 *
 * Keys: topic `stale-check:<changed>:<page>:<edit hash>`, group
 * `stale-check:<changed>:<n>`.
 */
import path from "node:path";
import {
  listLiveGroupedRows,
  listLiveStaleCheckRows,
  listStaleCheckRowsByChanged,
  supersedeStaleCheckGroup,
  type InsertWikiProposalParams,
  type LiveGroupedRow,
  type SupersedeStaleCheckOutcome,
  type WikiProposal,
} from "../db/wiki-proposals.ts";
import { applyStaleEdits, sameStaleEdit, type StaleFixEdit } from "../wiki/stale-fix.ts";
import type { WikiIndex } from "../wiki/store.ts";
import { sha256 } from "./util.ts";

/** The DB half, a seam so the route tests run without a database. */
export interface StaleProposalStore {
  byChanged(wiki: string, changed: string): Promise<WikiProposal[]>;
  liveGrouped(wiki: string): Promise<LiveGroupedRow[]>;
  liveStaleCheck(wiki: string): Promise<WikiProposal[]>;
  supersede(params: Parameters<typeof supersedeStaleCheckGroup>[0]): Promise<SupersedeStaleCheckOutcome>;
}

export const dbStaleProposalStore: StaleProposalStore = {
  byChanged: listStaleCheckRowsByChanged,
  liveGrouped: listLiveGroupedRows,
  liveStaleCheck: listLiveStaleCheckRows,
  supersede: supersedeStaleCheckGroup,
};

let activeStore: StaleProposalStore = dbStaleProposalStore;
export const staleProposalStore = (): StaleProposalStore => activeStore;
export function __setStaleProposalStoreForTest(store: StaleProposalStore | null): void {
  activeStore = store ?? dbStaleProposalStore;
}

const isLive = (r: Pick<WikiProposal, "status">) => r.status === "draft" || r.status === "approved";

/** The 12-hex hash of a page's edit list: the row's topic key carries it. */
export const staleEditHash = (edits: readonly StaleFixEdit[]) =>
  sha256(JSON.stringify(edits.map((e) => [e.kind, e.page, e.link, e.old, e.text, e.variant]))).slice(0, 12);

const RATIONALE_CAP = 600;

function rationaleFor(changed: string, edits: readonly StaleFixEdit[]): string {
  const parts = edits.map((e) => e.reason || `«${e.old}» → «${e.text}»`);
  const text = `Stale after ${changed}: ${parts.join(" · ")}`;
  return text.length > RATIONALE_CAP ? `${text.slice(0, RATIONALE_CAP)}…` : text;
}

/** A page a live grouped row outside `mine` holds, when one does. */
export function heldBy(rows: readonly LiveGroupedRow[], page: string, mine: ReadonlySet<string> = new Set()): LiveGroupedRow | undefined {
  return rows.find((r) => r.targetPath === page && !mine.has(r.id));
}

export const heldMessage = (h: Pick<LiveGroupedRow, "targetPath" | "groupKey" | "kind">) =>
  `${h.targetPath} is held by another Gardener card (${h.kind === "stale-check" ? "Stale check" : h.kind}, ${h.groupKey}): accept or dismiss it first.`;

export type SendStaleFixOutcome =
  | {
      outcome: "sent";
      groupKey: string;
      /** The group this one replaced, or null for a first card. */
      supersedes: string | null;
      pages: string[];
      fixes: number;
      /** Old edits that no longer place on their page's current bytes. */
      dropped: { page: string; old: string; reason: string }[];
    }
  | { outcome: "refused"; status: 409 | 503; error: string };

/**
 * Send one drafted edit to the Gardener as D20 says. `changed` is the page
 * whose STALE tab sent it; `edit.page` is the page it writes.
 */
export async function sendStaleFix(opts: {
  wiki: string;
  wikiDir: string;
  index: WikiIndex;
  changed: string;
  edit: StaleFixEdit;
  store?: StaleProposalStore;
  readFile?: (absPath: string) => Promise<string | null>;
}): Promise<SendStaleFixOutcome> {
  const store = opts.store ?? staleProposalStore();
  const readFile =
    opts.readFile ??
    (async (abs: string) => {
      try {
        return await Bun.file(abs).text();
      } catch {
        return null;
      }
    });
  const { wiki, changed, edit } = opts;
  const mine = (await store.byChanged(wiki, changed)).filter(isLive);
  if (mine.some((r) => r.status === "approved")) {
    return { outcome: "refused", status: 409, error: "The Stale check card for this page is being applied. Send again when it settles." };
  }
  const already = mine.some((r) => (r.staleMeta?.edits ?? []).some((e) => sameStaleEdit(e, edit) && e.text === edit.text));
  if (already) return { outcome: "refused", status: 409, error: "This fix is already in review in the Gardener." };
  const mineIds = new Set(mine.map((r) => r.id));
  const held = heldBy(await store.liveGrouped(wiki), edit.page, mineIds);
  if (held) return { outcome: "refused", status: 409, error: heldMessage(held) };

  // The edit lists per page: the open group's, then the new edit (which
  // replaces an old edit on the same text).
  const byPage = new Map<string, StaleFixEdit[]>();
  for (const r of mine) {
    for (const e of r.staleMeta?.edits ?? []) byPage.set(r.targetPath, [...(byPage.get(r.targetPath) ?? []), e]);
  }
  byPage.set(edit.page, [...(byPage.get(edit.page) ?? []).filter((e) => !sameStaleEdit(e, edit)), edit]);

  const dropped: { page: string; old: string; reason: string }[] = [];
  const supersedes = mine.find((r) => r.groupKey)?.groupKey ?? null;
  const rows: Omit<InsertWikiProposalParams, "groupKey">[] = [];
  let fixes = 0;
  for (const [page, edits] of byPage) {
    const content = await readFile(path.join(opts.wikiDir, page));
    if (content === null) {
      if (page === edit.page) return { outcome: "refused", status: 409, error: `${page} cannot be read.` };
      for (const e of edits) dropped.push({ page, old: e.old, reason: "the page cannot be read" });
      continue;
    }
    const placed = applyStaleEdits(content, edits, opts.index);
    const lost = placed.dropped.find((d) => sameStaleEdit(d.edit, edit));
    if (lost) return { outcome: "refused", status: 409, error: lost.reason };
    for (const d of placed.dropped) dropped.push({ page, old: d.edit.old, reason: d.reason });
    if (!placed.applied.length) continue;
    fixes += placed.applied.length;
    rows.push({
      botName: wiki,
      wikiName: wiki,
      topicKey: `stale-check:${changed}:${page}:${staleEditHash(placed.applied)}`,
      kind: "stale-check",
      mode: "update",
      targetPath: page,
      baseHash: sha256(content),
      draft: placed.content,
      sourceDocs: [],
      // `[]`, not NULL: the wire stage adds no See-also, and the gate draws no
      // «drafted before related pages» note for this kind.
      relatedPages: [],
      rationale: rationaleFor(changed, placed.applied),
      staleMeta: { changed, edits: placed.applied, supersedes },
    });
  }
  rows.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  const res = await store.supersede({ wikiName: wiki, changed, expectedLiveIds: [...mineIds], rows });
  if (res.outcome === "conflict") return { outcome: "refused", status: 409, error: res.reason };
  if (res.outcome === "held") return { outcome: "refused", status: 409, error: heldMessage(res) };
  return { outcome: "sent", groupKey: res.groupKey, supersedes, pages: rows.map((r) => r.targetPath), fixes, dropped };
}

/** One changed page's fixes in review: the live Stale check group's edits. */
export interface StaleInReview {
  fixes: number;
  groupKey: string;
  edits: { kind: StaleFixEdit["kind"]; page: string; link: string; old: string }[];
}

/** The ⧗ «in review» states (D31): per changed page, the edits its live Stale
 *  check rows hold. */
export function inReviewByChanged(rows: readonly WikiProposal[]): Map<string, StaleInReview> {
  const out = new Map<string, StaleInReview>();
  for (const r of rows) {
    if (r.kind !== "stale-check" || !isLive(r) || !r.staleMeta) continue;
    const cur = out.get(r.staleMeta.changed) ?? { fixes: 0, groupKey: r.groupKey ?? "", edits: [] };
    for (const e of r.staleMeta.edits) cur.edits.push({ kind: e.kind, page: e.page, link: e.link, old: e.old });
    cur.fixes = cur.edits.length;
    out.set(r.staleMeta.changed, cur);
  }
  return out;
}
