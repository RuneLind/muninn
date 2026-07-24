/**
 * Pure (DOM-free) helpers for the Atlas tab's SEMANTIC overlay — the client-side
 * counterpart to `src/wiki/atlas-semantic.ts`. The server joins huginn's fixed
 * Louvain communities + similarity edges onto the wiki index and ships them on
 * `AtlasPayload.semantic`; this module turns that overlay into (a) a stable
 * community→color-slot assignment gated to communities that colour ≥1 RENDERED
 * pill, and (b) the semantic-neighbour set for a selected node at a threshold.
 *
 * Kept import-safe (no DOM, no `escHtml`) so `wiki-atlas.ts` can consume it AND
 * it is unit-tested directly (legend gating on the mimir path, "+N not shown"
 * capping, the two "Other" rules). The client owns all HTML/SVG generation.
 *
 * ── Two partitions, on purpose ───────────────────────────────────────────────
 * Node colour = huginn's FIXED communities (never changes with the threshold
 * slider). The slider only gates which SEMANTIC EDGES are drawn on selection.
 */

/** Overlay shape mirrored from `src/wiki/atlas-semantic.ts` (`SemanticOverlay`),
 *  redefined here to keep the client bundle free of server-module imports. */
export interface SemanticCommunity {
  id: string;
  size: number;
  label: string;
  tags: string[];
}
export interface SemanticOverlay {
  /** `[emitKeyA, emitKeyB, similarity]`, both ends resolved to index pages. */
  edges: [string, string, number][];
  communities: SemanticCommunity[];
  /** emitKey → namespaced community id (isolate ids with no community row survive). */
  nodeCommunity: Record<string, string>;
}

/** Threshold slider bounds + default (semantic EDGE gate, not the node colouring). */
export const SEM_THRESHOLD_MIN = 0.9;
export const SEM_THRESHOLD_MAX = 0.995;
export const SEM_THRESHOLD_DEFAULT = 0.98;
export const SEM_THRESHOLD_STEP = 0.005;

/** Categorical colour slots. Identity is NEVER colour-alone — every legend row and
 *  tooltip carries the community label; the 7th+ community + huginn isolates fold
 *  into slot -1, the neutral "Other" grey. */
export const SEM_COLOR_SLOTS = 6;
/** Sentinel slot for the neutral "Other" bucket (folded communities + isolates). */
export const SEM_OTHER_SLOT = -1;
/** Legend id for the single folded "Other" row. */
export const SEM_OTHER_ID = "__other__";

export interface SemLegendRow {
  /** Community id, or `SEM_OTHER_ID` for the folded "Other" row. */
  id: string;
  label: string;
  /** 0..5 for a coloured community, `SEM_OTHER_SLOT` for the "Other" row. */
  slot: number;
  /** Number of RENDERED pills this row colours (always ≥ 1 — the gating invariant). */
  count: number;
}

export interface SemColoring {
  /** Rendered key → colour slot (0..5) or `SEM_OTHER_SLOT`. Keys with no community
   *  are absent (they get no dot). */
  slotByKey: Record<string, number>;
  /** Rendered key → its community's human label (the real label even for a grey
   *  folded/Other dot, so the tooltip always carries identity; `"Other"` only for
   *  a true isolate whose community has no row). Absent for keys with no dot. */
  labelByKey: Record<string, string>;
  /** Community id → colour slot (0..5); folded communities are absent (⇒ Other). */
  slotByCommunity: Map<string, number>;
  /** Legend rows: coloured communities (slot ≥ 0) that colour ≥ 1 rendered pill,
   *  in slot order, then a single "Other" row when any rendered pill is grey. */
  legend: SemLegendRow[];
  /** True when ≥ 1 rendered pill lands in the neutral "Other" bucket. */
  hasOther: boolean;
}

/**
 * Assign fixed community colours against the RENDERED node set (not the full
 * index). The top `SEM_COLOR_SLOTS` communities by rendered-pill count get a
 * distinct slot; the rest — plus huginn isolates whose community has no row —
 * fold into slot -1 ("Other").
 *
 * CRITICAL (legend gating): the legend is built ONLY from communities colouring
 * ≥ 1 rendered pill. The server's index-level orphan filter is NOT sufficient —
 * a community whose members are all capped out of the rendered projection
 * survives it, colours zero pills, and its dim-others click would dim
 * everything. Ranking + the legend both key off `renderedCount`, so a
 * zero-rendered community never gets a slot or a row.
 *
 * @param overlay        the payload's `semantic` overlay.
 * @param renderedKeys   the keys with a live DOM pill (the capped projection).
 */
