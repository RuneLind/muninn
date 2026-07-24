/**
 * Semantic overlay join for the `/wiki` Atlas tab — a PURE transform that fuses
 * huginn's per-collection similarity graphs onto the wiki's page index.
 *
 * Where `projectAtlas` (atlas.ts) derives the WIKILINK graph from the index, this
 * layer adds the SEMANTIC graph: huginn computes a similarity graph + Louvain
 * communities per search collection; we union those graphs across a wiki's
 * collections and resolve every huginn doc id back onto an index page.
 *
 * ── Two keys, deliberately distinct ─────────────────────────────────────────
 * Huginn doc ids are wiki-relative paths in ORIGINAL case + possibly NFC
 * (`plans/Foo Bar.md`), while the atlas `nodes` map + the client DOM lookup key
 * pages by the store's bare `normalizeRelPath` (posix + lowercase, NFD preserved
 * on macOS). So we MATCH on `coverageKey` (normalizeRelPath + NFC fold — the same
 * key index-coverage uses, which stops macOS-NFD vs huginn-NFC Norwegian names
 * from silently missing) but EMIT the matched page's bare `normalizeRelPath`. A
 * huginn id matching no index page (blogs, src/ pipeline sources, deleted docs)
 * is dropped.
 *
 * ── Community namespacing ────────────────────────────────────────────────────
 * Each collection's Louvain community ids restart at 0, so a multi-collection
 * union MUST namespace them as `<collection>:<id>` — otherwise two collections'
 * community 0 would collide. Isolate nodes carry a community id ≥ the community
 * count with NO entry in the communities list; those node assignments are KEPT
 * (the client renders them as a neutral "Other"), they just contribute no legend
 * row.
 */

import { GENERIC_TAGS } from "../dashboard/views/components/wiki-atlas-semantic.ts";
import { coverageKey } from "./index-coverage.ts";
import { normalizeRelPath, type WikiPageMeta } from "./store.ts";

// ── Huginn similarity-graph shape (GET /api/collection/<c>/similarity-graph) ──

export interface SimGraphNode {
  /** Wiki-relative doc id (original case, possibly NFC). */
  id: string;
  /** Louvain community id — restarts at 0 per collection; ≥ community count for isolates. */
  community?: number;
}

export interface SimGraphEdge {
  source: string;
  target: string;
  similarity: number;
}

export interface SimGraphCommunityTag {
  tag: string;
  count: number;
}

export interface SimGraphCommunity {
  id: number;
  name?: string;
  size?: number;
  top_tags?: SimGraphCommunityTag[];
  representative_docs?: string[];
}

export interface SimilarityGraph {
  nodes: SimGraphNode[];
  edges: SimGraphEdge[];
  communities: SimGraphCommunity[];
}

// ── Emitted overlay shape (attached to AtlasPayload.semantic) ────────────────

export interface SemanticCommunity {
  /** Namespaced `<collection>:<huginnId>`. */
  id: string;
  size: number;
  /** Human label derived from top_tags (server-side; huginn's `name` is ugly). */
  label: string;
  tags: string[];
}

export interface SemanticOverlay {
  /** `[emitKeyA, emitKeyB, similarity]`, both ends resolved to index pages,
   *  deduped per unordered pair keeping the max similarity. */
  edges: [string, string, number][];
  /** Namespaced communities referenced by ≥1 node (orphan rows filtered out). */
  communities: SemanticCommunity[];
  /** emitKey → namespaced community id (isolate ids with no community row survive). */
  nodeCommunity: Record<string, string>;
  /** emitKey → page type — for EVERY overlay node (edge endpoint or community
   *  member), incl. pages capped out of the rendered columns and excluded types.
   *  Feeds PR 3's client cluster rail (synthesis-candidate badge type-set map). */
  nodeType: Record<string, string>;
  /** emitKey → page tags, same population as `nodeType` — feeds the cluster rail's
   *  top-2 informative-tag label over the FULL graph. */
  nodeTags: Record<string, string[]>;
}

function stripExt(s: string): string {
  return s.replace(/\.(md|mdx|html)$/i, "");
}

/**
 * A community's display label: the top-2 non-generic `top_tags`, else the first
 * `representative_docs` stem, else huginn's `name`, else the raw id. Computed
 * server-side because huginn's `name` (`"muninn + plan: index"`) is noisy.
 */
function communityLabel(c: SimGraphCommunity): string {
  const tags = (c.top_tags ?? [])
    .map((t) => t?.tag)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .filter((t) => !GENERIC_TAGS.has(t.toLowerCase()))
    .slice(0, 2);
  if (tags.length > 0) return tags.join(" + ");
  const rep = (c.representative_docs ?? [])[0];
  if (rep) return stripExt(rep);
  return c.name ?? `community ${c.id}`;
}

