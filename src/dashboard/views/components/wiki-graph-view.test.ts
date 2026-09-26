/**
 * Graph mode's pure half: the `g` rule, the display URL helpers, the lanes
 * markup, the side card and the hover neighbourhood. Synthetic keys.
 */

import { describe, expect, test } from "bun:test";
import {
  GRAPH_FOCUS_ATTR,
  GRAPH_OPEN_ATTR,
  graphCardHtml,
  graphHtml,
  graphKeyToggles,
  graphLedgerText,
  graphLit,
  graphTruncatedText,
} from "./wiki-graph-view.ts";
import {
  articleUrl,
  readDisplayParams,
  searchWithDisplay,
  urlWithDisplay,
  urlWithJira,
} from "./wiki-filter.ts";
import type { GraphNode, GraphPayload } from "../../../wiki/trackers/graph-types.ts";

const issue: GraphNode = {
  id: "issue:jira:DEMO-101",
  lane: "issue",
  hop: 1,
  tracker: "jira",
  key: "DEMO-101",
  label: "Jira",
  url: "https://example.invalid/browse/DEMO-101",
  pageCount: 2,
  planPages: [],
};
const root: GraphNode = { id: "page:a.md", lane: "page", hop: 0, relPath: "a.md", title: "A <b>", type: "note", pageTimeMs: 1, plan: false };
const other: GraphNode = { id: "page:b.md", lane: "page", hop: 2, relPath: "b.md", title: "B", type: "note", pageTimeMs: 1, plan: true };
const session: GraphNode = {
  id: "session:s1",
  lane: "session",
  hop: 1,
  ref: "claude-code:s1",
  provider: "claude-code",
  sessionId: "s1",
  title: null,
  cost: 2,
  first: null,
  last: null,
  missing: false,
  unresolved: true,
};
const pr: GraphNode = { id: "pr:example-org/demo#7", lane: "pr", hop: 2, ref: "example-org/demo#7", url: "https://github.com/example-org/demo/pull/7" };

const payload: GraphPayload = {
  scope: "page",
  root: "a.md",
  depth: 2,
  level: 3,
  lanes: ["issue", "page", "session", "pr"],
  nodes: [issue, root, other, session, pr],
  edges: [
    { source: "issue:jira:DEMO-101", target: "page:a.md", kind: "issue-page", relations: ["created"] },
    { source: "issue:jira:DEMO-101", target: "page:b.md", kind: "issue-page", relations: ["title"] },
    { source: "page:a.md", target: "session:s1", kind: "page-session" },
    { source: "session:s1", target: "pr:example-org/demo#7", kind: "session-pr" },
  ],
  ledger: { configured: true, asked: true, reachable: true, timedOut: false },
};

describe("graphKeyToggles", () => {
  test("a bare g toggles", () => {
    expect(graphKeyToggles({ key: "g", targetTag: "BODY" })).toBe(true);
  });
  test("any modifier, key repeat, a dialog or a typing target refuses it", () => {
    for (const mod of ["ctrlKey", "metaKey", "altKey", "shiftKey", "repeat", "targetInDialog", "targetEditable"] as const) {
      expect(graphKeyToggles({ key: "g", [mod]: true }), mod).toBe(false);
    }
    for (const tag of ["INPUT", "textarea", "SELECT"]) expect(graphKeyToggles({ key: "g", targetTag: tag }), tag).toBe(false);
    expect(graphKeyToggles({ key: "G" })).toBe(false);
    expect(graphKeyToggles({ key: "f" })).toBe(false);
  });
});

describe("display URL state", () => {
  test("reading mode leaves an article URL byte-identical", () => {
    expect(articleUrl("w", "relPath", "a b.md", "", "DEMO-1")).toBe("/wiki?wiki=w&relPath=a%20b.md&jira=DEMO-1");
    expect(urlWithDisplay("/wiki?x=1", { graph: false, issue: "jira:DEMO-1" })).toBe("/wiki?x=1");
  });
  test("graph mode carries display and issue, after the facets, independent of jira", () => {
    expect(articleUrl("w", "relPath", "a.md", "P", "DEMO-1", { graph: true, issue: "jira:DEMO-102" })).toBe(
      "/wiki?wiki=w&relPath=a.md&project=P&jira=DEMO-1&display=graph&issue=jira%3ADEMO-102",
    );
    expect(urlWithDisplay(urlWithJira("/wiki", ""), { graph: true, issue: "" })).toBe("/wiki?display=graph");
  });
  test("readDisplayParams round-trips what the builders write, and drops what they never would", () => {
    const url = articleUrl("w", "relPath", "a.md", "", "", { graph: true, issue: "jira:DEMO-102" });
    expect(readDisplayParams(url.slice(url.indexOf("?")))).toEqual({ graph: true, issue: "jira:DEMO-102" });
    expect(readDisplayParams("?issue=jira:DEMO-1")).toEqual({ graph: false, issue: "" });
    expect(readDisplayParams("?display=graph&issue=DEMO-1")).toEqual({ graph: true, issue: "" });
    expect(readDisplayParams("?display=graph&issue=jira:DEMO 1")).toEqual({ graph: true, issue: "" });
    expect(readDisplayParams("?display=Graph")).toEqual({ graph: false, issue: "" });
  });
  test("searchWithDisplay rewrites only its own two params", () => {
    expect(searchWithDisplay("?wiki=w&relPath=a.md&jira=DEMO-1", { graph: true, issue: "" })).toBe(
      "?wiki=w&relPath=a.md&jira=DEMO-1&display=graph",
    );
    expect(searchWithDisplay("?wiki=w&display=graph&issue=jira%3ADEMO-1&relPath=a.md", { graph: false, issue: "" })).toBe(
      "?wiki=w&relPath=a.md",
    );
    expect(searchWithDisplay("?display=graph", { graph: true, issue: "jira:DEMO-2" })).toBe("?display=graph&issue=jira%3ADEMO-2");
    expect(searchWithDisplay("?display=graph", { graph: false, issue: "" })).toBe("");
  });
});

