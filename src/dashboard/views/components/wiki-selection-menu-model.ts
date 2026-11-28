/**
 * The selection menu's pure half (Discuss v2 PR 5, mimir plan
 * muninn-wiki-discuss-v2, D2 and D3): which actions a selection gets, the
 * markup of the bar and the right-click menu, the key chips, the inline cards'
 * markup for «Where else» and «History», and where a card goes in the
 * article. No DOM globals: the anchor helper takes its nodes' own document, so
 * a test drives it in a happy-dom `Window` of its own. The controller is
 * `wiki-selection-menu.ts`.
 *
 * Keys are found with the mentions route's own check and classifier
 * (`parseMentionKey`, `classifyKey`): a word of the selection is a key only
 * when the route would search it and would give it a kind.
 */

import { escHtml as esc } from "./escape.ts";
import { classifyKey, parseKeyKinds, type KeyKind } from "../../../wiki/key-kinds.ts";
import { parseMentionKey } from "../../../wiki/mention-key.ts";
import type { MentionsBody } from "../../../wiki/mentions.ts";

export const SEL_BAR_ID = "wikiSelBar";
export const SEL_MENU_ID = "wikiSelMenu";
export const SEL_CARD_CLASS = "wiki-sel-card";

/** Is `el` laid out with a box (not under a `display: none`)? Every element
 *  answers false where nothing is laid out: a caller checks its root first. */
export function hasBox(el: Element): boolean {
  return Array.from(el.getClientRects()).some((r) => r.width > 0 || r.height > 0);
}
/** The bar keeps the ids the breadcrumb's selection-gated buttons had: the
 *  read-only guards and every spec that drives a selection key on them. */
export const SEL_EXPLAIN_BTN_ID = "wikiExplainBtn";
export const SEL_FACTCHECK_BTN_ID = "wikiFactcheckBtn";
/** The passage button that was the breadcrumb's (Discuss v3 P1, «One button»):
 *  the same id, so the read-only and read-slice selectors still name it. */
export const SEL_HANDOFF_BTN_ID = "wikiDiscussHandoffBtn";
/** The tooltip the bar draws for Explain (a native `title` cannot hold «Change…»). */
export const SEL_TIP_ID = "wikiSelTip";
/** The who box «Change…» opens. A group, never a dialog: `modalOpen()` reads
 *  every visible `[role="dialog"]` as a modal and kills the single-key shortcuts. */
export const SEL_WHO_ID = "wikiSelWho";

export type SelAction = "explain" | "where" | "history" | "factcheck" | "copy" | "follow" | "key" | "handoff";

/** The handoff's passage action as the wiki offers it: Copy prompt with
 *  `discuss.handoff` («code»), else the wiki agent's «Ask here» («agent»). */
export type HandoffMode = "code" | "agent";
export const HANDOFF_ITEMS: Record<HandoffMode, { label: string; title: string }> = {
  code: { label: "⌘ Ask Claude Code", title: "Copy a prompt for Claude Code about this passage" },
  agent: { label: "💬 Ask about this", title: "Ask the wiki agent about this passage" },
};
/** Explain's sentence: the first line of its tooltip. */
export const EXPLAIN_TITLE = "What this means, why it is here and what led to it";

/** The question an «Explain with context» turn asks; the passage and its
 *  place on the page go with it as the turn's selection fields. */
export const EXPLAIN_QUESTION = "Explain this passage with context: what it means, why it is here, and what led to it.";
/** The Edit turn «Add to Oppfølging» asks. */
export const FOLLOW_QUESTION =
  "Add this passage to the page as a new point under the «Oppfølging» heading, in the page's own words and form. Propose it as an edit.";
/** The heading «Add to Oppfølging» needs on the page (compared without case). */
export const FOLLOW_HEADING = "Oppfølging";
/** At most this many key chips per selection. */
export const KEY_CHIPS_MAX = 3;

export interface SelMenuInput {
  /** The selection's text, as the reader reads it. */
  text: string;
  /** The page is an HTML explainer (its selection comes from the iframe). */
  explainer: boolean;
  /** The mentions route answers here (`reader.mentions`). */
  mentions: boolean;
  /** The page has an `Oppfølging` heading and a wiki agent. */
  follow: boolean;
  /** The keys found in the selection ({@link detectKeys}). */
  keys: string[];
  /** The handoff's passage action, when the wiki offers it and the selection
   *  may be a passage (Discuss v3 P1); null or absent: none. */
  handoff?: HandoffMode | null;
  /** The selection is past the bar's own bound (1,500 characters) but within
   *  the handoff's: only the handoff and Copy are offered. */
  long?: boolean;
}

