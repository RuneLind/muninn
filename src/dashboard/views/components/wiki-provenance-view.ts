/**
 * The reader's provenance VIEW — every string and every fragment of markup the
 * browser shows for `/api/wiki/page`'s `provenance` block, with no DOM in sight.
 *
 * **Placement C**, decided in the plan: the strip under the page title is the
 * SUMMARY (the Jira row plus ONE line of cost), the rail panel is the DETAIL
 * (one row per session). The two halves read the same payload, so they live in
 * one module — a cost line that disagreed with the chips below it would be two
 * renderers disagreeing about one object.
 *
 * Pure on purpose. `wiki-browser.ts` is a 5,000-line browser entrypoint that
 * `bun test` cannot load (it touches `document` at import time), so anything
 * shaped there is provable only through Playwright. Everything here is a string
 * builder over a plain payload, which is how the copy family below —
 * eight ledger states that must not collapse into each other — gets enumerated
 * in a table test instead of being spot-checked in one e2e run.
 *
 * Imports the SERVER's `bareChipReason` rather than re-deriving the precedence
 * between the three bare flags: the payload's contract says at most one is set,
 * and a second implementation of "which one wins" is exactly the thing that
 * drifts. The module is browser-safe — `provenance.ts` has one `import type` and
 * no runtime dependency at all.
 */

import {
  bareChipReason,
  isJiraKeyShape,
  type ProvenanceJira,
  type ProvenanceLedgerState,
  type ProvenancePayload,
  type ProvenanceSessionChip,
} from "../../../wiki/provenance.ts";
import type { WikiFilters } from "./wiki-filter.ts";
import { railSectionsVisible } from "./wiki-recents.ts";
import { escHtml as esc } from "./escape.ts";
import { fmtCost } from "./fmt-cost.ts";

/**
 * `$X.XX` for the STRIP's `totalCost` and nothing else.
 *
 * That number is rounded to cents at the server seam (`costOfSessions`), so two
 * decimals cannot hide anything here and a second rounding would hide a seam
 * that stopped rounding. A PER-CHIP `cost` arrives raw — the seam rounds only
 * the sum — so a chip renders through `fmtCost`, whose sub-cent rule keeps a
 * real $0.003 session from reading as $0.00.
 */
export function money(usd: number): string {
  return "$" + usd.toFixed(2);
}

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

/**
 * The ONE line of cost under the page title, or `null` when there is nothing
 * honest to say (a page carrying only a Jira key).
 *
 * Eight outcomes, and the reason they are eight rather than two is the whole
 * point of `ProvenanceLedgerState`:
 *
 * | state | line |
 * |---|---|
 * | priced, complete | `the N sessions that wrote this page cost $X in total` |
 * | priced, some chip unpriced | `… cost $X in total over M of N` |
 * | asked, reachable, NOTHING priced | `N sessions wrote this page — the ledger holds none of them` |
 * | `partial` (a batch failed) | `… at least $X — the ledger answered for M of N` |
 * | asked, unreachable | `N sessions wrote this page — claude-usage unreachable, cost unknown` |
 * | never asked, unconfigured | `N sessions wrote this page — no claude-usage on this host` |
 * | never asked, configured, all ids damaged | `N session refs — none could be looked up` |
 * | never asked, no sessions at all | (no line) |
 *
 * The fourth and fifth are the pair that must never be spelled the same way: an
 * instance nobody pointed at a claude-usage is not a claude-usage that is down,
 * and `asked` is the field that tells them apart. The sixth is the one the
 * server's own comment names — a page whose only problem is a mangled
 * frontmatter line reported "unreachable" in the first server cut, and reading
 * `asked` as "a lookup returned something" is how it got there.
 *
 * `backfilled` appends `· inferred from history YYYY-MM-DD` to whichever line
 * was built: it qualifies the LIST, not the money, so it rides every state
 * including the unreachable ones.
 */
