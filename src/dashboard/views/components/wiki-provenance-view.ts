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
 * seven ledger states that must not collapse into each other — gets enumerated
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
  type ProvenanceJira,
  type ProvenancePayload,
  type ProvenanceSessionChip,
} from "../../../wiki/provenance.ts";
import type { WikiFilters } from "./wiki-filter.ts";
import { railSectionsVisible } from "./wiki-recents.ts";
import { escHtml as esc } from "./escape.ts";

/** `$X.XX`. `totalCost` is already rounded to cents at the server seam, so this
 *  only ever pads — it is deliberately not a second rounding, which would hide a
 *  seam that stopped rounding. */
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
 * Seven outcomes, and the reason they are seven rather than two is the whole
 * point of `ProvenanceLedgerState`:
 *
 * | state | line |
 * |---|---|
 * | priced, complete | `the N sessions that wrote this page cost $X in total` |
 * | priced, some chip unpriced | `… cost $X in total over M of N` |
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

/** One session row, as data. The renderer below turns it into markup; a test
 *  reads it directly. */
export interface SessionChipView {
  glyph: string;
  /** `title=` on the glyph, so the mark is never the only thing naming the
   *  provider. */
  providerLabel: string;
  /** `first`, or "" when the ledger priced nothing and the page's ref carries no
   *  date of its own. */
  dateLabel: string;
  /** `last` when it differs from `first` — the hover that says a session ran
   *  across days. "" otherwise. */
  dateTitle: string;
  host: string;
  /** Clipped for the row; `titleFull` is the hover. */
  title: string;
  titleFull: string;
  /** `$X.XX` on a priced chip, `null` on a bare one. */
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

export function chipView(chip: ProvenanceSessionChip): SessionChipView {
  const reason = bareChipReason(chip);
  const title = chip.title ?? "";
  return {
    glyph: providerGlyph(chip.provider),
    providerLabel: chip.provider || "unknown provider",
    dateLabel: chip.first ?? "",
    dateTitle: chip.last && chip.last !== chip.first ? `${chip.first ?? "?"} → ${chip.last}` : "",
    host: chip.host ?? "",
    title: clipTitle(title),
    titleFull: title,
    // A priced chip is one the ledger held; `cost` can still be null there (an
    // unpriced but known session), and `—` is the honest answer for it.
    costLabel: reason ? null : chip.cost === null ? "—" : money(chip.cost),
    bareCopy: reason ? BARE_CHIP_COPY[reason] : null,
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
 * The strip under `.wiki-meta-row`: the Jira row, then the cost line.
 *
 * `""` when the page carries neither — a payload can exist for a `prs`-only
 * page, and an empty bordered strip is furniture. **`prs` renders nothing here
 * at all**: the PR row ships with campaign 2, and a half-built control is worse
 * than none.
 *
 * The key itself is the filter affordance (`data-prov-jira`), not a second
 * control beside the link: the chip already names one thing, and a reader who
 * wants the issue clicks the ↗.
 */
export function provStripHtml(p: ProvenancePayload): string {
  const cost = costLine(p);
  if (!p.jira.length && !cost) return "";
  let html = `<div class="wiki-prov-strip">`;
  if (p.jira.length) {
    html += `<div class="wiki-prov-jira-row">`;
    for (const j of p.jira.map(jiraChipView)) {
      html +=
        `<span class="wiki-prov-jira">` +
        `<button type="button" class="wiki-prov-jira-key" data-prov-jira="${esc(j.key)}"` +
        ` title="Show every page serving ${esc(j.key)}">${esc(j.key)}</button>` +
        (j.known ? HUGINN_KNOWN_MARK : "") +
        `<a class="wiki-prov-jira-link" href="${esc(j.url)}" target="_blank" rel="noopener"` +
        ` title="Open ${esc(j.key)} in Jira">↗</a>` +
        `</span>`;
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

/**
 * The rail's `Sessions` section — the header plus one row per chip.
 *
 * Rendered as a PREFIX to the page list rather than through `buildRail`, and the
 * reason is that function's own invariant: its model is pages ("every page
 * appears exactly ONCE"), `rail.shown` counts distinct pages among its rows, and
 * four e2e specs key on `.wiki-list-item[data-relpath]`. A session is not a
 * page, so folding these rows into that model would mean teaching every one of
 * those to ignore a row kind — while the visible result is identical.
 *
 * Rows carry no `data-relpath`, so the reader's navigation delegate never claims
 * them; the only controls are the ⧉ copy button and, where the instance sets
 * `CLAUDE_USAGE_PUBLIC_URL`, the ↗ link.
 */
export function sessionsRailHtml(sessions: ProvenanceSessionChip[]): string {
  if (!sessions.length) return "";
  let html =
    `<div class="wiki-list-sec" data-section="sessions">` +
    `<span class="wiki-sec-label">Sessions</span></div>`;
  for (const v of sessions.map(chipView)) {
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
      ` title="Copy the session id" aria-label="Copy the session id">${SESSION_COPY_IDLE}</button>`;
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
