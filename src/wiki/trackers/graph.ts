/**
 * The walk behind `GET /api/wiki/graph`: a breadth-first search from the root
 * over four edge kinds, restricted to the lanes the level draws.
 *
 *  - **issue–page**: the key map (`index.issueKeys`), counting relations only.
 *    A key whose only relations to a page are `link`/`mention` is no edge.
 *  - **page–session**: the page's stamped `sessions:` line — the only source of
 *    sessions. A ledger-side session the page never stamped is not drawn.
 *  - **page–PR**: the page's `prRefs` (stamped `prs:` plus PR links in the
 *    body), so a PR is one hop from its page with no session stamped.
 *  - **session–PR**: `GET /api/merges?sessions=` for the sessions the walk
 *    EXPANDS. A session at the last hop is not asked, so an edge from it to a
 *    PR already drawn is not found.
 *
 * Everything but the two ledger reads is index-local. The ledger is behind a
 * port so the walk unit-tests with no claude-usage.
 */

import type { WikiIndex, WikiPageMeta } from "../store.ts";
import { enrichSessions, parsePrRef, type ProvenanceMerge } from "../provenance.ts";
import { dedupeSessionRefs, type ProvenanceContext } from "../provenance-service.ts";
import {
  fetchMergesForSessions,
  fetchSessionsById,
  type SessionLedgerResult,
} from "../session-ledger.ts";
import { pageTimeMs } from "../../dashboard/views/components/wiki-filter.ts";
import { trackerAdapter } from "./index.ts";
import { isPlanPage } from "./rows.ts";
import { COVERAGE_RELATIONS, relationsCount, type IssueKeyEntry, type TrackerConfig } from "./types.ts";
import {
  GRAPH_LANES,
  GRAPH_NODES_MAX,
  GRAPH_SESSIONS_MAX,
  lanesForLevel,
  parseIssueRoot,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphIssueNode,
  type GraphLane,
  type GraphNode,
  type GraphPageNode,
  type GraphPayload,
  type GraphPrNode,
  type GraphQuery,
  type GraphSessionNode,
} from "./graph-types.ts";

/** The two ledger reads the walk makes, injected. */
export interface GraphLedgerPort {
  /** A claude-usage is configured; false ⇒ neither read is made. */
  configured: boolean;
  publicUrl: string | null;
  merges: (bareIds: string[]) => Promise<{ reachable: boolean; merges: ProvenanceMerge[] }>;
  facts: (bareIds: string[]) => Promise<SessionLedgerResult>;
}

/** The production port: the provenance join's own ledger client, under the
 *  caller's deadline. */
export function graphLedgerPort(ctx: ProvenanceContext, signal?: AbortSignal): GraphLedgerPort {
  return {
    configured: ctx.sessionLedger.urlConfigured,
    publicUrl: ctx.publicUrl,
    merges: (ids) => fetchMergesForSessions(ctx.sessionLedger, ids, signal),
    facts: (ids) => fetchSessionsById(ctx.sessionLedger, ids, signal),
  };
}

export type GraphResult = { ok: true; payload: GraphPayload } | { ok: false; status: 404; error: string };

const bareId = (ref: string): string => {
  const at = ref.indexOf(":");
  return at <= 0 || at === ref.length - 1 ? ref : ref.slice(at + 1);
};

const issueId = (tracker: string, key: string) => `issue:${tracker}:${key}`;
const pageId = (relPath: string) => `page:${relPath}`;
const sessionId = (bare: string) => `session:${bare}`;
const prId = (ref: string) => `pr:${ref.toLowerCase()}`;