export function costLine(p: ProvenancePayload): string | null {
  const n = p.sessions.length;
  const tail = p.backfilled ? ` · inferred from history ${p.backfilled}` : "";
  const with_ = (line: string): string => line + tail;

  if (!p.ledger.asked) {
    if (n === 0) return null;
    if (!p.ledger.configured) {
      return with_(`${plural(n, "session")} wrote this page — no claude-usage on this host`);
    }
    // Configured, sessions named, and still nobody asked: every id on the page
    // was refused before batching (`invalid`). Saying "unreachable" here blames
    // a service that was never called.
    return with_(`${plural(n, "session ref")} — none could be looked up`);
  }

  if (!p.ledger.reachable) {
    return with_(`${plural(n, "session")} wrote this page — claude-usage unreachable, cost unknown`);
  }

  const m = p.costedSessions;
  if (p.ledger.partial) {
    return with_(`the ${plural(n, "session")} that wrote this page cost at least ${money(p.totalCost)} — the ledger answered for ${m} of ${n}`);
  }
  // Asked, reachable, every batch answered — and NOT ONE of the sessions was
  // priced. The `m < n` line below would spell that `cost $0.00 in total over 0
  // of 1`, i.e. "we don't know" rendered as "it was free", which is the one
  // reading a money figure must never carry. Deliberately below the `partial`
  // branch: there a batch FAILED, so "the ledger holds none of them" would be a
  // claim about an answer nobody got.
  if (m === 0 && n > 0) {
    return with_(`${plural(n, "session")} wrote this page — the ledger holds none of them`);
  }
  if (m < n) {
    return with_(`the ${plural(n, "session")} that wrote this page cost ${money(p.totalCost)} in total over ${m} of ${n}`);
  }
  return with_(`the ${plural(n, "session")} that wrote this page cost ${money(p.totalCost)} in total`);
}

/** Per-provider glyph for a session row. `claude-code` and `opencode` are the
 *  two providers that stamp today; anything else — including a bare ref the
 *  ledger could not name a provider for — takes the neutral dot rather than an
 *  invented mark. */
export function providerGlyph(provider: string | null | undefined): string {
  if (provider === "claude-code") return "◆";
  if (provider === "opencode") return "◇";
  return "•";
}

/** What a bare chip says INSTEAD of money. The three are not interchangeable —
 *  a `missing` session is gone, an `unresolved` one was never asked about — so
 *  each gets its own sentence rather than a shared "no cost". */
export const BARE_CHIP_COPY: Record<"invalid" | "unresolved" | "missing", string> = {
  invalid: "not a session id — frontmatter damage",
  missing: "not in the ledger — reaped, or from another host",
  unresolved: "not looked up — claude-usage did not answer",
};

/**
 * `unresolved` on a host with no `CLAUDE_USAGE_URL` at all.
 *
 * The flag means "nobody asked", which has two causes — a batch that failed, and
 * an instance nobody pointed at a claude-usage — and `ledger.configured` is what
 * tells them apart. The default copy blames a service that does not exist on an
 * unconfigured host, and it did so UNDER a strip already saying "no claude-usage
 * on this host": the same split `costLine`'s fourth and fifth rows exist for,
 * one level down.
 */
export const BARE_CHIP_UNCONFIGURED_COPY = "not looked up — no claude-usage on this host";

/** The sentence a bare chip carries, given what this host knows. */
export function bareChipCopy(
  reason: "invalid" | "unresolved" | "missing",
  ledger?: ProvenanceLedgerState | null,
): string {
  if (reason === "unresolved" && ledger && !ledger.configured) return BARE_CHIP_UNCONFIGURED_COPY;
  return BARE_CHIP_COPY[reason];
}

/** One session row, as data. The renderer below turns it into markup; a test
 *  reads it directly. */
export interface SessionChipView {
  glyph: string;
  /** `title=` on the glyph, so the mark is never the only thing naming the
   *  provider. */
  providerLabel: string;
  /** `first`, else `last`, else "" — whichever date the ledger returned. */
  dateLabel: string;
  /** `first → last` when the ledger returned BOTH and they differ — the hover
   *  that says a session ran across days. "" otherwise. */
  dateTitle: string;
  host: string;
  /** Clipped for the row; `titleFull` is the hover. */
  title: string;
  titleFull: string;
  /** `fmtCost`'s figure on a priced chip (4 decimals under a cent), `null` on a
   *  bare one. */
  costLabel: string | null;
  /** The copy that REPLACES the money on a bare chip, `null` on a priced one. */
  bareCopy: string | null;
  /** The bare id, always — it is what the copy button puts on the clipboard. */
  id: string;
  /** The claude-usage drill-down, present only where `CLAUDE_USAGE_PUBLIC_URL`
   *  is set on this instance. */
  url: string | null;
}