export function computeColoring(
  overlay: SemanticOverlay,
  renderedKeys: Iterable<string>,
): SemColoring {
  const renderedSet = renderedKeys instanceof Set ? renderedKeys : new Set(renderedKeys);
  const communityById = new Map(overlay.communities.map((c) => [c.id, c] as const));

  // Rendered-pill count per COLOURABLE community (one with a communities row).
  const renderedCount = new Map<string, number>();
  for (const key of renderedSet) {
    const cid = overlay.nodeCommunity[key];
    if (cid == null) continue;
    if (communityById.has(cid)) renderedCount.set(cid, (renderedCount.get(cid) ?? 0) + 1);
  }

  // Rank by rendered-pill count (desc), id asc as a deterministic tie-break, so the
  // most-visible clusters get the distinct colours. Top-6 get slots 0..5.
  const ranked = [...renderedCount.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const slotByCommunity = new Map<string, number>();
  ranked.forEach(([cid], i) => {
    if (i < SEM_COLOR_SLOTS) slotByCommunity.set(cid, i);
  });

  const slotByKey: Record<string, number> = Object.create(null);
  const labelByKey: Record<string, string> = Object.create(null);
  let otherCount = 0;
  for (const key of renderedSet) {
    const cid = overlay.nodeCommunity[key];
    if (cid == null) continue; // no community ⇒ no dot
    const slot = slotByCommunity.has(cid) ? slotByCommunity.get(cid)! : SEM_OTHER_SLOT;
    slotByKey[key] = slot;
    // Real community label even for a grey dot (identity never colour-alone);
    // a true isolate (no community row) has none, so it reads "Other".
    labelByKey[key] = communityById.get(cid)?.label ?? "Other";
    if (slot === SEM_OTHER_SLOT) otherCount++;
  }

  const legend: SemLegendRow[] = ranked
    .filter(([cid]) => slotByCommunity.has(cid))
    .map(([cid, n]) => ({
      id: cid,
      label: communityById.get(cid)!.label,
      slot: slotByCommunity.get(cid)!,
      count: n,
    }))
    .sort((a, b) => a.slot - b.slot);

  const hasOther = otherCount > 0;
  if (hasOther) {
    legend.push({ id: SEM_OTHER_ID, label: "Other", slot: SEM_OTHER_SLOT, count: otherCount });
  }

  return { slotByKey, labelByKey, slotByCommunity, legend, hasOther };
}

export interface SemNeighbor {
  key: string;
  sim: number;
  /** Colour slot of the NEIGHBOUR's community (edges are stroked in it). */
  slot: number;
}

export interface SemNeighborResult {
  /** Neighbours ≥ threshold that ARE rendered (drawable dashed edges), sim desc. */
  rendered: SemNeighbor[];
  /** Neighbours ≥ threshold capped out of the rendered projection — the honest
   *  "+N similar not shown" count next to the selection. */
  hidden: number;
}

/**
 * Semantic neighbours of `key` at `threshold`, split into drawable (rendered) and
 * hidden (capped out). Edges can only be drawn to RENDERED nodes; a neighbour
 * with no live pill is counted into `hidden`, never silently dropped.
 */
export function neighborsFor(
  overlay: SemanticOverlay,
  key: string,
  threshold: number,
  renderedKeys: Iterable<string>,
  slotByKey: Record<string, number>,
): SemNeighborResult {
  const renderedSet = renderedKeys instanceof Set ? renderedKeys : new Set(renderedKeys);
  const rendered: SemNeighbor[] = [];
  let hidden = 0;
  for (const [a, b, sim] of overlay.edges) {
    if (sim < threshold) continue;
    let other: string;
    if (a === key) other = b;
    else if (b === key) other = a;
    else continue;
    if (renderedSet.has(other)) {
      rendered.push({ key: other, sim, slot: slotByKey[other] ?? SEM_OTHER_SLOT });
    } else {
      hidden++;
    }
  }
  rendered.sort((x, y) => y.sim - x.sim);
  return { rendered, hidden };
}
