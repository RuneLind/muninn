/**
 * The Jira-composer WIRE CONTRACT — the values the routes, PR 2's `/jira` page and
 * the tests must all agree on.
 *
 * Dependency-free on purpose, the `src/share/wire.ts` precedent: PR 2 bundles its
 * dialog/page client for the browser, so anything this module imports is pulled
 * into that bundle. `templates.ts` reaches for `bots/config.ts` types, `prompt.ts`
 * for the citation shape, `verify-keys.ts` for huginn. None of that is needed to
 * state a cap, name a depth or type a payload.
 */

/** Which template shapes the task. Ordered ids — see `templates.ts`. */
export type JiraTemplateId = "bug" | "story" | "task" | "spike";

/**
 * How much technical solution the draft carries. Deliberately an axis of its own
 * rather than four more templates (design call 2): "how much of the how" varies
 * independently of the issue type.
 */
export type JiraDepth = "ingen" | "skisse" | "full";

/** Picker order + labels. Spelled the way the reader picks them, in Norwegian. */
export const JIRA_DEPTHS: readonly { id: JiraDepth; label: string; hint: string }[] = [
  { id: "ingen", label: "Ingen", hint: "Problem, verdi, akseptansekriterier. Ingen filer, ingen klasser." },
  { id: "skisse", label: "Skisse", hint: "3–5 punkter: hvilke tjenester og klasser berøres, hvilken vei endringen går." },
  { id: "full", label: "Full", hint: "fil.kt:linje, rekkefølge, migrering, ett kodeutdrag, risiko." },
];

export function isJiraDepth(value: unknown): value is JiraDepth {
  return value === "ingen" || value === "skisse" || value === "full";
}

/**
 * Cap on the raw material (chars).
 *
 * A pasted Slack thread or a meeting note is the input; 24k is the same budget
 * `SHARE_BODY_MAX` gives a whole wiki page, which is the largest thing this
 * feature has ever been asked to read. Over-cap is a **400, never a truncation**
 * (the `SHARE_PROMPT_OVERRIDE_MAX` rule): a silently shortened note changes what
 * the model was asked without telling anyone, and the reader would read the
 * result as a task written from everything they pasted.
 */
export const JIRA_NOTES_MAX = 24_000;

/**
 * Cap on the whole assembled generation prompt (chars) — the backstop behind
 * `JIRA_NOTES_MAX`, since the citations block is server-grown and the notes cap
 * alone does not bound it. Enforced in `prompt.ts` by trimming the CITATIONS
 * (the recoverable half), never the notes.
 */
export const JIRA_BODY_MAX = 48_000;

/** Cap on the free-text `extra` steer ("fokuser på migreringsrisikoen"). */
export const JIRA_EXTRA_MAX = 2_000;

/**
 * Cap on the reader's edit of the draft at `PUT /api/jira/draft/:id`. Generous —
 * a Full-depth task with a code excerpt is genuinely long — and a hard 400, not a
 * truncation: the stored markdown is the only copy after the paste (design call 3).
 */
export const JIRA_MARKDOWN_MAX = 100_000;

/**
 * How often a client polls `GET /api/jira/draft/:id`.
 *
 * Polling, NOT a stream re-attach: there is nothing to attach to (the only SSE
 * endpoint STARTS a generation) and a re-POST of identical content would hit the
 * single-flight 409 — which is exactly this case. It is also the only mechanism
 * that survives the ordinary events: a reload, a second tab, switching away and
 * back while a 60–600 s turn runs.
 *
 * Lives HERE rather than beside `/jira`'s own page bundle because BOTH readers
 * poll the same endpoint on the same contract — the composer page and the chat's
 * draft card — and two copies of a cadence is two things to keep in step.
 */
export const JIRA_POLL_INTERVAL_MS = 2_500;

/**
 * When a poller gives up.
 *
 * Sized off the server's own ceiling: `Full` is budgeted 600 s and the
 * single-flight slot outlives it by `JIRA_SLOT_SLACK_MS` (180 s), so a draft that
 * is still `generating` at 13 min is a draft nothing is working on. Giving up
 * says so rather than polling a dead row forever.
 */
export const JIRA_POLL_MAX_MS = 13 * 60_000;

