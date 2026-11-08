/// <reference lib="dom" />
/**
 * The /wiki reader's article controller (mimir plan muninn-wiki-browser-split,
 * C5): the article tools (⧉ Copy path, the provenance strip, issue links),
 * 📤 Share on the open article, and the right pane (Connections with its
 * mini-graph, the rail tabs, Related work, Similar articles).
 *
 * Moved out of the shell (`wiki-browser.ts`). The controller owns its state
 * outright (the issue rows and Link locks, `connData`, `currentOutgoingTitles`,
 * `relatedOrder`, the provenance and related-hop fetch state); `initArticle`
 * sets `relatedOrder` at the spot in `boot()` that assigned it before the move,
 * and the shell clears and reads `currentOutgoingTitles` through
 * `clearOutgoingTitles` and `getCurrentOutgoingTitles`. It never imports the shell:
 * what it reads and calls there arrives through {@link ArticlePort}. Leaf
 * modules, `wiki-rail-controller.ts` (`renderList`, `renderJiraChips`) and
 * `wiki-stale-controller.ts` (`staleTabAvailable`) are imported directly and
 * are not port members.
 */
import { CONN_ISSUES_ID, DRAFT_PLAN_ATTR, ISSUE_LINK_ALL_ATTR, ISSUE_LINK_ATTR, type IssueRowState, issueSectionHtml, linkAllKeys } from "./wiki-issue-rows.ts";
import { COPY_PATH_BTN_ID, COPY_PATH_FAIL, COPY_PATH_IDLE, COPY_PATH_OK, copyPathAriaLabel, copyText, flashCopyResult, wikiPagePath } from "./copy-path.ts";
import { JIRA_TRACKER_ID } from "../../../wiki/trackers/jira-id.ts";
import { RELATED_HOP_ATTR, RELATED_HOP_BODY_ATTR, RELATED_ORDER_ATTR, relatedHopHtml, type RelatedHopResponse, type RelatedListing, relatedSectionHtml, type RelatedViewOptions } from "./wiki-related-view.ts";
import { RELATED_HOP_LIMIT_DEFAULT } from "../../../wiki/related-constants.ts";
import { provPendingHtml, provStripHtml, provUnavailableHtml, SESSION_COPY_FAIL, SESSION_COPY_IDLE, SESSION_COPY_OK, sessionCopyAriaLabel, STAMP_CONFIRM_LABEL, STAMP_LABEL } from "./wiki-provenance-view.ts";
import { SHARE_BTN_ID } from "./wiki-share-dialog.ts";
import { compactIssues, type IssueRow, relationsCount } from "../../../wiki/trackers/types.ts";
import { connItemHtml, miniNodeHtml } from "./wiki-cull-view.ts";
import { connectionTypeOrder, displayTitleOf, facetJiraKeys, shortGraphLabel, type WikiListing } from "./wiki-filter.ts";
import { escHtml as esc } from "./escape.ts";
import { type MovedWithListing, movedWithSectionHtml } from "./wiki-moved-with.ts";
import { normalizeRel } from "./wiki-nav.ts";
import { openShareDialog } from "./share-dialog.ts";
import { refreshLensSwitch } from "./wiki-lens.ts";
import { relationWord } from "./wiki-issue-pills.ts";
import { renderJiraChips, renderList } from "./wiki-rail-controller.ts";
import { seriesEditable, wikiReadonlyWikiFlag } from "./wiki-readonly-client.ts";
import { seriesLabelFor, seriesLabels } from "./wiki-find.ts";
import { staleTabAvailable } from "./wiki-stale-controller.ts";
import { wikiToolsFlag } from "./wiki-read-slice.ts";
import { readRelatedOrder, writeRelatedOrder } from "./wiki-recents-store.ts";
import type { ProvenancePayload } from "../../../wiki/provenance.ts";
import type { PageAnswersInfo } from "./wiki-answer-cards.ts";
import type { ReaderPayload } from "../../../wiki/render.ts";
import type { RelatedOrder } from "./wiki-recents.ts";
import type { WorkedGate } from "./wiki-activity-rank.ts";

/** What the article controller reads and calls on the shell, read live through
 *  a function so a value the shell reassigns is never a stale copy. Every
 *  member is shell-owned: the shell is its only writer. */
export interface ArticlePort {
  /** The shell's `WIKI` let: share, issue links, related hops, `readRelatedOrder`. */
  WIKI(): string;
  /** The shell's `WIKI_ROOT` let: ⧉ Copy path's absolute path. */
  WIKI_ROOT(): string | null;
  /** The shell's `allPages` let (the listing): issue rows, related freshness. */
  allPages(): WikiListing[];
  /** The shell's `currentRelPath` let (`setCurrentRelPath` is its one writer). */
  currentRelPath(): string | null;
  /** The shell's `currentArticle` let, set by `renderBreadcrumb`: Copy path and Share. */
  currentArticle(): WikiListing | null;
  /** The shell's `typeOrder` let (from the listing): Connections' type order. */
  typeOrder(): string[];
  /** The shell's `typeLabel()`: Connections' type headings. */
  typeLabel(t: string): string;
  /** The shell's `workedGate` let (from the listing): Related work's worked axis. */
  workedGate(): WorkedGate | null;
  /** The shell's `workedAxisOn` let (View options): Related work's worked sort. */
  workedAxisOn(): boolean;
  /** The shell's `jiraKeys` let (the Jira facet): issue rows and Link all. */
  jiraKeys(): Record<string, number>;
  /** The shell's `trackerLabels` let: issue rows and the mini-graph. */
  trackerLabels(): Record<string, string>;
  /** The shell's `withWiki()`: provenance, related-hop and similar URLs. */
  withWiki(url: string): string;
  /** The shell's `recencyNow()`: Related work's recency. */
  recencyNow(): number;
}

let deps!: ArticlePort;

// ── Data shapes (mirror src/dashboard/routes/wiki-routes.ts) ──────────
export interface WikiPageDetail {
  meta: WikiListing;
  html: string;
  outgoing: WikiListing[];
  backlinks: WikiListing[];
  /** The pages one hop from this one, strongest first. ABSENT on an older server;
   *  `[]` on a page with no neighbours — both render no block at all. */
  related?: RelatedListing[];
  /** TRUE when the page carries any provenance key and the block is worth
   *  fetching from `/api/wiki/page/provenance`. ABSENT on a page carrying none
   *  of the frontmatter keys — never `false` — so the client's one gate is "is
   *  this key here at all". The block itself never rides on this payload: the
   *  join reaches claude-usage and huginn, and a page open must not wait on it. */
  provenancePending?: boolean;
  /** Connections' issue rows, index-local half. ABSENT on a page with none and
   *  on every page of a wiki with no tracker. The deferred provenance block
   *  carries the whole row and replaces these when it lands. */
  issueRows?: IssueRow[];
  /** Whether a Link may be offered, before the deferred payload says so. */
  issueStampable?: boolean;
  /** Connections' *Moved with* rows (`stale.ts`). ABSENT on an older server;
   *  `[]` without git — both render no section. */
  movedWith?: MovedWithListing[];
  /** sha256 of the page's RAW bytes, as of this response — the series editor's
   *  CAS base for the page the reader has open, captured when the popover opens
   *  rather than fetched again a millisecond before the POST. Kept in step with
   *  every write this client makes (`POST /api/wiki/series` answers the new
   *  hash), so the editor's own first write cannot leave it stale. */
  hash?: string;
  /** The find palette's closeness map: relPath (the listing's spelling) →
   *  (0, 1), one and two hops over the neighbour rule. ABSENT on an older
   *  server; `{}` for a bookkeeping or hub page. */
  near?: Record<string, number>;
  /** Present only on a wiki in `WIKI_ANSWER_WIKIS`: the answer cards' own
   *  flag (D14). Absent ⇒ every `<Question>` card stays read-only. */
  answers?: PageAnswersInfo;
  /** The lens switch's inputs, the ids' nouns and the Agent flag. ABSENT on an
   *  older server: the reader then shows All with English labels. */
  reader?: ReaderPayload;
  error?: string;
}

