import { getDb } from "./client.ts";
import {
  JIRA_ARCHIVE_LIMIT_DEFAULT,
  clampJiraArchiveLimit,
  effectiveCoverage,
  isJiraDraftSource,
  JIRA_TITLE_SCAN_CHARS,
  jiraDraftTitle,
} from "../jira/wire.ts";
import type {
  JiraCitation,
  JiraCoverage,
  JiraDepth,
  JiraDraftListRow,
  JiraDraftSource,
  JiraDraftStatus,
  JiraDraftView,
  JiraKeyVerdict,
  JiraMarkdownFlag,
} from "../jira/wire.ts";

/**
 * CRUD for `jira_drafts` — the Jira composer's one persistent surface, and since
 * PR 4 deleted the notes path, the ONLY channel a run has: `POST
 * /api/jira/draft/from-thread` is fire-and-forget, so the row is what the chat
 * card and the `/jira` archive both read.
 *
 * The row is written in TWO steps by design, and the split is what makes the
 * fire-and-forget contract work:
 *
 *   · {@link createJiraDraft} inserts `status: 'generating'` BEFORE the turn, so
 *     the POST has an id to hand back immediately and `GET /api/jira/draft/:id`
 *     can honestly answer `generating` mid-flight.
 *   · {@link finishJiraDraft} writes the result. It runs on EVERY terminal path:
 *     the reader closing the tab stops nobody watching, not the work, so a draft
 *     nobody is looking at is still generated and still costs its 60–600 s.
 *     Landing it on the row is the only thing that stops that spend being thrown
 *     away — and the row outlives the tab, which is the whole point.
 *
 * `citations` is stored as seeded (capped at 24). Nothing here renumbers: a
 * thread draft cites what the conversation retrieved, and there is no exclusion
 * set on this path to renumber against.
 *
 * READ-side note: `source = 'notes'` rows are still in the table and the archive
 * still renders them, so every reader here stays four-value/both-source honest —
 * only the WRITE path narrowed.
 */

export interface CreateJiraDraftInput {
  botName: string;
  template: string;
  depth: JiraDepth;
  notes: string;
  extra: string;
  /**
   * Stated by the caller, never defaulted.
   *
   * The one writer left passes `'thread'`. A default of `'notes'` would silently
   * mint rows on the deleted path's label — a row the archive would then render
   * with a raw-material block over the `fra samtale: …` placeholder, and no
   * provenance banner.
   */
  source: JiraDraftSource;
  /** Set with `source: 'thread'`: the chat thread the draft turn runs in. */
  threadId?: string;
}

/** Insert a `generating` row and return its id. */
export async function createJiraDraft(input: CreateJiraDraftInput): Promise<string> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO jira_drafts (bot_name, template, depth, notes, extra, status, source, thread_id)
    VALUES (${input.botName}, ${input.template}, ${input.depth}, ${input.notes}, ${input.extra}, 'generating',
            ${input.source}, ${input.threadId ?? null})
    RETURNING id`;
  return String(rows[0]!.id);
}

/**
 * Store the hit set the thread retrieved.
 *
 * **It runs AFTER the turn, deliberately** — the one caller
 * (`runJiraThreadDraft`) seeds from `research_citations` once the draft turn has
 * finished, because the turn may itself have searched and because its own reply
 * is the strongest `cited` evidence there is: it is the text about to be pasted
 * into Jira. Naming it a pre-generation write would describe the deleted notes
 * path, where the hit set WAS the prompt.
 *
 * Separate from {@link finishJiraDraft} because the two have different failure
 * modes: the seeding can succeed and the finalize still fail (a huginn timeout in
 * key verification, a throw), and the row should still say what the conversation
 * had found.
 *
 * **This is the ONLY writer of `retrieval_coverage`, by design.** The column
 * holds what RETRIEVAL found; the verdict a reader sees is derived from it and
 * the citations the draft retained (`effectiveCoverage`). A second writer storing
 * the DERIVED value is precisely what latched a draft to `no_hits` — every later
 * read took it back as the retrieval verdict — and the rows that happened to are
 * still in the archive.
 */
export async function saveJiraDraftRetrieval(
  id: string,
  citations: JiraCitation[],
  retrievalCoverage: JiraCoverage,
  retrievalQuestion: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE jira_drafts
       SET citations = ${sql.json(citations as never)},
           retrieval_coverage = ${retrievalCoverage},
           retrieval_question = ${retrievalQuestion},
           updated_at = now()
     WHERE id = ${id}`;
}