/**
 * How many rows one archive listing may carry (`GET /api/jira/archive`, and the
 * `/jira` page built on it).
 *
 * `jira_drafts` has no retention by design (migration 070) and every 🧾 click
 * mints a row, so the table only grows. The default is a screenful of recent
 * work; the ceiling is what stops a hand-written `?limit=100000` turning a page
 * render into a full-table read plus a per-row `jsonb_array_elements` pass.
 */
export const JIRA_ARCHIVE_LIMIT_DEFAULT = 50;
export const JIRA_ARCHIVE_LIMIT_MAX = 200;

/**
 * Clamp a caller-supplied `limit` into `[1, JIRA_ARCHIVE_LIMIT_MAX]`.
 *
 * `Number()` rather than `parseInt`, the `clampIntQuery` rule: `parseInt("1e3")`
 * is 1, which answers a request for a thousand rows with one and says nothing.
 * Anything unparseable falls back to the default rather than 400ing — this is a
 * read-only listing, and the page reaches it from a URL a human typed.
 */
export function clampJiraArchiveLimit(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return JIRA_ARCHIVE_LIMIT_DEFAULT;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return JIRA_ARCHIVE_LIMIT_DEFAULT;
  return Math.min(JIRA_ARCHIVE_LIMIT_MAX, Math.max(1, n));
}

/**
 * The archive list's own state, as the reader reached it.
 *
 * Carried on every link the page renders — the saved/all toggle, each row, and
 * the back link — so a hand-typed `?limit=200` survives one click. `limit` is
 * `null` when the reader named none: echoing the default back into the URL
 * would pin a value they never chose, and the next default change would not
 * reach them.
 */
export interface JiraArchiveListState {
  all: boolean;
  limit: number | null;
}

function archiveStateParams(state: JiraArchiveListState | undefined): string[] {
  if (!state) return [];
  const params: string[] = [];
  if (state.all) params.push("all=1");
  if (state.limit !== null && state.limit !== undefined) params.push(`limit=${state.limit}`);
  return params;
}

/** The list, with or without the toggle, keeping the rest of the list state. */
export function jiraArchiveUrl(state: JiraArchiveListState): string {
  const params = archiveStateParams(state);
  return params.length ? `/jira?${params.join("&")}` : "/jira";
}

/**
 * One draft's read-only page — the ONE builder both pure modules use.
 *
 * Plain (`/jira?draft=<id>`) for the chat card, which knows nothing about a
 * list; the archive passes its own `state` so a row opened from
 * `?all=1&limit=200` comes back to the page it was opened from. Two hand-written
 * copies of this path is how the back link ended up returning to a different
 * list than the one the reader left.
 */
export function jiraDraftUrl(draftId: string, state?: JiraArchiveListState): string {
  const tail = archiveStateParams(state)
    .map((p) => `&${p}`)
    .join("");
  return `/jira?draft=${encodeURIComponent(draftId)}${tail}`;
}

/** The depth's reader-facing name, from the one ordered list. Shared by the
 *  archive row and the chat card, which had a copy each. */
export function depthLabel(depth: JiraDepth | string): string {
  return JIRA_DEPTHS.find((d) => d.id === depth)?.label ?? String(depth);
}

/**
 * How much of a draft's markdown {@link jiraDraftTitle} reads.
 *
 * Bounding lives in the DERIVATION, not only in the SQL that feeds it: the
 * listing reads this many characters out of the row while the draft page holds
 * the whole markdown, so an unbounded scan gave a draft opening with a long
 * fenced block "(uten tittel)" in the list and a real title on its own page.
 * 400 chars × 200 rows is 80 KB to produce 200 labels.
 */
export const JIRA_TITLE_SCAN_CHARS = 400;

/**
 * The one-line name an archived draft goes by.
 *
 * Derived, never stored: a stored copy would let a `PUT` edit leave the listing
 * naming a task the row no longer holds.
 *
 * **The first SENTENCE identifies a Jira draft; the first heading usually does
 * not.** A Jira description carries no title — the title is the issue's summary
 * field, which lives in Jira, not in this markdown — so every shipped template
 * opens on a section name. Measured over the 43 rows on this laptop
 * (2026-08-23): 38 of them start `## Symptom`, `## Problem` or `## Verdi`, i.e.
 * heading-first would have labelled the entire archive with four repeated words.
 * The first line of prose under that heading is what tells them apart.
 *
 * A leading level-1 `# ` heading is the one exception and wins outright: a draft
 * that opens with one has been given a real title, and that beats its own first
 * sentence. A headings-only draft falls back to the first heading of any level
 * rather than to nothing.
 *
 * Fenced code is skipped, for the same reason a `#` inside a fence is not a
 * heading, and the scan is bounded HERE, at {@link JIRA_TITLE_SCAN_CHARS} — the
 * listing hands in the head of the markdown (`listJiraDrafts` reads no more than
 * that out of the row, so a 100 KB Full-depth task never crosses the wire) and
 * the draft page hands in all of it. Bounding inside the function is what makes
 * those two answer the same.
 */