export interface SelMenuItem {
  act: SelAction;
  label: string;
  title: string;
  /** For a key chip: the key. */
  key?: string;
}

/** The actions, in the menu's order; the first is the default (Enter). The
 *  bar and the right-click menu show the same list (D2). «Where else» and
 *  «History» search the whole selection, so they show only when the route
 *  accepts it as a key: 3–80 characters on one line. */
export function selMenuItems(s: SelMenuInput): SelMenuItem[] {
  const handoff = s.handoff && !s.explainer ? { act: "handoff" as const, ...HANDOFF_ITEMS[s.handoff] } : null;
  if (s.long) return [...(handoff ? [handoff] : []), { act: "copy", label: "⧉ Copy", title: "Copy the selected text" }];
  const items: SelMenuItem[] = [{ act: "explain", label: "✨ Explain with context", title: EXPLAIN_TITLE }];
  const searchable = s.mentions && "key" in parseMentionKey(s.text);
  if (searchable) {
    items.push({ act: "where", label: "🔗 Where else", title: "Every line in the wiki that names this, with no model" });
    items.push({ act: "history", label: "🕘 History", title: "The commits and log.md entries that added or changed it, with no model" });
  }
  items.push({ act: "factcheck", label: "✓ Fact check", title: "Fact-check this passage against the web" });
  items.push({ act: "copy", label: "⧉ Copy", title: "Copy the selected text" });
  if (handoff) items.push(handoff);
  if (s.follow && !s.explainer) items.push({ act: "follow", label: "＋ Add to Oppfølging", title: "Propose this as a point under the page's Oppfølging heading (an Edit turn)" });
  if (s.mentions) {
    for (const key of s.keys) if (!(searchable && key === s.text.trim())) items.push({ act: "key", key, label: `🧭 ${key}`, title: `Trace ${key}: its mentions and timeline` });
  }
  return items;
}

/** Does the list offer more than «Copy»? A Copy-only bar (the read slice
 *  hides the rest, or a long selection on a wiki with no handoff) is no
 *  better than the browser's own menu: no bar then. */
export function selMenuOffers(items: readonly SelMenuItem[]): boolean {
  return items.some((it) => it.act !== "copy");
}

function itemAttrs(it: SelMenuItem, title = true): string {
  return `data-selact="${it.act}"${it.key ? ` data-selkey="${esc(it.key)}"` : ""}${title ? ` title="${esc(it.title)}"` : ""}`;
}

const BAR_IDS: Partial<Record<SelAction, string>> = { explain: SEL_EXPLAIN_BTN_ID, factcheck: SEL_FACTCHECK_BTN_ID, handoff: SEL_HANDOFF_BTN_ID };

/** The bar's buttons. Explain, Fact check and the handoff keep the breadcrumb
 *  buttons' ids. Explain has no native `title`: the bar draws its tooltip
 *  ({@link selTipHtml}), which names who a turn runs as. */
export function selBarHtml(items: SelMenuItem[]): string {
  return items
    .map((it, i) => {
      const id = BAR_IDS[it.act] ? ` id="${BAR_IDS[it.act]}"` : "";
      const cls = `wiki-selbar-btn${i === 0 ? " def" : ""}${it.act === "key" ? " chip" : ""}`;
      const tip = it.act === "explain" ? ` aria-describedby="${SEL_TIP_ID}"` : "";
      return `<button type="button" class="${cls}"${id} ${itemAttrs(it, it.act !== "explain")}${tip}>${esc(it.label)}</button>`;
    })
    .join("");
}

// ── Who answers (Discuss v3 P1) ─────────────────────────────────────────

/** Who a Discuss turn runs on here, as the page payload's `discussWho` says. */
export interface SelWho {
  bot: string;
  origin: "pinned" | "owner" | "fallback";
  connector: string;
  model: string | null;
}

/** The «Runs as» user: «…» while the read is pending, a refusal's text, or the user. */
export type SelRunsAs = { state: "pending" } | { state: "refused"; text: string } | { state: "user"; userId: string; name: string };

/** The page payload's `discussWho`: an object (who answers), null (no bot
 *  answers here) or undefined (not sent: no wiki agent, or an old payload). */
export function selWhoFrom(raw: unknown): SelWho | null | undefined {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.bot !== "string" || typeof r.connector !== "string") return undefined;
  const origin = r.origin === "pinned" || r.origin === "owner" ? r.origin : "fallback";
  return { bot: r.bot, origin, connector: r.connector, model: typeof r.model === "string" && r.model ? r.model : null };
}

