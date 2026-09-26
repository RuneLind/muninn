/**
 * The wire shape of `GET /api/wiki/graph` and the rules for its query — PURE
 * and dependency-free, so the reader's bundle may import them (the walk itself
 * is `graph.ts`, server-only).
 *
 * Four LANES, left to right: issues, pages, sessions, PRs. `level` picks how
 * many of them a graph draws, `depth` how many hops from the root it walks.
 */

export type GraphLane = "issue" | "page" | "session" | "pr";

/** Every lane, left to right — the order the reader draws them in. */
export const GRAPH_LANES: readonly GraphLane[] = ["issue", "page", "session", "pr"];

export type GraphScope = "page" | "issue" | "series" | "wiki";

const GRAPH_SCOPES: readonly GraphScope[] = ["page", "issue", "series", "wiki"];

/** 1: issues and pages. 2: adds sessions. 3: adds PRs. */
export type GraphLevel = 1 | 2 | 3;

/** The lanes a level draws. */
export function lanesForLevel(level: GraphLevel): GraphLane[] {
  return GRAPH_LANES.slice(0, level + 1);
}

/** The deepest walk a request may ask for. Past four hops a page graph reaches
 *  most of a tracker wiki, which is what `scope=wiki` is for. */
export const GRAPH_DEPTH_MAX = 4;

/** At most this many session nodes per answer; past it the answer says
 *  `truncated`. The facts read is one call per 200 drawn sessions (two at the
 *  cap); merges are asked once per expanded hop that holds sessions, each call
 *  batched by 200 the same way. So this bounds the ledger fan-out one GET buys. */
export const GRAPH_SESSIONS_MAX = 400;

/** At most this many nodes per answer, whatever the lane. A page-scoped graph
 *  stays far below it; the cap is for `series` and `wiki` scope. */
export const GRAPH_NODES_MAX = 1500;

/** At most this many edges per answer, beside the node cap: nodes alone do not
 *  bound the payload, since 1,400 pages that all share one tag set drew 140,000
 *  edges (14.5 MB). Past it the answer says `truncatedBy: ["edges"]`. */
export const GRAPH_EDGES_MAX = 6000;

/** The defaults a scope takes when the query leaves `depth` or `level` out.
 *  `series` and `wiki` default to level 1, which makes no ledger call; a
 *  `wiki` graph with no `depth` walks exactly far enough to reach every lane
 *  its level draws (issues are its roots). */
export function graphDefaults(scope: GraphScope, level?: GraphLevel): { depth: number; level: GraphLevel } {
  if (scope === "page" || scope === "issue") return { depth: 2, level: level ?? 3 };
  if (scope === "series") return { depth: 2, level: level ?? 1 };
  const l = level ?? 1;
  return { depth: l, level: l };
}

export interface GraphQuery {
  scope: GraphScope;
  /** A relPath (`page`), `tracker:KEY` (`issue`, {@link parseIssueRoot}), a series key (`series`);
   *  `""` for `wiki`. */
  root: string;
  depth: number;
  level: GraphLevel;
}

/** Validate the query. Every refusal names the parameter. */
export function parseGraphQuery(q: {
  scope?: string | null;
  root?: string | null;
  depth?: string | null;
  level?: string | null;
}): { ok: true; query: GraphQuery } | { ok: false; error: string } {
  const scopeRaw = (q.scope ?? "").trim() || "page";
  if (!(GRAPH_SCOPES as readonly string[]).includes(scopeRaw)) {
    return { ok: false, error: `scope must be one of ${GRAPH_SCOPES.join(", ")}` };
  }
  const scope = scopeRaw as GraphScope;
  const root = (q.root ?? "").trim();
  if (scope !== "wiki" && !root) return { ok: false, error: `root is required for scope=${scope}` };
  if (scope === "issue" && !parseIssueRoot(root)) {
    return { ok: false, error: "root must be tracker:KEY for scope=issue (a lowercase tracker id, e.g. jira:DEMO-101)" };
  }
  let level: GraphLevel | undefined;
  const levelRaw = (q.level ?? "").trim();
  if (levelRaw) {
    if (!/^[123]$/.test(levelRaw)) return { ok: false, error: "level must be 1, 2 or 3" };
    level = Number(levelRaw) as GraphLevel;
  }
  const defaults = graphDefaults(scope, level);
  let depth = defaults.depth;
  const depthRaw = (q.depth ?? "").trim();
  if (depthRaw) {
    if (!/^[0-9]$/.test(depthRaw) || Number(depthRaw) > GRAPH_DEPTH_MAX) {
      return { ok: false, error: `depth must be 0–${GRAPH_DEPTH_MAX}` };
    }
    depth = Number(depthRaw);
  }
  return { ok: true, query: { scope, root: scope === "wiki" ? "" : root, depth, level: defaults.level } };
}