export function jiraDraftTitle(markdownHead: string | null | undefined): string | null {
  if (!markdownHead) return null;
  const head = titleScanHead(markdownHead);
  let fenced = false;
  let seenAnything = false;
  let firstHeading: string | null = null;
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      seenAnything = true;
      continue;
    }
    if (fenced || !line) continue;
    // The quote marker comes OFF before the heading test, not only inside
    // `cleanJiraTitle` afterwards: a quoted section heading otherwise failed the
    // heading regex, fell through to the prose branch and titled the row
    // «## Sitert tittel» — markdown syntax rendered as a name.
    const content = stripQuoteMarkers(line);
    if (!content) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(content);
    if (heading) {
      const text = cleanJiraTitle(heading[2] ?? "");
      // A `# ` on the very first line of content is an authored title.
      if (text && heading[1]!.length === 1 && !seenAnything) return text;
      if (text && firstHeading === null) firstHeading = text;
      seenAnything = true;
      continue;
    }
    seenAnything = true;
    const text = cleanJiraTitle(content);
    if (text) return text;
  }
  return firstHeading;
}

/**
 * The first {@link JIRA_TITLE_SCAN_CHARS} code points — Postgres `substring`
 * counts characters, so a code-POINT bound is what keeps the page's scan and the
 * listing's SQL slice looking at the same text. The iterator is lazy, so this
 * costs 400 steps on a 100 KB draft, not a copy of it.
 */
function titleScanHead(text: string): string {
  if (text.length <= JIRA_TITLE_SCAN_CHARS) return text;
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n >= JIRA_TITLE_SCAN_CHARS) break;
    out += ch;
    n++;
  }
  return out;
}

/**
 * Leading BLOCK markers, stripped before the line is read as a name.
 *
 * A draft that opens on a list item, a quote or a table row is naming its task
 * in the text AFTER the marker: measured on real rows, the un-stripped form
 * titled the archive «- [ ] oppgave». Applied repeatedly (`> - [x] …` is two
 * markers), bounded so a line of nothing but markers terminates, and a line that
 * strips to nothing simply names nothing — the caller moves to the next line.
 *
 * **Every alternative demands whitespace (or the end of the line) behind the
 * marker**, the `-*+`/ordered ones included. Without it on `>` and `|` the strip
 * ate the first character of ordinary prose: `">=100 saker feiler"` was titled
 * `"=100 saker feiler"` and `"|x| er absoluttverdi"` lost its opening bar. The
 * cost is that a space-less `>quoted` line keeps its `>`; a quote written
 * without the space is rarer than a comparison, and the failure is legible
 * rather than a silently mutilated name.
 */
const BLOCK_MARKER_RE =
  /^(?:[-*+](?:\s+|$)(?:\[[ xX]\](?:\s+|$))?|\d+[.)](?:\s+|$)|>(?:\s+|$)|\|(?:\s+|$))/;

/**
 * The quote half of {@link BLOCK_MARKER_RE}, applied BEFORE a line is tested for
 * a heading — see {@link jiraDraftTitle}.
 *
 * It keeps that regex's **whitespace-or-EOL** requirement, which is the whole of
 * the F2 policy: a space-less `">=100 saker feiler"` must not lose its `>`. What
 * it adds is a RUN — `">> dobbeltsitert"` is one nested quote, and `^>(?:\s+|$)`
 * never matches it (the char after the first `>` is another `>`), so a nested
 * quote stopped stripping and titled the row `">> dobbeltsitert"`. `">>x"` still
 * matches nothing, since no prefix of the run is followed by whitespace.
 */
const QUOTE_MARKER_RE = /^>{1,8}(?:\s+|$)/;