const GITHUB_PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([0-9]+)(?:[/?#].*)?$/;

/** A merge row's PR as `owner/repo#n`: from its URL, else `<repo dir>#n`. Null
 *  for a bare merge with no PR number, which names no PR. */
export function mergePrRef(merge: ProvenanceMerge): string | null {
  const m = merge.url ? GITHUB_PR_URL.exec(merge.url) : null;
  if (m) return `${m[1]}/${m[2]}#${m[3]}`;
  if (merge.prNumber === null) return null;
  const dir = merge.repo.split("/").filter(Boolean).pop() || "unknown";
  return `${dir}#${merge.prNumber}`;
}

interface Neighbor {
  id: string;
  lane: GraphLane;
  make: () => Omit<GraphNode, "hop">;
  edge: GraphEdge;
}

const EDGE_ORDER: Record<GraphLane, number> = { issue: 0, page: 1, session: 2, pr: 3 };

/** One edge, oriented left lane → right lane. */
function edgeOf(a: string, aLane: GraphLane, b: string, bLane: GraphLane, relations?: string[]): GraphEdge {
  const [s, sl, t, tl] = EDGE_ORDER[aLane] <= EDGE_ORDER[bLane] ? [a, aLane, b, bLane] : [b, bLane, a, aLane];
  const kind = `${sl}-${tl}` as GraphEdgeKind;
  return { source: s, target: t, kind, ...(relations ? { relations } : {}) };
}

/**
 * Walk the index from the query's root. Never throws; a degraded ledger leaves
 * sessions `unresolved` and draws no session–PR edge.
 */
export async function buildGraph(
  index: Pick<WikiIndex, "pages" | "issueKeys" | "readerConfig" | "resolveRelPath">,
  query: GraphQuery,
  port: GraphLedgerPort,
  signal?: AbortSignal,
): Promise<GraphResult> {
  const trackers = index.readerConfig?.trackers ?? [];
  if (!trackers.length) return { ok: false, status: 404, error: "this wiki names no tracker" };
  const configOf = new Map<string, TrackerConfig>(trackers.map((t) => [t.id, t]));
  const planConfig = trackers[0]!;
  const lanes = new Set<GraphLane>(lanesForLevel(query.level));
  const keyMap: ReadonlyMap<string, IssueKeyEntry> = index.issueKeys ?? new Map();

  // Reverse maps, built only for the lanes this level draws.
  const pagesBySession = new Map<string, WikiPageMeta[]>();
  const pagesByPr = new Map<string, WikiPageMeta[]>();
  for (const page of index.pages) {
    if (lanes.has("session")) {
      for (const ref of dedupeSessionRefs(page.sessions ?? [])) {
        const id = bareId(ref);
        const list = pagesBySession.get(id);
        if (list) list.push(page);
        else pagesBySession.set(id, [page]);
      }
    }
    if (lanes.has("pr")) {
      for (const ref of page.prRefs ?? []) {
        const id = prId(ref);
        const list = pagesByPr.get(id);
        if (list) list.push(page);
        else pagesByPr.set(id, [page]);
      }
    }
  }

  // ── Node builders ─────────────────────────────────────────────────────────
  const issueNode = (tracker: string, key: string): Omit<GraphIssueNode, "hop"> => {
    const config = configOf.get(tracker)!;
    const adapter = trackerAdapter(tracker);
    const entry = keyMap.get(`${tracker}:${key}`);
    const counting = entry ? entry.pages.filter((p) => relationsCount(p.relations)) : [];
    return {
      id: issueId(tracker, key),
      lane: "issue",
      tracker,
      key,
      label: adapter?.label ?? tracker,
      url: adapter ? adapter.urlFor(key, config) : "",
      pageCount: counting.length,
      planPages: (entry?.pages ?? [])
        .filter((p) => p.plan && p.relations.some((r) => (COVERAGE_RELATIONS as readonly string[]).includes(r)))
        .map((p) => ({ relPath: p.relPath, title: p.title })),
    };
  };
  const pageNode = (page: WikiPageMeta): Omit<GraphPageNode, "hop"> => ({
    id: pageId(page.relPath),
    lane: "page",
    relPath: page.relPath,
    title: page.displayTitle || page.title,
    type: page.type,
    pageTimeMs: pageTimeMs(page),
    ...(page.prRefs?.length ? { prRefs: [...page.prRefs] } : {}),
    plan: isPlanPage(page, planConfig),
  });
  const sessionRefs = new Map<string, string>(); // bare → the ref as first stamped
  const sessionNode = (ref: string): Omit<GraphSessionNode, "hop"> => {
    const bare = bareId(ref);
    if (!sessionRefs.has(bare)) sessionRefs.set(bare, ref);
    return {
      id: sessionId(bare),
      lane: "session",
      ref,
      provider: null,
      sessionId: bare,
      title: null,
      cost: null,
      first: null,
      last: null,
      missing: false,
      unresolved: true,
    };
  };
  const prInfo = new Map<string, { subject?: string; mergedAt?: string }>();
  const prNode = (ref: string): Omit<GraphPrNode, "hop"> => ({
    id: prId(ref),
    lane: "pr",
    ref,
    url: parsePrRef(ref).url,
  });

  // ── The merges leg, filled as sessions are expanded ──────────────────────
  const prsBySession = new Map<string, string[]>();
  const sessionsByPr = new Map<string, Set<string>>();
  const askedMerges = new Set<string>();
  let ledgerAsked = false;
  let ledgerReachable = true;
  const askMerges = async (bareIds: string[]) => {
    const ask = bareIds.filter((id) => !askedMerges.has(id));
    if (!ask.length || !port.configured || !lanes.has("pr")) return;
    for (const id of ask) askedMerges.add(id);
    ledgerAsked = true;
    const res = await port.merges(ask);
    if (!res.reachable) ledgerReachable = false;
    for (const merge of res.merges) {
      const ref = mergePrRef(merge);
      if (!ref) continue;
      const list = prsBySession.get(merge.sessionId) ?? [];
      if (!list.some((r) => prId(r) === prId(ref))) list.push(ref);
      prsBySession.set(merge.sessionId, list);
      const set = sessionsByPr.get(prId(ref)) ?? new Set<string>();
      set.add(merge.sessionId);
      sessionsByPr.set(prId(ref), set);
      const info = prInfo.get(prId(ref)) ?? {};
      if (!info.subject && merge.subject) info.subject = merge.subject;
      if (!info.mergedAt && merge.mergedAt) info.mergedAt = merge.mergedAt;
      prInfo.set(prId(ref), info);
    }
  };

  // ── Neighbours ────────────────────────────────────────────────────────────
  const nodes = new Map<string, GraphNode>();
  const neighbors = (node: GraphNode): Neighbor[] => {
    const out: Neighbor[] = [];
    if (node.lane === "issue") {
      const entry = keyMap.get(`${node.tracker}:${node.key}`);
      for (const p of entry?.pages ?? []) {
        if (!relationsCount(p.relations)) continue;
        const page = index.resolveRelPath(p.relPath);
        if (!page) continue;
        out.push({
          id: pageId(page.relPath),
          lane: "page",
          make: () => pageNode(page),
          edge: edgeOf(node.id, "issue", pageId(page.relPath), "page", p.relations.filter((r) => r !== "mention")),
        });
      }
    } else if (node.lane === "page") {
      const page = index.resolveRelPath(node.relPath);
      if (!page) return out;
      for (const ref of page.issues ?? []) {
        if (!configOf.has(ref.tracker) || !relationsCount(ref.relations)) continue;
        const id = issueId(ref.tracker, ref.key);
        out.push({
          id,
          lane: "issue",
          make: () => issueNode(ref.tracker, ref.key),
          edge: edgeOf(node.id, "page", id, "issue", ref.relations.filter((r) => r !== "mention")),
        });
      }
      if (lanes.has("session")) {
        for (const ref of dedupeSessionRefs(page.sessions ?? [])) {
          const id = sessionId(bareId(ref));
          out.push({ id, lane: "session", make: () => sessionNode(ref), edge: edgeOf(node.id, "page", id, "session") });
        }
      }
      if (lanes.has("pr")) {
        for (const ref of page.prRefs ?? []) {
          const id = prId(ref);
          out.push({ id, lane: "pr", make: () => prNode(ref), edge: edgeOf(node.id, "page", id, "pr") });
        }
      }
    } else if (node.lane === "session") {
      for (const page of pagesBySession.get(node.sessionId) ?? []) {
        const id = pageId(page.relPath);
        out.push({ id, lane: "page", make: () => pageNode(page), edge: edgeOf(node.id, "session", id, "page") });
      }
      for (const ref of prsBySession.get(node.sessionId) ?? []) {
        const id = prId(ref);
        out.push({ id, lane: "pr", make: () => prNode(ref), edge: edgeOf(node.id, "session", id, "pr") });
      }
    } else {
      for (const page of pagesByPr.get(node.id) ?? []) {
        const id = pageId(page.relPath);
        out.push({ id, lane: "page", make: () => pageNode(page), edge: edgeOf(node.id, "pr", id, "page") });
      }
      for (const bare of sessionsByPr.get(node.id) ?? []) {
        const id = sessionId(bare);
        const ref = sessionRefs.get(bare) ?? bare;
        out.push({ id, lane: "session", make: () => sessionNode(ref), edge: edgeOf(node.id, "pr", id, "session") });
      }
    }
    return out.filter((n) => lanes.has(n.lane));
  };

  // ── Caps ──────────────────────────────────────────────────────────────────
  const truncatedBy = new Set<"sessions" | "nodes">();
  let sessionCount = 0;
  const addNode = (made: Omit<GraphNode, "hop">, hop: number): boolean => {
    if (nodes.size >= GRAPH_NODES_MAX) {
      truncatedBy.add("nodes");
      return false;
    }
    if (made.lane === "session") {
      if (sessionCount >= GRAPH_SESSIONS_MAX) {
        truncatedBy.add("sessions");
        return false;
      }
      sessionCount++;
    }
    nodes.set(made.id, { ...made, hop } as GraphNode);
    return true;
  };
  const edges = new Map<string, GraphEdge>();
  const addEdge = (edge: GraphEdge) => {
    const k = `${edge.source}\u0001${edge.target}`;
    if (!edges.has(k)) edges.set(k, edge);
  };

  // ── Roots ─────────────────────────────────────────────────────────────────
  const roots: Omit<GraphNode, "hop">[] = [];
  let rootEcho = query.root;
  if (query.scope === "page") {
    const page = index.resolveRelPath(query.root);
    if (!page) return { ok: false, status: 404, error: `no wiki page for relPath "${query.root}"` };
    rootEcho = page.relPath;
    roots.push(pageNode(page));
  } else if (query.scope === "issue") {
    const parsed = parseIssueRoot(query.root);
    const adapter = parsed ? trackerAdapter(parsed.tracker) : undefined;
    const key = parsed && adapter ? adapter.parseKey(parsed.key) : null;
    const entry = parsed && key && configOf.has(parsed.tracker) ? keyMap.get(`${parsed.tracker}:${key}`) : undefined;
    if (!parsed || !key || !entry || !entry.pages.some((p) => relationsCount(p.relations))) {
      return { ok: false, status: 404, error: "no page in this wiki relates to that issue" };
    }
    rootEcho = `${parsed.tracker}:${key}`;
    roots.push(issueNode(parsed.tracker, key));
  } else if (query.scope === "series") {
    const members = index.pages
      .filter((p) => p.series === query.root)
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    if (!members.length) return { ok: false, status: 404, error: `no series "${query.root}" in this wiki` };
    for (const p of members) roots.push(pageNode(p));
  } else {
    const keys = [...keyMap.values()]
      .filter((e) => configOf.has(e.tracker) && e.pages.some((p) => relationsCount(p.relations)))
      .sort((a, b) => (a.tracker + a.key < b.tracker + b.key ? -1 : 1));
    for (const e of keys) roots.push(issueNode(e.tracker, e.key));
  }

  let frontier: GraphNode[] = [];
  for (const r of roots) if (addNode(r, 0)) frontier.push(nodes.get(r.id)!);

  // ── The walk ──────────────────────────────────────────────────────────────
  for (let hop = 0; hop < query.depth && frontier.length; hop++) {
    await askMerges(frontier.filter((n): n is GraphSessionNode => n.lane === "session").map((n) => n.sessionId));
    const next: GraphNode[] = [];
    for (const node of frontier) {
      for (const nb of neighbors(node)) {
        if (!nodes.has(nb.id)) {
          if (!addNode(nb.make(), hop + 1)) continue;
          next.push(nodes.get(nb.id)!);
        }
        addEdge(nb.edge);
      }
    }
    frontier = next;
  }
  // The last hop is never expanded: draw its edges to nodes already drawn.
  for (const node of nodes.values()) {
    if (node.hop < query.depth) continue;
    for (const nb of neighbors(node)) if (nodes.has(nb.id)) addEdge(nb.edge);
  }

  // ── Session facts, one batched read ───────────────────────────────────────
  const sessionNodes = [...nodes.values()].filter((n): n is GraphSessionNode => n.lane === "session");
  if (sessionNodes.length) {
    let result: SessionLedgerResult | null = null;
    if (port.configured) {
      ledgerAsked = true;
      result = await port.facts(sessionNodes.map((n) => n.sessionId));
      if (result.asked && !result.reachable) ledgerReachable = false;
    }
    const chips = enrichSessions(
      sessionNodes.map((n) => n.ref),
      result ?? { facts: new Map(), unresolved: new Set(sessionNodes.map((n) => n.sessionId)) },
      port.publicUrl,
    );
    sessionNodes.forEach((n, i) => {
      const chip = chips[i]!;
      Object.assign(n, {
        provider: chip.provider,
        title: chip.title,
        cost: chip.cost,
        first: chip.first,
        last: chip.last,
        missing: chip.missing,
        unresolved: chip.unresolved || chip.invalid,
        ...(chip.url ? { url: chip.url } : {}),
      });
    });
  }
  for (const n of nodes.values()) {
    if (n.lane !== "pr") continue;
    const info = prInfo.get(n.id);
    if (info?.subject) n.subject = info.subject;
    if (info?.mergedAt) n.mergedAt = info.mergedAt;
  }

  const laneRank = (l: GraphLane) => GRAPH_LANES.indexOf(l);
  const sortKey = (n: GraphNode) =>
    n.lane === "issue" ? n.key : n.lane === "page" ? n.relPath : n.lane === "session" ? n.sessionId : n.ref;
  const outNodes = [...nodes.values()].sort(
    (a, b) => laneRank(a.lane) - laneRank(b.lane) || a.hop - b.hop || (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0),
  );
  const outEdges = [...edges.values()].sort((a, b) =>
    a.source === b.source ? (a.target < b.target ? -1 : 1) : a.source < b.source ? -1 : 1,
  );

  return {
    ok: true,
    payload: {
      scope: query.scope,
      root: rootEcho,
      depth: query.depth,
      level: query.level,
      lanes: GRAPH_LANES.filter((l) => lanes.has(l)),
      nodes: outNodes,
      edges: outEdges,
      ...(truncatedBy.size ? { truncated: true as const, truncatedBy: [...truncatedBy].sort() } : {}),
      ledger: {
        configured: port.configured,
        asked: ledgerAsked,
        reachable: ledgerAsked ? ledgerReachable : false,
        timedOut: signal?.aborted === true,
      },
    },
  };
}
