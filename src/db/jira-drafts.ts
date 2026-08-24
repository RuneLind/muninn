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
 * CRUD for `jira_drafts` — the composer's one persistent surface.
 *
 * The row is written in TWO steps by design, and the split is what makes three
 * separate behaviours possible at once:
 *
 *   · {@link createJiraDraft} inserts `status: 'generating'` BEFORE retrieval, so
 *     `GET /api/jira/draft/:id` can honestly answer `generating` mid-flight and
 *     the extension's `POST /draft/start` has an id to hand back immediately.
 *   · {@link finishJiraDraft} writes the result. It runs on EVERY terminal path,
 *     including a client abort — the scaffold family's `clientState.gone` stops
 *     the WRITES, not the work, so an aborted draft is still generated and still
 *     costs its 120–600 s. Landing it on the row is the only thing that stops
 *     that spend being thrown away.
 *
 * `citations` is stored as built (`maxSources` 24) and is the input to a
 * regenerate; nothing here renumbers, because renumbering is a function of the
 * exclusion set the caller holds.
 */

export interface CreateJiraDraftInput {
  botName: string;
  template: string;
  depth: JiraDepth;
  notes: string;
  extra: string;
  /** Defaults to `notes` — the pasted-raw-material path, and every legacy row. */
  source?: JiraDraftSource;
  /** Set with `source: 'thread'`: the chat thread the draft turn runs in. */
  threadId?: string;
}

/** Insert a `generating` row and return its id. */
export async function createJiraDraft(input: CreateJiraDraftInput): Promise<string> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO jira_drafts (bot_name, template, depth, notes, extra, status, source, thread_id)
    VALUES (${input.botName}, ${input.template}, ${input.depth}, ${input.notes}, ${input.extra}, 'generating',
            ${input.source ?? "notes"}, ${input.threadId ?? null})
    RETURNING id`;
  return String(rows[0]!.id);
}

/**
 * Store the retrieved hit set as soon as it exists — BEFORE the model call.
 *
 * Separate from {@link finishJiraDraft} because the two have different failure
 * modes: retrieval can succeed and generation still time out, and the hit set is
 * the expensive half to re-acquire (a Haiku decomposition plus up to four
 * searches). Persisting it early means a failed draft can be regenerated without
 * re-retrieving, and PR 2's toggle column has rows to render on a `failed` row.
 *
 * **This is the ONLY writer of `retrieval_coverage`, by design.** The column holds
 * what RETRIEVAL found; the verdict for one generation is derived from it and that
 * run's exclusion set (`effectiveCoverage`). A second writer is precisely what
 * made a draft latch to `no_hits`: an exclude-everything regenerate stored the
 * derived value, and every later run read it back as the retrieval verdict.
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
 * Point a FIRST-DRAFT row at the assistant message its turn just produced —
 * before the seeding, the finalize and both post-passes.
 *
 * The chat card is bound to a bubble by `message_id`, and everything between the
 * turn and {@link finishJiraDraft} can fail: an empty reply, a huginn timeout in
 * key verification, a throw. Stamped only at finish time, all of those left a row
 * the card could never reach — a failure the reader could see nowhere. Stamped
 * here, the only unmapped rows left are "the turn itself failed" (there is no
 * message) and a throw before the turn ran.
 *
 * **Never on a REGENERATE.** There, `finishJiraDraft` writes `message_id`
 * together with `markdown` deliberately — the row already carries the PREVIOUS
 * turn's text, and an early stamp on a run that then failed would leave it
 * pointing at the new message while holding the old task. `failJiraDraft`
 * restores `exclude_doc_ids` and nothing else, so nothing would put it back.
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
   * The assistant message this draft's markdown came from — thread path only.
   *
   * Written in the SAME statement as the markdown on a REGENERATE, deliberately:
   * a regenerate is another thread turn, so a separate write could leave the row
   * pointing at the previous turn while carrying this one's text — a «Juster i
   * samtalen» link to the wrong message. A FIRST draft stamps it earlier through
   * {@link setJiraDraftMessageId} (the card has to be reachable on a run that
   * fails after the turn); writing it again here is idempotent. Absent on the
   * notes path, and an absent value LEAVES the column alone rather than nulling
   * it (a `PUT` edit does not un-anchor a draft from the turn that produced it).
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
 * Mark a draft `failed` with a reader-facing reason. `restoreExcludeDocIds`, when
 * given, puts back the exclusion set the surviving markdown was written under —
 * `startJiraDraftRun` lands the NEW set before any work, and a failed regenerate
 * would otherwise leave it beside the OLD text.
 */
export async function failJiraDraft(id: string, error: string, restoreExcludeDocIds?: string[]): Promise<void> {
  const sql = getDb();
  if (restoreExcludeDocIds) {
    await sql`
      UPDATE jira_drafts
         SET status = 'failed', error = ${error},
             exclude_doc_ids = ${sql.json(restoreExcludeDocIds as never)},
             updated_at = now()
       WHERE id = ${id}`;
    return;
  }
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