interface GraphNodeBase {
  /** `issue:<tracker>:<key>`, `page:<relPath>`, `session:<bare id>`,
   *  `pr:<owner/repo#n, lowercased>`. */
  id: string;
  lane: GraphLane;
  /** Hops from the nearest root; 0 on a root. */
  hop: number;
}

export interface GraphIssueNode extends GraphNodeBase {
  lane: "issue";
  tracker: string;
  key: string;
  /** The tracker's name for itself (`Jira`). */
  label: string;
  /** Where a human reads the issue; `""` when the tracker names no host. */
  url: string;
  /** Pages whose relations to the key count, over the whole wiki. */
  pageCount: number;
  /** Plans that cover the key (`COVERAGE_RELATIONS`); empty ⇒ uncovered. */
  planPages: { relPath: string; title: string }[];
}

export interface GraphPageNode extends GraphNodeBase {
  lane: "page";
  relPath: string;
  title: string;
  type: string;
  /** The reader's recency key (`pageTimeMs`, `wiki-filter.ts`); 0 when the page
   *  has no usable date. */
  pageTimeMs: number;
  /** Every PR the page names (`WikiPageMeta.prRefs`), at every level — present
   *  even when the PR lane is not drawn. Absent when it names none. */
  prRefs?: string[];
  /** A plan under the wiki's first tracker config (`isPlanPage`). */
  plan: boolean;
}

export interface GraphSessionNode extends GraphNodeBase {
  lane: "session";
  /** The stamped ref, verbatim. */
  ref: string;
  provider: string | null;
  sessionId: string;
  title: string | null;
  cost: number | null;
  first: string | null;
  last: string | null;
  /** The ledger answered and does not hold it. */
  missing: boolean;
  /** Nobody asked (no ledger, a failed batch, the deadline). */
  unresolved: boolean;
  /** Deep link into claude-usage, when `CLAUDE_USAGE_PUBLIC_URL` is set. */
  url?: string;
}

export interface GraphPrNode extends GraphNodeBase {
  lane: "pr";
  /** `owner/repo#n` as first seen. */
  ref: string;
  /** The PR on GitHub, or null when the ref is not a coordinate. */
  url: string | null;
  /** The merge row's subject, when the ledger reported one. */
  subject?: string;
  mergedAt?: string;
  /** Every merge row for it says the merge command did not confirm the merge
   *  (`mergeOk: false`) — qualified, never dropped, as provenance does. */
  mergeUnconfirmed?: true;
}

export type GraphNode = GraphIssueNode | GraphPageNode | GraphSessionNode | GraphPrNode;

/** Edge kinds. `source` is always in the left lane of the pair. */
export type GraphEdgeKind = "issue-page" | "page-session" | "session-pr" | "page-pr";

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** On `issue-page`: the page's relations to the key, strongest first, with
   *  `mention` dropped. Only a counting relation makes an edge. */
  relations?: string[];
}

export interface GraphLedgerState {
  /** A claude-usage is configured on this host. */
  configured: boolean;
  /** At least one ledger call was sent. */
  asked: boolean;
  /** Every call that was sent answered. */
  reachable: boolean;
  /** The shared deadline fired first. */
  timedOut: boolean;
  /** Some merges batch failed while another answered: session–PR edges may be
   *  missing. */
  mergesPartial: boolean;
  /** claude-usage cut a merges batch at its own cap: session–PR edges may be
   *  missing. */
  mergesTruncated: boolean;
}

export type GraphCap = "sessions" | "nodes" | "edges";

export interface GraphPayload {
  scope: GraphScope;
  root: string;
  depth: number;
  level: GraphLevel;
  lanes: GraphLane[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** The answer is a prefix: past `GRAPH_SESSIONS_MAX` session refs,
   *  `GRAPH_NODES_MAX` nodes or `GRAPH_EDGES_MAX` edges. `truncatedBy` says which. */
  truncated?: true;
  truncatedBy?: GraphCap[];
  ledger: GraphLedgerState;
}

/** `tracker:KEY`: a lowercase tracker id, one colon, a key with no colon or
 *  whitespace. The one shape an issue root is read as — the route's `root=`,
 *  the reader's `issue=` and its own splits all go through {@link parseIssueRoot}. */
const ISSUE_ROOT_SHAPE = /^([a-z][a-z0-9-]*):([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/** `tracker:KEY` → its parts, or null when it is not that shape. */
export function parseIssueRoot(raw: string): { tracker: string; key: string } | null {
  const m = ISSUE_ROOT_SHAPE.exec(raw.trim());
  return m ? { tracker: m[1]!, key: m[2]! } : null;
}