/** Explain's tooltip, second line: who the turn runs as (HTML). */
export function selRunsAsHtml(who: SelWho | null, runsAs: SelRunsAs): string {
  if (!who) return "No bot answers here: Explain answers without the wiki's agent.";
  const user = runsAs.state === "user" ? `<b>${esc(runsAs.name)}</b>` : runsAs.state === "refused" ? esc(runsAs.text) : "…";
  return `Runs as ${user} · ${[who.model, who.connector].filter(Boolean).map((x) => esc(x!)).join(" · ")}`;
}

/**
 * The tooltip the bar draws under Explain: the sentence, then (on a wiki with
 * an agent, for a thread turn) «Runs as <user> · <model> · <connector> ·
 * Change…». `who` undefined: the sentence only (no agent, an explainer).
 * «Change…» is a button the keyboard reaches with Tab from Explain.
 */
export function selTipHtml(who: SelWho | null | undefined, runsAs: SelRunsAs): string {
  const l2 =
    who === undefined
      ? ""
      : `<div class="wiki-seltip-l2"><span data-seltip-who>${selRunsAsHtml(who, runsAs)}</span>${who ? ` · <button type="button" class="wiki-seltip-change" data-selwho-open>Change…</button>` : ""}</div>`;
  return `<div class="wiki-seltip-l1">${esc(EXPLAIN_TITLE)}</div>${l2}`;
}

const ORIGIN_WORDS: Record<SelWho["origin"], string> = {
  pinned: "Pinned to this wiki in the server's setup. Not a choice per turn.",
  owner: "The wiki's own bot. Not a choice per turn.",
  fallback: "The research bot role on /models answers on this wiki.",
};

/**
 * The who box «Change…» opens: the users to pick from (where the read says
 * the user can be chosen), the bot and where it comes from, and the model
 * with «Change on /models ↗». Nothing here changes a connector; on a pinned
 * wiki the box says the connector is fixed there. `message` is a pick's
 * refusal (shown as an alert).
 */
export function selWhoHtml(opts: { wiki: string; who: SelWho; runsAs: SelRunsAs; users: { id: string; name: string }[]; choosable: boolean; message: string | null }): string {
  const { who, runsAs } = opts;
  const current = runsAs.state === "user" ? runsAs.userId : null;
  const userCell =
    opts.choosable && opts.users.length
      ? `<div class="wiki-selwho-users">${opts.users.map((u) => `<button type="button" class="wiki-selwho-user" data-selwho-user="${esc(u.id)}" aria-pressed="${u.id === current}">${esc(u.name)}</button>`).join("")}</div>` +
        `<div class="wiki-selwho-h">The ${esc(who.bot)} bot's /chat users. Each has their own discussion of a page. Kept in this browser.</div>`
      : `<div>${runsAs.state === "user" ? esc(runsAs.name) : runsAs.state === "refused" ? esc(runsAs.text) : "…"}</div>` +
        (opts.choosable ? "" : `<div class="wiki-selwho-h">Not choosable on this instance.</div>`);
  const fixed = who.origin === "pinned" ? `The connector is fixed on this wiki: it is ${esc(who.bot)}'s.` : "Nothing here changes the connector.";
  return (
    `<div class="wiki-selwho-hd"><span>Who answers on ${esc(opts.wiki)}</span><button type="button" class="wiki-selwho-x" data-selwho-close aria-label="Close">✕</button></div>` +
    `<div class="wiki-selwho-row"><span class="wiki-selwho-k">User</span><div>${userCell}</div></div>` +
    `<div class="wiki-selwho-row"><span class="wiki-selwho-k">Bot</span><div><div>${esc(who.bot)}</div><div class="wiki-selwho-h">${esc(ORIGIN_WORDS[who.origin])}</div></div></div>` +
    `<div class="wiki-selwho-row"><span class="wiki-selwho-k">Model</span><div><div>${[who.model, who.connector].filter(Boolean).map((x) => esc(x!)).join(" · ")} <a class="wiki-selwho-models" href="/models?bot=${encodeURIComponent(who.bot)}" target="_blank" rel="noopener">Change on /models ↗</a></div>` +
    `<div class="wiki-selwho-h">The bot's model, for every turn on this wiki. ${fixed}</div></div></div>` +
    (opts.message ? `<div class="wiki-discuss-error wiki-selwho-msg" role="alert">${esc(opts.message)}</div>` : "")
  );
}