/** How much of a session title a rail row shows before the hover takes over.
 *  The rail is resizable and the ledger's titles are whole sentences; 60 is
 *  where a title stops competing with the date and the money beside it. */
export const SESSION_TITLE_MAX = 60;

export function clipTitle(title: string, max = SESSION_TITLE_MAX): string {
  if (title.length <= max) return title;
  return title.slice(0, max - 1).trimEnd() + "…";
}

export function chipView(
  chip: ProvenanceSessionChip,
  ledger?: ProvenanceLedgerState | null,
): SessionChipView {
  const reason = bareChipReason(chip);
  const title = chip.title ?? "";
  // Both halves through `?? null`, so an ABSENT field and an explicit null are
  // the same thing: this payload crosses the wire, and `JSON.parse` drops a key
  // the server left undefined.
  const first = chip.first ?? null;
  const last = chip.last ?? null;
  return {
    glyph: providerGlyph(chip.provider),
    providerLabel: chip.provider || "unknown provider",
    // The date the ledger DID return, whichever end of the range it is. Reading
    // `first` alone dropped a chip's only date on the ground — `dateTitle` was
    // built for that case and the renderer shows a title only beside a label.
    dateLabel: first ?? last ?? "",
    // The hover exists to say a session ran across days, which needs BOTH ends.
    dateTitle: first && last && first !== last ? `${first} → ${last}` : "",
    host: chip.host ?? "",
    title: clipTitle(title),
    titleFull: title,
    // A priced chip is one the ledger held; `cost` can still be null there (an
    // unpriced but known session), and `—` is the honest answer for it.
    //
    // `fmtCost`, not `money`, for two reasons. The per-chip figure is the
    // ledger's RAW number — only the SUM is rounded at the seam — so the
    // sub-cent rule is what keeps a real $0.003 session off `$0.00`; and it
    // answers `—` for an absent value, where `money(undefined)` threw out of the
    // render loop and took the whole Sessions section down over one chip.
    // `== null` widens the explicit branch to match (a wire payload loses a key
    // the server left undefined). It is deliberately belt-and-braces: with
    // `fmtCost` behind it the two spellings render identically, so no test can
    // tell them apart — the OBSERVABLE fix here is the renderer.
    costLabel: reason ? null : chip.cost == null ? "—" : fmtCost(chip.cost),
    bareCopy: reason ? bareChipCopy(reason, ledger) : null,
    id: chip.id,
    // A BARE chip gets no drill-down, even where the server built one: for
    // `missing` and `invalid` the link is a dead end by construction (the
    // service answered that it does not hold the id, or the id cannot be one),
    // and rendering an ↗ that lands on "no such session" is worse than the
    // copyable id beside it. `unresolved` rides along with them — its link would
    // often work, but it is the state where the reader has just been told
    // nothing could be looked up, and one live arrow among three would read as
    // "this one is different" rather than "this one was asked about".
    url: reason ? null : (chip.url ?? null),
  };
}

/** One Jira chip in the strip. `known` is `true` ONLY when huginn's corpus was
 *  asked AND answered yes — an absent `huginnKnown` means nobody asked, which is
 *  not the same as "this key is fabricated", so it renders no mark at all. */
export interface JiraChipView {
  key: string;
  url: string;
  known: boolean;
}

export function jiraChipView(j: ProvenanceJira): JiraChipView {
  return { key: j.key, url: j.url, known: j.huginnKnown === true };
}

// ── Markup ───────────────────────────────────────────────────────────────────

/** The mark beside a key huginn's corpus holds. A title, never a bare glyph:
 *  the reader has no way to guess what a check mark on a Jira key means. */
const HUGINN_KNOWN_MARK =
  `<span class="wiki-prov-known" title="huginn's Jira corpus holds this issue">✓</span>`;

