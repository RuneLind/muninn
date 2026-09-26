/**
 * The issue board (`/wiki/issues?wiki=`): rows, flags, filters and markup.
 * Pure string building, so `bun test` loads it; the browser entry is
 * `wiki-board-browser.ts`.
 *
 * The data is ONE `GET /api/wiki/graph?scope=wiki&level=1&depth=0&keyless=1&fields=issue&ledger=keys`
 * (`src/wiki/graph-types.ts`, `src/wiki/graph-board.ts`). The browser never
 * calls claude-usage or huginn.
 */

import { escHtml as esc } from "./escape.ts";
import { articleUrl, localDay, urlWithDisplay } from "./wiki-filter.ts";
import { withWikiParam } from "./wiki-param.ts";
import { calendarDay } from "./wiki-activity-rank.ts";
import { statusHtml } from "./wiki-issue-rows.ts";
import { GRAPH_NODES_MAX, type GraphIssueNode, type GraphPageNode, type GraphPayload } from "../../../wiki/graph-types.ts";

export type BoardFlag = "no plan" | "unknown key" | "0 stamped";

/** The prototype's filter bar, plus `flagged`. */
export type BoardShow = "all" | "open" | "noplan" | "active" | "flagged";

export const BOARD_SHOWS: readonly { id: BoardShow; label: string }[] = [
  { id: "all", label: "All" },
  { id: "open", label: "Open" },
  { id: "noplan", label: "Open without a plan" },
  { id: "active", label: "Active in 14 days" },
  { id: "flagged", label: "Flagged" },
];

/** `active` keeps a key whose newest page is at most this old. */
export const BOARD_ACTIVE_DAYS = 14;

export interface BoardFilter {
  show: BoardShow;
  /** Matched, case-insensitively, against the key and the issue's title. */
  q: string;
}

export interface BoardRow {
  node: GraphIssueNode;
  flags: BoardFlag[];
}

/**
 * A key's flags. `unknown key` only when the lookup answered: a down huginn
 * knows nothing, so it flags nothing.
 */
export function issueFlags(n: GraphIssueNode, lookupAvailable: boolean): BoardFlag[] {
  const flags: BoardFlag[] = [];
  if (!n.planPages.length) flags.push("no plan");
  if (lookupAvailable && n.known === false) flags.push("unknown key");
  if (n.stampedCount === 0) flags.push("0 stamped");
  return flags;
}

const KEY_PARTS = /^(.*)-(\d+)$/;
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Project, then the key's number (`DEMO-9` before `DEMO-10`); a key of any
 *  other shape by its code units. */
export function compareIssueKeys(a: string, b: string): number {
  const x = KEY_PARTS.exec(a);
  const y = KEY_PARTS.exec(b);
  if (!x || !y) return byCodeUnit(a, b);
  return byCodeUnit(x[1]!, y[1]!) || Number(x[2]) - Number(y[2]) || byCodeUnit(a, b);
}

/** One row per issue node, newest activity first, then by key. */
export function boardRows(p: Pick<GraphPayload, "nodes" | "issueLookup">): BoardRow[] {
  const available = p.issueLookup?.available === true;
  return p.nodes
    .filter((n): n is GraphIssueNode => n.lane === "issue")
    .map((node) => ({ node, flags: issueFlags(node, available) }))
    .sort((a, b) => (b.node.lastActivityMs ?? 0) - (a.node.lastActivityMs ?? 0) || compareIssueKeys(a.node.key, b.node.key));
}

/**
 * The calendar day a stamp names, or "" for none. A stamp at exactly UTC
 * midnight is what `Date.parse` makes of a bare frontmatter day, so it names
 * that day ({@link calendarDay}, the rail's rule) rather than the viewer's
 * local day of the instant — the day before, west of UTC.
 */
export function boardDay(ms: number | undefined): string {
  if (!ms || ms <= 0) return "";
  return calendarDay(ms, ms % 86_400_000 === 0 ? new Date(ms).toISOString().slice(0, 10) : undefined);
}

/** Not `done`. A key with no category (the lookup did not answer) is open:
 *  nothing says it is finished. */
const isOpen = (n: GraphIssueNode): boolean => n.category !== "done";

