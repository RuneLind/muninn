/**
 * The reader's provenance VIEW — every string and every fragment of markup the
 * browser shows for `/api/wiki/page`'s `provenance` block, with no DOM in sight.
 *
 * **One surface, under the title.** The strip is a collapsed LINE — the Jira
 * row, then one sentence of cost plus a mark per event — that opens in place
 * into the CHAIN: every session that wrote the page and every PR those sessions
 * merged, on one spine in time order. The rail's Sessions section was the same
 * facts in a 340 px column and is gone.
 *
 * The line and the chain read one payload and live in one module, because a
 * sentence that disagreed with the rows it opens into would be two renderers
 * disagreeing about one object.
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
  HANDOFF_READS_MAX,
  PR_READS_MAX,
  type ProvenanceGhostLink,
  type ProvenanceHandoff,
  type ProvenanceJira,
  type ProvenanceLedgerState,
  type ProvenanceLinksState,
  type ProvenanceMerge,
  type ProvenanceMergesState,
  type ProvenancePayload,
  type ProvenanceSessionChip,
} from "../../../wiki/provenance.ts";
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

  // THE NINTH STATE: no session on the page, but the ledger links one. A
  // `prs:`-only page produced no line at all — and therefore no strip — while a
  // PR ghost is exactly the thing such a page has to say. It is a state of THIS
  // function rather than a second condition in `provStripHtml`, which is what
  // keying that early return on the LINE was for.
  // `?? []` throughout, because this crosses the wire: a payload a server built
  // before the ghost legs existed simply has no key.
  const ghosts = p.ghosts ?? [];
  if (n === 0 && ghosts.length > 0) {
    // Through `with_` like every other branch. `backfilled` qualifies the LIST —
    // "this page's `sessions:` line was inferred from history" — and this is the
    // one state where that list is EMPTY, which makes the marker MORE relevant,
    // not less: it is why the page names no session of its own.
    return with_(`the ledger links ${plural(ghosts.length, "session")}${ghostLinkTail(p)}`);
  }

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

/**
 * `through #553 — $101.72`, the tail both ghost sentences share.
 *
 * TWO claims, and an earlier cut got both wrong on the same line. It read
 * `links 3 sessions through #553 — $15.00` for a page whose three ghosts came
 * through two PRs and a handoff and of which the ledger had priced two: the
 * link named was the FIRST ghost's alone, and the money read as the total for
 * all three.
 *
 *  - **The sources are counted, not sampled.** One PR is named (`through #553`);
 *    several are counted (`through 2 PRs`), because naming one of them is how
 *    the sentence claims the others do not exist. Handoffs are appended rather
 *    than dropped — `through #553 and a handoff` — since a handoff is the weaker
 *    evidence of the two and the sentence must not hide which kind it rests on.
 *    A session id is never named: a reader has no way to place one.
 *  - **The money says its denominator.** `— $15.00` only when every ghost is
 *    priced; `— $15.00 over 2 of 3` otherwise. With none priced (leg 5 failed)
 *    there is no amount at all, because a ghost with no cost is not a $0 session.
 *
 * Rounding happens in ONE place, `money`'s own `toFixed(2)`. The local
 * `Math.round(total * 100) / 100` that used to sit here was a second rounding of
 * a number about to be rounded — inert, and exactly the kind of duplicate that
 * survives a change to the first one.
 */
function ghostLinkTail(p: ProvenancePayload): string {
  const ghosts = p.ghosts ?? [];
  const prs: string[] = [];
  let handoffs = 0;
  let total = 0;
  let priced = 0;
  for (const ghost of ghosts) {
    const link = ghost.ghost;
    if (link?.via === "pr") {
      if (!prs.includes(link.through)) prs.push(link.through);
    } else if (link?.via === "handoff") {
      handoffs += 1;
    }
    if (typeof ghost.cost === "number") {
      total += ghost.cost;
      priced += 1;
    }
  }

  const parts: string[] = [];
  if (prs.length === 1) parts.push(prs[0]!);
  else if (prs.length > 1) parts.push(plural(prs.length, "PR"));
  if (handoffs === 1) parts.push("a handoff");
  else if (handoffs > 1) parts.push(plural(handoffs, "handoff"));
  const through = parts.length ? ` through ${parts.join(" and ")}` : "";

  if (priced === 0) return through;
  const over = priced < ghosts.length ? ` over ${priced} of ${ghosts.length}` : "";
  return `${through} — ${money(total)}${over}`;
}

/**
 * The hint after the marks when the page HAS stamped sessions and the ledger
 * links more — `the ledger links 1 more session through #553 — $101.72`.
 *
 * A separate sentence rather than a clause of `costLine`, because the cost
 * sentence is about the sessions the page STAMPED and a ghost is never in its
 * denominator. `null` when there is no ghost, or when the page has no stamped
 * session at all — there the ninth `costLine` state says it instead, and two
 * sentences saying the same thing on one line is worse than either.
 */
export function ghostHint(p: ProvenancePayload): string | null {
  const ghosts = p.ghosts ?? [];
  if (!ghosts.length || !p.sessions.length) return null;
  return `the ledger links ${plural(ghosts.length, "more session")}${ghostLinkTail(p)}`;
}

/**
 * What a gate kind is called in a row. The ledger's kinds are its own spelling
 * (`gate-review-floor`); an UNKNOWN one is named raw rather than dropped, so a
 * kind claude-usage adds shows up as a fact the reader can look up instead of
 * silently thinning the verdict.
 */