/** `GET /api/wiki/page/provenance`'s answer: the block, or `{}` on a page
 *  carrying none of the keys. */
interface WikiPageProvenance {
  provenance?: ProvenancePayload;
  error?: string;
}

/**
 * Connections' issue rows for the open page: the inline half from the page
 * payload, replaced by the whole rows when the deferred provenance fetch (or a
 * Link's answer) lands — written only under that fetch's sequence guard.
 * `stampable` comes from the same payload; until it lands no Link is offered.
 * Per-key Link state lives beside them and is dropped with them on navigation.
 */
let issueRows: IssueRow[] | null = null;
let issueStampable = false;
const issueStates = new Map<string, IssueRowState>();
/**
 * In-flight Links, per page (`linkLockId`) → the keys being written, plus
 * {@link LINK_ALL_LOCK} while Link all runs. Module-level and keyed by wiki and
 * relPath, NOT cleared by a render: a reader who leaves a page mid-Link and
 * comes back finds its Links still disabled until the POST lands.
 */
const linkLocks = new Map<string, Set<string>>();
const LINK_ALL_LOCK = "*";
/** The Link control the reader activated and whose POST is still settling — a
 *  key, or {@link LINK_ALL_LOCK} for Link all. While focus is parked on the
 *  section (the control is disabled mid-POST), a redraw returns it there. The
 *  only other way focus lands on a Link is a redraw of the Link that already
 *  held it. Cleared when the Link settles and on navigation. */
let issueFocusKey: string | null = null;
/** The page payload Connections last rendered, so the mini-graph can redraw
 *  when the issue rows change under it. */
let connData: WikiPageDetail | null = null;
/**
 * Titles of the current page's outgoing links, stamped by `renderConnections`.
 *
 * Only used to offer a "how does this relate to X and Y?" starter question in the
 * Discuss dialog. Kept as data in this controller (rather than read out of the rail's
 * DOM) so the suggestion is derived from data, and cleared with the breadcrumb so
 * a stale page's neighbours can't leak into the next page's chips.
 */
let currentOutgoingTitles: string[] = [];

// ── Article tools: ⧉ Copy path, the provenance strip, issue links ────

/**
 * ⧉ Copy path — the open page's path ON DISK, for pasting into an agent brief.
 *
 * The same control the plan drawer got, on the surface where the decision is
 * actually made: you read a page, decide it needs an agent, and the one string
 * you then need is the one the breadcrumb does NOT show — its trail's leaf is
 * the page's TITLE, not its filename. Absolute where the server named a root,
 * the relPath alone otherwise (`wikiPagePath`) — and every registered wiki has
 * a root, not just mimir.
 *
 * The path is carried on the button rather than re-derived at click time, so the
 * string in the tooltip and the string on the clipboard cannot be different
 * pages — which is the whole failure mode of a control that reads "the current
 * article" from module state a navigation may already have moved.
 */
export function copyPathBtnHtml(m: WikiListing): string {
  const full = wikiPagePath(deps.WIKI_ROOT(), m.relPath);
  const aria = copyPathAriaLabel(full);
  // Icon-only: the `title` is the whole discoverability story AND names the exact
  // string, which the dropped "Copy path" label never did.
  return (
    `<button class="wiki-bc-copy" id="${COPY_PATH_BTN_ID}" type="button" ` +
    `data-copy-path="${esc(full)}" title="${esc(full ? "Copy " + full : "Nothing to copy")}" ` +
    `aria-label="${esc(aria)}">${COPY_PATH_IDLE}</button>`
  );
}

/** Run the copy and report it IN the button — the only feedback a clipboard
 *  write can give, and the only way the tailnet `execCommand` path's failure is
 *  visible at all. A missing path reports "Copy failed" rather than returning
 *  silently: `writeText("")` RESOLVES, so copying nothing would report success
 *  while emptying the reader's clipboard, and a bare `return` is a control that
 *  looks live and does nothing — the one outcome with no feedback at all. */
export function copyArticlePath(btn: HTMLButtonElement): void {
  const full = btn.getAttribute("data-copy-path") || "";
  const idle = {
    text: COPY_PATH_IDLE,
    ariaLabel: copyPathAriaLabel(full),
    okText: COPY_PATH_OK,
    failText: COPY_PATH_FAIL,
  };
  if (!full) return flashCopyResult(btn, false, idle);
  void copyText(full).then((ok) => flashCopyResult(btn, ok, idle));
}

/**
 * Copy one session id off a chain row — the ⧉ Copy path control's twin, and
 * through the same `copyText`/`flashCopyResult` pair rather than a second
 * clipboard write.
 *
 * That matters more here than on the breadcrumb: the reader most likely to want
 * a session id is on the tailnet over plain HTTP, where `navigator.clipboard` is
 * simply absent and the `execCommand` fallback is the ONLY path — and the flash
 * is the only report either path can give. The id is the whole reason the chip
 * is copyable text: the browser cannot reach claude-usage (see the strip's own
 * comment), so a search for this string is what a reader does with it.
 */
export function copySessionId(btn: HTMLButtonElement): void {
  const id = btn.getAttribute("data-sess-copy") || "";
  const idle = {
    text: SESSION_COPY_IDLE,
    // The SAME spelling the button was rendered with — two copies meant the
    // button quietly renamed itself the first time a reader pressed it.
    ariaLabel: sessionCopyAriaLabel(id),
    okText: SESSION_COPY_OK,
    failText: SESSION_COPY_FAIL,
  };
  // An empty id reports a failure rather than returning silently: `writeText("")`
  // RESOLVES, so copying nothing would report success while emptying the
  // reader's clipboard (the ⧉ Copy path reasoning, verbatim).
  if (!id) return flashCopyResult(btn, false, idle);
  void copyText(id).then((ok) => flashCopyResult(btn, ok, idle));
}