/** The right-click menu: the quoted selection, the same actions, the key
 *  chips under «For this selection», and how to reach the browser's menu. */
export function selMenuHtml(items: SelMenuItem[], text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const quote = flat.length > 40 ? `${flat.slice(0, 39)}…` : flat;
  const main = items.filter((it) => it.act !== "key");
  const chips = items.filter((it) => it.act === "key");
  const row = (it: SelMenuItem, i: number) =>
    `<button type="button" role="menuitem" class="wiki-selmenu-it${i === 0 ? " def" : ""}" ${itemAttrs(it)}><span>${esc(it.label)}</span>${i === 0 ? '<span class="k">↵</span>' : ""}</button>`;
  return (
    `<div class="wiki-selmenu-hd">«${esc(quote)}»</div>` +
    main.map(row).join("") +
    (chips.length ? `<div class="wiki-selmenu-sep"></div><div class="wiki-selmenu-hd">For this selection</div>` + chips.map((c) => row(c, 1)).join("") : "") +
    `<div class="wiki-selmenu-sep"></div><div class="wiki-selmenu-foot"><span>Browser menu</span><span class="k">⇧ right-click</span></div>`
  );
}

// ── Keys ─────────────────────────────────────────────────────────────────

/** A word of the selection: letters and digits, with `-` and `_` inside. */
const WORD_RE = /[\p{L}\p{N}](?:[\p{L}\p{N}_-]*[\p{L}\p{N}])?/gu;

/** The key kinds the page payload sent, compiled and checked by the same
 *  parser the server ran (`parseKeyKinds`). */
export function keyKindsFrom(raw: unknown): KeyKind[] {
  return parseKeyKinds(raw).kinds;
}

/**
 * The keys in `text`, in order, each once, at most {@link KEY_CHIPS_MAX}: a
 * word the mentions route accepts (`parseMentionKey`) and gives a kind
 * (`classifyKey`, with the wiki's tracker projects and `keys` kinds). Each
 * pattern runs anchored on one word, as the route runs it on one key.
 */
export function detectKeys(text: string, trackerProjects: readonly string[], kinds: readonly KeyKind[]): string[] {
  const trackers = trackerProjects.length ? [{ id: "tracker", projects: [...trackerProjects] }] : [];
  const out: string[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const w = m[0];
    if (out.includes(w) || !("key" in parseMentionKey(w))) continue;
    if (classifyKey(w, trackers, kinds) === null) continue;
    out.push(w);
    if (out.length >= KEY_CHIPS_MAX) break;
  }
  return out;
}

// ── Where the page offers «Add to Oppfølging» ──────────────────────────

/** The article's `Oppfølging` heading (h2–h4, its own text without the
 *  reader's additions), or null. */
export function followHeading(article: Element): Element | null {
  for (const h of Array.from(article.querySelectorAll("h2, h3, h4"))) {
    const own = Array.from(h.childNodes)
      .filter((n) => n.nodeType === 3 || (n.nodeType === 1 && !(n as Element).hasAttribute("data-reader-only") && (n as Element).tagName !== "BUTTON"))
      .map((n) => n.textContent ?? "")
      .join("")
      .trim();
    if (own.toLocaleLowerCase() === FOLLOW_HEADING.toLocaleLowerCase()) return h;
  }
  return null;
}

// ── Where an inline card goes ─────────────────────────────────────────────

const BLOCK_SEL = "li, p, blockquote, pre, figure, dd, dt, h1, h2, h3, h4, h5, h6, .callout, table, details";
/** Elements a bare paragraph run ends at. */
const RUN_END = new Set(["DIV", "UL", "OL", "TABLE", "PRE", "BLOCKQUOTE", "DETAILS", "P", "H1", "H2", "H3", "H4", "H5", "H6", "FIGURE", "HR", "SECTION", "DL"]);

function lastLeaf(n: Node): Node {
  while (n.lastChild) n = n.lastChild;
  return n;
}

/** The leaf just before `n` in document order, not leaving `within`. */
function prevLeaf(n: Node, within: Node): Node | null {
  for (let cur: Node | null = n; cur && cur !== within; cur = cur.parentNode) {
    if (cur.previousSibling) return lastLeaf(cur.previousSibling);
  }
  return null;
}

/**
 * The node holding the selection's last character. A range often ends on a
 * boundary instead: Chrome's triple-click ends at (the next block, 0) or at
 * (the container, child index). So an end at a child index starts from the
 * child before it, an end with nothing before it in its node walks back, and
 * the walk skips `<br>`s and blank text. A walk that leaves the range, or
 * finds nothing, keeps the end container.
 */