/**
 * Point a draft row at the assistant message its turn just produced — before the
 * seeding, the finalize and both post-passes.
 *
 * The chat card is bound to a bubble by `message_id`, and everything between the
 * turn and {@link finishJiraDraft} can fail: an empty reply, a huginn timeout in
 * key verification, a throw. Stamped only at finish time, all of those left a row
 * the card could never reach — a failure the reader could see nowhere. Stamped
 * here, the only unmapped rows left are "the turn itself failed" (there is no
 * message) and a throw before the turn ran.
 *
 * **Every run stamps its OWN row and no other.** Re-running a draft is another
 * 🧾 click, i.e. another turn on a NEW row, so the early stamp can never
 * re-point a row that already holds a finished task — the failure mode this
 * ordering had to reason about while a regenerate could overwrite one in place.
 */
export async function setJiraDraftMessageId(id: string, messageId: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE jira_drafts
       SET message_id = ${messageId}::uuid,
           updated_at = now()
     WHERE id = ${id}`;
}

export interface FinishJiraDraftInput {
  markdown: string;
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  /**
   * The assistant message this draft's markdown came from.
   *
   * Written in the SAME statement as the markdown, so the two can never disagree
   * about which turn produced the text — a «Juster i samtalen» link to the wrong
   * message. {@link setJiraDraftMessageId} has already stamped it right after the
   * turn (the card has to be reachable on a run that fails after it); writing it
   * again here is idempotent.
   *
   * Optional because the runner may not know it: {@link JiraThreadTurnRunner}
   * returns `messageId?` (a turn the chat pipeline completed without reporting
   * which row it wrote), and `runJiraThreadDraft` spreads the field in only when
   * it is present. Absent LEAVES the column alone rather than nulling it — the
   * `COALESCE` below is what makes the double write safe.
   */
  messageId?: string;
}

/** Mark a draft `ready` with its generated task and both post-pass results. */
export async function finishJiraDraft(id: string, input: FinishJiraDraftInput): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE jira_drafts
       SET status = 'ready',
           markdown = ${input.markdown},
           key_verdicts = ${sql.json(input.keyVerdicts as never)},
           markdown_flags = ${sql.json(input.markdownFlags as never)},
           -- The ::uuid cast is not decoration: a bare NULL parameter leaves
           -- postgres unable to infer the type of the COALESCE and it errors.
           message_id = COALESCE(${input.messageId ?? null}::uuid, message_id),
           error = NULL,
           updated_at = now()
     WHERE id = ${id}`;
}

/**
 * Mark a draft `failed` with a reader-facing reason.
 *
 * **`markdown` is deliberately left alone**, and it is the archive's job to
 * remember that: a `source = 'notes'` row could fail a REGENERATE while still
 * holding the previous run's task, which is why `/jira` refuses to render the
 * text of a `failed` draft and names it «Mislykket utkast» instead. Only the
 * deleted notes path could produce that shape — every 🧾 click mints its own row
 * — and none is in the table today (measured 2026-08-24: both `failed` rows carry
 * no markdown). The refusal stands anyway: it is the row shape the page has to be
 * safe against, not a population it has to find.
 */
