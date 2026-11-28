/**
 * What /chat reads of `wiki_discuss_turns` (Discuss v3 P4): for a wiki
 * thread's user messages, the turn each one asked. /chat draws an Explain turn
 * as a chip from these fields rather than parsing the stored text (the passage
 * clamped to 200 characters, a blank line and the question), and «Continue in
 * Claude Code» names the newest turn. Its own file so /chat's read stays out
 * of the ledger module the Discuss routes write through.
 */
import { getDb } from "./client.ts";

/** A user message's turn as /chat shows it: `passage` is the turn's
 *  selection (null for a turn asked with none, a card's follow-up). */
export interface ChatWikiTurn {
  id: string;
  seq: number;
  question: string;
  passage: string | null;
}

/** The turns of `threadId` keyed by their user message id, for the messages
 *  in `messageIds`. A message no turn stored maps to nothing. */
export async function listWikiTurnsByUserMessage(threadId: string, messageIds: string[]): Promise<Map<string, ChatWikiTurn>> {
  const out = new Map<string, ChatWikiTurn>();
  if (messageIds.length === 0) return out;
  const rows = await getDb()`
    SELECT id, seq, question, selection, user_message_id
    FROM wiki_discuss_turns
    WHERE thread_id = ${threadId} AND user_message_id = ANY(${messageIds}::uuid[])`;
  for (const r of rows) {
    out.set(r.user_message_id as string, { id: r.id as string, seq: Number(r.seq), question: r.question as string, passage: (r.selection as string | null) ?? null });
  }
  return out;
}