/**
 * Leading quote-marker runs only.
 *
 * Loops while the line keeps shrinking rather than for a fixed few passes: a
 * SPACED nesting (`"> > > > > ## Dypt"`) costs one pass per level, and the old
 * 4-iteration cap left the fifth `>` on the line, which then failed the heading
 * test and titled the row `"## Dypt"`. The cap is a termination guard, not a
 * nesting limit — each pass either removes a marker or breaks.
 */
function stripQuoteMarkers(text: string): string {
  let out = text.trimStart();
  for (let i = 0; i < 32; i++) {
    const next = out.replace(QUOTE_MARKER_RE, "");
    if (next === out) break;
    out = next.trimStart();
  }
  return out;
}

function stripBlockMarkers(text: string): string {
  let out = text.trimStart();
  for (let i = 0; i < 4; i++) {
    const next = out.replace(BLOCK_MARKER_RE, "");
    if (next === out) break;
    out = next.trimStart();
  }
  return out;
}

/** Light markdown strip + clip. Emphasis and inline code only — the title is a
 *  label in a list, not a rendering surface. */
function cleanJiraTitle(text: string): string {
  const flat = stripBlockMarkers(text)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(?<!\w)[*_]([^*_]+?)[*_](?!\w)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  // Clip by CODE POINT, never by unit: `.slice(0, 119)` through an astral pair
  // stores a lone surrogate, which the row renders as a replacement character.
  return flat.length > 120 ? `${clipUnits(flat, 119)}…` : flat;
}

/**
 * Clip to `max` UTF-16 units without splitting a surrogate pair — the
 * `truncateUnits` rule from `src/wiki/ask-chat.ts`, mirrored rather than
 * imported because this module is bundled for the browser and must stay
 * dependency-free.
 */