export async function failJiraDraft(id: string, error: string): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE jira_drafts
       SET status = 'failed', error = ${error}, updated_at = now()
     WHERE id = ${id}`;
}

interface JiraDraftRow {
  id: string;
  bot_name: string;
  template: string;
  depth: string;
  notes: string;
  extra: string;
  status: string;
  markdown: string | null;
  citations: unknown;
  exclude_doc_ids: unknown;
  key_verdicts: unknown;
  markdown_flags: unknown;
  retrieval_coverage: string | null;
  retrieval_question: string;
  error: string | null;
  source: string | null;
  thread_id: string | null;
  message_id: string | null;
  saved_at: Date | string | null;
  /** Joined from `threads`, never stored — see `JiraDraftView.threadName`. */
  thread_name?: string | null;
  /** Joined from `threads` too — see `JiraDraftView.threadUserId`. */
  thread_user_id?: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Map a row to the wire view.
 *
 * Every JSONB column is shape-guarded with `Array.isArray` rather than trusted:
 * these are read back into a payload the browser renders, and a hand-edited or
 * partially-migrated row must degrade to an empty list, not to a `.map` on
 * `null`.
 */
function toView(row: JiraDraftRow): JiraDraftView {
  const citations = Array.isArray(row.citations) ? (row.citations as JiraCitation[]) : [];
  const excludeDocIds = Array.isArray(row.exclude_doc_ids)
    ? (row.exclude_doc_ids as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const retrieval = (row.retrieval_coverage as JiraCoverage | null) ?? null;
  const excluded = new Set(excludeDocIds);
  const retained = citations.filter((c) => !excluded.has(c.docId)).length;
  return {
    draftId: String(row.id),
    bot: row.bot_name,
    status: row.status as JiraDraftStatus,
    template: row.template,
    depth: row.depth as JiraDepth,
    notes: row.notes,
    extra: row.extra,
    markdown: row.markdown,
    citations,
    excludeDocIds,
    keyVerdicts: Array.isArray(row.key_verdicts) ? (row.key_verdicts as JiraKeyVerdict[]) : [],
    markdownFlags: Array.isArray(row.markdown_flags) ? (row.markdown_flags as JiraMarkdownFlag[]) : [],
    retrievalCoverage: retrieval,
    // Derived, never stored: the row says what retrieval found, the exclusion set
    // says what THIS draft kept. A draft whose retrieval has not landed yet (no
    // verdict AND no citations) reports `null` rather than `no_hits` — claiming
    // retrieval came back empty before it has come back at all is a different lie.
    coverage: retrieval === null && citations.length === 0
      ? null
      : effectiveCoverage(retrieval, retained),
    retrievalQuestion: row.retrieval_question ?? "",
    error: row.error,
    // A hand-edited or partially-migrated row degrades to `notes`, which is the
    // column default AND the only truthful answer for a row with no thread.
    source: isJiraDraftSource(row.source) ? row.source : "notes",
    threadId: row.thread_id ?? null,
    threadName: row.thread_name ?? null,
    threadUserId: row.thread_user_id ?? null,
    messageId: row.message_id ?? null,
    // Nullable, so it cannot go through `new Date(...)` unconditionally: `new
    // Date(null)` is the epoch, which would report every unsaved draft as saved
    // on 1970-01-01 — a truthy timestamp the card would render as «Lagret».
    savedAt: row.saved_at == null ? null : new Date(row.saved_at).getTime(),
    // `new Date(...)` like every other db module: the driver hands back a string
    // for these columns in some configurations, and `.getTime()` on one throws.
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
  };
}

/**
 * Read one draft. `null` when the id names nothing.
 *
 * The thread name is LEFT-joined rather than stored: threads get renamed, and a
 * copy on this row would then label the «Juster i samtalen» link with a title
 * that no longer exists. A LEFT join is also what keeps a draft readable after
 * its thread is deleted (there is deliberately no FK) — `thread_name` comes back
 * null and the view reports the draft without a name, rather than not at all.
 *
 * The thread's OWNER rides the same join, for the same reason it is not stored:
 * one row, one source of truth. It is what puts `user=` on the deep link — see
 * `JiraDraftView.threadUserId`.
 */
export async function getJiraDraft(id: string): Promise<JiraDraftView | null> {
  const sql = getDb();
  const rows = await sql<JiraDraftRow[]>`
    SELECT d.*, t.name AS thread_name, t.user_id AS thread_user_id
    FROM jira_drafts d
    LEFT JOIN threads t ON t.id = d.thread_id
    WHERE d.id = ${id}`;
  return rows[0] ? toView(rows[0]) : null;
}

/**
 * Mark a draft as KEPT — the chat card's «Lagre».
 *
 * Idempotent by construction: the timestamp is overwritten, so a second press
 * simply re-dates the decision rather than erroring or toggling it off. There is
 * no un-save, deliberately — the card offers no affordance for one, and a draft
 * the reader kept once is not made less kept by a stray click.
 *
 * Returns the full view so the card can adopt exactly what the row now holds
 * (the `PUT` precedent), rather than optimistically drawing a state the server
 * might not have reached — or **null when nothing was kept**, which is both
 * "no such draft" and "not finished".
 */