export function filterBoardRows(rows: readonly BoardRow[], f: BoardFilter, nowMs: number): BoardRow[] {
  const q = f.q.trim().toLowerCase();
  // Calendar days, not a 14 × 24 h window: a page dated 14 days back is in,
  // whatever the time of day.
  const now = new Date(nowMs);
  const sinceDay = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - BOARD_ACTIVE_DAYS));
  return rows.filter(({ node, flags }) => {
    if (q && !node.key.toLowerCase().includes(q) && !(node.title ?? "").toLowerCase().includes(q)) return false;
    switch (f.show) {
      case "open":
        return isOpen(node);
      case "noplan":
        return isOpen(node) && !node.planPages.length;
      case "active":
        return boardDay(node.lastActivityMs) >= sinceDay;
      case "flagged":
        return flags.length > 0;
      default:
        return true;
    }
  });
}

const SHOW_PARAM = "show";
const Q_PARAM = "q";

/** The filter a board URL asks for; an unknown `show` is `all`. */
export function parseBoardFilter(search: string): BoardFilter {
  const params = new URLSearchParams(search);
  const raw = params.get(SHOW_PARAM) ?? "";
  const show = BOARD_SHOWS.some((s) => s.id === raw) ? (raw as BoardShow) : "all";
  return { show, q: (params.get(Q_PARAM) ?? "").trim() };
}

/** `location.search` with the filter set, every other param kept. The default
 *  filter leaves no param behind. */
export function searchWithBoardFilter(search: string, f: BoardFilter): string {
  const params = new URLSearchParams(search);
  params.delete(SHOW_PARAM);
  params.delete(Q_PARAM);
  if (f.show !== "all") params.set(SHOW_PARAM, f.show);
  if (f.q.trim()) params.set(Q_PARAM, f.q.trim());
  const s = params.toString();
  return s ? "?" + s : "";
}

/** The reader's graph, rooted at the key (PR 4's deep link). */
export function boardGraphUrl(wiki: string, tracker: string, key: string): string {
  return urlWithDisplay(withWikiParam("/wiki", wiki), { graph: true, issue: `${tracker}:${key}` });
}

const day = (ms: number | undefined): string => boardDay(ms) || "—";

/** Connections' pill; a dash when the lookup did not answer. */
const statusCell = (n: GraphIssueNode): string => statusHtml(n, n.label) || `<span class="board-dim">—</span>`;

function planCell(n: GraphIssueNode, wiki: string): string {
  if (!n.planPages.length) return `<span class="board-dim">—</span>`;
  const first = n.planPages[0]!;
  const more = n.planPages.length > 1 ? ` <span class="board-dim">+${n.planPages.length - 1}</span>` : "";
  return `<a href="${esc(articleUrl(wiki, "relPath", first.relPath, ""))}" class="board-plan" title="${esc(first.title)}">✓ ${esc(first.title)}</a>${more}`;
}

const UNPRICED_TITLES = {
  deadline: "the session ledger timed out",
  unreachable: "the session ledger did not answer",
  "not-configured": "no session ledger on this host",
  "no-row": "the session ledger returned no usable row for this key",
} as const;

/** Sessions and cost: a count and a dollar figure only when the ledger priced
 *  the key. Never `$0` for a key it did not price. */
function ledgerCells(n: GraphIssueNode): [string, string] {
  const l = n.keyLedger;
  if (!l) return [`<td class="num board-dim">—</td>`, `<td class="num board-dim">—</td>`];
  if (l.state === "not-tracked") {
    const t = `title="the session ledger records no mentions for this project"`;
    return [`<td class="num board-dim" ${t}>—</td>`, `<td class="num board-dim" data-cost="not-tracked" ${t}>not tracked</td>`];
  }
  if (l.state === "unpriced") {
    const t = `title="${esc(UNPRICED_TITLES[l.reason])}"`;
    return [`<td class="num board-dim" ${t}>—</td>`, `<td class="num board-dim" data-cost="unpriced" ${t}>—</td>`];
  }
  const seen = l.lastSeen ? `, last ${l.lastSeen.slice(0, 10)}` : "";
  const count = `${l.sessions}${l.truncated ? "+" : ""}`;
  const costTitle =
    l.costedSessions < l.sessions ? `${l.costedSessions} of ${l.sessions} sessions carry a cost` : `${l.costedSessions} sessions`;
  // A cost that is not a number (JSON `null` for a non-finite one) is a dash,
  // never a throw that leaves the board on "Loading…".
  const cost = l.costedSessions > 0 && Number.isFinite(l.totalCost) ? `$${l.totalCost.toFixed(2)}` : "—";
  return [
    `<td class="num" data-sessions title="sessions that mention the key${esc(seen)}">${count}</td>`,
    `<td class="num" data-cost="priced" title="${esc(costTitle)}">${cost}</td>`,
  ];
}