export function selectionEndNode(range: Range, within: Node): Node {
  const c = range.endContainer;
  const o = range.endOffset;
  let n: Node | null;
  if (c.nodeType === 3) {
    if ((c.textContent ?? "").slice(0, o).trim()) return c;
    n = prevLeaf(c, within);
  } else {
    const child = o > 0 ? c.childNodes[o - 1] : undefined;
    n = child ? lastLeaf(child) : prevLeaf(c, within);
  }
  for (; n && range.intersectsNode(n); n = prevLeaf(n, within)) {
    if (n.nodeType === 3 ? !!(n.textContent ?? "").trim() : n.nodeType === 1 && (n as Element).tagName === "IMG") return n;
  }
  return c;
}

/**
 * Where a card about `range` goes: right under the paragraph that holds its
 * last character ({@link selectionEndNode}). A list item takes it inside,
 * before any nested list; a table, a heading or another block takes it after
 * itself. A bare paragraph (the reader's markdown has no `<p>`: paragraphs
 * are text runs split by `<br><br>`) takes it at the run's end: after its
 * `<br><br>`, or before the block that ends it.
 */
export function inlineCardAnchor(range: Range, article: Element): { parent: Node; before: Node | null } {
  const end = selectionEndNode(range, article);
  const start = end.nodeType === 1 ? (end as Element) : end.parentElement;
  const block = start?.closest(BLOCK_SEL);
  if (block && article.contains(block) && block !== article) {
    const table = block.closest("table");
    const target = table && article.contains(table) ? table : block;
    if (target.tagName === "LI") {
      const nested = Array.from(target.children).find((c) => c.tagName === "UL" || c.tagName === "OL") ?? null;
      return { parent: target, before: nested };
    }
    return { parent: target.parentNode!, before: target.nextSibling };
  }
  // A bare run: climb to the child of the run's container.
  let node: Node = end;
  const container = start && article.contains(start) ? (start.closest("div, section, .wiki-article") ?? article) : article;
  while (node.parentNode && node.parentNode !== container) node = node.parentNode;
  if (node.parentNode !== container) return { parent: article, before: null };
  for (let n = node.nextSibling; n; n = n.nextSibling) {
    if (n.nodeType !== 1) continue;
    const el = n as Element;
    if (el.tagName === "BR") {
      let next = el.nextSibling;
      while (next && next.nodeType === 3 && !(next.textContent ?? "").trim()) next = next.nextSibling;
      // After the pair: the paragraph break stays above the card, and the next paragraph follows it.
      if (next && next.nodeType === 1 && (next as Element).tagName === "BR") return { parent: container, before: next.nextSibling };
      continue;
    }
    if (RUN_END.has(el.tagName)) return { parent: container, before: el };
  }
  return { parent: container, before: null };
}

// ── The inline cards' markup ─────────────────────────────────────────────

export type CardKind = "explain" | "where" | "history" | "follow" | "trace";

const CARD_TITLES: Record<CardKind, string> = {
  explain: "✨ Explain with context",
  where: "🔗 Where else",
  history: "🕘 History",
  follow: "＋ Add to Oppfølging",
  trace: "🧭 Trace",
};

/** A thread turn card's sub line: whose discussion the turn is in, once the
 *  thread read named the user. */
export function inlineTurnSub(userName: string | null | undefined): string {
  return userName ? `a turn in ${userName}'s discussion of this page` : "a turn in this page's discussion";
}

/** A thread turn card's sub line from the «Runs as» user (Discuss v3 P1):
 *  the same user the tooltip names; «…» in the name's place while the read
 *  is pending (the card fills it once, when the read lands); a refusal's text. */
export function runsAsSub(runsAs: SelRunsAs): string {
  return runsAs.state === "user" ? inlineTurnSub(runsAs.name) : runsAs.state === "refused" ? runsAs.text : inlineTurnSub("…");
}

/** A card's frame: its title, «Open in Discuss →» for a thread turn, and ✕.
 *  `data-reader-only` keeps it out of every read of the page's own text (a
 *  later selection's context, Explain, fact check). */