/**
 * Stamp a ghost session onto the open page — the ONE write the provenance
 * feature makes, and it is a POST to a route that shells out to claude-usage's
 * `wiki-stamp` CLI. muninn writes no frontmatter line here or anywhere.
 *
 * ── The two-step confirm, and the three ways the first cut lost it ──────────
 *
 * A handoff ghost's button carries `data-prov-stamp-confirm`: a handoff link
 * says a later session pasted this one's prompt, which is not the same as saying
 * it wrote the page, and the write is a permanent claim. So the first press only
 * ARMS; a second, separate press writes.
 *
 *  1. **A double-click delivered both presses.** `dblclick` fires two `click`
 *     events milliseconds apart, so the confirm label was set and consumed
 *     inside one gesture and the write happened with the confirmation never on
 *     screen. Arming therefore DISABLES the button for {@link STAMP_ARM_MS};
 *     the second click of a double-click lands on a disabled button and is
 *     dropped, while a deliberate second press half a second later is not.
 *  2. **A failed attempt disarmed the button permanently.** The confirm state
 *     lived in the ATTRIBUTE, which the first press removed — so after a 409 the
 *     row said `not stamped: …` and the NEXT single click wrote with no
 *     confirmation at all. The attribute is now a static fact from the server
 *     ("this ghost needs confirming") and the armed state is
 *     `data-prov-stamp-armed`, which every failure path clears along with the
 *     label.
 *  3. **A 200 carrying no `provenance` disabled the button forever.** The
 *     re-resolve can legitimately answer nothing (the index lost the page, the
 *     ledger context is absent), and the row was left with a dead `…` button.
 *     It now re-enables and re-reads the page's payload.
 *
 * The state lives on the BUTTON, never in a module flag, for `toggleProvChain`'s
 * reason — the strip is re-rendered from scratch on every page load, so a flag
 * would outlive the element it described.
 *
 * The REASON goes in its own `.wiki-chain-stamp-msg` span, not into the label:
 * a label is what the control does, and `not stamped: not-a-stamp-root` as a
 * label is a button that renamed itself to a sentence. `textContent` is the
 * escape — the reason is server copy and a route can echo a `ref` inside it.
 */

/** How long an armed Stamp button stays disabled. Long enough to swallow a
 *  double-click's second event (a system double-click threshold is ~500 ms),
 *  short enough that a reader who meant it is not made to wait. */
const STAMP_ARM_MS = 500;

/** The message span beside one Stamp button, if the row has one. */
function stampMsgSpan(btn: HTMLButtonElement): HTMLElement | null {
  const row = btn.closest(".wiki-chain-row");
  return row ? row.querySelector<HTMLElement>("[data-prov-stamp-msg]") : null;
}

function showStampMsg(btn: HTMLButtonElement, text: string): void {
  const span = stampMsgSpan(btn);
  if (!span) return;
  span.textContent = text;
  span.hidden = false;
}

function clearStampMsg(btn: HTMLButtonElement): void {
  const span = stampMsgSpan(btn);
  if (!span) return;
  span.textContent = "";
  span.hidden = true;
}

/** Back to an offerable Stamp: the label restored, the confirm re-armable, the
 *  button live. Every non-success path ends here. */
function resetStampButton(btn: HTMLButtonElement): void {
  btn.disabled = false;
  btn.textContent = STAMP_LABEL;
  btn.removeAttribute("data-prov-stamp-armed");
}

export async function stampGhost(btn: HTMLButtonElement): Promise<void> {
  const ref = btn.getAttribute("data-prov-stamp") || "";
  if (!ref || !deps.currentRelPath() || btn.disabled) return;
  // The page the button was pressed on. The redraw below keys on the DOM, and
  // the DOM is another page's if the reader navigated while the POST ran.
  const pressedOn = deps.currentRelPath();
  // ARM. `data-prov-stamp-confirm` says this ghost needs confirming and is never
  // removed; `data-prov-stamp-armed` is the press that answered it.
  if (btn.getAttribute("data-prov-stamp-confirm") && !btn.hasAttribute("data-prov-stamp-armed")) {
    btn.setAttribute("data-prov-stamp-armed", "1");
    btn.textContent = STAMP_CONFIRM_LABEL;
    clearStampMsg(btn);
    // See (1) above: the gap is what makes the confirm a separate gesture.
    btn.disabled = true;
    setTimeout(() => {
      // Only re-enable a button still waiting for its confirm — a redraw may
      // have replaced the row, and a POST cannot have started from here.
      if (btn.hasAttribute("data-prov-stamp-armed")) btn.disabled = false;
    }, STAMP_ARM_MS);
    return;
  }
  btn.disabled = true;
  btn.textContent = "…";
  clearStampMsg(btn);
  try {
    const res = await fetch("/api/wiki/provenance/stamp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: deps.WIKI(), relPath: deps.currentRelPath(), ref }),
    });
    const body = (await res.json().catch(() => null)) as
      | { provenance?: ProvenancePayload; reason?: string; error?: string }
      | null;
    if (!res.ok) {
      // The route's own reason, verbatim — `not-a-stamp-root`, `lock-timeout`, a
      // 403 from the read-only guards. A refusal the reader can act on beats a
      // button that silently goes back to saying "Stamp" — but it goes back to
      // saying "Stamp" all the same, so a retry asks again.
      resetStampButton(btn);
      showStampMsg(btn, `not stamped: ${body?.reason || body?.error || res.status}`);
      return;
    }
    // The route answers with the RE-RESOLVED block, so the strip redraws with no
    // second fetch — and with the chain left open, since the reader was reading
    // it when they pressed the button.
    if (body?.provenance) {
      if (deps.currentRelPath() === pressedOn) redrawProvStrip(body.provenance);
      return;
    }
    // A 200 with no block: the write happened, the re-resolve did not answer.
    // Re-read the page's own payload rather than leaving a dead button.
    resetStampButton(btn);
    refetchProvStrip();
  } catch {
    resetStampButton(btn);
    showStampMsg(btn, "not stamped: the request failed");
  }
}

/** Re-read the open page's provenance block and redraw the strip from it —
 *  through the ONE load path, so it takes a sequence number like any load and
 *  writes through `placeProvStrip` like any writer. */
function refetchProvStrip(): void {
  if (deps.currentRelPath()) void loadProvStrip(deps.currentRelPath()!);
}

function provenanceUrl(relPath: string): string {
  return deps.withWiki("/api/wiki/page/provenance?relPath=" + encodeURIComponent(relPath));
}

/** The newest provenance load's sequence number. Only that load may write —
 *  see `loadProvStrip`; a Stamp redraw bumps it to retire whatever is in
 *  flight. */
let provLoadSeq = 0;

/** The provenance load in flight. Leaving the page aborts it, which cancels
 *  the server's claude-usage fetches with it (the route passes the request
 *  signal into `pageProvenance`; its huginn reads are raced, not cancelled). */
let provLoadAbort: AbortController | null = null;

export function abortProvLoad(): void {
  provLoadAbort?.abort();
  provLoadAbort = null;
}

