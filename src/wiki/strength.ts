/**
 * THE NEIGHBOUR RULE — which pages are one hop from a page, why, and how
 * strongly. One rule, two readers: `computeRelated` (the Connections panel's
 * Related work block) and {@link nearScores} (the find palette's closeness
 * boost, sent as `near` on `/api/wiki/page`).
 *
 * | Signal          | Counts when                                            | Weight                       |
 * |-----------------|--------------------------------------------------------|------------------------------|
 * | Link            | either direction                                       | 1.0 one way, 1.6 both ways   |
 * | Shared PR refs  | ≥ 2 shared, both ends ≤ 15 refs                        | 0.6 per ref, max 1.8         |
 * | Shared session  | ≥ 1 shared, the session on ≤ 12 pages                  | 1.2 per session, max 2.4     |
 *
 * A pair is a neighbour iff at least one signal counts, so every neighbour
 * scores ≥ 1.0. The numbers live in `related-constants.ts`.
 *
 * **Cuts, and which end each applies to.** Bookkeeping and hub apply to BOTH
 * ends: an open page that is either gets no neighbours. The PR digest cut
 * applies to both ends of the PR signal only, and the session digest cut to the
 * session itself. Culled and the open page's own attachments cut CANDIDATES
 * only — a culled page still has neighbours of its own.
 *
 * Pure, index-only, deterministic and AGE-FREE: nothing here reads a date, so a
 * worked-on date arriving from the ledger cannot move a neighbour or a score
 * (`worked-order-invariant.test.ts`).
 *
 * The PR and session sharing are answered from inverted maps (ref → pages,
 * session id → pages), built once per index and memoized on the index object —
 * never per request.
 */

import { isMetaStem, pageStemOf } from "../dashboard/views/components/wiki-filter.ts";
import { normalizeRelPath, type WikiIndex, type WikiPageMeta } from "./store.ts";
import {
  NEAR_HOP_DECAY,
  NEAR_MAX,
  RELATED_DIGEST_PRS,
  RELATED_HUB_BACKLINKS,
  RELATED_SHARED_PRS_MIN,
  STRENGTH_SESSION_DIGEST,
  strengthParts,
} from "./related-constants.ts";
import { bareId, stampedSessionRefs } from "./session-refs.ts";

/**
 * BOOKKEEPING pages are never related work, whatever the link graph says —
 * `index`, `log` and `CLAUDE`, by stem, in any folder.
 *
 * The stem comes from `pageStemOf`, the RAIL's own spelling, which strips any
 * extension: `wikiPageStem` strips only `.md`/`.mdx`, so `plans/index.html` read
 * as the stem `index.html`, sat under `Bookkeeping` in the rail and arrived here
 * as ordinary related work. ⚠️ `isMetaStem` is case-SENSITIVE on `CLAUDE` alone
 * (inherited from the rail, where the same predicate decides the tail).
 *
 * Exported for the lint's series checks (`lint-series.ts`, through `related.ts`'s
 * re-export), which apply the same four cuts — the constants AND this predicate
 * — rather than re-declaring them, and for graph mode (`graph.ts`), which never
 * draws one.
 *
 * The hub cut alone does not reach these pages, and that is measured rather than
 * assumed: on mimir (547 pages) `index.md` has **3** backlinks, `log.md` 4 and
 * `plans/index.md` 6 — all far under `RELATED_HUB_BACKLINKS`, because a catalog
 * page LINKS OUT rather than being linked to. Without the cut they led the block
 * on both acceptance pages.
 */
export function isBookkeeping(relPath: string): boolean {
  return isMetaStem(pageStemOf(relPath));
}

/** How many pages link to this one. The hub test's one reader. */
function backlinkCount(index: WikiIndex, key: string): number {
  return index.backlinks.get(key)?.length ?? 0;
}

/** Is the page at this normalized key a hub? */
function isHub(index: WikiIndex, key: string): boolean {
  return backlinkCount(index, key) > RELATED_HUB_BACKLINKS;
}

/** Which signals tie a neighbour to the page, each in the OPEN page's terms. */
export interface NeighbourSignals {
  /** The neighbour links to the open page. */
  cites: boolean;
  /** The open page links to the neighbour. */
  citedBy: boolean;
  /** Shared PR refs in the open page's spelling and order; `[]` under
   *  `RELATED_SHARED_PRS_MIN` (one shared ref is no signal). */
  prs: string[];
  /** Shared stamped sessions, as the OPEN page spells each ref
   *  (`claude-code:<uuid>` or bare), in its own order. */
  sessions: string[];
}