/**
 * Is this key a working control, or only a string the page happens to carry?
 *
 * `known` is the LISTING payload's `jira` map — the facet's own membership set,
 * shape-filtered server-side (`jiraCounts`) while the store deliberately keeps a
 * malformed key on the page's own row. A key outside it is exactly the key
 * `resolveJiraParam` drops, so rendering it as a filter produced a control whose
 * whole life was a lie: the click narrowed the list, the facet chip rendered
 * `NOT-A-KEY 0` beside it (breaking the rule that a count matches the rows a
 * click leaves), every link built while it was live carried a dead param, and a
 * reload of that URL silently dropped the filter.
 *
 * Absent `known` (a caller with no listing yet) ⇒ nothing is filterable, which
 * degrades to plain text rather than to a control that cannot work.
 */
function jiraKeyFilterable(key: string, known?: Record<string, number> | null): boolean {
  return !!known && Object.prototype.hasOwnProperty.call(known, key) && !!known[key];
}

/**
 * The strip under `.wiki-meta-row`: the Jira row, then the cost line.
 *
 * `""` when the page carries neither — a payload can exist for a `prs`-only
 * page, and an empty bordered strip is furniture. **`prs` renders nothing here
 * at all**: the PR row ships with campaign 2, and a half-built control is worse
 * than none.
 *
 * The key itself is the filter affordance (`data-prov-jira`), not a second
 * control beside the link: the chip already names one thing, and a reader who
 * wants the issue clicks the ↗. **Both controls are gated on `known`** — a key
 * the facet does not hold gets neither, and says why in its `title`, because the
 * browse URL for a non-key is as dead as the filter (see `jiraKeyFilterable`).
 */
export function provStripHtml(
  p: ProvenancePayload,
  known?: Record<string, number> | null,
): string {
  const cost = costLine(p);
  if (!p.jira.length && !cost) return "";
  let html = `<div class="wiki-prov-strip">`;
  if (p.jira.length) {
    html += `<div class="wiki-prov-jira-row">`;
    for (const j of p.jira.map(jiraChipView)) {
      const filterable = jiraKeyFilterable(j.key, known);
      html += `<span class="wiki-prov-jira${filterable ? "" : " wiki-prov-jira-inert"}">`;
      if (filterable) {
        html +=
          `<button type="button" class="wiki-prov-jira-key" data-prov-jira="${esc(j.key)}"` +
          ` title="Show every page serving ${esc(j.key)}">${esc(j.key)}</button>`;
      } else {
        // Two reasons, two sentences: a value that cannot BE a key is frontmatter
        // the reader can fix, while a well-shaped key the listing has not got is
        // a listing that has not caught up — and telling the second it is
        // malformed would be a false accusation about a real issue.
        const why = isJiraKeyShape(j.key)
          ? `${j.key} is not in this wiki's Jira index — no filter and no link until the page list refreshes`
          : `${j.key} is not a Jira key — no filter, no Jira link`;
        html += `<span class="wiki-prov-jira-key" title="${esc(why)}">${esc(j.key)}</span>`;
      }
      html += j.known ? HUGINN_KNOWN_MARK : "";
      if (filterable) {
        html +=
          `<a class="wiki-prov-jira-link" href="${esc(j.url)}" target="_blank" rel="noopener"` +
          ` title="Open ${esc(j.key)} in Jira">↗</a>`;
      }
      html += `</span>`;
    }
    html += `</div>`;
  }
  if (cost) html += `<div class="wiki-prov-cost">${esc(cost)}</div>`;
  return html + `</div>`;
}

/** Label on the rail's copy button, and what it flips to. Short because the
 *  button sits at the end of a row that already carries a date, a host, a title
 *  and a price. */
export const SESSION_COPY_IDLE = "⧉";
export const SESSION_COPY_OK = "✓";
export const SESSION_COPY_FAIL = "✗";

/** The ⧉ button's accessible name — ONE spelling, shared by the render here and
 *  by `copySessionId`'s revert in `wiki-browser.ts`. Two spellings meant the
 *  button silently renamed itself the first time it was pressed. */
export function sessionCopyAriaLabel(id: string): string {
  return id ? `Copy the session id ${id}` : "Copy the session id";
}