function clipUnits(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * Retrieval coverage verdict — `research/answer.ts`'s `Coverage` plus one value
 * of this feature's own, so the browser half never imports the research layer.
 *
 * **`unreachable` is not a coverage verdict about the corpus; it is the absence
 * of one.** Measured on the first real run: huginn was down, every sub-search
 * threw (`research-knowledge.ts` records `resultCount: 0` + `error` for each),
 * `assessCoverage` saw zero hits and returned `no_hits` — and the page told the
 * reader that *"nothing in jira-issues, melosys-confluence-v3 or nav-wiki covered
 * this search"*. The corpus was never asked. The two states lead to opposite
 * actions (rewrite the raw material vs. try again in a minute), so they get
 * different values rather than one sentence hedging both.
 */
export type JiraCoverage = "answer" | "no_hits" | "low_confidence" | "unreachable";

/**
 * The three reader-facing coverage sentences.
 *
 * They live in the WIRE module rather than beside `assessCoverage` in
 * `retrieval.ts` for exactly the reason this module exists: `/jira`'s page
 * bundle renders them, and `retrieval.ts` reaches for `researchKnowledge` /
 * `fetchKnowledgeApi` / the logger, so importing them from the browser half
 * would drag the whole research layer into the bundle. `retrieval.ts` imports
 * these two, so there is still ONE spelling of each.
 *
 * Deliberately NOT `coverageMessage` from `answer.ts`: its `NO_HITS_MESSAGE`
 * names the Anthropic firehose and the Claude/YouTube/X shelves (none of which
 * this feature searches) and its `LOW_CONFIDENCE_MESSAGE` says *"I'd rather not
 * synthesize an answer that isn't well-grounded"* — the opposite of what this
 * does. An ungrounded draft is still useful raw material, so it still drafts; it
 * just never presents the result as grounded.
 */
export const JIRA_NO_HITS_MESSAGE =
  "Ingenting i jira-issues, melosys-confluence-v3 eller nav-wiki dekket dette søket, " +
  "så utkastet er skrevet utelukkende fra råmaterialet ditt. Det er ingen referanser å kontrollere — " +
  "les nøye før du oppretter saken.";

export const JIRA_LOW_CONFIDENCE_MESSAGE =
  "De nærmeste treffene dekket ikke dette temaet med sikkerhet, så utkastet er svakt forankret. " +
  "Kildene er listet opp likevel — vurder dem selv, eller skriv om råmaterialet mot det som faktisk er indeksert.";

/**
 * The retrieval that never happened.
 *
 * Deliberately says the API was unavailable and NOT that the corpus is empty —
 * see {@link JiraCoverage}. It also tells the reader what to do, because unlike
 * the other three states this one is transient: the same notes, retried later,
 * produce a grounded draft.
 */
export const JIRA_UNREACHABLE_MESSAGE =
  "Kunnskaps-API-et var utilgjengelig — ingen kilder ble hentet. Utkastet er skrevet utelukkende " +
  "fra råmaterialet ditt. Prøv igjen senere.";

/**
 * The fourth state, which the SERVER cannot spell.
 *
 * `jiraCoverageMessage` takes only the derived verdict, and a derived `no_hits`
 * has two completely different causes: the corpus covered nothing, or the reader
 * switched every retrieved source off. Telling someone who just unticked 24 rows
 * that "nothing in jira-issues covered this search" is a lie about the corpus.
 * The page distinguishes them by comparing the derived `coverage` against the
 * stored `retrievalCoverage`, which is why both ride the payload.
 */
export const JIRA_ALL_EXCLUDED_MESSAGE =
  "Alle kilder er slått av — utkastet er uten grunnlag. Retrieval fant treff, " +
  "men ingen av dem er med i denne genereringen. Slå på minst én kilde og generer på nytt " +
  "hvis saken skal være forankret.";

/**
 * The verdict for ONE generation, from the immutable retrieval verdict plus how
 * many sources that run actually kept.
 *
 * **The two are different questions and only one of them is storable.** What
 * retrieval found is a fact about the draft session — it is written once, by
 * `saveJiraDraftRetrieval`, and never again. What a given RUN was grounded in is
 * a function of the reader's exclusion set at that moment, which changes on every
 * regenerate. Writing the second back over the first is what made the composer
 * latch: one regenerate with every source toggled off stored `no_hits`, the next
 * regenerate read that back as "what retrieval found", and the draft stayed
 * `no_hits` with 21 live citations and a full `## Referanser` underneath it.
 *
 * So: the row keeps the retrieval verdict, and both the `done` payload and
 * `GET /api/jira/draft/:id` report THIS. Deriving costs nothing — the row already
 * stores the wide citation set and the run's exclusion set — and it cannot drift,
 * which two columns could.
 *
 * `null` (a legacy row, or one whose retrieval never landed) reads as `answer`,
 * the same default the regenerate path has always applied.
 */
export function effectiveCoverage(
  retrievalCoverage: JiraCoverage | null | undefined,
  retainedCount: number,
): JiraCoverage {
  // `unreachable` PASSES THROUGH the zero-retained branch. An unreachable
  // retrieval has nothing to retain by construction, so the branch below would
  // otherwise convert every one of them back into the `no_hits` claim about the
  // corpus that this value exists to stop being made.
  if (retrievalCoverage === "unreachable") return "unreachable";
  if (retainedCount === 0) return "no_hits";
  return retrievalCoverage ?? "answer";
}

/** One retrieved source, as the toggle column renders it and the prompt cites it. */
export interface JiraCitation {
  /** 1-based, renumbered after `excludeDocIds` (see the regenerate contract). */
  n: number;
  collection: string;
  docId: string;
  title: string;
  url?: string;
  /** Corpus badge — "Jira" / "Confluence" / "NAV-wiki" (see `COLLECTION_META`). */
  badge: string;
  relevance: number;
  snippet?: string;
  /** The Jira key when this doc IS an issue (`<KEY>_<slug>.md`), else absent. */
  key?: string;
}

/**
 * Verdict on one Jira key found in the generated markdown. THREE states, not two
 * — a prefix allow-list would silently drop the worst case (a fabricated key from
 * a project retrieval never surfaced), and unioning the notes' keys into
 * `verified` would bless a key mistyped in a meeting note.
 */
export type JiraKeyState =
  /** The key is in the retrieved set — the draft is grounded in that issue. */
  | "verified"
  /** Present in the notes only. Amber: the reader wrote it, retrieval never saw it. */
  | "notes"
  /** Neither retrieved nor in the notes. Red — the fabricated-key case. */
  | "unknown";

export interface JiraKeyVerdict {
  key: string;
  state: JiraKeyState;
  /**
   * Whether the key resolves to a real document in `jira-issues`.
   *
   * This is the "real verdict" behind the amber state, and it is a SEPARATE axis
   * from `state` on purpose: `state` answers "is the draft grounded in it",
   * `resolved` answers "does it exist". A notes-only key that resolves is a real
   * issue the retrieval simply missed; one that does not is a typo in the meeting
   * note. `undefined` ⇒ the lookup was unavailable (huginn down), never `false` —
   * a degraded lookup must not read as a fabrication verdict.
   */
  resolved?: boolean;
  /** The `[KEY](url)` target when resolved. */
  url?: string;
}

/** A construct the generated markdown carries that the Jira paste does NOT convert
 *  (PR 0, measured). Flagged, never silently rewritten — the `verify-keys` shape. */
export type JiraMarkdownFlagKind = "html" | "wiki-markup" | "task-list" | "emoji-shortcode";

export interface JiraMarkdownFlag {
  kind: JiraMarkdownFlagKind;
  /** 1-based line number in the generated markdown. */
  line: number;
  /** The offending fragment, clipped. */
  sample: string;
}

/** The SSE `done` payload. */
export interface JiraDonePayload {
  draftId: string;
  markdown: string;
  citations: JiraCitation[];
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  /**
   * The coverage VERDICT, deliberately not a `weakCoverage` boolean: at
   * `low_confidence` the draft is grounded-but-weak, at `no_hits` there is no
   * `## Referanser` section at all. The two states differ and the page renders
   * them differently.
   */
  coverage: JiraCoverage;
  /**
   * What RETRIEVAL found, before this run's exclusions — the same field the view
   * carries, so a stream-driven client can tell "the corpus had nothing" from
   * "the reader toggled everything off" without a second GET. `null` only when
   * retrieval never landed.
   */
  retrievalCoverage: JiraCoverage | null;
  /** The condensed retrieval question — shown so the reader can see what was searched. */
  retrievalQuestion: string;
}

/** Status of a stored draft, as `GET /api/jira/draft/:id` reports it. */
export type JiraDraftStatus = "generating" | "ready" | "failed";

/**
 * Where a draft came from.
 *
 * `notes` — the reader pasted raw material and the server retrieved for it.
 * `thread` — the draft is a TURN in a chat thread: the conversation already
 * retrieved (through the `research_knowledge` MCP tool), already argued with the
 * answer, and the draft turn inherits all of it as ordinary history. The two
 * differ in every later operation, which is why it is stored rather than inferred
 * from `thread_id` being set: a regenerate on a `thread` draft is another thread
 * turn, and its hit set comes from `research_citations`, not from a retrieval.
 */
export type JiraDraftSource = "notes" | "thread";

export function isJiraDraftSource(value: unknown): value is JiraDraftSource {
  return value === "notes" || value === "thread";
}

/** `GET /api/jira/draft/:id`. `markdown` is null while `generating`. */
export interface JiraDraftView {
  draftId: string;
  /**
   * The bot the draft was written on (`bot_name` on the row).
   *
   * Served because the page's «Juster i samtalen» deep link is built from it and
   * `GET /api/jira/templates` was the only thing that set it — so a templates
   * 503, exactly the state in which the reader most wants to get back to the
   * conversation, took the link away with it.
   */
  bot: string;
  status: JiraDraftStatus;
  /**
   * The template id as stored — a plain string, NOT {@link JiraTemplateId}.
   *
   * The shipped four are not the closed set: a bot's `jiraTemplate.<id>.md` adds
   * ids the union cannot know, so typing this as the union bought a cast at the
   * db boundary and a type that lies about the rows it describes.
   */
  template: string;
  depth: JiraDepth;
  notes: string;
  extra: string;
  markdown: string | null;
  /** The WIDE stored hit set — every row PR 2's toggle column renders. */
  citations: JiraCitation[];
  /**
   * The doc ids the reader toggled OFF, as the last generation used them.
   *
   * Stored so the view is self-consistent: without it a poll answered with 24
   * citations beside markdown that cites 23, and `PUT` re-verified against the
   * wide set — flipping an excluded key back to `verified` on save.
   */
  excludeDocIds: string[];
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  /**
   * What RETRIEVAL found — the stored column, written once and never overwritten.
   * `null` while a draft is still generating (or on a draft whose retrieval died).
   */
  retrievalCoverage: JiraCoverage | null;
  /**
   * The verdict for the draft as it currently stands: {@link effectiveCoverage}
   * of the retrieval verdict and the citations left after `excludeDocIds`. This
   * is the one the page renders; the row does not store it (see the function).
   */
  coverage: JiraCoverage | null;
  retrievalQuestion: string;
  error: string | null;
  /** `notes` (pasted raw material) | `thread` (a turn in a chat thread). */
  source: JiraDraftSource;
  /** The chat thread the draft turn runs in. Null on a notes-sourced draft. */
  threadId: string | null;
  /**
   * That thread's name, resolved at READ time rather than stored — a thread can
   * be renamed, and a copy on this row would then name a thread that no longer
   * exists under that title. Null when there is no thread, or when the thread row
   * is gone (there is deliberately no FK).
   */
  threadName: string | null;
  /**
   * That thread's OWNER (`threads.user_id`), joined at READ time like the name.
   *
   * The chat's `handleDeepLink` honours a `user=` param, and the deep link needs
   * it: without one the chat resolves whichever user that browser last used on
   * this bot, and `selectThread(<id>)` then looks for the thread in someone
   * else's list. Null when there is no thread, or when the thread row is gone.
   */
  threadUserId: string | null;
  /**
   * The assistant message whose text this draft's `markdown` was taken from.
   *
   * Re-pointed by every regenerate, since a regenerate is another turn in the
   * same thread. Null on a notes-sourced draft.
   */
  messageId: string | null;
  /**
   * When the reader pressed «Lagre» on the chat card — null when they never did.
   *
   * A timestamp rather than a boolean because it dates the decision, and a
   * column of its own rather than a reading of `updated_at` (which the runner
   * moves on every write) or of `status` (which is about the generation, not
   * about whether a human decided to keep the result). It is what makes the
   * card's «Lagret» survive a reload.
   */
  savedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * One row of the corpus-wide archive listing (`GET /api/jira/archive`, and the
 * `/jira` list the page renders from the same call).
 *
 * **Deliberately not a {@link JiraDraftView}.** The view carries the wide
 * citation set (24 rows, each with a snippet up to 900 chars) and the whole
 * markdown; a 200-row listing of those is megabytes of payload to render forty
 * characters of each. The listing carries what a ROW shows plus the id that
 * opens the full read, and nothing else.
 */
export interface JiraDraftListRow {
  draftId: string;
  bot: string;
  source: JiraDraftSource;
  template: string;
  depth: JiraDepth;
  status: JiraDraftStatus;
  /**
   * {@link jiraDraftTitle} over the head of the markdown. Null only when the row
   * holds no text: one still `generating`, or one that failed before ever
   * writing any. A FAILED row can perfectly well carry a title — `failJiraDraft`
   * leaves `markdown` alone, so a failed regenerate keeps the previous turn's
   * text (the statement on `failJiraDraft` in `db/jira-drafts.ts` is the
   * authority). The archive's DRAFT view refuses to render that text; the row
   * still names it.
   */
  title: string | null;
  /** The stored retrieval verdict, unchanged — see {@link JiraDraftView}. */
  retrievalCoverage: JiraCoverage | null;
  /** {@link effectiveCoverage} of that verdict and the citations this draft
   *  retained. The PAIR is what the row's notice reads; neither half alone. */
  coverage: JiraCoverage | null;
  /** Null on a notes-sourced draft. */
  threadId: string | null;
  threadName: string | null;
  /** Null when «Lagre» was never pressed — the default listing hides those. */
  savedAt: number | null;
  createdAt: number;
}

// ── Request-body validation ──────────────────────────────────────────────────

/** The validated draft-request body. */
export interface ParsedJiraDraftBody {
  notes: string;
  template: string;
  depth: JiraDepth;
  extra: string;
  /** Regenerate: reuse this draft's stored hit set. Empty ⇒ a fresh retrieval. */
  draftId: string;
  /** Doc ids the reader toggled OFF. Only meaningful with `draftId`. */
  excludeDocIds: string[];
}

export type JiraBodyResult =
  | { ok: true; body: ParsedJiraDraftBody }
  | { ok: false; error: string };

/**
 * The wire fields, named the way the `/jira` page names them.
 *
 * **These messages are reader-facing.** The route returns the validator's string
 * verbatim in its 400 body and the page renders it verbatim in its status line,
 * so an English `extra is longer than 2000 characters` landed under a Norwegian
 * form whose own field is labelled «Ekstra instruks». The whole surface is
 * Norwegian; so is this.
 */
const FIELD_LABELS: Record<string, string> = {
  notes: "Råmaterialet",
  template: "Malen",
  depth: "Teknisk dybde",
  extra: "Ekstra instruks",
  draftId: "Utkast-id-en",
};

/**
 * Validate one draft POST body.
 *
 * Lives in the dependency-free wire module for the `parseShareRequestBody`
 * reason: BOTH entry points run it — the SSE `POST /api/jira/draft` and the
 * plain-JSON `POST /api/jira/draft/start` the extension calls — and two copies of
 * a validation contract is two copies to drift. The error copy IS the contract
 * (the route tests pin these strings), so a caller hitting one endpoint must not
 * be told something different from a caller hitting the other.
 *
 * Returns an error rather than a `Response` so it stays dependency-free and each
 * route keeps ownership of its status code. The ORDERING rule both routes hold:
 * this runs BEFORE anything resolution-dependent, and long before `streamSSE`
 * commits a 200 — after that a validation failure can only be an `app_error` no
 * client can tell from a model failure.
 *
 * The TEMPLATE id is deliberately not validated here: the valid set is a function
 * of the resolved bot's `jiraTemplate.<id>.md` overrides, which this module
 * cannot see. It is checked in the route, still pre-commit.
 */
export function parseJiraDraftBody(body: Record<string, unknown>): JiraBodyResult {
  for (const field of ["notes", "template", "depth", "extra", "draftId"]) {
    const v = body[field];
    if (v !== undefined && typeof v !== "string") {
      return { ok: false, error: `${FIELD_LABELS[field] ?? field} må være en tekststreng.` };
    }
  }

  const draftId = typeof body.draftId === "string" ? body.draftId.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes : "";
  // A regenerate reuses the stored notes, so an absent `notes` is legal there and
  // only there. Requiring them on both paths would force the extension/page to
  // echo a 10 KB Slack thread back on every toggle click.
  if (!draftId && !notes.trim()) return { ok: false, error: "Råmaterialet mangler." };
  // ...and NEW notes on a regenerate are refused rather than silently honoured.
  // The stored hit set was retrieved for the OLD raw material and is deliberately
  // not re-retrieved (design call 1), so drafting different notes against it
  // answers a question nobody asked and leaves `retrieval_question` describing a
  // search that no longer matches the row. Changing the notes means a new draft.
  if (draftId && notes.trim()) {
    return {
      ok: false,
      error:
        "Råmaterialet kan ikke endres når du genererer på nytt — treffene ble hentet for den " +
        "opprinnelige teksten. Start et nytt utkast i stedet.",
    };
  }
  if (notes.length > JIRA_NOTES_MAX) {
    return { ok: false, error: `Råmaterialet er ${notes.length} tegn — grensen er ${JIRA_NOTES_MAX}.` };
  }

  const template = typeof body.template === "string" ? body.template.trim() : "";
  if (!template) return { ok: false, error: "Ingen mal er valgt." };

  if (!isJiraDepth(body.depth)) {
    return {
      ok: false,
      error: `Teknisk dybde må være en av: ${JIRA_DEPTHS.map((d) => d.id).join(", ")}.`,
    };
  }

  const extra = typeof body.extra === "string" ? body.extra : "";
  if (extra.length > JIRA_EXTRA_MAX) {
    return { ok: false, error: `Ekstra instruks er ${extra.length} tegn — grensen er ${JIRA_EXTRA_MAX}.` };
  }

  const rawExclude = body.excludeDocIds;
  if (rawExclude !== undefined) {
    if (!Array.isArray(rawExclude) || rawExclude.some((v) => typeof v !== "string")) {
      return { ok: false, error: "Avslåtte kilder må være en liste med dokument-id-er." };
    }
  }
  const excludeDocIds = Array.isArray(rawExclude) ? (rawExclude as string[]).map((s) => s.trim()).filter(Boolean) : [];
  // An exclusion set with no draft to apply it to is a client bug, not a
  // no-op: the reader toggled rows off against a hit set the server is about to
  // discard, and the draft would silently come back citing every one of them.
  if (!draftId && excludeDocIds.length > 0) {
    return {
      ok: false,
      error: "Kilder kan ikke slås av uten et utkast — det finnes ingen lagret trefliste å utelate fra.",
    };
  }

  return { ok: true, body: { notes, template, depth: body.depth, extra, draftId, excludeDocIds } };
}