/**
 * The ONE writer of the strip. Every writer — a load, the Stamp redraw, the
 * retry — replaces whatever `.wiki-prov-strip` is on the page (the
 * placeholder, the failure line, a real strip), and inserts after the meta
 * row when none is there (a `prs:`-only page rendered no placeholder; an empty
 * insert is a no-op). Two writers with rules of their own is how this page
 * came to show two strips, twice: each rule enumerated the DOM states the
 * OTHER writer could leave and got one wrong. What a load may WRITE is decided
 * in `loadProvStrip` (an empty or failed answer replaces only a placeholder);
 * where it goes is decided here. An open chain stays open across the
 * replacement: the reader was looking at it. A cost line that lands brings
 * the lens switch with it when Overview hides nothing else on the page.
 */
function placeProvStrip(html: string): void {
  writeProvStrip(html);
  refreshLensSwitch(document.getElementById("articleWrap")!);
}

function writeProvStrip(html: string): void {
  const existing = document.querySelector(".wiki-prov-strip");
  if (!existing) {
    document.querySelector(".wiki-article-head .wiki-meta-row")?.insertAdjacentHTML("afterend", html);
    return;
  }
  const wasOpen =
    existing.querySelector("[data-prov-toggle]")?.getAttribute("aria-expanded") === "true";
  existing.outerHTML = html;
  if (!wasOpen) return;
  const line = document.querySelector<HTMLButtonElement>("[data-prov-toggle]");
  if (line) toggleProvChain(line);
}

/**
 * Fill the placeholder strip a `provenancePending` page rendered. Runs AFTER
 * the article is on screen, so the join's 10 s budget is spent behind a
 * spinner rather than in front of the markdown.
 *
 * Who may write is decided once: the NEWEST load for the page that is still
 * open. Loads overlap whenever the reader leaves a page and returns before
 * its first answer lands, or presses Stamp and the refetch races the page's
 * own load — both are for the same relPath, so a relPath guard alone lets
 * both through. An older answer is dropped whatever it carries; the newest
 * writes through `placeProvStrip`. A failed fetch becomes the failure line
 * with a retry only where a placeholder promised a strip; on a `prs:`-only
 * page, which rendered none, it stays silent.
 */
export async function loadProvStrip(relPath: string): Promise<void> {
  const seq = ++provLoadSeq;
  abortProvLoad();
  const ctl = new AbortController();
  provLoadAbort = ctl;
  let next: string | null = null;
  let prov: ProvenancePayload | undefined;
  try {
    const res = await fetch(provenanceUrl(relPath), { signal: ctl.signal });
    if (res.ok) {
      const data = (await res.json()) as WikiPageProvenance | null;
      prov = data?.provenance;
      next = prov ? provStripHtml(prov, deps.jiraKeys()) : "";
    }
  } catch {
    /* falls through to the unavailable line */
  }
  // An aborted load was retired on purpose: it never writes the failure line.
  if (ctl.signal.aborted) return;
  if (provLoadAbort === ctl) provLoadAbort = null;
  if (deps.currentRelPath() !== relPath || seq !== provLoadSeq) return;
  // Connections is the fetch's second consumer, under the same guard.
  if (prov) adoptIssueRows(prov);
  if (next) {
    placeProvStrip(next);
    return;
  }
  // Nothing to show, or nothing came back. Either one may only replace a
  // PLACEHOLDER: a real strip stays (the Stamp refetch re-reads a page that
  // just resolved to no keys — the same state that answered its POST with no
  // block — and a successful write must not make the strip, the chain and the
  // Stamp button vanish), and a bare head stays bare.
  if (!document.querySelector(".wiki-prov-strip.wiki-prov-pending")) return;
  placeProvStrip(next === null ? provUnavailableHtml() : "");
}

/** The retry on a failed load: back to the placeholder, then the fetch again. */
export function retryProvStrip(): void {
  if (!document.querySelector(".wiki-prov-strip.wiki-prov-unavailable") || !deps.currentRelPath()) return;
  placeProvStrip(provPendingHtml());
  void loadProvStrip(deps.currentRelPath()!);
}

/** Redraw the strip from the block the stamp route answered with. That block
 *  is a re-resolve AFTER the write, so it is fresher than any load in flight:
 *  the sequence is bumped to retire them. */
function redrawProvStrip(provenance: ProvenancePayload): void {
  provLoadSeq += 1;
  abortProvLoad();
  placeProvStrip(provStripHtml(provenance, deps.jiraKeys()));
  adoptIssueRows(provenance);
}

/** Take a provenance block's whole issue rows (and its `stampable`) into
 *  Connections and the mini-graph. A block with no `issues` means the page has
 *  none now, so the rows go too. */
function adoptIssueRows(provenance: ProvenancePayload): void {
  const had = issueRows !== null;
  issueRows = provenance.issues ?? null;
  issueStampable = provenance.stampable;
  // A wiki with no tracker has rows on neither side: nothing to redraw.
  if (!had && !issueRows) return;
  redrawConnIssues();
  redrawMiniGraph();
}

function linkLockId(relPath: string): string {
  return JSON.stringify([deps.WIKI(), relPath]);
}

function pageLinkLocked(relPath: string): boolean {
  return (linkLocks.get(linkLockId(relPath))?.size ?? 0) > 0;
}

function setLinkLock(relPath: string, key: string, on: boolean): void {
  const id = linkLockId(relPath);
  const held = linkLocks.get(id) ?? new Set<string>();
  if (on) held.add(key);
  else held.delete(key);
  if (held.size) linkLocks.set(id, held);
  else linkLocks.delete(id);
}

/** The open page is markdown — only then is Link offered. */
function isMarkdownRel(relPath: string | null): boolean {
  return !!relPath && /\.mdx?$/i.test(relPath);
}

function issueSectionFor(relPath: string | null): string {
  if (!relPath) return "";
  // A Link in flight on this page reads "linking…" on its row, whichever
  // render drew the section.
  const states = new Map(issueStates);
  for (const key of linkLocks.get(linkLockId(relPath)) ?? []) {
    if (key !== LINK_ALL_LOCK) states.set(key, { kind: "busy" });
  }
  return issueSectionHtml(issueRows ?? undefined, {
    labelOf: (id) => deps.trackerLabels()[id] || "",
    stampable: issueStampable,
    markdown: isMarkdownRel(relPath),
    relPath,
    states,
    discuss: !wikiReadonlyWikiFlag(),
    locked: pageLinkLocked(relPath),
  });
}

/** The ONE writer of Connections' issue section: replaces it in place, or
 *  inserts it at the top of the panel (above the mini-graph). Focus inside
 *  the section stays inside it — see {@link issueFocusSelector}. */
function redrawConnIssues(): void {
  const html = issueSectionFor(deps.currentRelPath());
  const el = document.getElementById(CONN_ISSUES_ID);
  if (el) {
    const active = document.activeElement;
    const sel = active && el.contains(active) ? issueFocusSelector(active, el) : null;
    el.outerHTML = html;
    if (sel !== null) {
      const sec = document.getElementById(CONN_ISSUES_ID);
      const target = sel ? sec?.querySelector<HTMLElement>(`${sel}:not(:disabled)`) : null;
      (target ?? sec)?.focus({ preventScroll: true });
    }
    return;
  }
  if (html) document.getElementById("connBody")?.insertAdjacentHTML("afterbegin", html);
}