/**
 * The rail's `Sessions` section — the header plus one row per chip.
 *
 * Rendered as a PREFIX to the page list rather than through `buildRail`, and the
 * reason is that function's own invariant: its model is pages ("every page
 * appears exactly ONCE"), `rail.shown` counts distinct pages among its rows, and
 * eight e2e specs key on `.wiki-list-item[data-relpath]` (`grep -rl data-relpath
 * e2e/`). A session is not a page, so folding these rows into that model would
 * mean teaching every one of those to ignore a row kind — while the visible
 * result is identical.
 *
 * Rows carry no `data-relpath`, so the reader's navigation delegate never claims
 * them; the only controls are the ⧉ copy button and, where the instance sets
 * `CLAUDE_USAGE_PUBLIC_URL`, the ↗ link.
 *
 * `ledger` rides along for the bare rows alone: `unresolved` means "nobody
 * asked", and only `configured` says whether that was an outage or a host with
 * no claude-usage at all (see `bareChipCopy`).
 */
export function sessionsRailHtml(
  sessions: ProvenanceSessionChip[],
  ledger?: ProvenanceLedgerState | null,
): string {
  if (!sessions.length) return "";
  let html =
    `<div class="wiki-list-sec" data-section="sessions">` +
    `<span class="wiki-sec-label">Sessions</span></div>`;
  for (const v of sessions.map((c) => chipView(c, ledger))) {
    html += `<div class="wiki-sess-row${v.bareCopy ? " wiki-sess-bare" : ""}">`;
    html += `<div class="wiki-sess-head">`;
    html += `<span class="wiki-sess-glyph" title="${esc(v.providerLabel)}">${esc(v.glyph)}</span>`;
    if (v.dateLabel) {
      html +=
        `<span class="wiki-sess-date"${v.dateTitle ? ` title="${esc(v.dateTitle)}"` : ""}>` +
        `${esc(v.dateLabel)}</span>`;
    }
    if (v.host) html += `<span class="wiki-sess-host">${esc(v.host)}</span>`;
    if (v.costLabel) html += `<span class="wiki-sess-cost">${esc(v.costLabel)}</span>`;
    html += `</div>`;
    if (v.title) {
      html += `<div class="wiki-sess-title" title="${esc(v.titleFull)}">${esc(v.title)}</div>`;
    }
    if (v.bareCopy) html += `<div class="wiki-sess-reason">${esc(v.bareCopy)}</div>`;
    html += `<div class="wiki-sess-idrow">`;
    html += `<code class="wiki-sess-id">${esc(v.id)}</code>`;
    html +=
      `<button type="button" class="wiki-sess-copy" data-sess-copy="${esc(v.id)}"` +
      ` title="Copy the session id" aria-label="${esc(sessionCopyAriaLabel(v.id))}">` +
      `${SESSION_COPY_IDLE}</button>`;
    if (v.url) {
      html +=
        `<a class="wiki-sess-link" href="${esc(v.url)}" target="_blank" rel="noopener"` +
        ` title="Open this session in claude-usage">↗</a>`;
    }
    html += `</div></div>`;
  }
  return html;
}

/**
 * Is the rail's `Sessions` section on screen?
 *
 * Two conditions, and the second is borrowed rather than re-decided: the open
 * page must name a session, and the rail's recall sections must be allowed at
 * all (`railSectionsVisible` — i.e. no search query). A search is "find this",
 * and the Jira-key jump owns the head of the rail while one is running; a
 * Sessions block sitting above it would be answering a question nobody asked.
 */
export function sessionsSectionVisible(
  filters: WikiFilters,
  sessions: ProvenanceSessionChip[] | null | undefined,
): boolean {
  return Boolean(sessions?.length) && railSectionsVisible(filters);
}

/** The rail's empty state — what `#wikiList` says when no page matches. */
export const LIST_EMPTY_HTML = '<div class="wiki-conn-empty">No pages match.</div>';

/**
 * Compose the rail: the open page's Sessions block, then the page rows — or the
 * empty state when there are none.
 *
 * **The empty state is decided on the PAGE html alone.** Seeding one buffer with
 * the Sessions block and falling back with `html || EMPTY` made a non-empty
 * Sessions section suppress "No pages match." entirely: open a stamped page,
 * pick a facet matching nothing, and the rail showed session rows and no answer
 * to the question the reader had just asked. The Sessions block is about the
 * OPEN PAGE and the empty state is about the FILTER — two facts, so neither may
 * stand in for the other.
 */
export function railListHtml(sessionsHtml: string, pagesHtml: string): string {
  return sessionsHtml + (pagesHtml || LIST_EMPTY_HTML);
}