function prCell(refs: readonly string[] | undefined): string {
  if (!refs?.length) return `<span class="board-dim">—</span>`;
  const shown = refs.slice(0, 3).map((r) => `<span class="board-pr">${esc(r.includes("/") ? r.slice(r.indexOf("/") + 1) : r)}</span>`);
  const more = refs.length > 3 ? ` <span class="board-dim" title="${esc(refs.slice(3).join(", "))}">+${refs.length - 3}</span>` : "";
  return shown.join(" ") + more;
}

const th = (label: string, cls = ""): string => `<th scope="col"${cls ? ` class="${cls}"` : ""}>${esc(label)}</th>`;

/** One `<tr>` per row. The key cell is the row's link to the graph, so the row
 *  is reachable by keyboard; a click anywhere else on the row follows it too. */
export function boardTableHtml(rows: readonly BoardRow[], wiki: string): string {
  const head =
    `<caption class="board-sr">Keys, newest activity first</caption>` +
    `<thead><tr>${th("Key")}${th("Issue")}${th("Status")}${th("Plan")}${th("Pages", "num")}` +
    `${th("Sessions", "num")}${th("Cost", "num")}${th("PRs")}${th("Last activity")}${th("Flags")}</tr></thead>`;
  const body = rows
    .map(({ node: n, flags }) => {
      const graph = boardGraphUrl(wiki, n.tracker, n.key);
      const ext = n.url
        ? ` <a class="board-ext" href="${esc(n.url)}" target="_blank" rel="noopener" title="Open in ${esc(n.label)}" aria-label="Open ${esc(n.key)} in ${esc(n.label)}">↗</a>`
        : "";
      const [sessions, cost] = ledgerCells(n);
      return (
        `<tr data-board-key="${esc(n.key)}" data-graph-href="${esc(graph)}">` +
        `<td class="board-key"><a href="${esc(graph)}" title="Open the graph for ${esc(n.key)}">${esc(n.key)}</a>${ext}</td>` +
        `<td class="board-title">${n.title ? esc(n.title) : `<span class="board-dim">—</span>`}</td>` +
        `<td>${statusCell(n)}</td>` +
        `<td class="board-plan-cell">${planCell(n, wiki)}</td>` +
        `<td class="num" data-pages>${n.pageCount}</td>` +
        sessions +
        cost +
        `<td data-prs>${prCell(n.prRefs)}</td>` +
        `<td class="board-date" data-last>${day(n.lastActivityMs)}</td>` +
        `<td>${flags.map((f) => `<span class="board-flag" data-flag="${esc(f)}">${esc(f)}</span>`).join(" ")}</td>` +
        `</tr>`
      );
    })
    .join("");
  const empty = rows.length ? "" : `<tr><td colspan="10" class="board-empty">No key matches this filter.</td></tr>`;
  return `<table class="board-table" id="boardTable">${head}<tbody>${body}${empty}</tbody></table>`;
}

export function keylessTableHtml(pages: readonly GraphPageNode[], wiki: string): string {
  if (!pages.length) return `<p class="board-note">Every page relates to a key.</p>`;
  const head = `<thead><tr>${th("Page")}${th("Type")}${th("Last activity")}${th("PRs")}</tr></thead>`;
  const body = pages
    .map(
      (p) =>
        `<tr data-keyless="${esc(p.relPath)}">` +
        `<td><a href="${esc(articleUrl(wiki, "relPath", p.relPath, ""))}">${esc(p.title)}</a><div class="board-path">${esc(p.relPath)}</div></td>` +
        `<td>${esc(p.plan ? "plan" : p.type)}</td>` +
        `<td class="board-date">${day(p.pageTimeMs)}</td>` +
        `<td>${prCell(p.prRefs)}</td></tr>`,
    )
    .join("");
  return `<table class="board-table board-keyless" id="boardKeyless">${head}<tbody>${body}</tbody></table>`;
}

