import { getDb } from "./client.ts";
import { effectiveCoverage, isJiraDraftSource } from "../jira/wire.ts";
import type {
  JiraCitation,
  JiraCoverage,
  JiraDepth,
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
 * Put an EXISTING row back into flight — the first write a regenerate makes.
 *
 * Without it a regenerate wrote nothing until {@link finishJiraDraft}, so
 * `POST /draft` answered `generating` while the row still said `ready` with the
 * OLD markdown, and the page's poller stopped on its very first tick and rendered
 * the previous draft as the new one. It also lands the exclusion set, so a poll
 * mid-flight already describes the generation that is running.
 *
 * `markdown` is deliberately LEFT ALONE: the previous task is the best thing to
 * show until the new one exists, and a regenerate that fails should not have
 * destroyed it.
 */
export async function startJiraDraftRun(id: string, excludeDocIds: string[]): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE jira_drafts
       SET status = 'generating',
           error = NULL,
           exclude_doc_ids = ${sql.json(excludeDocIds as never)},
           updated_at = now()
     WHERE id = ${id}`;
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

export interface FinishJiraDraftInput {
  markdown: string;
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  /**
   * The assistant message this draft's markdown came from — thread path only.
   *
   * Written in the SAME statement as the markdown, deliberately: a regenerate is
   * another thread turn, so a separate write could leave the row pointing at the
   * previous turn while carrying this one's text — a «Juster i samtalen» link to
   * the wrong message. Absent on the notes path, and an absent value LEAVES the
   * column alone rather than nulling it (a `PUT` edit does not un-anchor a draft
   * from the turn that produced it).
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

/**
 * Replace the draft's markdown with the reader's edit (`PUT /api/jira/draft/:id`).
 *
 * The post-pass results are RE-RUN by the route and written here in the same
 * statement rather than left stale: an edit that removes the fabricated key must
 * clear its red row, and one that introduces `- [ ]` must grow a flag. Leaving
 * them behind would leave the page asserting things about text that no longer
 * exists. `status` is forced to `ready` — a reader editing a `failed` draft into
 * something usable has, by doing so, made it ready.
 */
export async function updateJiraDraftMarkdown(
  id: string,
  markdown: string,
  keyVerdicts: JiraKeyVerdict[],
  markdownFlags: JiraMarkdownFlag[],
): Promise<boolean> {
  const sql = getDb();
  const rows = await sql`
    UPDATE jira_drafts
       SET markdown = ${markdown},
           key_verdicts = ${sql.json(keyVerdicts as never)},
           markdown_flags = ${sql.json(markdownFlags as never)},
           status = 'ready',
           error = NULL,
           updated_at = now()
     WHERE id = ${id}
    RETURNING id`;
  return rows.length > 0;
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
  /** Joined from `threads`, never stored — see `JiraDraftView.threadName`. */
  thread_name?: string | null;
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
    messageId: row.message_id ?? null,
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
 */
export async function getJiraDraft(id: string): Promise<JiraDraftView | null> {
  const sql = getDb();
  const rows = await sql<JiraDraftRow[]>`
    SELECT d.*, t.name AS thread_name
    FROM jira_drafts d
    LEFT JOIN threads t ON t.id = d.thread_id
    WHERE d.id = ${id}`;
  return rows[0] ? toView(rows[0]) : null;
}
