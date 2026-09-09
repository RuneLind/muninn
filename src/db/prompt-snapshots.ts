import { getDb } from "./client.ts";
import { capTextWithNote } from "../summaries/truncation.ts";

/**
 * What produced a snapshot, and therefore how long it is kept.
 *
 * `chat` is a turn's assembled prompt (`src/core/prompt-assembly.ts`), swept
 * with the traces beside it. `capture` is a summarization pass
 * (`src/summaries/summarizer-shared.ts`), kept far longer: the summary it
 * produced is read months later, and its trace is gone after a week.
 */
export type PromptSnapshotKind = "chat" | "capture";

interface SavePromptSnapshotParams {
  traceId: string;
  systemPrompt: string;
  userPrompt: string;
  /**
   * The model span this prompt was sent on — `claude` for a summary pass,
   * `claude:select` for the YouTube selection pass, `''` for a chat turn (which
   * has exactly one). Part of the row's key, so a two-pass capture stores both.
   */
  pass?: string;
  kind?: PromptSnapshotKind;
  /** The captured document's address. Only a `capture` row has one. */
  sourceUrl?: string;
}

export interface PromptSnapshot {
  systemPrompt: string;
  userPrompt: string;
  createdAt: number; // epoch ms
  pass: string;
  kind: string;
}

/** A capture snapshot found by its source url — the trace id comes back too,
 *  because the caller offers a `/traces` deep link with it. */
export interface CaptureSnapshot extends PromptSnapshot {
  traceId: string;
}

/** The summary pass. The label every read-side fast path keys off, and the row
 *  the default read prefers. */
export const SUMMARY_PASS = "claude";

/**
 * How much of a CAPTURE's user prompt is stored.
 *
 * A capture prompt is a scaffold with a TRANSCRIPT pasted into it, and a
 * 3-hour talk's windowed transcript reaches 2 MiB — the cap the ingest body
 * already lives by. Storing that per pass, for 90 days, for every capture, is a
 * different bargain from storing a chat turn: what a reader opens this for is
 * the instruction and the shape of the input, and 256 KiB is ~40 minutes of
 * windowed speech, so the head is the readable part in any case. Over the cap
 * the stored text ends on the same truncation note the ingest body uses, so a
 * reader is never shown a cut prompt that reads as the whole one.
 *
 * CHAT prompts are not capped: they carry conversation history and memories,
 * not transcripts, and shortening one would silently change what the modal
 * says was sent.
 */
export const CAPTURE_PROMPT_MAX_BYTES = 256 * 1024;

export async function savePromptSnapshot(params: SavePromptSnapshotParams): Promise<void> {
  const sql = getDb();
  const userPrompt = params.kind === "capture"
    ? capTextWithNote(params.userPrompt, CAPTURE_PROMPT_MAX_BYTES)
    : params.userPrompt;
  // `||`, not `??`: `src/article/summarizer.ts` passes `url: ""` for a pasted
  // article with no source link. Stored verbatim, every one of those rows shares
  // the key `''`, and `getLatestCaptureSnapshotByUrl("")` would then answer one
  // arbitrary article's prompt for all of them.
  const sourceUrl = params.sourceUrl || null;
  await sql`
    INSERT INTO prompt_snapshots (trace_id, system_prompt, user_prompt, pass, kind, source_url)
    VALUES (
      ${params.traceId},
      ${params.systemPrompt},
      ${userPrompt},
      ${params.pass ?? ""},
      ${params.kind ?? "chat"},
      ${sourceUrl}
    )
    ON CONFLICT (trace_id, pass) DO NOTHING
  `;
}

/**
 * One trace's prompt.
 *
 * With no `pass`, the SUMMARY pass wins: a two-pass capture stores its
 * selection prompt under `claude:select` and its summary prompt under `claude`,
 * and a reader who opened the modal off the trace row means the summary one. A
 * chat trace has only the `''` row, which is second in the same ordering, so
 * the chat path is unchanged.
 */
export async function getPromptSnapshot(traceId: string, pass?: string): Promise<PromptSnapshot | null> {
  const sql = getDb();
  const rows = pass === undefined
    ? await sql`
      SELECT system_prompt, user_prompt, created_at, pass, kind
      FROM prompt_snapshots
      WHERE trace_id = ${traceId}
      ORDER BY CASE WHEN pass = ${SUMMARY_PASS} THEN 0 WHEN pass = '' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 1
    `
    : await sql`
      SELECT system_prompt, user_prompt, created_at, pass, kind
      FROM prompt_snapshots
      WHERE trace_id = ${traceId} AND pass = ${pass}
      LIMIT 1
    `;
  if (rows.length === 0) return null;
  return toSnapshot(rows[0]!);
}

/**
 * The newest SUMMARY-pass capture snapshot for a document's url — the only
 * lookup that does not start from a trace id (the trace is swept after 7 days;
 * this row lives 90).
 *
 * It backs `GET /api/summaries/prompt?url=`, which is the SEAM a /summaries doc
 * panel control will call. There is no such control yet — that half is PR 3's.
 *
 * The match is EXACT on the stored string; nothing is normalized on either
 * side. See the route's docblock for which string each vertical stores.
 */
export async function getLatestCaptureSnapshotByUrl(url: string): Promise<CaptureSnapshot | null> {
  const sql = getDb();
  const rows = await sql`
    SELECT trace_id, system_prompt, user_prompt, created_at, pass, kind
    FROM prompt_snapshots
    WHERE kind = 'capture' AND source_url = ${url} AND pass = ${SUMMARY_PASS}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  return { ...toSnapshot(rows[0]!), traceId: rows[0]!.trace_id as string };
}

function toSnapshot(r: Record<string, unknown>): PromptSnapshot {
  return {
    systemPrompt: r.system_prompt as string,
    userPrompt: r.user_prompt as string,
    createdAt: new Date(r.created_at as string).getTime(),
    pass: r.pass as string,
    kind: r.kind as string,
  };
}

/**
 * Retention, per kind, in ONE statement.
 *
 * Two windows rather than one because the two kinds answer different questions:
 * a chat prompt is a debugging artefact of a turn that just happened, while a
 * capture prompt is what a stored summary was written from and is asked for
 * long after the capture. A single number would delete the second with the
 * first.
 *
 * ⚠️ **Both windows must be at least 1 day, and anything smaller THROWS.** These
 * numbers go into `NOW() - make_interval(days => n)`, so `0` resolves to `NOW()`
 * — the next scheduler tick would empty the table — and a negative one reaches
 * into the future and does the same. `src/config.ts` clamps the two env vars
 * (`positiveEnvInt`), but this function is exported and takes two plain numbers,
 * so a caller that COMPUTES a window would bypass that clamp silently. Refusing
 * here is loud and deletes nothing.
 */
export async function cleanupOldSnapshots(retention: {
  chatDays: number;
  captureDays: number;
}): Promise<number> {
  for (const [name, days] of [
    ["chatDays", retention.chatDays],
    ["captureDays", retention.captureDays],
  ] as const) {
    if (!Number.isFinite(days) || days < 1) {
      throw new Error(
        `cleanupOldSnapshots: ${name} must be at least 1 day, got ${days} — that window deletes every snapshot`,
      );
    }
  }
  const sql = getDb();
  const result = await sql`
    DELETE FROM prompt_snapshots
    WHERE (kind = 'capture' AND created_at < NOW() - make_interval(days => ${retention.captureDays}))
       OR (kind <> 'capture' AND created_at < NOW() - make_interval(days => ${retention.chatDays}))
  `;
  return result.count;
}