export async function saveJiraDraft(id: string): Promise<JiraDraftView | null> {
  const sql = getDb();
  const rows = await sql`
    UPDATE jira_drafts
       SET saved_at = now(), updated_at = now()
     WHERE id = ${id}
       AND status = 'ready'
    RETURNING id`;
  // No row updated: either the id is unknown or the draft is not FINISHED. The
  // status gate rides in the UPDATE rather than a read-then-write, so a run that
  // finishes mid-request cannot slip between the check and the stamp — and the
  // route tells the two cases apart by re-reading (404 vs 409).
  if (rows.length === 0) return null;
  // Re-read rather than `RETURNING *`: the view needs the `threads` join, and one
  // extra primary-key lookup is cheaper than a second, drifting row→view mapping.
  return getJiraDraft(id);
}

/** One row of `GET /api/jira/drafts?thread=<id>` — the card's binding listing. */
export interface JiraDraftThreadRow {
  draftId: string;
  /** The assistant message the card hangs under. Null until the turn produced one. */
  messageId: string | null;
  status: JiraDraftStatus;
}

/**
 * Every draft on one thread, oldest first.
 *
 * **Deliberately three fields and no content.** The chat asks for this on every
 * thread load, every thread switch and every `response_meta`, and it is served
 * with no CORS headers precisely because it hands over every draft id on a
 * thread — a listing is a much better lever for a guessing attacker than the
 * single CORS-open `GET /api/jira/draft/:id` it feeds. Keeping the payload to
 * the binding means the wide read stays the per-card one, which the client makes
 * ONCE per draft on adopt.
 *
 * Rows with no `message_id` ride along rather than being filtered out: an
 * unmapped row is exactly what the card cannot render, and the client needs to
 * know it exists to say so (and to keep polling a `generating` one that has not
 * reached its turn yet).
 */
/**
 * How much of each row's markdown the archive listing reads.
 *
 * The bound itself lives in `src/jira/wire.ts` beside {@link jiraDraftTitle},
 * which applies it to whatever it is handed: the draft PAGE holds the whole
 * markdown, and two different bounds meant a draft opening with a long fenced
 * block was "(uten tittel)" in the list and titled on its own page. Slack is
 * needed either way — a `failed` regenerate keeps the PREVIOUS text and a draft
 * can open with a fence — and 400 chars × 200 rows is 80 KB read to produce 200
 * labels, where the whole markdown would be tens of megabytes.
 */
const TITLE_SCAN_CHARS = JIRA_TITLE_SCAN_CHARS;

export interface JiraDraftListing {
  drafts: JiraDraftListRow[];
  /**
   * The table held at least one row past the limit.
   *
   * A FACT from the read (one extra row is fetched and dropped), never
   * `drafts.length >= limit` — an exact-fit page is not a truncated one, and
   * this is the one page whose reader can count the rows and see the claim
   * is wrong.
   */
  capped: boolean;
}

export interface ListJiraDraftsOptions {
  /** Default true is deliberately NOT the default here — the caller says. */
  savedOnly?: boolean;
  /** Clamped through `clampJiraArchiveLimit`; absent ⇒ the shared default. */
  limit?: number;
}

/**
 * The corpus-wide archive listing — every draft, newest first.
 *
 * Distinct from {@link listJiraDraftsForThread}, which is the chat card's
 * binding: that one is keyed on one thread, ordered OLDEST first, and carries
 * three fields. This one is `/jira`'s list — every bot, both sources, ordered by
 * `created_at DESC` on `idx_jira_drafts_created_at` (070), which the thread
 * index cannot serve.
 *
 * **`savedOnly` is the whole reason `saved_at` exists.** Every 🧾 click mints a
 * row and nothing prunes them, so the unfiltered list is mostly attempts nobody
 * kept; the page defaults to the kept ones and the all-attempts toggle asks for
 * the rest.
 *
 * Three things are computed in SQL rather than in TypeScript, all for the same
 * reason — the alternative is shipping the wide payload to throw it away:
 * the title scan reads only the HEAD of the markdown, and the citation/retained
 * counts are aggregated server-side so `coverage` can be derived (the same
 * `effectiveCoverage` pair `toView` derives, with the same "retrieval never
 * landed ⇒ null" rule) without the 24-row hit set crossing the wire. The two
 * JSONB reads are `jsonb_typeof`-guarded because `jsonb_array_elements` ERRORS
 * on a non-array, which would take the whole listing down over one hand-edited
 * row — the `Array.isArray` discipline in {@link toView}, in SQL.
 */
