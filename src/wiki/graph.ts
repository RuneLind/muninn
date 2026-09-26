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
 *
 * Never drawn: bookkeeping pages (`isMetaStem` — index, log, CLAUDE; `log.md`
 * names every PR and would fan out to everything), and session refs that are
 * not an id shape (`isSessionIdShape`), which the ledger would refuse anyway.
 */

import type { WikiIndex, WikiPageMeta } from "./store.ts";
import { echoQuery, enrichSessions, parsePrRef, parseSessionRef, type ProvenanceMerge } from "./provenance.ts";
import { dedupeSessionRefs, type ProvenanceContext } from "./provenance-service.ts";
import {
  fetchMergesForSessions,
  fetchSessionsById,
  isSessionIdShape,
  type MergeLedgerResult,
  type SessionLedgerResult,
} from "./session-ledger.ts";
import { isMetaStem, pageStemOf, pageTimeMs } from "../dashboard/views/components/wiki-filter.ts";
import { trackerAdapter } from "./trackers/index.ts";
import { countingPageCount, coveringPlans, isPlanPage, issueKeyId } from "./trackers/rows.ts";
import { relationsCount, type IssueKeyEntry, type TrackerConfig } from "./trackers/types.ts";
import {
  GRAPH_EDGES_MAX,
  GRAPH_LANES,
  GRAPH_NODES_MAX,
  GRAPH_SESSIONS_MAX,
  lanesForLevel,
  parseIssueRoot,
  type GraphCap,
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
  merges: (bareIds: string[]) => Promise<MergeLedgerResult>;
  facts: (bareIds: string[]) => Promise<SessionLedgerResult>;
  /** The caller's deadline fired — read once the walk is done. */
  timedOut: () => boolean;
}

/** The production port: the provenance join's own ledger client, under the
 *  caller's `signal` (the deadline, and the client's own disconnect). */
export function graphLedgerPort(
  ctx: ProvenanceContext,
  signal?: AbortSignal,
  deadline?: AbortSignal,
): GraphLedgerPort {
  return {
    configured: ctx.sessionLedger.urlConfigured,
    publicUrl: ctx.publicUrl,
    merges: (ids) => fetchMergesForSessions(ctx.sessionLedger, ids, signal),
    facts: (ids) => fetchSessionsById(ctx.sessionLedger, ids, signal),
    timedOut: () => deadline?.aborted === true,
  };
}

type GraphResult = { ok: true; payload: GraphPayload } | { ok: false; status: 400 | 404; error: string };

const bareId = (ref: string): string => parseSessionRef(ref).id;

const issueId = (tracker: string, key: string) => `issue:${issueKeyId(tracker, key)}`;
const pageId = (relPath: string) => `page:${relPath}`;
const sessionId = (bare: string) => `session:${bare}`;
const prId = (ref: string) => `pr:${ref.toLowerCase()}`;

/** A bookkeeping page (`index`, `log`, `CLAUDE`): never a graph node. */
const isBookkeeping = (page: { relPath: string }): boolean => isMetaStem(pageStemOf(page.relPath));

/** A page's stamped session refs that can be session ids at all. */
const stampedSessionRefs = (page: WikiPageMeta): string[] =>
  dedupeSessionRefs(page.sessions ?? []).filter((ref) => isSessionIdShape(bareId(ref)));

