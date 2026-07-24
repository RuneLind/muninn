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
  /** emitKey → page type, for EVERY overlay node incl. pages capped out of the
   *  rendered columns and excluded types (explainers). Populated by the server
   *  join (`src/wiki/atlas-semantic.ts`); optional so old payloads / test fixtures
   *  without it degrade (cluster rail then withholds the candidate badge). */
  nodeType?: Record<string, string>;
  /** emitKey → page tags, same population as `nodeType` — feeds the cluster rail's
   *  top-2 informative-tag label over the FULL graph (not just rendered pills). */
  nodeTags?: Record<string, string[]>;
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

// ── Cluster rail (PR 3) ──────────────────────────────────────────────────────
/**
 * The cluster rail is the consolidation-gardener instrument: a union-find over the
 * FULL index-resolved semantic graph (`overlay.edges` — every page incl. those
 * capped out of the rendered columns AND excluded types like explainers) AT the
 * current similarity threshold. Distinct on purpose from the FIXED Louvain
 * `communities` legend — components recompute every time the slider moves, so the
 * rail header says "Clusters at threshold" while the legend says "Communities".
 *
 * Follow-up seam (no code): each `candidate` cluster is exactly the input shape a
 * future consolidation-gardener "Draft synthesis" button would post into the
 * `wiki_proposals` gate — `{ members, label }` → one clustered proposal.
 */

/** Tags too generic to make a useful cluster/community label. SINGLE source of
 *  truth — the server (`src/wiki/atlas-semantic.ts`) imports this same set for its
 *  community label rule, so the exclusion list lives in exactly one place. */
export const GENERIC_TAGS = new Set(["plan", "wiki", "blog"]);

/** A component must reach this many members to earn a rail row (drops singleton /
 *  pair noise). Also the narrative-member floor for the synthesis-candidate badge. */
export const RAIL_MIN_MEMBERS = 3;
/** Above this size a component is a blob — render header + count + a "raise the
 *  threshold" note, NO member list, NO badge. */
export const RAIL_BLOB_MAX = 40;

/**
 * Page-type → consolidation role, keyed by TYPE (never a folder name). Covers BOTH
 * per-wiki ontologies at once — mimir (`plan`/`report` narrative, `blog`/`subsystem`
 * synthesis) and default wikis (`source`/`analysis` narrative, `concept` synthesis).
 * The two ontologies' type names are disjoint, so one static map serves both without
 * needing the wiki's typeMap client-side. A type absent from the map is neither.
 */
export const CLUSTER_ROLE_BY_TYPE: Record<string, "narrative" | "synthesis"> = {
  plan: "narrative",
  report: "narrative",
  blog: "synthesis",
  subsystem: "synthesis",
  source: "narrative",
  analysis: "narrative",
  concept: "synthesis",
};

export interface RailCluster {
  /** Stable id = the lexicographically smallest member key (== union-find root). */
  id: string;
  /** All member emitKeys, sorted asc — every row deep-links regardless of rendering. */
  members: string[];
  size: number;
  /** Top-2 informative tags (`a + b`), else the smallest member's stem. Empty when tooBroad. */
  label: string;
  /** Synthesis candidate: ≥ RAIL_MIN_MEMBERS narrative-type members AND zero synthesis-type. */
  candidate: boolean;
  /** Blob guard tripped (size > RAIL_BLOB_MAX): no member list, no badge. */
  tooBroad: boolean;
}

/** Basename without a wiki extension — the display label for a rail member row and
 *  the label fallback when a cluster has no informative tags. */
export function stemOf(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.(md|mdx|html)$/i, "");
}

/**
 * A cluster's label: the top-2 most frequent NON-generic tags across its members
 * (each tag counted once per member), `a + b`. Ties break alphabetically. Empty
 * string when no informative tag survives — the caller falls back to a member stem.
 */
export function clusterLabel(memberTagLists: string[][]): string {
  const freq = new Map<string, number>(); // lowercased tag → member count
  const display = new Map<string, string>(); // lowercased tag → first-seen display form
  for (const list of memberTagLists) {
    const seen = new Set<string>();
    for (const raw of list ?? []) {
      const t = (raw ?? "").trim();
      if (!t) continue;
      const lc = t.toLowerCase();
      if (GENERIC_TAGS.has(lc) || seen.has(lc)) continue;
      seen.add(lc);
      freq.set(lc, (freq.get(lc) ?? 0) + 1);
      if (!display.has(lc)) display.set(lc, t);
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 2)
    .map(([lc]) => display.get(lc)!)
    .join(" + ");
}

/**
 * Union-find components of the overlay's semantic graph AT `threshold`, as rail
 * clusters. Only edges with `sim >= threshold` union; a node with no qualifying
 * edge is a singleton dropped by the `>= RAIL_MIN_MEMBERS` filter. Clusters are
 * sorted by size desc (id asc tie-break). Pure — recompute freely on slider change.
 */
export function computeClusters(overlay: SemanticOverlay, threshold: number): RailCluster[] {
  const parent = new Map<string, string>();
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: string, b: string) => {
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the lexicographically smaller root so `id` is stable + deterministic.
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };

  for (const [a, b, sim] of overlay.edges) {
    if (sim < threshold) continue;
    union(a, b);
  }

  const groups = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    (groups.get(root) ?? groups.set(root, []).get(root)!).push(node);
  }

  const nodeType = overlay.nodeType ?? {};
  const nodeTags = overlay.nodeTags ?? {};
  const clusters: RailCluster[] = [];
  for (const raw of groups.values()) {
    if (raw.length < RAIL_MIN_MEMBERS) continue;
    const members = raw.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const size = members.length;
    const tooBroad = size > RAIL_BLOB_MAX;
    let label = "";
    let candidate = false;
    if (!tooBroad) {
      label = clusterLabel(members.map((m) => nodeTags[m] ?? [])) || stemOf(members[0]!);
      let narrative = 0;
      let synthesis = 0;
      for (const m of members) {
        const role = CLUSTER_ROLE_BY_TYPE[nodeType[m] ?? ""];
        if (role === "narrative") narrative++;
        else if (role === "synthesis") synthesis++;
      }
      candidate = narrative >= RAIL_MIN_MEMBERS && synthesis === 0;
    }
    clusters.push({ id: members[0]!, members, size, label, candidate, tooBroad });
  }
  clusters.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return clusters;
}