/** Counts over ALL rows, never the filtered ones, and no cost total: one
 *  session counts under every key it mentions, so a sum would double-count.
 *  `keylessCapped`: the keyless list was cut, so its count reads `N+`. */
export function boardKpisHtml(rows: readonly BoardRow[], keyless: number, keylessCapped = false): string {
  const kpi = (n: number | string, label: string, id: string) =>
    `<div class="board-kpi" data-kpi="${id}"><b>${n}</b><span>${esc(label)}</span></div>`;
  return (
    kpi(rows.length, "keys", "keys") +
    kpi(rows.filter((r) => isOpen(r.node) && !r.node.planPages.length).length, "open, no plan", "open-no-plan") +
    kpi(rows.filter((r) => r.flags.includes("0 stamped")).length, "0 stamped", "zero-stamped") +
    kpi(`${keyless}${keylessCapped ? "+" : ""}`, "pages with no key", "keyless")
  );
}

const keysWord = (n: number): string => `${n} ${n === 1 ? "key" : "keys"}`;
const itWord = (n: number): string => (n === 1 ? "it" : "them");

/** The notes above the table: what degraded, and what was cut. */
export function boardNotes(
  p: Pick<GraphPayload, "truncated" | "truncatedBy" | "keylessTruncated" | "issueLookup" | "keysLedger"> & Partial<Pick<GraphPayload, "nodes">>,
): string[] {
  const out: string[] = [];
  if (p.issueLookup && !p.issueLookup.available) {
    out.push("The issue listing (huginn) did not answer: no titles or statuses, and no key is flagged unknown.");
  }
  const ledgers = (p.nodes ?? []).flatMap((n) => (n.lane === "issue" && n.keyLedger ? [n.keyLedger] : []));
  const unpriced = (reason: string) => ledgers.filter((v) => v.state === "unpriced" && v.reason === reason).length;
  const noRow = unpriced("no-row");
  const unreached = unpriced("unreachable");
  const l = p.keysLedger;
  // Some call answered (the server counts them): a failed one leaves only its
  // own keys unpriced. Row states cannot say this — `not-tracked` comes from
  // the config as well as from an answered `tracked: false`.
  const answered = (l?.answered ?? 0) > 0;
  if (l && !l.configured) out.push("No session ledger on this host: sessions and cost are not shown.");
  else if (l?.timedOut) out.push("The session ledger timed out: sessions and cost are not shown for the keys it did not answer.");
  else if (l && l.calls > 0 && !l.reachable) {
    out.push(
      answered && unreached > 0
        ? `${keysWord(unreached)} could not be priced: the session ledger did not answer for ${itWord(unreached)}.`
        : "Session ledger unavailable: sessions and cost are not shown.",
    );
  }
  if (noRow > 0) out.push(`${keysWord(noRow)} got no row from the session ledger: sessions and cost are not shown for ${itWord(noRow)}.`);
  if (p.truncated && (p.truncatedBy ?? []).includes("nodes")) out.push(`The board shows the first ${GRAPH_NODES_MAX} keys.`);
  if (p.keylessTruncated) out.push(`Pages with no key: the first ${GRAPH_NODES_MAX}, newest first.`);
  return out;
}

/** The filter bar: one button per `show`, and a text box. */
export function boardFilterHtml(f: BoardFilter): string {
  const buttons = BOARD_SHOWS.map(
    (s) =>
      `<button type="button" class="board-show${s.id === f.show ? " active" : ""}" data-board-show="${s.id}" aria-pressed="${s.id === f.show}">${esc(s.label)}</button>`,
  ).join("");
  return (
    `<div class="board-shows" role="group" aria-label="Show">${buttons}</div>` +
    `<input type="search" id="boardQuery" class="board-query" placeholder="Filter by key or title" aria-label="Filter by key or title" value="${esc(f.q)}">`
  );
}