/**
 * Where focus goes after a redraw replaced `active`: the EQUIVALENT control in
 * the new section — same kind, same key — as a selector, or `""` for the
 * section itself (`tabindex="-1"`). Focus is moved onto a Link or Link all only
 * from that same control, or from the section while it holds focus for the
 * Link the reader activated ({@link issueFocusKey}); never from anything else,
 * so Enter on a focused key anchor cannot become a write.
 */
function issueFocusSelector(active: Element, sec: Element): string {
  const attr = (name: string) => CSS.escape(active.getAttribute(name) ?? "");
  if (active === sec) {
    if (issueFocusKey === LINK_ALL_LOCK) return `[${ISSUE_LINK_ALL_ATTR}]`;
    return issueFocusKey ? `[${ISSUE_LINK_ATTR}="${CSS.escape(issueFocusKey)}"]` : "";
  }
  if (active.hasAttribute(ISSUE_LINK_ATTR)) return `[${ISSUE_LINK_ATTR}="${attr(ISSUE_LINK_ATTR)}"]`;
  if (active.hasAttribute(ISSUE_LINK_ALL_ATTR)) return `[${ISSUE_LINK_ALL_ATTR}]`;
  if (active.hasAttribute(DRAFT_PLAN_ATTR)) return `[${DRAFT_PLAN_ATTR}="${attr(DRAFT_PLAN_ATTR)}"]`;
  const row = active.closest("[data-issue-row]");
  if (!row) return "";
  const key = CSS.escape(row.getAttribute("data-issue-row") ?? "");
  for (const cls of ["wiki-issue-key", "wiki-issue-plan"]) {
    if (active.classList.contains(cls)) return `[data-issue-row="${key}"] a.${cls}`;
  }
  return "";
}

/** Redraw the mini-graph from the current issue rows (a Link, or the deferred
 *  rows landing), in place. */
function redrawMiniGraph(): void {
  if (!connData || (connData.meta?.relPath ?? deps.currentRelPath()) !== deps.currentRelPath()) return;
  const html = miniGraphHtml(connData, issueRows);
  const el = document.querySelector("#connBody .wiki-mini-graph");
  if (el) {
    if (html) el.outerHTML = html;
    else el.remove();
    return;
  }
  if (!html) return;
  const sec = document.getElementById(CONN_ISSUES_ID);
  if (sec) sec.insertAdjacentHTML("afterend", html);
  else document.getElementById("connBody")?.insertAdjacentHTML("afterbegin", html);
}

/**
 * A Link changed a page's relations: its rail row's pills and the Jira facet
 * take the answer's rows (the listing's own compact shape) without a listing
 * refetch. A key that newly counts joins the facet's membership.
 */
function refreshListingIssues(relPath: string, rows: readonly IssueRow[]): void {
  const hit = deps.allPages().find((p) => p.relPath === relPath);
  if (!hit) return;
  const before = new Set(facetJiraKeys(hit));
  hit.issues = compactIssues(rows);
  if (deps.currentArticle() && deps.currentArticle() !== hit && deps.currentArticle()!.relPath === relPath) deps.currentArticle()!.issues = hit.issues;
  for (const key of facetJiraKeys(hit)) if (!before.has(key)) deps.jiraKeys()[key] = (deps.jiraKeys()[key] ?? 0) + 1;
  renderJiraChips();
  renderList();
}

/**
 * **Link**: write one key to a page's tracker line through the Stamp route's
 * `{ tracker, key }` form — the only write path, which shells out to the same
 * CLI as a session Stamp. The answer carries the re-resolved block, so the
 * strip, the rows, the mini-graph and the rail row redraw from it with no
 * second fetch. A skip lands on the row as its named state. The page's Link
 * lock is held for the POST, so no second Link starts beside it (`inLinkAll`:
 * Link all already holds it). Resolves true on success.
 */
export async function linkIssue(relPath: string, tracker: string, key: string, inLinkAll = false): Promise<boolean> {
  if (!inLinkAll && pageLinkLocked(relPath)) return false;
  if (!inLinkAll) issueFocusKey = key;
  if (deps.currentRelPath() === relPath) issueStates.delete(key);
  setLinkLock(relPath, key, true);
  if (deps.currentRelPath() === relPath) redrawConnIssues();
  let state: IssueRowState | null = null;
  let provenance: ProvenancePayload | undefined;
  let ok = false;
  try {
    const res = await fetch("/api/wiki/provenance/stamp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wiki: deps.WIKI(), relPath, tracker, key }),
    });
    const body = (await res.json().catch(() => null)) as
      | { provenance?: ProvenancePayload; reason?: string; error?: string }
      | null;
    if (res.ok) {
      ok = true;
      provenance = body?.provenance;
    } else {
      state =
        res.status === 409 && body?.reason
          ? { kind: "refused", reason: body.reason }
          : { kind: "error", text: `not linked: ${body?.reason || body?.error || res.status}` };
    }
  } catch {
    state = { kind: "error", text: "not linked: the request failed" };
  } finally {
    setLinkLock(relPath, key, false);
  }
  // The rail row is that page's wherever the reader is now.
  if (provenance) refreshListingIssues(relPath, provenance.issues ?? []);
  if (deps.currentRelPath() !== relPath) return ok;
  if (!ok) {
    issueStates.set(key, state!);
    redrawConnIssues();
  } else if (provenance) redrawProvStrip(provenance);
  else {
    redrawConnIssues();
    refetchProvStrip();
  }
  if (!inLinkAll && issueFocusKey === key) issueFocusKey = null;
  return ok;
}

/** **Link all**: the eligible keys one POST at a time (the CLI's lockfile
 *  serializes them anyway), under the page's Link lock from first to last, and
 *  stopping at the first that does not land. A key the open page already shows
 *  stamped by its turn is skipped. */
export async function linkAllIssues(): Promise<void> {
  const relPath = deps.currentRelPath();
  if (!relPath || pageLinkLocked(relPath)) return;
  const rows = [...(issueRows ?? [])];
  const keys = linkAllKeys(rows, { stampable: issueStampable, markdown: isMarkdownRel(relPath) });
  setLinkLock(relPath, LINK_ALL_LOCK, true);
  issueFocusKey = LINK_ALL_LOCK;
  try {
    for (const key of keys) {
      const row = rows.find((r) => r.key === key)!;
      const now = deps.currentRelPath() === relPath ? issueRows?.find((r) => r.key === key) : undefined;
      if (now?.relations.includes("stamped")) continue;
      if (!(await linkIssue(relPath, row.tracker, key, true))) break;
    }
  } finally {
    setLinkLock(relPath, LINK_ALL_LOCK, false);
    if (deps.currentRelPath() === relPath) redrawConnIssues();
    if (issueFocusKey === LINK_ALL_LOCK) issueFocusKey = null;
  }
}

/**
 * Open or close the provenance chain under the page title.
 *
 * The button's `aria-expanded` and the chain's `hidden` are flipped TOGETHER and
 * both read off the DOM rather than a module-level flag: the strip is re-rendered
 * from scratch on every page load (collapsed, by the renderer), so a flag here
 * would outlive the element it described and report the wrong state on the next
 * page.
 *
 * `aria-controls` names the chain, so the element is found through the button
 * rather than by a second selector that could drift from the markup.
 */