/** One neighbour: which page, how strongly, and why. */
export interface Neighbour {
  /** The neighbour's relPath, exactly as `WikiPageMeta.relPath` spells it. */
  relPath: string;
  meta: WikiPageMeta;
  /** Sum of the counting signals' weights, in `[1.0, STRENGTH_MAX]`. */
  score: number;
  signals: NeighbourSignals;
}

/** The inverted maps, one per index. Values are normalized relPath keys, each
 *  page at most once per entry. */
interface SharingMaps {
  /** Lowercased PR ref → pages naming it, digests (> `RELATED_DIGEST_PRS`
   *  refs) left out: the PR signal never counts on one. */
  prPages: Map<string, string[]>;
  /** Bare session id → EVERY page stamping it, so its length is the session
   *  digest count. */
  sessionPages: Map<string, string[]>;
}

const sharingMemo = new WeakMap<WikiIndex, SharingMaps>();

function sharingMaps(index: WikiIndex): SharingMaps {
  const hit = sharingMemo.get(index);
  if (hit) return hit;
  const prPages = new Map<string, string[]>();
  const sessionPages = new Map<string, string[]>();
  for (const page of index.pages) {
    const key = normalizeRelPath(page.relPath);
    const refs = page.prRefs ?? [];
    if (refs.length <= RELATED_DIGEST_PRS) {
      for (const ref of new Set(refs.map((r) => r.toLowerCase()))) {
        const list = prPages.get(ref);
        if (list) list.push(key);
        else prPages.set(ref, [key]);
      }
    }
    for (const id of new Set(stampedSessionRefs(page).map(bareId))) {
      const list = sessionPages.get(id);
      if (list) list.push(key);
      else sessionPages.set(id, [key]);
    }
  }
  const maps = { prPages, sessionPages };
  sharingMemo.set(index, maps);
  return maps;
}

/**
 * The pages one hop from `relPath`, each with its score and signals. `[]` for an
 * unknown relPath, a bookkeeping page and a hub. Order is unspecified — every
 * reader sorts.
 */
export function neighbours(index: WikiIndex, relPath: string): Neighbour[] {
  const self = index.resolveRelPath(relPath);
  if (!self) return [];
  const selfKey = normalizeRelPath(self.relPath);
  if (isBookkeeping(self.relPath)) return [];
  if (isHub(index, selfKey)) return [];

  const found = new Map<string, { meta: WikiPageMeta; signals: NeighbourSignals }>();
  /** The candidate's entry, or null when a cut removes it. */
  const entry = (candidateKey: string): { meta: WikiPageMeta; signals: NeighbourSignals } | null => {
    if (candidateKey === selfKey) return null;
    const have = found.get(candidateKey);
    if (have) return have;
    const meta = index.resolveRelPath(candidateKey);
    if (!meta) return null;
    if (isBookkeeping(meta.relPath)) return null;
    // A CULLED page is retired work: it stays in Linked from / Links to (marked),
    // but it is not related work a reader should continue in.
    if (meta.culled) return null;
    // The open page's OWN attachments: the rail already shows them as this
    // page's attachment chip. Scoped to THIS page's children — an `.html`
    // explainer belonging to some other page is an ordinary candidate.
    if (meta.parent !== undefined && normalizeRelPath(meta.parent) === selfKey) return null;
    // The hub cut applies to EVERY signal, link included.
    if (isHub(index, candidateKey)) return null;
    const made = { meta, signals: { cites: false, citedBy: false, prs: [], sessions: [] } };
    found.set(candidateKey, made);
    return made;
  };

  for (const from of index.backlinks.get(selfKey) ?? []) {
    const e = entry(from);
    if (e) e.signals.cites = true;
  }
  for (const to of index.outgoing.get(selfKey) ?? []) {
    const e = entry(to);
    if (e) e.signals.citedBy = true;
  }

  const maps = sharingMaps(index);

  // Shared PR refs. Case-insensitive, because the two ends may have got their
  // spelling from a frontmatter line and from prose; the VALUE kept is the open
  // page's, so the reason reads in one spelling however the other page wrote it.
  const selfRefs = self.prRefs ?? [];
  if (selfRefs.length >= RELATED_SHARED_PRS_MIN && selfRefs.length <= RELATED_DIGEST_PRS) {
    const selfByKey = new Map(selfRefs.map((r) => [r.toLowerCase(), r]));
    // Ordered by the OPEN page's own list, so the refs a reason names are the
    // first ones THIS page declares.
    const ordered = [...selfByKey.values()].sort((a, b) => selfRefs.indexOf(a) - selfRefs.indexOf(b));
    // A Set per candidate: two pages whose relPaths differ only by case share
    // one normalized key, so the ref map lists that key twice under one ref.
    const shared = new Map<string, Set<string>>();
    for (const mine of ordered) {
      for (const key of maps.prPages.get(mine.toLowerCase()) ?? []) {
        if (key === selfKey) continue;
        const set = shared.get(key);
        if (set) set.add(mine);
        else shared.set(key, new Set([mine]));
      }
    }
    for (const [key, refs] of shared) {
      if (refs.size < RELATED_SHARED_PRS_MIN) continue;
      const e = entry(key);
      if (e) e.signals.prs = [...refs];
    }
  }

  // Shared stamped sessions, keyed on the bare id so `claude-code:<id>` and a
  // bare `<id>` pair. A session on more than STRENGTH_SESSION_DIGEST pages is
  // a sweep and says nothing.
  for (const ref of stampedSessionRefs(self)) {
    const pages = maps.sessionPages.get(bareId(ref)) ?? [];
    if (pages.length > STRENGTH_SESSION_DIGEST) continue;
    for (const key of pages) {
      const e = entry(key);
      if (e && !e.signals.sessions.includes(ref)) e.signals.sessions.push(ref);
    }
  }

  return [...found].map(([, { meta, signals }]) => ({
    relPath: meta.relPath,
    meta,
    score: strengthOf(signals),
    signals,
  }));
}

