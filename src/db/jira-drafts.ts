import { getDb } from "./client.ts";
import type {
  JiraCitation,
  JiraCoverage,
  JiraDepth,
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
}

/** Insert a `generating` row and return its id. */
export async function createJiraDraft(input: CreateJiraDraftInput): Promise<string> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO jira_drafts (bot_name, template, depth, notes, extra, status)
    VALUES (${input.botName}, ${input.template}, ${input.depth}, ${input.notes}, ${input.extra}, 'generating')
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
 */
export async function saveJiraDraftRetrieval(
  id: string,
  citations: JiraCitation[],
  coverage: JiraCoverage,
  retrievalQuestion: string,
): Promise<void> {
  const sql = getDb();
  await sql`
    UPDATE jira_drafts
       SET citations = ${sql.json(citations as never)},
           coverage = ${coverage},
           retrieval_question = ${retrievalQuestion},
           updated_at = now()
     WHERE id = ${id}`;
}

export interface FinishJiraDraftInput {
  markdown: string;
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
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
           error = NULL,
           updated_at = now()
     WHERE id = ${id}`;
}

/** Mark a draft `failed` with a reader-facing reason. */
export async function failJiraDraft(id: string, error: string): Promise<void> {
  const sql = getDb();
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
  key_verdicts: unknown;
  markdown_flags: unknown;
  coverage: string | null;
  retrieval_question: string;
  error: string | null;
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
  return {
    draftId: String(row.id),
    status: row.status as JiraDraftStatus,
    template: row.template as JiraDraftView["template"],
    depth: row.depth as JiraDepth,
    notes: row.notes,
    extra: row.extra,
    markdown: row.markdown,
    citations: Array.isArray(row.citations) ? (row.citations as JiraCitation[]) : [],
    keyVerdicts: Array.isArray(row.key_verdicts) ? (row.key_verdicts as JiraKeyVerdict[]) : [],
    markdownFlags: Array.isArray(row.markdown_flags) ? (row.markdown_flags as JiraMarkdownFlag[]) : [],
    coverage: (row.coverage as JiraCoverage | null) ?? null,
    retrievalQuestion: row.retrieval_question ?? "",
    error: row.error,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
  };
}

/** Read one draft. `null` when the id names nothing. */
export async function getJiraDraft(id: string): Promise<JiraDraftView | null> {
  const sql = getDb();
  const rows = await sql<JiraDraftRow[]>`SELECT * FROM jira_drafts WHERE id = ${id}`;
  return rows[0] ? toView(rows[0]) : null;
}