export function toggleProvChain(btn: HTMLButtonElement): void {
  const id = btn.getAttribute("aria-controls") || "";
  const chain = id ? document.getElementById(id) : null;
  if (!chain) return;
  const open = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", open ? "false" : "true");
  // `hidden`, not a display style: it is what the renderer ships the element
  // with, so one property is the whole state.
  chain.hidden = open;
}

interface MiniNode {
  p: WikiListing;
  out: boolean;
  inn: boolean;
  x?: number;
  y?: number;
}

/** How many of the page's issue keys the mini-graph draws beside its pages;
 *  the rest are counted in its footer line. */
const MINI_ISSUES_MAX = 4;

/** 1-hop neighborhood as a small radial SVG: current page centered, top
 *  neighbors on a ring, and the page's counting Jira keys as diamonds on the
 *  same ring (dashed edge when inferred; a click filters by the key). `rows`
 *  are Connections' current issue rows, which a Link or the deferred fetch
 *  replaces after the page renders. */
function miniGraphHtml(data: WikiPageDetail, rows: readonly IssueRow[] | null | undefined): string {
  // Jira only: a diamond's click is the Jira facet's filter.
  const counting = (rows ?? []).filter((r) => r.tracker === JIRA_TRACKER_ID && relationsCount(r.relations));
  const issues = counting.slice(0, MINI_ISSUES_MAX);
  const byName: Record<string, MiniNode> = {};
  data.outgoing.forEach((p) => {
    byName[p.name] = { p, out: true, inn: false };
  });
  data.backlinks.forEach((p) => {
    if (byName[p.name]) byName[p.name]!.inn = true;
    else byName[p.name] = { p, out: false, inn: true };
  });
  const all = Object.keys(byName).map((k) => byName[k]!);
  if (!all.length && !issues.length) return "";
  all.sort((a, b) => {
    const ab = a.out && a.inn ? 1 : 0;
    const bb = b.out && b.inn ? 1 : 0;
    return bb - ab || b.p.backlinkCount - a.p.backlinkCount;
  });
  const shown = all.slice(0, 12 - issues.length);
  const slots = shown.length + issues.length;
  const W = 272;
  const H = 244;
  const cx = W / 2;
  const cy = H / 2 - 4;
  const r = 86;
  // `shortGraphLabel`, not a head-slice: a colliding node's label is
  // `<prefix>/<stem>`, and cutting from the front threw the stem away entirely.
  const short = (t: string) => shortGraphLabel(t, 15);
  let edges = "";
  let nodes = "";
  shown.forEach((n, i) => {
    const ang = (2 * Math.PI * i) / slots - Math.PI / 2;
    n.x = cx + r * Math.cos(ang);
    n.y = cy + r * Math.sin(ang);
    edges +=
      `<line class="mini-edge${n.out && n.inn ? " both" : ""}"` +
      (n.inn && !n.out ? ' stroke-dasharray="3,3"' : "") +
      ` x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}"/>`;
  });
  shown.forEach((n) => {
    const ly = n.y! + (n.y! >= cy ? 15 : -9);
    // The VISIBLE label and the `<title>` tooltip read one field — they used to
    // read two, so a colliding node's hover said `muninn/MEMORY` while the dot
    // under it said `MEMORY`. A culled neighbour is muted and says so on hover.
    const title = displayTitleOf(n.p);
    nodes += miniNodeHtml(n.p, { x: n.x!, y: n.y!, labelY: ly, label: short(title), title });
  });
  issues.forEach((row, j) => {
    const ang = (2 * Math.PI * (shown.length + j)) / slots - Math.PI / 2;
    const x = cx + r * Math.cos(ang);
    const y = cy + r * Math.sin(ang);
    const inferred = !row.relations.includes("stamped");
    edges +=
      `<line class="mini-edge mini-issue-edge"${inferred ? ' stroke-dasharray="2,3"' : ""}` +
      ` x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`;
    const ly = y + (y >= cy ? 15 : -9);
    nodes +=
      `<g class="mini-node mini-issue${inferred ? " inferred" : ""}" data-prov-jira="${esc(row.key)}" data-mini-issue="${esc(row.key)}">` +
      `<title>${esc(`${deps.trackerLabels()[row.tracker] || row.tracker} ${row.key} — ${row.relations.map(relationWord).join(", ")}`)}</title>` +
      `<circle class="mini-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="transparent"></circle>` +
      `<rect class="mini-issue-dot" x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9"` +
      ` transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})"></rect>` +
      `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="middle">${esc(row.key)}</text></g>`;
  });
  nodes +=
    `<g class="mini-center"><circle class="mini-dot t-${esc(data.meta.type)}" cx="${cx}" cy="${cy}" r="7"></circle>` +
    `<text x="${cx}" y="${cy + 21}" text-anchor="middle">${esc(short(data.meta.title))}</text></g>`;
  const hiddenIssues = counting.length - issues.length;
  const more = [
    all.length > shown.length ? `strongest ${shown.length} of ${all.length} — full lists below` : "",
    hiddenIssues > 0 ? `+${hiddenIssues} issue${hiddenIssues === 1 ? "" : "s"} not drawn` : "",
  ]
    .filter(Boolean)
    .map((t) => `<div class="wiki-mini-more">${esc(t)}</div>`)
    .join("");
  return `<div class="wiki-mini-graph"><svg viewBox="0 0 ${W} ${H}">${edges}${nodes}</svg>${more}</div>`;
}

// ── Right pane: connections ───────────────────────────────────────────
/** The Related work order this reader picked on this wiki. */
let relatedOrder!: RelatedOrder;

/*
 * Second-hop state for ONE page open, keyed by the hop row's normalized
 * relPath. `resetRelatedHops` runs on every `renderConnections` — a page open,
 * A → start → A, an in-place reload — so a ▸ never shows a cut made against an
 * earlier open, and an answer arriving for an earlier open is dropped by
 * generation. An answer is cached for the open; a failure is shown while the
 * hop stays open and refetched on the next open.
 */
const relatedHops = new Map<string, RelatedHopResponse>();
const relatedHopErrors = new Map<string, RelatedHopResponse>();
const relatedHopsOpen = new Set<string>();
/** One request per hop at a time: a re-click while it is in flight waits on it. */
const relatedHopsInFlight = new Set<string>();
let relatedHopsGen = 0;

function resetRelatedHops(): void {
  relatedHops.clear();
  relatedHopErrors.clear();
  relatedHopsOpen.clear();
  relatedHopsInFlight.clear();
  relatedHopsGen++;
}

/** A hop's render state: `undefined` closed, `null` loading, else its answer. */
function relatedHopState(rel: string): RelatedHopResponse | null | undefined {
  const key = normalizeRel(rel);
  if (!relatedHopsOpen.has(key)) return undefined;
  const answer = relatedHops.get(key) ?? relatedHopErrors.get(key);
  return answer ? { ...answer, related: freshenRelated(answer.related) } : null;
}