export const GATE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "gate-review-floor": "review floor",
  "gate-split-check": "split check",
  "gate-campaign": "campaign gate",
  "gate-closing": "closing gate",
  triviality: "review skipped",
  "ceremony-check": "ceremony check",
});

/** Render order — the ledger's own `ASSOCIABLE_GATE_KINDS`, so two merges with
 *  the same gates read the same way whatever order the payload listed them in. */
export const GATE_ORDER: readonly string[] = Object.keys(GATE_LABELS);

/**
 * The gate verdict for one merge row, or null when there is nothing to say.
 *
 * Five outcomes, and the order they are tried in is the whole content:
 *
 * | gate | verdict |
 * |---|---|
 * | `null` (a bare `gh pr merge`) | nothing — upstream left the data out, so this states no opinion |
 * | `{matched: false}` | `gate not matched` — the join found no ledger row, which is not "ungated" |
 * | `gated` | `✓ <the gates it carried>` |
 * | `preStandardization` | `no gate data before <date>` |
 * | otherwise | `no gate line` |
 *
 * `preStandardization` sits BELOW `gated` and ABOVE `no gate line`: it qualifies
 * an ABSENCE. A merge from before the phrases were machine-parsed has no gate
 * data to be missing, and rendering it as `no gate line` reads as a verdict
 * about the merge rather than about the corpus.
 */
/** The mark a gated verdict opens with — one spelling, shared by the builder and
 *  by the renderer that splits it back out. */
export const GATE_OK_MARK = "✓";

export function gateVerdict(
  merge: ProvenanceMerge,
  rulesStandardizedDate?: string | null,
): string | null {
  const gate = merge.gate;
  if (!gate) return null;
  if (!gate.matched) return GATE_NOT_MATCHED_COPY;
  if (gate.gated) {
    const kinds = gate.gates ?? [];
    const known = GATE_ORDER.filter((k) => kinds.includes(k));
    const rest = kinds.filter((k) => !GATE_ORDER.includes(k));
    const labels = [...known.map((k) => GATE_LABELS[k]!), ...rest];
    // Gated through a shape that associated no KIND (a campaign session's
    // closing gate covering its sole merge) still says so: the ledger's verdict
    // is the fact, and the kinds are how it is spelled out when it has them.
    return `${GATE_OK_MARK} ${labels.length ? labels.join(" + ") : "gated"}`;
  }
  if (merge.preStandardization) {
    return rulesStandardizedDate
      ? `no gate data before ${rulesStandardizedDate}`
      : "no gate data before the gate phrases were standardized";
  }
  return NO_GATE_LINE_COPY;
}

/** The two gate sentences that are not built from a date or a kind list. */
export const GATE_NOT_MATCHED_COPY = "gate not matched";
export const NO_GATE_LINE_COPY = "no gate line";

/**
 * A model id, shortened for the row.
 *
 * ONE rule: drop a trailing `-YYYYMMDD` release stamp and keep the family, so
 * `claude-sonnet-4-5-20250929` reads as `claude-sonnet-4-5` while
 * `claude-opus-5` is unchanged. Eight digits is the whole test — a seven-digit
 * tail is a version, not a day — and the RAW id rides the row's `title`, because
 * which build answered is a fact worth being able to read exactly.
 */