describe("graphHtml", () => {
  test("one lane per payload lane, each counting its nodes, the root marked and labels escaped", () => {
    const html = graphHtml(payload, { level: 3, depth: 2, rootLabel: "A <b>" });
    for (const [lane, n] of [["issue", 1], ["page", 2], ["session", 1], ["pr", 1]] as const) {
      expect(html).toContain(`data-lane-count="${lane}">${n}<`);
    }
    expect(html).toContain('class="wiki-graph-node lane-page root"');
    expect(html).toContain('class="wiki-graph-node lane-session bare"');
    expect(html).not.toContain("A <b>");
    expect(html).toContain("A &lt;b&gt;");
    expect(html).not.toContain("data-graph-truncated");
  });
  test("a level-1 payload draws two lanes", () => {
    const html = graphHtml({ ...payload, lanes: ["issue", "page"], nodes: [issue, root] }, { level: 1, depth: 2, rootLabel: "A" });
    expect(html).toContain('data-lane="page"');
    expect(html).not.toContain('data-lane="session"');
  });
  test("a truncated answer says so, naming the cap", () => {
    const html = graphHtml({ ...payload, truncated: true, truncatedBy: ["sessions"] }, { level: 3, depth: 2, rootLabel: "A" });
    expect(html).toContain("data-graph-truncated");
    expect(graphTruncatedText({ truncated: true, truncatedBy: ["sessions"] })).toContain("first 400 sessions");
    expect(graphTruncatedText({})).toBe("");
  });
  test("the ledger note names a missing, a timed-out and an unreachable ledger", () => {
    expect(graphLedgerText(payload)).toBe("");
    expect(graphLedgerText({ ...payload, ledger: { ...payload.ledger, configured: false } })).toContain("No session ledger");
    expect(graphLedgerText({ ...payload, ledger: { ...payload.ledger, timedOut: true } })).toContain("timed out");
    expect(graphLedgerText({ ...payload, ledger: { ...payload.ledger, reachable: false } })).toContain("did not answer");
  });
});

describe("graphCardHtml", () => {
  test("an issue offers Focus here and its tracker link", () => {
    const html = graphCardHtml(issue, { isRoot: false });
    expect(html).toContain(`${GRAPH_FOCUS_ATTR}="issue:jira:DEMO-101"`);
    expect(html).toContain('href="https://example.invalid/browse/DEMO-101"');
    expect(html).toContain("Open in Jira");
  });
  test("a page offers Focus here and Open; the root page only Open", () => {
    expect(graphCardHtml(other, { isRoot: false })).toContain(`${GRAPH_FOCUS_ATTR}="page:b.md"`);
    expect(graphCardHtml(other, { isRoot: false })).toContain(`${GRAPH_OPEN_ATTR}="b.md"`);
    expect(graphCardHtml(root, { isRoot: true })).not.toContain(GRAPH_FOCUS_ATTR);
  });
  test("sessions and PRs are never a root, so never offer Focus here", () => {
    expect(graphCardHtml(session, { isRoot: false })).not.toContain(GRAPH_FOCUS_ATTR);
    expect(graphCardHtml(pr, { isRoot: false })).toContain("Open PR");
  });
});

describe("graphLit", () => {
  test("lights the neighbours and one path back to the root", () => {
    const lit = graphLit(payload, "pr:example-org/demo#7");
    expect([...lit.nodes].sort()).toEqual(["page:a.md", "pr:example-org/demo#7", "session:s1"]);
    expect([...lit.edges].sort()).toEqual(["page:a.md|session:s1", "session:s1|pr:example-org/demo#7"]);
    const fromB = graphLit(payload, "page:b.md");
    expect(fromB.nodes.has("page:a.md")).toBe(true);
    expect(fromB.nodes.has("session:s1")).toBe(false);
  });
});