/**
 * Related rows with their LISTING fields taken from the listing the rail holds
 * now; only `why`, `strength` and `signals` stay the row's. The block's rows
 * come from the page response, which a series write or a later listing does
 * not re-send. The fresh entry REPLACES the row's listing fields rather than
 * merging over them: `toListing` omits an absent optional key, so a merge kept
 * a `series` (or `seriesLabel`, `culled`, …) the page had since lost.
 */
function freshenRelated(rows: RelatedListing[]): RelatedListing[] {
  const byRel = new Map(deps.allPages().map((p) => [normalizeRel(p.relPath), p]));
  return rows.map((p) => {
    const fresh = byRel.get(normalizeRel(p.relPath));
    return fresh ? { ...fresh, why: p.why, strength: p.strength, signals: p.signals } : p;
  });
}

/** The block's options: the worked axis and instant the rail reads, the order,
 *  the rail's series labels and the open hops. */
function relatedViewOpts(): RelatedViewOptions {
  const labels = seriesLabels(deps.allPages());
  return {
    workedAxis: deps.workedAxisOn(),
    ledgerAsOfMs: deps.workedGate()?.asOfMs,
    now: deps.recencyNow(),
    order: relatedOrder,
    hops: true,
    seriesLabelOf: (p) => seriesLabelFor(p, labels),
    hopState: relatedHopState,
  };
}

function relatedBlockHtml(data: WikiPageDetail): string {
  return relatedSectionHtml(freshenRelated(data.related ?? []), seriesEditable(), relatedViewOpts());
}

/** Repaint the block alone from `connData` and the listing held now — after an
 *  order pick, a series write, or a flip of the worked-on axis. Open hops stay
 *  open (`hopState`). */
export function repaintRelatedBlock(): void {
  const section = document.querySelector("#connBody .wiki-related");
  if (!section || !connData) return;
  section.outerHTML = relatedBlockHtml(connData);
}

/** The reader picked an order: remember it for this wiki and repaint the block
 *  alone, keeping focus on the button pressed. */
export function setRelatedOrder(order: RelatedOrder): void {
  relatedOrder = order;
  writeRelatedOrder(deps.WIKI(), order);
  repaintRelatedBlock();
  document.querySelector<HTMLButtonElement>(`#connBody [${RELATED_ORDER_ATTR}="${order}"]`)?.focus();
}

/** Paint one hop's ▸ and body from its state, leaving the rest of the block —
 *  and the focus on the ▸ — in place. */
function paintRelatedHop(rel: string): void {
  const sel = CSS.escape(rel);
  const btn = document.querySelector<HTMLButtonElement>(`#connBody .wiki-related [${RELATED_HOP_ATTR}="${sel}"]`);
  const body = document.querySelector<HTMLElement>(`#connBody .wiki-related [${RELATED_HOP_BODY_ATTR}="${sel}"]`);
  if (!btn || !body) return;
  const state = relatedHopState(rel);
  const open = state !== undefined;
  btn.setAttribute("aria-expanded", String(open));
  btn.textContent = open ? "▾" : "▸";
  body.hidden = !open;
  const viaRow = connData?.related?.find((p) => p.relPath === rel);
  body.innerHTML = open ? relatedHopHtml(viaRow ? displayTitleOf(viaRow) : rel, state, relatedViewOpts()) : "";
}

/**
 * ▸ on a Related work row: open (or close) THAT page's own related work under
 * the row — `GET /api/wiki/related`, minus the page open now and its
 * attachments. One request per row per page open, in flight or answered.
 */
export function toggleRelatedHop(btn: HTMLButtonElement): void {
  const rel = btn.getAttribute(RELATED_HOP_ATTR) || "";
  if (!rel) return;
  const key = normalizeRel(rel);
  if (relatedHopsOpen.has(key)) {
    relatedHopsOpen.delete(key);
    relatedHopErrors.delete(key);
  } else {
    relatedHopsOpen.add(key);
    if (!relatedHops.has(key) && !relatedHopsInFlight.has(key)) fetchRelatedHop(rel, key);
  }
  paintRelatedHop(rel);
}

function fetchRelatedHop(rel: string, key: string): void {
  const open = deps.currentRelPath();
  if (!open) return;
  const gen = relatedHopsGen;
  relatedHopsInFlight.add(key);
  const url =
    "/api/wiki/related?relPath=" +
    encodeURIComponent(rel) +
    "&exclude=" +
    encodeURIComponent(open) +
    "&limit=" +
    RELATED_HOP_LIMIT_DEFAULT;
  const unavailable = (error?: string): RelatedHopResponse => ({ related: [], total: 0, error: error || "unavailable" });
  fetch(deps.withWiki(url))
    .then((r) => r.json() as Promise<RelatedHopResponse>)
    .then((data) => (Array.isArray(data.related) ? data : unavailable(data.error)))
    .catch(() => unavailable())
    .then((answer) => {
      if (gen !== relatedHopsGen) return;
      relatedHopsInFlight.delete(key);
      if (!answer.error) relatedHops.set(key, answer);
      else if (relatedHopsOpen.has(key)) relatedHopErrors.set(key, answer);
      paintRelatedHop(rel);
    });
}

export function renderConnections(data: WikiPageDetail): void {
  // Feeds the Discuss dialog's "How it connects" starter question. Stamped here
  // because this is the one place the page's resolved neighbours arrive.
  currentOutgoingTitles = (data.outgoing || []).map((p) => p.title).filter((t) => !!t);
  function section(title: string, items: WikiListing[]): string {
    let html = `<div class="wiki-conn-section"><div class="wiki-conn-title">${title} (${items.length})</div>`;
    if (!items.length) {
      return html + '<div class="wiki-conn-empty">None</div></div>';
    }
    // Group by the union of (stored order ∪ types actually present in the items),
    // ordered by the stored list — so a custom-typed neighbor is NEVER dropped even
    // if the stored list arrived late or empty (the pre-fix bug silently excluded it).
    connectionTypeOrder(items.map((p) => p.type), deps.typeOrder()).forEach((t) => {
      const group = items.filter((p) => p.type === t);
      if (!group.length) return;
      html += `<div class="wiki-conn-group">${esc(deps.typeLabel(t))}</div>`;
      group
        .sort((a, b) => b.backlinkCount - a.backlinkCount)
        .forEach((p) => {
          // A culled page stays in Connections, marked (`connItemHtml`).
          html += connItemHtml(p, displayTitleOf(p));
        });
    });
    return html + "</div>";
  }
  // The inline half of the issue rows; the deferred fetch replaces them. A
  // Link lock is not cleared here — see `linkLocks`.
  issueRows = data.issueRows ?? null;
  issueStampable = data.issueStampable === true;
  issueStates.clear();
  issueFocusKey = null;
  connData = data;
  resetRelatedHops();
  document.getElementById("connBody")!.innerHTML =
    issueSectionFor(data.meta?.relPath ?? deps.currentRelPath()) +
    miniGraphHtml(data, issueRows) +
    // `Related work` leads: it is the one section that ANSWERS a question
    // ("what else is this piece of work?") rather than listing a mechanism.
    // The two below are the raw link lists it is derived from.
    relatedBlockHtml(data) +
    section("Linked from", data.backlinks) +
    section("Links to", data.outgoing) +
    // Pages committed with this one (D10); absent without git or shared commits.
    movedWithSectionHtml(data.movedWith, displayTitleOf) +
    // Placeholder the lazy "Similar" fetch fills in after the page renders.
    '<div id="wikiSimilar"></div>';
}