export function modelLabel(raw: string): string {
  return raw.replace(/-\d{8}$/, "");
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
  host: string;
  /** Clipped for the row; `titleFull` is the hover. */
  title: string;
  titleFull: string;
  /** `fmtCost`'s figure on a priced chip (4 decimals under a cent), `null` on a
   *  bare one. */
  costLabel: string | null;
  /** The copy that REPLACES the money on a bare chip, `null` on a priced one. */
  bareCopy: string | null;
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
  return {
    glyph: providerGlyph(chip.provider),
    providerLabel: chip.provider || "unknown provider",
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
 * The strip under `.wiki-meta-row`: the Jira row, then the disclosure line and
 * the chain it opens.
 *
 * `""` when the page carries neither a Jira key nor a line — a payload can exist
 * for a `prs`-only page, and an empty bordered strip is furniture. **`prs`
 * renders nothing here at all**: the PR row ships with campaign 2, and a
 * half-built control is worse than none.
 *
 * The early return is keyed on the LINE rather than on `sessions.length`, which
 * is what keeps it extensible: a later state that has something to say about a
 * page naming no session (a ledger-linked session the page never stamped) says
 * it by answering from `costLine`, not by adding a second condition here.
 *
 * The key itself is the filter affordance (`data-prov-jira`), not a second
 * control beside the link: the chip already names one thing, and a reader who
 * wants the issue clicks the ↗. **Both controls are gated on `known`** — a key
 * the facet does not hold gets neither, and says why in its `title`, because the
 * browse URL for a non-key is as dead as the filter (see `jiraKeyFilterable`).
 */
/** What the placeholder strip says while `GET /api/wiki/page/provenance` is in
 *  flight. The page is already readable above it; this line only says the
 *  chain is coming, so it stays as short as a caption. */
export const PROV_PENDING_COPY = "loading provenance…";
/** What the placeholder becomes when the fetch fails outright (network, a 5xx).
 *  A degraded LEDGER is not this — that answers 200 with bare chips and its own
 *  reason; this is the one case where nothing at all came back. */
export const PROV_UNAVAILABLE_COPY = "provenance not loaded";

/**
 * The strip a page renders BEFORE its provenance is known: the same
 * `.wiki-prov-strip` block `provStripHtml` renders, so `redrawProvStrip` can
 * replace it in place, plus `wiki-prov-pending` for the spinner. Rendered only
 * when the page answered `provenancePending`, so an unstamped page still gets
 * no strip at all.
 */
export function provPendingHtml(): string {
  return (
    `<div class="wiki-prov-strip wiki-prov-pending" aria-busy="true">` +
    `<span class="wiki-prov-cost"><span class="wiki-prov-spinner" aria-hidden="true"></span>` +
    `${esc(PROV_PENDING_COPY)}</span></div>`
  );
}

/** The placeholder's terminal state when the fetch itself failed. Still a
 *  `.wiki-prov-strip`, so a later stamp refetch can replace it too. */
export function provUnavailableHtml(): string {
  return (
    `<div class="wiki-prov-strip wiki-prov-unavailable">` +
    `<span class="wiki-prov-cost">${esc(PROV_UNAVAILABLE_COPY)}</span></div>`
  );
}

export function provStripHtml(
  p: ProvenancePayload,
  known?: Record<string, number> | null,
  opts: ChainRenderOptions = {},
): string {
  // `opts` reaches BOTH halves: the marks' hovers carry the same stamps the
  // chain rows do, and a zone passed to one and not the other renders a session
  // at two different hours on one page.
  const line = provLineHtml(p, opts);
  if (!p.jira.length && !line) return "";
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
  if (line) html += line + chainHtml(p, opts);
  return html + `</div>`;
}

// ── The chain ────────────────────────────────────────────────────────────────

/**
 * One event on the page's spine: a session that wrote it, or a PR one of those
 * sessions merged.
 *
 * `at` is the instant the event is SORTED on, carried on the event so a renderer
 * and a test read the same field the comparator did — `null` for an event the
 * ledger gave no date for.
 */
export interface ChainSessionEvent {
  kind: "session";
  at: string | null;
  chip: ProvenanceSessionChip;
}
export interface ChainMergeEvent {
  kind: "merge";
  at: string | null;
  merge: ProvenanceMerge;
}
/** One session's handoff being run by another — a quiet line BETWEEN the two
 *  sessions, which is where sorting it on the instant the later session typed it
 *  puts it. */
export interface ChainHandoffEvent {
  kind: "handoff";
  at: string | null;
  handoff: ProvenanceHandoff;
}
export type ChainEvent = ChainSessionEvent | ChainMergeEvent | ChainHandoffEvent;

/**
 * The union of sessions and merges, ascending.
 *
 * A session is dated by `first ?? last` — the fallback `chipView` already uses,
 * because the ledger returns one end of the range for a session that ran inside
 * a minute and the other for one that did not.
 *
 * **A dateless event sorts LAST, in the page's own `sessions:` order.** Every
 * bare chip has `first: null` (`enrichSessions` fills the whole key set with
 * nulls when the ledger holds no facts), so the shape fixture's `missing`
 * session and a damaged ref's `invalid` chip would otherwise land wherever the
 * comparator happened to leave them — which is a different place per engine, and
 * the reason the rule is stated rather than inherited from a sort.
 *
 * Ties keep input order (sessions before merges), through an explicit index
 * rather than by relying on the sort being stable.
 */
export function chainEvents(p: ProvenancePayload): ChainEvent[] {
  const events: ChainEvent[] = [
    // A ghost is a session event like any other and takes the SAME dating rule:
    // dated from its own facts when leg 5 priced it, and dateless — therefore
    // last — when that leg failed. `?? []` for the same wire reason as `merges`.
    ...[...p.sessions, ...(p.ghosts ?? [])].map((chip): ChainEvent => ({
      kind: "session",
      at: chip.first ?? chip.last ?? null,
      chip,
    })),
    ...(p.handoffs ?? []).map((handoff): ChainEvent => ({
      kind: "handoff",
      at: handoff.at ?? null,
      handoff,
    })),
    // `?? []` because this crosses the wire: a payload a server built before the
    // merges leg existed simply has no key, and the reader must not index into
    // it.
    ...(p.merges ?? []).map((merge): ChainEvent => ({
      kind: "merge",
      at: merge.mergedAt ?? null,
      merge,
    })),
  ];
  return events
    .map((event, i) => ({ event, i, ms: stampMs(event.at) }))
    .sort((a, b) => {
      // Undated means "no position of its own", so it goes after everything
      // that has one — including an `at` the ledger sent that does not parse,
      // which cannot be placed either.
      if (a.ms === null || b.ms === null) {
        if (a.ms === b.ms) return a.i - b.i;
        return a.ms === null ? 1 : -1;
      }
      return a.ms === b.ms ? a.i - b.i : a.ms - b.ms;
    })
    .map(({ event }) => event);
}

/** Epoch ms for a ledger stamp, or null when there is nothing to place. Parsed
 *  rather than string-compared: the ledger spells its stamps in UTC today, and a
 *  lexicographic order would be wrong the day one carries an offset. */
function stampMs(at: string | null): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** What a chain row shows of a date. The runtime default is the VIEWER's own
 *  zone; tests pass one explicitly, or every assertion on an hour becomes a fact
 *  about the machine the suite ran on. */
interface ChainRenderOptions {
  timeZone?: string;
}

/**
 * `MM-DD HH:MM` from the ledger's ISO stamp.
 *
 * Assembled from `formatToParts` rather than from a format string: the order of
 * a locale's date parts is the locale's business (`09/15` before the time in
 * en-US, after it elsewhere), and this row's layout is not.
 *
 * `hourCycle: "h23"` is stated rather than left to the locale. Measured on bun
 * 1.3.10 for midnight UTC under `en-GB`: `h23` and `hour12: false` both give
 * `00`, the locale's own default gives `00`, `h24` gives `24` and `h12` gives
 * `12`. So the two wrong answers are reachable through an option, and naming the
 * cycle is what keeps a midnight row from reading as the end of the day before
 * or as noon.
 *
 * A DATE-ONLY value (`2026-09-15`) is answered `MM-DD` from its own digits and
 * never converted: `Date.parse` reads it as UTC midnight, so formatting it in
 * any zone west of UTC renders the day BEFORE — and there is no hour in the
 * input to render anyway. Nothing on this page produces one today — `chip.first`
 * and `chip.last` are ledger facts and `mergedAt` comes off the merges payload,
 * all three full ISO stamps, and the only date-only value that reaches this
 * function is a test fixture. The branch is defence against an upstream that
 * starts spelling a day, so that it renders as a day rather than as yesterday.
 *
 * The digits are ROUND-TRIPPED before they are echoed: the shape pattern alone
 * accepts `2026-99-99` and `0000-00-00`, and answering those `99-99` / `00-00`
 * puts a non-date in front of the reader where the pre-branch code put nothing.
 * `setUTCFullYear` rather than `Date.UTC` for the trip: `Date.UTC` maps a year
 * of 0–99 onto 1900+year, which would refuse a year below 100 as out of range.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function fmtChainStamp(at: string | null | undefined, timeZone?: string): string {
  if (!at) return "";
  const dateOnly = DATE_ONLY.exec(at);
  if (dateOnly) {
    const [year, month, day] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    const trip = new Date(0);
    trip.setUTCFullYear(year, month - 1, day);
    const survived =
      trip.getUTCFullYear() === year && trip.getUTCMonth() + 1 === month && trip.getUTCDate() === day;
    return survived ? `${dateOnly[2]}-${dateOnly[3]}` : "";
  }
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const at_ = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${at_("month")}-${at_("day")} ${at_("hour")}:${at_("minute")}`;
}

/** The span a session covers: both ends when the ledger returned two different
 *  instants, one otherwise. */
function sessionWhen(chip: ProvenanceSessionChip, timeZone?: string): string {
  const first = fmtChainStamp(chip.first, timeZone);
  const last = fmtChainStamp(chip.last, timeZone);
  if (first && last && first !== last) return `${first} → ${last}`;
  return first || last;
}

/**
 * The GitHub coordinate a merge row is titled with, or null.
 *
 * Read off the URL the ledger resolved, never off `repo`: that column is a
 * CHECKOUT PATH on this corpus, and turning one into an `owner/repo` is the
 * guess upstream refuses to make. A URL that is not a github.com pull request is
 * treated as no URL at all — this row renders one kind of link, and an arbitrary
 * href out of a ledger row is not it.
 */
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\/pull\/([0-9]+)$/;

function mergeCoordinate(url: string | null): { repo: string; number: string } | null {
  if (!url) return null;
  const m = PR_URL.exec(url);
  return m ? { repo: m[1]!, number: m[2]! } : null;
}

/** The last segment of a checkout path — what an unlinked row hovers, so the
 *  reader can tell WHICH checkout without being shown a coordinate nobody
 *  resolved. */
function repoBasename(repo: string): string {
  const parts = repo.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : repo;
}

/** What a merge row says when the ledger's own result was never paired with a
 *  confirmation. Qualified, never dropped: false has three causes and two of
 *  them are ordinary (a UI merge, an unpaired `gh pr merge`). */
export const MERGE_UNCONFIRMED_COPY = "merge unconfirmed";

/** The merges leg failed. One line, at the foot of the chain — the cost sentence
 *  is about the FACTS leg and must not move for this. */
export const MERGES_UNREACHABLE_NOTE = "merges not shown: claude-usage did not answer";

/** Some batches answered and some did not. The rows above are real and there
 *  are more of them — which is why this does not say "not shown". */
export const MERGES_PARTIAL_NOTE =
  "merges may be incomplete: claude-usage answered for some sessions only";

/**
 * Upstream cut the list at ITS own cap, reported with the cap it used.
 *
 * The number is the payload's `limit`, never a literal here: upstream's
 * `truncated` is `ids.length > SESSION_IDS_MAX` per CALL (claude-usage
 * `src/routes.ts`), and this module is browser-safe and cannot import the
 * ledger client to name a constant that lives in another repo anyway.
 *
 * ⚠️ UNREACHABLE TODAY, deliberately kept: `fetchMergesForSessions` batches at
 * exactly `SESSION_IDS_PER_CALL` (200) = upstream's own cap, so no call this
 * side makes can exceed it. It is upstream's cap that decides, and it can move
 * in a release muninn does not ship — at which point this is the only thing
 * standing between a reader and a silently short list.
 *
 * "list cut", not "not shown": the rows beside this note are rendered, and the
 * previous wording told the reader to disbelieve what was on screen.
 */
export function mergesCutNote(limit?: number | null): string {
  return typeof limit === "number" && limit > 0
    ? `merges list cut at ${limit} by claude-usage`
    : "merges list cut by claude-usage";
}

/** The footer line for the merges leg, or null when it has nothing to report.
 *  An UNASKED leg says nothing: a host with no claude-usage has no merges call
 *  to have failed. Most-severe first: a leg that answered nothing, then one that
 *  answered for some sessions, then a list upstream cut. */
export function mergesNote(state?: ProvenanceMergesState | null): string | null {
  if (!state?.asked) return null;
  if (!state.reachable) return MERGES_UNREACHABLE_NOTE;
  if (state.partial) return MERGES_PARTIAL_NOTE;
  if (state.truncated) return mergesCutNote(state.limit);
  return null;
}

/**
 * Most marks the line renders before it stops and counts the rest.
 *
 * MEASURED on a 60-session page in a 1100 px window: the uncapped run painted
 * 60 marks, ending 44 px past the article column and taking the caret with them
 * (the review that found this measured 213 px at its own width). The marks are
 * one inline-flex run beside a sentence, in a column a reader is reading an
 * ARTICLE in. Two dozen 9 px glyphs with a 3 px gap is ~150 px, which sits
 * beside the cost sentence down to a 760 px window; past two dozen the count
 * says more than the glyphs do. The CSS wraps them as well (see
 * `.wiki-prov-marks` in `wiki-page.ts`), so the cap is the legibility bound and
 * the wrap is the containment one — neither alone.
 */
export const MARKS_MAX = 24;

/**
 * How many marks each kind renders when the page has more than {@link MARKS_MAX}
 * of them, given one count per kind in render order.
 *
 * Every kind PRESENT is reserved an equal share of the cap first
 * (`floor(cap / kinds present)`), and whatever a kind does not need of its share
 * is handed on to the kinds in render order. So a page of 250 sessions and one
 * merge spends one slot on the merge and the other 23 on sessions, and a page of
 * 30 and 30 splits 12/12 — while a page with only sessions is unchanged, because
 * one kind present means one share worth the whole cap.
 *
 * The reservation is the point: MEASURED on 3f019ea4, which built the run
 * sessions-then-merges and sliced it, a page of 250 sessions and one merge
 * rendered `session=24, merge=0, +227` — the merges leg's whole contribution to
 * the line deleted by a page's session count.
 */
function markQuotas(counts: number[], cap: number): number[] {
  const total = counts.reduce((sum, n) => sum + n, 0);
  if (total <= cap) return counts.slice();
  const present = counts.filter((n) => n > 0).length;
  const share = Math.floor(cap / present);
  const quotas = counts.map((n) => Math.min(n, share));
  let spare = cap - quotas.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < quotas.length && spare > 0; i++) {
    const take = Math.min(spare, counts[i]! - quotas[i]!);
    quotas[i]! += take;
    spare -= take;
  }
  return quotas;
}

/** The marks after the sentence: sessions first, then merges, and one `+N`
 *  counting everything dropped of BOTH kinds when there are more than
 *  {@link MARKS_MAX}. Each kind present keeps a reserved share of the cap — see
 *  {@link markQuotas}. The vocabulary is open — `data-mark` names the kind, so a
 *  later kind (a session the ledger links but the page never stamped) is a
 *  value, not a rewrite: it joins the counts array and gets a share of its own. */
function marksHtml(p: ProvenancePayload, opts: ChainRenderOptions): string {
  const sessionMarks: string[] = [];
  const ghostMarks: string[] = [];
  const mergeMarks: string[] = [];
  const sessionMark = (chip: ProvenanceSessionChip, ghost: boolean): string => {
    const v = chipView(chip, p.ledger);
    const when = sessionWhen(chip, opts.timeZone);
    const what = v.bareCopy ?? `${v.titleFull || chip.id}${v.costLabel ? ` — ${v.costLabel}` : ""}`;
    const why = ghost ? "linked by the ledger, not stamped on this page · " : "";
    return (
      `<span class="wiki-prov-mark wiki-prov-mark-${ghost ? "ghost" : "session"}"` +
      ` data-mark="${ghost ? "ghost" : "session"}"` +
      ` title="${esc(why + (when ? `${when} · ${what}` : what))}">○</span>`
    );
  };
  for (const chip of p.sessions) sessionMarks.push(sessionMark(chip, false));
  // A DASHED ring — the same glyph, a different class, so the two kinds read as
  // the same thing in two states rather than as two vocabularies.
  for (const chip of p.ghosts ?? []) ghostMarks.push(sessionMark(chip, true));
  for (const merge of p.merges ?? []) {
    const coordinate = mergeCoordinate(merge.url);
    const label = merge.prNumber === null ? "a merge" : `#${merge.prNumber}`;
    const where = coordinate ? `${coordinate.repo} ` : "";
    mergeMarks.push(
      `<span class="wiki-prov-mark wiki-prov-mark-merge" data-mark="merge"` +
        ` title="merged ${esc(where + label)}">▪</span>`,
    );
  }
  const byKind = [sessionMarks, ghostMarks, mergeMarks];
  const quotas = markQuotas(
    byKind.map((kind) => kind.length),
    MARKS_MAX,
  );
  const shown = byKind.flatMap((kind, i) => kind.slice(0, quotas[i]!));
  let html = `<span class="wiki-prov-marks">` + shown.join("");
  const rest = byKind.reduce((sum, kind) => sum + kind.length, 0) - shown.length;
  if (rest > 0) {
    // A mark like the others — it carries a title, so the number is never the
    // only thing it says — and the chain below lists every one of them.
    html +=
      `<span class="wiki-prov-mark wiki-prov-mark-more" data-mark="more"` +
      ` title="${esc(`${plural(rest, "more event")} — open the line to see ${rest === 1 ? "it" : "them"}`)}">` +
      `+${rest}</span>`;
  }
  return html + `</span>`;
}

/** The id of the chain element, and what the line's `aria-controls` points at.
 *  One strip per page, so one id. */
export const CHAIN_ID = "wikiProvChain";

/**
 * The collapsed line: the cost sentence and the marks, as ONE disclosure
 * button.
 *
 * A real `<button aria-expanded>` rather than a `<summary>` or a clickable
 * `<div>`: the reader on a keyboard gets it for free, and the state is readable
 * by anything that asks. `""` when there is no sentence — a page carrying only a
 * Jira key has nothing to open.
 */
export function provLineHtml(p: ProvenancePayload, opts: ChainRenderOptions = {}): string {
  const sentence = costLine(p);
  if (!sentence) return "";
  const hint = ghostHint(p);
  return (
    `<button type="button" class="wiki-prov-line" data-prov-toggle` +
    ` aria-expanded="false" aria-controls="${CHAIN_ID}">` +
    `<span class="wiki-prov-cost">${esc(sentence)}</span>` +
    marksHtml(p, opts) +
    (hint ? `<span class="wiki-prov-ghost-hint">${esc(hint)}</span>` : "") +
    `<span class="wiki-prov-caret" aria-hidden="true">▾</span>` +
    `</button>`
  );
}

/** One session's row. The copy button keeps the `data-sess-copy` contract the
 *  rail rows had — the client's delegate and `copySessionId` are unchanged. */
/** The Stamp control's two labels. ONE spelling each, shared with the client's
 *  two-step confirm — two spellings is how a button silently renames itself. */
export const STAMP_LABEL = "Stamp";
export const STAMP_CONFIRM_LABEL = "Confirm: this session wrote the page";

/** What a ghost row says its evidence is. A handoff is a pasted PROMPT and says
 *  nothing about this page, which is why its Stamp asks twice. */
function ghostReason(link: ProvenanceGhostLink): string {
  return link.via === "handoff"
    ? "ran this session's handoff — may not have touched this page"
    : `merged ${link.through} — this page does not stamp it`;
}

/**
 * Why a ghost has no Stamp button even on a stamping instance, or `null` when
 * the row already says it.
 *
 * A chip the ledger never answered for (`unresolved`, `missing`, `invalid`)
 * already carries its own reason line from `bareChipCopy`, and it is the TRUE
 * one: leg 5 failed, or the ledger does not hold this id. Adding "the ledger
 * named no provider for this session" beside it put two contradicting sentences
 * on one row — one saying the lookup never answered, the other reporting what
 * the answer contained. `bareChipReason` is the same predicate `chipView` uses
 * to decide the bare copy, so the two can never disagree about which state the
 * chip is in.
 *
 * The provider sentence stays exactly where it was earned: a chip the ledger DID
 * answer for, naming a provider this pipeline does not stamp.
 */
function noStampReason(chip: ProvenanceSessionChip): string | null {
  if (chip.provider) {
    return `no Stamp — the ledger reports provider "${chip.provider}", which this pipeline does not stamp`;
  }
  if (bareChipReason(chip)) return null;
  return "no Stamp — the ledger named no provider for this session";
}

function sessionRowHtml(
  chip: ProvenanceSessionChip,
  ledger: ProvenanceLedgerState | null | undefined,
  opts: ChainRenderOptions,
  stampable = false,
): string {
  const v = chipView(chip, ledger);
  const when = sessionWhen(chip, opts.timeZone);
  // The hover carries the ledger's own stamps, so the row's local-time label is
  // never the only spelling of the instant. DEDUPED on the RAW stamps: a session
  // the ledger answered one timestamp for has `first === last`, and `X → X`
  // reads as a range of zero rather than as one moment. (The other collapse —
  // two stamps inside the same minute rendering one label — is `sessionWhen`'s,
  // on the FORMATTED pair, and leaves both raw stamps in this hover.)
  const whenTitle = [...new Set([chip.first, chip.last].filter(Boolean))].join(" → ");
  const messages = typeof chip.messages === "number" ? plural(chip.messages, "message") : "";
  const ghost = chip.ghost;
  let html =
    `<div class="wiki-chain-row wiki-chain-session${v.bareCopy ? " wiki-chain-bare" : ""}` +
    `${ghost ? " wiki-chain-ghost" : ""}"` +
    `${messages ? ` title="${esc(messages)}"` : ""}>`;
  html += `<div class="wiki-chain-head">`;
  html += `<span class="wiki-chain-glyph" title="${esc(v.providerLabel)}">${esc(v.glyph)}</span>`;
  if (when) {
    html +=
      `<span class="wiki-chain-when"${whenTitle ? ` title="${esc(whenTitle)}"` : ""}>${esc(when)}</span>`;
  }
  // The `·` SEPARATES the host from the date before it; with no date there is
  // nothing to separate it from, and the row opened `◇ · macmini`.
  if (v.host) html += `<span class="wiki-chain-host">${when ? "· " : ""}${esc(v.host)}</span>`;
  // The model after the host, shortened, with the raw id on the hover. The `·`
  // separates it from whatever is before it, and with neither date nor host
  // there is nothing to separate it from.
  if (chip.model) {
    html +=
      `<span class="wiki-chain-model" title="${esc(chip.model)}">` +
      `${when || v.host ? "· " : ""}${esc(modelLabel(chip.model))}</span>`;
  }
  if (v.costLabel) html += `<span class="wiki-chain-cost">${esc(v.costLabel)}</span>`;
  // The delegated SLICE of that total, never an addition to it. Rendered only
  // beside a cost, since "of what" is the whole meaning of the number.
  if (v.costLabel && typeof chip.delegatedCost === "number") {
    html +=
      `<span class="wiki-chain-delegated" title="spent by this session's subagents">` +
      `· ${esc(fmtCost(chip.delegatedCost))} delegated</span>`;
  }
  html += `</div>`;
  if (v.title) {
    html += `<div class="wiki-chain-title" title="${esc(v.titleFull)}">${esc(v.title)}</div>`;
  }
  if (v.bareCopy) html += `<div class="wiki-chain-reason">${esc(v.bareCopy)}</div>`;
  if (ghost) html += `<div class="wiki-chain-reason">${esc(ghostReason(ghost))}</div>`;
  html += `<div class="wiki-chain-idrow">`;
  html += `<code class="wiki-chain-id">${esc(chip.id)}</code>`;
  html +=
    `<button type="button" class="wiki-chain-copy" data-sess-copy="${esc(chip.id)}"` +
    ` title="Copy the session id" aria-label="${esc(sessionCopyAriaLabel(chip.id))}">` +
    `${SESSION_COPY_IDLE}</button>`;
  if (v.url) {
    html +=
      `<a class="wiki-chain-link" href="${esc(v.url)}" target="_blank" rel="noopener"` +
      ` title="Open this session in claude-usage">↗</a>`;
  }
  // The Stamp, on a ghost only. THREE conditions, each with its own outcome:
  // this instance may stamp at all (`stampable`, which is false on the mini and
  // on any wiki the CLI's roots do not cover), and the ledger's provider maps to
  // a prefix the CLI will accept — otherwise the row says why rather than
  // offering a click that can only 409.
  if (ghost) {
    if (!stampable) {
      // Nothing: `stampable` is an instance-and-wiki fact, and repeating it on
      // every ghost row of a read-only reader is noise, not information.
    } else if (!ghost.stampRef) {
      const why = noStampReason(chip);
      if (why) html += `<span class="wiki-chain-nostamp">${esc(why)}</span>`;
    } else {
      html +=
        `<button type="button" class="wiki-chain-stamp"` +
        ` data-prov-stamp="${esc(ghost.stampRef)}"` +
        // A handoff is evidence about a PROMPT, so the write it would make is a
        // claim the reader has to affirm. The client swaps the label on the
        // first click; the attribute is what tells it to.
        `${ghost.via === "handoff" ? ` data-prov-stamp-confirm="1"` : ""}` +
        ` title="Record this session on the page's sessions: line">${STAMP_LABEL}</button>` +
        // Where a refusal goes. Rendered EMPTY and hidden rather than created by
        // the client, so the class and the hook are one spelling shared by the
        // renderer and `wiki-browser.ts` — and so the reason never has to be put
        // into the button's own label, which is what made a failed Stamp rename
        // the control to a sentence. The client writes `textContent`, so the
        // route's copy is escaped by the DOM rather than by a second escaper.
        `<span class="wiki-chain-stamp-msg" data-prov-stamp-msg hidden></span>`;
    }
  }
  return html + `</div></div>`;
}

/** One handoff: the quiet line between the session that wrote a handoff prompt
 *  and the one that ran it. Both ends on the hover — the ids are what a reader
 *  would paste into claude-usage, and the row has no room for two of them. */
function handoffRowHtml(handoff: ProvenanceHandoff, opts: ChainRenderOptions): string {
  const when = fmtChainStamp(handoff.at, opts.timeZone);
  return (
    `<div class="wiki-chain-row wiki-chain-handoff"` +
    ` title="${esc(`${handoff.from} → ${handoff.to}`)}">` +
    `<span class="wiki-chain-glyph" aria-hidden="true">↳</span>` +
    `<span class="wiki-chain-when">handoff${when ? ` · ${esc(when)}` : ""}` +
    `${handoff.host ? ` · ${esc(handoff.host)}` : ""}</span>` +
    `</div>`
  );
}

/** One merged PR. The title is omitted: `subject` is null on every merge
 *  measured — it comes from the confirm side, not the merge event. */
function mergeRowHtml(
  merge: ProvenanceMerge,
  opts: ChainRenderOptions,
  rulesStandardizedDate?: string | null,
): string {
  const coordinate = mergeCoordinate(merge.url);
  const number = merge.prNumber === null ? "" : `#${merge.prNumber}`;
  const when = fmtChainStamp(merge.mergedAt, opts.timeZone);
  let html = `<div class="wiki-chain-row wiki-chain-merge">`;
  html += `<span class="wiki-chain-glyph" title="a merged pull request">▪</span>`;
  if (coordinate) {
    html +=
      `<a class="wiki-chain-pr" href="${esc(merge.url!)}" target="_blank" rel="noopener">` +
      `${esc(coordinate.repo)} ${esc(number || `#${coordinate.number}`)}</a>`;
  } else {
    // No coordinate: the number alone, with the checkout's basename as the
    // hover. Never a link — a plausible-looking link to somebody else's
    // repository is the worst output this row can have. NO third branch: a row
    // with neither a number nor a repo (the ledger holds a `sessionId` and
    // nothing else) still says `a merge`, where the guard this replaced left a
    // row carrying one glyph and no words at all.
    html +=
      `<span class="wiki-chain-pr"${merge.repo ? ` title="${esc(repoBasename(merge.repo))}"` : ""}>` +
      `${esc(number || "a merge")}</span>`;
  }
  if (when) html += `<span class="wiki-chain-when">merged ${esc(when)}</span>`;
  if (!merge.mergeOk) {
    html +=
      `<span class="wiki-chain-unconfirmed"` +
      ` title="the merge command's own result was never paired with a confirmation">` +
      `${MERGE_UNCONFIRMED_COPY}</span>`;
  }
  const verdict = gateVerdict(merge, rulesStandardizedDate);
  if (verdict) {
    // The ✓ is a MARK and takes the only colour on this row; the WORDS beside it
    // stay at the row's own text colour. Measured on a body probe: the success
    // token is 3.0:1 in the light theme, under the 4.5:1 floor every line a
    // reader has to READ sits at — and a verdict is a line to read.
    const gated = verdict.startsWith(GATE_OK_MARK);
    const body = gated ? verdict.slice(GATE_OK_MARK.length).trimStart() : verdict;
    html +=
      `<span class="wiki-chain-gate"` +
      ` title="the pipeline ledger's own gate verdict for this merge">` +
      (gated ? `<span class="wiki-chain-gate-ok">${GATE_OK_MARK}</span> ` : "") +
      `${esc(body)}</span>`;
  }
  return html + `</div>`;
}

/**
 * The chain itself — hidden until the line is pressed.
 *
 * `hidden` on the element rather than a class, so the collapsed state is the
 * DOM's own and a reader with no CSS (or a stylesheet that failed to load) does
 * not get every row of every page expanded.
 */
export function chainHtml(p: ProvenancePayload, opts: ChainRenderOptions = {}): string {
  let html = `<div class="wiki-prov-chain" id="${CHAIN_ID}" hidden>`;
  for (const event of chainEvents(p)) {
    if (event.kind === "session") {
      html += sessionRowHtml(event.chip, p.ledger, opts, p.stampable === true);
    } else if (event.kind === "merge") {
      html += mergeRowHtml(event.merge, opts, p.rulesStandardizedDate);
    } else {
      html += handoffRowHtml(event.handoff, opts);
    }
  }
  // The merges leg first (it is the one the rows above came from), then the four
  // PR-3 legs. Every one of them is a footer line rather than a missing row: a
  // leg that did not answer and a page that has nothing to show are different
  // facts, and the cost sentence moves for neither.
  for (const note of [mergesNote(p.mergesLedger), ...linksNotes(p.links)]) {
    if (note) html += `<div class="wiki-chain-note">${esc(note)}</div>`;
  }
  return html + `</div>`;
}

/**
 * The footer lines for the four PR-3 legs, most-severe first.
 *
 * A leg that was never ASKED says nothing — a page naming no `prs:` has no PR
 * call to have failed, exactly as `mergesNote` treats an unasked merges leg.
 * Legs 5 and 6 report nothing here either: their degrade is already on screen
 * as an id-only ghost row, and a footer line about it would describe a row the
 * reader can see.
 */
export function linksNotes(links?: ProvenanceLinksState | null): string[] {
  if (!links) return [];
  const notes: string[] = [];
  if (links.handoffs.asked && !links.handoffs.reachable) notes.push(HANDOFFS_UNREAD_NOTE);
  if (links.prs.asked && !links.prs.reachable) notes.push(PR_LINKS_UNREAD_NOTE);
  if (links.handoffsCapped) {
    notes.push(`handoff lines not shown: this page names more than ${HANDOFF_READS_MAX} sessions`);
  }
  if (links.prsCapped) notes.push(`PR links read for the first ${PR_READS_MAX} entries only`);
  if (links.timedOut) notes.push(LINKS_TIMED_OUT_NOTE);
  return notes;
}

export const HANDOFFS_UNREAD_NOTE = "handoffs not read";
export const PR_LINKS_UNREAD_NOTE = "PR links not read: claude-usage did not answer";
export const LINKS_TIMED_OUT_NOTE = "some ledger reads timed out";

/** Label on a chain row's copy button, and what it flips to. Short because the
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

/** The rail's empty state — what `#wikiList` says when no page matches. */
export const LIST_EMPTY_HTML = '<div class="wiki-conn-empty">No pages match.</div>';

/**
 * Compose the rail: the page rows, or the empty state when there are none.
 *
 * **The empty state is decided on the PAGE html alone**, and the function stays
 * after the Sessions section left the rail because that is the rule it carries.
 * Seeding the buffer with something else and falling back with `html || EMPTY`
 * is what made a non-empty prefix suppress "No pages match." entirely: open a
 * stamped page, pick a facet matching nothing, and the rail showed session rows
 * and no answer to the question the reader had just asked. Whatever a later
 * change wants to put above the rows, it may not stand in for the answer about
 * the filter.
 */
export function railListHtml(pagesHtml: string): string {
  return pagesHtml || LIST_EMPTY_HTML;
}