export function inlineCardHtml(kind: CardKind, sub: string, body: string, turnKey: string | null): string {
  return (
    `<div class="${SEL_CARD_CLASS}" data-sel-card="${kind}" data-reader-only role="region" aria-label="${esc(CARD_TITLES[kind].replace(/^\S+\s/, ""))}"${turnKey ? ` data-sel-turn="${esc(turnKey)}"` : ""}>` +
    `<div class="wiki-sel-card-head"><span class="wiki-sel-card-title">${esc(CARD_TITLES[kind])}${sub ? ` <span class="wiki-sel-card-sub">· ${esc(sub)}</span>` : ""}</span>` +
    `<span class="wiki-sel-card-tools">` +
    (turnKey ? `<button type="button" class="wiki-sel-card-btn" data-sel-card-pane="${esc(turnKey)}" title="This turn in the page's discussion">Open in Discuss →</button>` : "") +
    `<button type="button" class="wiki-sel-card-btn" data-sel-card-close aria-label="Close">✕</button></span></div>` +
    `<div class="wiki-sel-card-body">${body}</div></div>`
  );
}

const LINE_MAX = 160;
const cut = (s: string, n = LINE_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const day = (d: string | null) => (d ? d.slice(0, 10) : "");

export function prsHtml(b: MentionsBody): string {
  if (!b.prs.length) return "";
  const words: Record<string, string> = { open: "open", merged: "merged", closed: "closed", unknown: "not known yet", "not-a-pr": "not a PR", "not-checked": "not checked" };
  return (
    `<div class="wiki-sel-prs">` +
    b.prs
      .map((p) => `<a class="wiki-sel-pr" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.repo)}#${p.number}</a> <span class="wiki-sel-pr-state" data-pr-state="${p.state}">${esc(words[p.state] ?? p.state)}${p.mergedAt ? ` ${esc(day(p.mergedAt))}` : ""}</span>`)
      .join(" · ") +
    `</div>`
  );
}

/** Why a free phrase (no key kind) can be missed: the route `git grep`s
 *  each line of the tracked files for it as written (never an untracked one,
 *  such as a page the wiki-committer has not committed yet), and the
 *  selection is the rendered text. The answer cannot tell which reason holds. */
export const NOT_AS_WRITTEN = "The search reads only the files git tracks in the wiki, one source line at a time, as written: a new page not yet in git, a phrase that wraps across lines, or one with formatting or a link in the source is not found.";

/** «Where else»: each file that names the key, with its line numbers and its
 *  first line; the open page marked; then the log.md lines and the PRs. A page
 *  row's link carries `data-relpath`, so the shell's nav delegate opens it.
 *  A free phrase is on the open page (it was selected there), so its card
 *  never says it is named nowhere, nor lets the page's absence pass unsaid. */
export function whereElseHtml(b: MentionsBody, opts: { currentRelPath: string | null; hrefFor: (relPath: string) => string }): string {
  const phrase = b.kind === null;
  if (b.files.length === 0 && b.log.length === 0) {
    return phrase
      ? `<div class="wiki-sel-empty">«${esc(b.key)}» is not found as written in the wiki's tracked files. ${esc(NOT_AS_WRITTEN)}</div>`
      : `<div class="wiki-sel-empty">«${esc(b.key)}» is named nowhere in the wiki's tracked files.</div>`;
  }
  const total = `${b.totalLines}${b.totalsAtLeast ? "+" : ""} line${b.totalLines === 1 ? "" : "s"} in ${b.totalFiles}${b.totalsAtLeast ? "+" : ""} file${b.totalFiles === 1 ? "" : "s"}`;
  const rows = b.files
    .map((f) => {
      const here = f.relPath === opts.currentRelPath;
      const name = f.title ? `<a href="${esc(opts.hrefFor(f.relPath))}" data-relpath="${esc(f.relPath)}">${esc(f.title)}</a>` : `<span class="wiki-sel-file-name">${esc(f.relPath)}</span>`;
      const nums = f.lines.slice(0, 8).map((l) => l.n).join(", ") + (f.lines.length > 8 ? " …" : "");
      const first = f.lines[0];
      return (
        `<li class="wiki-sel-file" data-sel-file="${esc(f.relPath)}">${name}${here ? ' <span class="wiki-sel-here">this page</span>' : ""}` +
        `${f.title ? ` <span class="wiki-sel-path">${esc(f.relPath)}</span>` : ""}` +
        ` <span class="wiki-sel-lines">line${f.lines.length === 1 ? "" : "s"} ${esc(nums)}</span>` +
        (first ? `<div class="wiki-sel-line">${esc(cut(first.text.trim()))}</div>` : "") +
        `</li>`
      );
    })
    .join("");
  const log = b.log.length
    ? `<div class="wiki-sel-log">log.md: ${b.log.length} line${b.log.length === 1 ? "" : "s"}${b.log[0]?.date ? ` (${esc(day(b.log.at(-1)!.date))} → ${esc(day(b.log[0]!.date))})` : ""}</div>`
    : "";
  const hereMissing =
    phrase && !b.truncated && opts.currentRelPath !== null && !b.files.some((f) => f.relPath === opts.currentRelPath)
      ? `<div class="wiki-sel-empty">This page is not listed, though the phrase was selected on it. ${esc(NOT_AS_WRITTEN)}</div>`
      : "";
  return `<div class="wiki-sel-meta">${esc(total)}${b.truncated ? " · not all listed" : ""}</div><ul class="wiki-sel-files">${rows}</ul>${hereMissing}${log}${prsHtml(b)}`;
}

/** «History»: the commits and the log.md lines as one timeline, newest first,
 *  then the PRs those lines name. */
export function historyHtml(b: MentionsBody, max = 12): string {
  const events = [
    ...b.commits.map((c) => ({ date: day(c.date), html: `${esc(cut(c.subject, 120))} <span class="wiki-sel-sha">${esc(c.sha.slice(0, 7))}</span>`, kind: "commit" })),
    ...b.log.map((l) => ({ date: day(l.date), html: esc(cut(l.line.replace(/^[-*]\s+/, "").trim(), 120)), kind: "log" })),
  ].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  if (!events.length) return `<div class="wiki-sel-empty">No commit or log.md entry adds or changes «${esc(b.key)}».</div>`;
  const shown = events.slice(0, max);
  return (
    `<div class="wiki-sel-tl">` +
    shown.map((e) => `<div class="wiki-sel-ev" data-ev="${e.kind}"><span class="wiki-sel-d">${esc(e.date || "—")}</span> ${e.kind === "log" ? '<span class="wiki-sel-evk">log.md</span> ' : ""}${e.html}</div>`).join("") +
    `</div>` +
    (events.length > shown.length || b.truncated ? `<div class="wiki-sel-meta">${events.length - shown.length > 0 ? `${events.length - shown.length} more` : "More"} not shown.</div>` : "") +
    prsHtml(b)
  );
}

export function selectionMenuStyles(): string {
  return `
    #${SEL_BAR_ID}, #${SEL_MENU_ID} {
      position: fixed; z-index: 45; display: none;
      background: var(--bg-surface); color: var(--text-primary);
      border: 1px solid var(--border-secondary); border-radius: 9px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22); font-size: 13px; font-family: inherit;
    }
    #${SEL_BAR_ID} { padding: 4px; gap: 2px; flex-wrap: wrap; max-width: min(960px, calc(100vw - 24px)); }
    .wiki-selbar-btn {
      background: none; border: 0; color: var(--text-primary); padding: 5px 9px; border-radius: 6px;
      cursor: pointer; font: inherit; white-space: nowrap;
    }
    .wiki-selbar-btn:hover, .wiki-selbar-btn.def, .wiki-selmenu-it:hover, .wiki-selmenu-it.def, .wiki-selbar-btn:focus-visible, .wiki-selmenu-it:focus-visible {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
    }
    .wiki-selbar-btn:focus-visible, .wiki-selmenu-it:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .wiki-selbar-btn.def { font-weight: 600; }
    .wiki-selbar-btn.chip, .wiki-selmenu-it[data-selact="key"] { color: var(--accent-light); }
    #${SEL_MENU_ID} { padding: 5px; min-width: 260px; }
    .wiki-selmenu-it {
      display: flex; width: 100%; justify-content: space-between; gap: 12px; padding: 6px 10px; border-radius: 6px;
      background: none; border: 0; color: var(--text-primary); cursor: pointer; font: inherit; text-align: left;
    }
    .wiki-selmenu-it.def { font-weight: 600; }
    #${SEL_MENU_ID} .k { color: var(--text-dim); font-size: 11.5px; font-weight: 400; }
    .wiki-selmenu-sep { border-top: 1px solid var(--border-secondary); margin: 4px 0; }
    .wiki-selmenu-hd { font-size: 11px; color: var(--text-dim); padding: 4px 10px 2px; text-transform: uppercase; letter-spacing: 0.04em; }
    .wiki-selmenu-hd:first-child { text-transform: none; letter-spacing: 0; font-style: italic; }
    .wiki-selmenu-foot { display: flex; justify-content: space-between; gap: 12px; padding: 4px 10px; font-size: 12px; color: var(--text-dim); }
    .${SEL_CARD_CLASS} {
      border: 1px solid var(--accent); border-left-width: 4px; border-radius: 8px;
      background: var(--bg-surface); padding: 10px 12px; margin: 8px 0 12px; font-size: 13.5px;
      line-height: 1.5; color: var(--text-primary); white-space: normal; list-style: none;
    }
    .wiki-sel-card-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
    .wiki-sel-card-title { font-weight: 600; }
    .wiki-sel-card-moved { margin: 0 0 6px; }
    .wiki-sel-card-sub { font-weight: 400; color: var(--text-dim); }
    /* A thread turn's head is one line at a fixed height: its sub line is
       filled once when the read lands and must not move the text below (R6). */
    .${SEL_CARD_CLASS}[data-sel-turn] .wiki-sel-card-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #${SEL_TIP_ID} {
      position: absolute; top: calc(100% + 6px); left: 0; display: none; z-index: 46; width: max-content; max-width: 380px;
      background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-secondary); border-radius: 8px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22); padding: 7px 11px; font-size: 13px; line-height: 1.45; white-space: normal;
    }
    .wiki-seltip-l2 { margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--border-secondary); color: var(--text-secondary); }
    .wiki-seltip-change, .wiki-selwho-x {
      background: none; border: 0; padding: 0; color: var(--accent-light); font: inherit; cursor: pointer; text-decoration: underline;
    }
    .wiki-seltip-change:focus-visible, .wiki-selwho-user:focus-visible, .wiki-selwho-x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    #${SEL_WHO_ID} {
      position: fixed; z-index: 47; display: none; width: 360px; max-width: calc(100vw - 16px);
      background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-secondary); border-radius: 10px;
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22); padding: 10px 14px; font-size: 13px;
    }
    .wiki-selwho-hd { display: flex; justify-content: space-between; gap: 8px; font-weight: 600; margin-bottom: 6px; }
    .wiki-selwho-x { text-decoration: none; color: var(--text-secondary); }
    .wiki-selwho-row { display: grid; grid-template-columns: 54px 1fr; gap: 4px 10px; padding: 7px 0; border-top: 1px solid var(--border-secondary); }
    .wiki-selwho-k { color: var(--text-secondary); font-size: 12.5px; }
    .wiki-selwho-h { font-size: 12px; color: var(--text-dim); margin-top: 2px; }
    .wiki-selwho-users { display: flex; flex-wrap: wrap; gap: 6px; }
    .wiki-selwho-user {
      background: transparent; border: 1px solid var(--border-primary); color: var(--text-primary);
      border-radius: 999px; padding: 2px 10px; font: inherit; cursor: pointer;
    }
    .wiki-selwho-user[aria-pressed="true"] { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, transparent); font-weight: 600; }
    .wiki-selwho-models { color: var(--accent-light); margin-left: 4px; }
    .wiki-selwho-msg { margin-top: 6px; }
    .wiki-sel-card-tools { display: flex; gap: 6px; flex-shrink: 0; }
    .wiki-sel-card-btn {
      background: transparent; border: 1px solid var(--border-primary); color: var(--text-secondary);
      border-radius: 999px; padding: 2px 9px; font: inherit; font-size: 12px; cursor: pointer;
    }
    .wiki-sel-card-btn:hover { background: var(--tint-neutral); color: var(--text-primary); }
    .wiki-sel-meta, .wiki-sel-log, .wiki-sel-empty { font-size: 12.5px; color: var(--text-secondary); margin: 4px 0; }
    .wiki-sel-files { margin: 4px 0; padding-left: 18px; }
    .wiki-sel-file { margin: 3px 0; }
    .wiki-sel-path, .wiki-sel-lines { font-size: 11.5px; color: var(--text-dim); }
    .wiki-sel-here { font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--tint-neutral); color: var(--text-secondary); }
    .wiki-sel-line { font-size: 12px; color: var(--text-secondary); font-family: var(--font-mono, monospace); overflow-wrap: anywhere; }
    .wiki-sel-prs { font-size: 12.5px; margin-top: 4px; }
    .${SEL_CARD_CLASS} a { color: var(--accent-light); }
    .wiki-sel-pr-state { color: var(--text-secondary); }
    .wiki-sel-tl { border-left: 2px solid var(--border-secondary); margin-left: 6px; padding-left: 12px; }
    .wiki-sel-ev { position: relative; margin: 0 0 6px; font-size: 12.5px; }
    .wiki-sel-ev::before { content: ""; position: absolute; left: -18px; top: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--bg-surface); border: 2px solid var(--accent); }
    .wiki-sel-d, .wiki-sel-sha { font-family: var(--font-mono, monospace); font-size: 11.5px; color: var(--text-dim); }
    .wiki-sel-evk { font-size: 11px; color: var(--text-dim); }
  `;
}