export async function listJiraDrafts(
  options: ListJiraDraftsOptions = {},
): Promise<JiraDraftListing> {
  const sql = getDb();
  const limit = clampJiraArchiveLimit(options.limit ?? JIRA_ARCHIVE_LIMIT_DEFAULT);
  const savedOnly = options.savedOnly === true;
  const rows = await sql<
    {
      id: string;
      bot_name: string;
      source: string | null;
      template: string;
      depth: string;
      status: string;
      retrieval_coverage: string | null;
      thread_id: string | null;
      thread_name: string | null;
      saved_at: Date | string | null;
      created_at: Date;
      markdown_head: string | null;
      citation_count: string | number;
      retained_count: string | number;
    }[]
  >`
    SELECT d.id, d.bot_name, d.source, d.template, d.depth, d.status,
           d.retrieval_coverage, d.thread_id, t.name AS thread_name,
           d.saved_at, d.created_at,
           substring(d.markdown from 1 for ${TITLE_SCAN_CHARS}) AS markdown_head,
           CASE WHEN jsonb_typeof(d.citations) = 'array'
                THEN jsonb_array_length(d.citations) ELSE 0 END AS citation_count,
           (SELECT count(*)
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(d.citations) = 'array'
                          THEN d.citations ELSE '[]'::jsonb END) AS c
             WHERE NOT jsonb_exists(
                     CASE WHEN jsonb_typeof(d.exclude_doc_ids) = 'array'
                          THEN d.exclude_doc_ids ELSE '[]'::jsonb END,
                     COALESCE(c->>'docId', ''))) AS retained_count
      FROM jira_drafts d
      LEFT JOIN threads t ON t.id = d.thread_id
     WHERE ${savedOnly ? sql`d.saved_at IS NOT NULL` : sql`TRUE`}
     ORDER BY d.created_at DESC
     LIMIT ${limit + 1}`;

  // One row past the limit is the truncation probe; it is never rendered.
  const capped = rows.length > limit;
  const drafts = rows.slice(0, limit).map((r) => {
    const retrieval = (r.retrieval_coverage as JiraCoverage | null) ?? null;
    const citationCount = Number(r.citation_count) || 0;
    const retained = Number(r.retained_count) || 0;
    return {
      draftId: String(r.id),
      bot: r.bot_name,
      source: isJiraDraftSource(r.source) ? r.source : "notes",
      template: r.template,
      depth: r.depth as JiraDepth,
      status: r.status as JiraDraftStatus,
      // A `failed` row is still named after the text it kept — deliberately NOT
      // `deriveDraftHeading`, whose «Mislykket utkast» exists because the DRAFT
      // PAGE refuses to show that text (see its docstring's heading-end
      // exception). A list of identical failure labels is unreadable, and the
      // row's own status chip already says it failed.
      title: jiraDraftTitle(r.markdown_head),
      retrievalCoverage: retrieval,
      // The `toView` rule, verbatim: a draft whose retrieval has not landed yet
      // (no verdict AND no citations) reports `null`, never `no_hits` — claiming
      // the corpus came back empty before it was asked is a different lie.
      coverage:
        retrieval === null && citationCount === 0 ? null : effectiveCoverage(retrieval, retained),
      threadId: r.thread_id ?? null,
      threadName: r.thread_name ?? null,
      savedAt: r.saved_at == null ? null : new Date(r.saved_at).getTime(),
      createdAt: new Date(r.created_at).getTime(),
    } satisfies JiraDraftListRow;
  });
  return { drafts, capped };
}

export async function listJiraDraftsForThread(threadId: string): Promise<JiraDraftThreadRow[]> {
  const sql = getDb();
  const rows = await sql<{ id: string; message_id: string | null; status: string }[]>`
    SELECT id, message_id, status
    FROM jira_drafts
    WHERE thread_id = ${threadId}
    ORDER BY created_at ASC`;
  return rows.map((r) => ({
    draftId: String(r.id),
    messageId: r.message_id ?? null,
    status: r.status as JiraDraftStatus,
  }));
}