/** The score a set of signals adds up to. Exported for the unit tests' signal
 *  sweep; a reader takes `Neighbour.score`. */
export function strengthOf(signals: NeighbourSignals): number {
  const p = strengthParts(linkOf(signals), signals.prs.length, signals.sessions.length);
  return p.link + p.prs + p.sessions;
}

/** The link signal as one value: `in` — the neighbour cites the open page,
 *  `out` — the open page cites the neighbour, `both`, or `null`. */
export function linkOf(signals: Pick<NeighbourSignals, "cites" | "citedBy">): "out" | "in" | "both" | null {
  if (signals.cites && signals.citedBy) return "both";
  if (signals.cites) return "in";
  if (signals.citedBy) return "out";
  return null;
}

/** A first-hop closeness: `s/(s+1)`, in `[0.5, 1)` for every neighbour. */
export function hopOne(score: number): number {
  return score / (score + 1);
}

/** A second-hop closeness through a parent of closeness `parentNear`. */
export function hopTwo(parentNear: number, score: number): number {
  return parentNear * NEAR_HOP_DECAY * hopOne(score);
}

/**
 * The find palette's closeness map for the open page: relPath (as the listing
 * spells it) → a number in `(0, 1)`. First-hop pages score {@link hopOne};
 * second-hop pages {@link hopTwo}, which stays under every first-hop score. The
 * walk expands only through neighbours, which are never hubs, keeps the best
 * score per page, leaves the open page out and keeps the `NEAR_MAX` strongest
 * entries (ties by relPath, so the cut is deterministic). Empty for a
 * bookkeeping or hub page, exactly as its neighbours are.
 */
export function nearScores(index: WikiIndex, relPath: string): Record<string, number> {
  const self = index.resolveRelPath(relPath);
  if (!self) return {};
  const selfKey = normalizeRelPath(self.relPath);
  const best = new Map<string, { relPath: string; near: number }>();
  const keep = (rel: string, near: number): void => {
    const key = normalizeRelPath(rel);
    if (key === selfKey) return;
    const have = best.get(key);
    if (!have || near > have.near) best.set(key, { relPath: rel, near });
  };
  const first = neighbours(index, self.relPath);
  for (const n of first) keep(n.relPath, hopOne(n.score));
  for (const n of first) {
    const parentNear = hopOne(n.score);
    for (const m of neighbours(index, n.relPath)) keep(m.relPath, hopTwo(parentNear, m.score));
  }
  const ranked = [...best.values()].sort(
    (a, b) => b.near - a.near || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0),
  );
  const out: Record<string, number> = {};
  for (const { relPath: rel, near } of ranked.slice(0, NEAR_MAX)) out[rel] = Math.round(near * 1000) / 1000;
  return out;
}