/**
 * Join huginn similarity graphs onto the wiki index. Pure — no I/O.
 *
 * @param indexPages          the FULL index page list (NOT the capped rendered
 *                            node set — the join must see every page so an edge
 *                            to an off-screen page still resolves).
 * @param graphsByCollection  one similarity graph per successfully-fetched
 *                            collection (a failed collection is simply absent).
 * @param collectionsOrder    the wiki's `collections` order — the DETERMINISTIC
 *                            tie-break for a page present in multiple graphs
 *                            (first collection wins), independent of fetch order.
 * @returns the overlay, or null when there's nothing to attach (no graphs, or no
 *          huginn id resolved to an index page).
 */
export function joinSemantic(
  indexPages: WikiPageMeta[],
  graphsByCollection: Map<string, SimilarityGraph>,
  collectionsOrder: string[],
): SemanticOverlay | null {
  if (graphsByCollection.size === 0) return null;

  // Match key (NFC-folded) → emit key (bare normalizeRelPath, the atlas node key).
  const emitByMatch = new Map<string, string>();
  // Emit key → its page's type + tags (for the client cluster rail — populated for
  // every overlay node below, incl. capped-out + excluded-type pages).
  const metaByEmit = new Map<string, WikiPageMeta>();
  for (const p of indexPages) {
    const emit = normalizeRelPath(p.relPath);
    emitByMatch.set(coverageKey(p.relPath), emit);
    metaByEmit.set(emit, p);
  }
  const resolve = (id: string): string | undefined => emitByMatch.get(coverageKey(id));

  const nodeCommunity: Record<string, string> = Object.create(null);
  const communityMeta = new Map<string, SemanticCommunity>();
  // Unordered pair key → [lo, hi, maxSim].
  const edgeMax = new Map<string, [string, string, number]>();

  // Iterate in the wiki's declared collections order so the tie-break (first
  // collection wins) is deterministic regardless of fetch/Map insertion order.
  for (const collection of collectionsOrder) {
    const graph = graphsByCollection.get(collection);
    if (!graph) continue;

    for (const c of graph.communities ?? []) {
      const nsId = `${collection}:${c.id}`;
      if (!communityMeta.has(nsId)) {
        communityMeta.set(nsId, {
          id: nsId,
          size: c.size ?? 0,
          label: communityLabel(c),
          tags: (c.top_tags ?? [])
            .map((t) => t?.tag)
            .filter((t): t is string => typeof t === "string"),
        });
      }
    }

    for (const n of graph.nodes ?? []) {
      if (typeof n.community !== "number") continue;
      const emit = resolve(n.id);
      if (!emit) continue; // huginn id with no index page — dropped
      if (Object.hasOwn(nodeCommunity, emit)) continue; // earlier collection wins
      nodeCommunity[emit] = `${collection}:${n.community}`;
    }

    for (const e of graph.edges ?? []) {
      const a = resolve(e.source);
      const b = resolve(e.target);
      if (!a || !b || a === b) continue;
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const key = `${lo}\u0000${hi}`;
      const existing = edgeMax.get(key);
      if (!existing || e.similarity > existing[2]) {
        edgeMax.set(key, [lo, hi, e.similarity]);
      }
    }
  }

  // Orphan filter: drop community rows no surviving node points at — otherwise
  // the legend shows dangling rows. NOTE: this is an INDEX-level filter only; a
  // community that survives here can still color ZERO *rendered* pills because the
  // atlas node set is capped (TYPE_CAP_TOP etc.). PR 2 handles the client legend
  // against the rendered node set — do not conflate the two.
  const referenced = new Set(Object.values(nodeCommunity));
  const communities = [...communityMeta.values()].filter((c) => referenced.has(c.id));

  const edges = [...edgeMax.values()];
  if (edges.length === 0 && Object.keys(nodeCommunity).length === 0) return null;

  // Per-node type + tags for every emitKey the overlay references (edge endpoints
  // + community members). Bounded by the overlay, not the whole index. The rail's
  // union-find only needs edge endpoints; community keys are included so a
  // dim-others node still resolves its type/tags.
  const nodeType: Record<string, string> = Object.create(null);
  const nodeTags: Record<string, string[]> = Object.create(null);
  const attach = (emit: string) => {
    if (Object.hasOwn(nodeType, emit)) return;
    const meta = metaByEmit.get(emit);
    if (!meta) return;
    nodeType[emit] = meta.type;
    nodeTags[emit] = meta.tags;
  };
  for (const [lo, hi] of edges) {
    attach(lo);
    attach(hi);
  }
  for (const emit of Object.keys(nodeCommunity)) attach(emit);

  return { edges, communities, nodeCommunity, nodeType, nodeTags };
}