// ── Right rail tabs (Connections | Ask) ───────────────────────────────
/** Toggle the right rail between the Connections body and the Ask compose body.
 *  Default tab is Connections (so Linked from / Links to / Similar are visible on
 *  page select). Auto-switched to Ask when an Ask/Explain stream starts (via
 *  `runAskStream`); switching back to Connections is manual. `focus` (manual tab
 *  clicks only) drops the caret into the Ask box; the auto-switch path passes it
 *  false so a follow-up ask can't steal focus from the in-pane follow-up input. */
export function switchConnTab(tab: string, focus?: boolean): void {
  // No Ask route under the read slice: the rail stays on Connections.
  if (!wikiToolsFlag()) tab = "conn";
  // The STALE tab is absent where its routes are (the read slice) and hidden
  // on a read-only instance (D25): the rail stays on Connections there. Decided
  // before the active mark, so only the tab actually shown is marked (A12).
  if (tab === "stale" && !staleTabAvailable()) tab = "conn";
  document.querySelectorAll(".wiki-conn-tab").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-conntab") === tab);
  });
  const connBody = document.getElementById("connBody");
  const askBody = document.getElementById("askBody");
  const staleBody = document.getElementById("staleBody");
  const ask = tab === "ask";
  const stale = tab === "stale";
  if (connBody) connBody.style.display = ask || stale ? "none" : "";
  if (askBody) askBody.style.display = ask ? "flex" : "none";
  if (staleBody) staleBody.style.display = stale ? "" : "none";
  if (ask && focus) {
    const input = document.getElementById("wikiAskInput") as HTMLTextAreaElement | null;
    if (input) input.focus();
  }
}

// ── Similar articles (semantic cousins, lazily fetched) ───────────────
/** One resolved similar page (mirrors SimilarPage in src/wiki/similar.ts). */
interface SimilarPage {
  name: string;
  title: string;
  relPath: string;
  type: string;
  snippet?: string;
  relevance: number;
}
/** Per-page memo so flipping tabs / re-rendering doesn't refetch. */
const similarMemo = new Map<string, SimilarPage[]>();
/** In-flight guard so a page render can't kick two concurrent fetches. */
const similarInFlight = new Set<string>();

/** Render the "Similar" section markup, or "" when there are no cousins (so the
 *  section is simply absent). Rows reuse the connection-item shape → clicking one
 *  opens it in the reader via the delegated `[data-page]` handler. */
function similarSectionHtml(items: SimilarPage[]): string {
  if (!items.length) return "";
  let html = `<div class="wiki-conn-section"><div class="wiki-conn-title">Similar (${items.length})</div>`;
  items.forEach((p) => {
    html +=
      `<div class="wiki-conn-item" data-page="${esc(p.name)}" data-relpath="${esc(p.relPath)}" title="${esc(p.snippet || "")}">` +
      `<div class="wiki-type-dot type-${esc(p.type)}"></div><span>${esc(displayTitleOf(p))}</span></div>`;
  });
  return html + "</div>";
}

/** Fill the placeholder — but only if the reader is still on the page we fetched
 *  for (a fast tab flip may have moved on). Keyed on relPath, like the fetch. */
function renderSimilarInto(relPath: string, items: SimilarPage[]): void {
  if (deps.currentRelPath() !== relPath) return;
  const el = document.getElementById("wikiSimilar");
  if (el) el.innerHTML = similarSectionHtml(items);
}

/** Lazily fetch + render the Similar section for a page. Memoized per page and
 *  guarded against concurrent duplicate fetches; a failed/empty fetch leaves the
 *  section absent.
 *
 *  Keyed on relPath end to end — memo, in-flight guard, query param and the
 *  still-on-this-page test. Under the name key, two same-stem pages shared one
 *  memo entry and the route resolved both to whichever registered first, so the
 *  rail showed another page's cousins under this one.
 *
 *  Skipped entirely on a read-only WIKI: the route ships the page's prose to
 *  huginn's embedder, so it now carries the per-wiki egress prologue and can only
 *  answer 403. The section is absent either way — this just stops one pointless
 *  request per page open. Deliberately NOT in the readonly click guard: nothing
 *  here is a click. */
export function loadSimilar(page: { relPath: string }): void {
  if (wikiReadonlyWikiFlag() || !wikiToolsFlag()) return;
  const relPath = page.relPath;
  const memo = similarMemo.get(relPath);
  if (memo) {
    renderSimilarInto(relPath, memo);
    return;
  }
  if (similarInFlight.has(relPath)) return;
  similarInFlight.add(relPath);
  fetch(deps.withWiki("/api/wiki/similar?relPath=" + encodeURIComponent(relPath)))
    .then((r) => r.json())
    .then((data: { similar?: SimilarPage[] }) => {
      const items = Array.isArray(data.similar) ? data.similar : [];
      similarMemo.set(relPath, items);
      renderSimilarInto(relPath, items);
    })
    .catch(() => {
      /* huginn down or route error — hide the section silently */
    })
    .finally(() => {
      similarInFlight.delete(relPath);
    });
}

/**
 * 📤 Share on the open article.
 *
 * Sends `relPath` BESIDE the name: the route prefers the path and falls back to
 * the stem, because `index.resolve(name)` is first-registration-wins — sharing
 * one of two same-stem pages generated a post from the OTHER one under this
 * page's title. (This comment used to assert the opposite; see `resolvePageRef`.)
 *
 * `SHARE_BTN_ID` is declared as the opener so the click that opens the dialog is
 * not also read as a click-away by its own document listener.
 */
export function openArticleShare(): void {
  // A read-only wiki never opens the dialog. The capture-phase guard already
  // cancels the click on `#wikiShareBtn`, but this opener is also reachable from
  // code paths that never dispatch one, and the dialog's own Generate would spend
  // the one-shot the route then 403s.
  if (wikiReadonlyWikiFlag()) return;
  const m = deps.currentArticle();
  if (!m) return;
  openShareDialog({
    wiki: deps.WIKI() || "",
    page: m.name,
    relPath: m.relPath,
    title: displayTitleOf(m),
    openerIds: [SHARE_BTN_ID],
  });
}

// ── Wiring: the port, the boot-time read, the outgoing titles ─────────
/** Wire the port, then read this reader's Related work order on this wiki:
 *  the assignment `boot()` made at this spot before the move. */
export function initArticle(d: ArticlePort): void {
  deps = d;
  relatedOrder = readRelatedOrder(deps.WIKI());
}

/** The open page's outgoing link titles (the Discuss dialog's starter question). */
export function getCurrentOutgoingTitles(): string[] {
  return currentOutgoingTitles;
}

/** Drop the previous page's neighbours: the breadcrumb's render and hide. */
export function clearOutgoingTitles(): void {
  currentOutgoingTitles = [];
}