const GITHUB_PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([0-9]+)(?:[/?#].*)?$/;
const PR_COORDINATE = /^[A-Za-z0-9._-]+\/([A-Za-z0-9._-]+)#([0-9]+)$/;

/** `<repo basename>#n`, lowercased — the part of a PR's identity a URL-less
 *  merge row and a page's `owner/repo#n` share. */
const prBasenameKey = (repo: string, n: number | string): string => `${repo.toLowerCase()}#${n}`;

/**
 * The PRs the wiki's pages name, keyed by {@link prBasenameKey}: each key → the
 * page's `owner/repo#n` as first seen, or null when two pages name two
 * DIFFERENT owners for it (a fork, or two repos sharing a name) — then no
 * merge row is resolved onto either.
 */
export function knownPrRefs(pages: readonly { prRefs?: string[] }[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const page of pages) {
    for (const ref of page.prRefs ?? []) {
      const m = PR_COORDINATE.exec(ref.trim());
      if (!m) continue;
      const k = prBasenameKey(m[1]!, m[2]!);
      const seen = out.get(k);
      if (seen === undefined) out.set(k, ref.trim());
      else if (seen !== null && seen.toLowerCase() !== ref.trim().toLowerCase()) out.set(k, null);
    }
  }
  return out;
}

/**
 * A merge row's PR as `owner/repo#n`: from its URL; else the PR a page names
 * with the same repo basename and number (case-insensitive, `known`); else
 * `<repo dir>#n`. Null for a bare merge with no PR number, which names no PR.
 *
 * The middle step is what keeps one PR one node: the ledger answers `url: null`
 * for a repo its own map does not name, and its `repo` is a checkout path, so
 * without it the page's `owner/repo#n` and the row's `<dir>#n` were two nodes.
 */
export function mergePrRef(merge: ProvenanceMerge, known?: ReadonlyMap<string, string | null>): string | null {
  const m = merge.url ? GITHUB_PR_URL.exec(merge.url) : null;
  if (m) return `${m[1]}/${m[2]}#${m[3]}`;
  if (merge.prNumber === null) return null;
  const dir = merge.repo.split("/").filter(Boolean).pop() || "unknown";
  return known?.get(prBasenameKey(dir, merge.prNumber)) ?? `${dir}#${merge.prNumber}`;
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
): Promise<GraphResult> {
  const trackers = index.readerConfig?.trackers ?? [];
  if (!trackers.length) return { ok: false, status: 404, error: "this wiki names no tracker" };
  const configOf = new Map<string, TrackerConfig>(trackers.map((t) => [t.id, t]));
  const planConfig = trackers[0]!;
  const lanes = new Set<GraphLane>(lanesForLevel(query.level));
  const keyMap: ReadonlyMap<string, IssueKeyEntry> = index.issueKeys ?? new Map();
  const knownPrs = lanes.has("pr") ? knownPrRefs(index.pages) : new Map<string, string | null>();

  // Reverse maps, built only for the lanes this level draws.
  const pagesBySession = new Map<string, WikiPageMeta[]>();
  const pagesByPr = new Map<string, WikiPageMeta[]>();
  for (const page of index.pages) {
    if (isBookkeeping(page)) continue;
    if (lanes.has("session")) {
      for (const ref of stampedSessionRefs(page)) {
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
    const entry = keyMap.get(issueKeyId(tracker, key));
    return {
      id: issueId(tracker, key),
      lane: "issue",
      tracker,
      key,
      label: adapter?.label ?? tracker,
      url: adapter ? adapter.urlFor(key, config) : "",
      pageCount: countingPageCount(entry),
      planPages: coveringPlans(entry),
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
  const prInfo = new Map<string, { subject?: string; mergedAt?: string; confirmed: boolean }>();
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
  let mergesPartial = false;
  let mergesTruncated = false;
  const askMerges = async (bareIds: string[]) => {
    const ask = bareIds.filter((id) => !askedMerges.has(id));
    if (!ask.length || !port.configured || !lanes.has("pr")) return;
    for (const id of ask) askedMerges.add(id);
    const res = await port.merges(ask);
    // The facts leg's rule: a leg that sent nothing says nothing about the ledger.
    if (res.asked) ledgerAsked = true;
    if (res.asked && !res.reachable) ledgerReachable = false;
    if (res.partial) mergesPartial = true;
    if (res.truncated) mergesTruncated = true;
    for (const merge of res.merges) {
      const ref = mergePrRef(merge, knownPrs);
      if (!ref) continue;
      const list = prsBySession.get(merge.sessionId) ?? [];
      if (!list.some((r) => prId(r) === prId(ref))) list.push(ref);
      prsBySession.set(merge.sessionId, list);
      const set = sessionsByPr.get(prId(ref)) ?? new Set<string>();
      set.add(merge.sessionId);
      sessionsByPr.set(prId(ref), set);
      const info = prInfo.get(prId(ref)) ?? { confirmed: false };
      if (merge.mergeOk) info.confirmed = true;
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
      const entry = keyMap.get(issueKeyId(node.tracker, node.key));
      for (const p of entry?.pages ?? []) {
        if (!relationsCount(p.relations)) continue;
        const page = index.resolveRelPath(p.relPath);
        if (!page || isBookkeeping(page)) continue;
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
        for (const ref of stampedSessionRefs(page)) {
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
        if (!isSessionIdShape(bare)) continue;
        const id = sessionId(bare);
        const ref = sessionRefs.get(bare) ?? bare;
        out.push({ id, lane: "session", make: () => sessionNode(ref), edge: edgeOf(node.id, "pr", id, "session") });
      }
    }
    return out.filter((n) => lanes.has(n.lane));
  };

  // ── Caps ──────────────────────────────────────────────────────────────────
  const truncatedBy = new Set<GraphCap>();
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
    if (edges.has(k)) return;
    if (edges.size >= GRAPH_EDGES_MAX) {
      truncatedBy.add("edges");
      return;
    }
    edges.set(k, edge);
  };

  // ── Roots ─────────────────────────────────────────────────────────────────
  const roots: Omit<GraphNode, "hop">[] = [];
  let rootEcho = query.root;
  if (query.scope === "page") {
    const page = index.resolveRelPath(query.root);
    if (!page) return { ok: false, status: 404, error: `no wiki page for relPath "${echoQuery(query.root)}"` };
    if (isBookkeeping(page)) {
      return { ok: false, status: 404, error: `"${echoQuery(page.relPath)}" is a bookkeeping page, which the graph never draws` };
    }
    rootEcho = page.relPath;
    roots.push(pageNode(page));
  } else if (query.scope === "issue") {
    const parsed = parseIssueRoot(query.root);
    if (!parsed) return { ok: false, status: 400, error: `root "${echoQuery(query.root)}" is not tracker:KEY` };
    const adapter = configOf.has(parsed.tracker) ? trackerAdapter(parsed.tracker) : undefined;
    const key = adapter ? adapter.parseKey(parsed.key) : null;
    if (adapter && !key) {
      return { ok: false, status: 400, error: `root "${echoQuery(query.root)}" is not a ${adapter.label} key` };
    }
    const entry = key ? keyMap.get(issueKeyId(parsed.tracker, key)) : undefined;
    if (!key || !entry || countingPageCount(entry) === 0) {
      return { ok: false, status: 404, error: "no page in this wiki relates to that issue" };
    }
    rootEcho = `${parsed.tracker}:${key}`;
    roots.push(issueNode(parsed.tracker, key));
  } else if (query.scope === "series") {
    const members = index.pages
      .filter((p) => p.series === query.root && !isBookkeeping(p))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    if (!members.length) return { ok: false, status: 404, error: `no series "${echoQuery(query.root)}" in this wiki` };
    for (const p of members) roots.push(pageNode(p));
  } else {
    const keys = [...keyMap.values()]
      .filter((e) => configOf.has(e.tracker) && countingPageCount(e) > 0)
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
          // A new node needs a new edge: past the edge cap it would be drawn
          // with nothing connecting it to the node that reached it.
          if (edges.size >= GRAPH_EDGES_MAX) {
            truncatedBy.add("edges");
            continue;
          }
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
        // The ledger's own JSON: a field that is not the type it should be is
        // null here rather than a crash in the reader's card.
        first: typeof chip.first === "string" ? chip.first : null,
        last: typeof chip.last === "string" ? chip.last : null,
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
    if (info && !info.confirmed) n.mergeUnconfirmed = true;
  }

  // ── The board's index-local opt-ins (`scope=wiki` only) ──────────────────
  if (query.issueFields) {
    for (const n of nodes.values()) if (n.lane === "issue") Object.assign(n, issueAggregates(keyMap.get(issueKeyId(n.tracker, n.key)), index));
  }
  let keylessPages: GraphPageNode[] | undefined;
  let keylessTruncated = false;
  if (query.keyless) {
    const keyless = index.pages
      .filter((p) => !isBookkeeping(p) && !(p.issues ?? []).some((r) => configOf.has(r.tracker) && relationsCount(r.relations)))
      .map((p) => ({ ...pageNode(p), hop: 0 }) as GraphPageNode)
      .sort((a, b) => b.pageTimeMs - a.pageTimeMs || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    keylessTruncated = keyless.length > GRAPH_NODES_MAX;
    keylessPages = keyless.slice(0, GRAPH_NODES_MAX);
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
        timedOut: port.timedOut(),
        mergesPartial,
        mergesTruncated,
      },
      ...(keylessPages ? { keylessPages } : {}),
      ...(keylessTruncated ? { keylessTruncated: true as const } : {}),
    },
  };
}

/**
 * A key's board columns that need no network: over its counting,
 * non-bookkeeping pages in the whole wiki — never the drawn edges, which the
 * caps can cut.
 */
export function issueAggregates(
  entry: IssueKeyEntry | undefined,
  index: Pick<WikiIndex, "resolveRelPath">,
): Required<Pick<GraphIssueNode, "stampedCount" | "lastActivityMs" | "prRefs">> {
  let stampedCount = 0;
  let lastActivityMs = 0;
  const prs = new Map<string, string>();
  for (const p of entry?.pages ?? []) {
    if (!relationsCount(p.relations)) continue;
    const page = index.resolveRelPath(p.relPath);
    if (!page || isBookkeeping(page)) continue;
    if (p.relations.includes("stamped")) stampedCount++;
    lastActivityMs = Math.max(lastActivityMs, pageTimeMs(page));
    for (const ref of page.prRefs ?? []) if (!prs.has(ref.toLowerCase())) prs.set(ref.toLowerCase(), ref);
  }
  const prRefs = [...prs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, ref]) => ref);
  return { stampedCount, lastActivityMs, prRefs };
}
