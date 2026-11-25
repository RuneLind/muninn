/**
 * A thread's `kind` (migration 094), on its own module so the chat pipeline's
 * D7 backstop can read it without importing `threads.ts`: several handler
 * tests `mock.module` that file, and a mock without this export would break
 * every module that imports it in the same process.
 */
import { getDb } from "./client.ts";

/** The thread's kind, or null when there is no such thread. */
export async function getThreadKind(threadId: string): Promise<"chat" | "wiki" | null> {
  const [row] = await getDb()`SELECT kind FROM threads WHERE id = ${threadId}`;
  if (!row) return null;
  return row.kind === "wiki" ? "wiki" : "chat";
}
