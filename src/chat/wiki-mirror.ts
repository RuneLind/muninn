/**
 * A wiki thread's turns in /chat (Discuss v2, PR 3). The Discuss engine
 * (`src/wiki/discuss-engine.ts`) sits below `src/chat/`, so each entry point
 * builds the mirror here and passes it in: the user message, the deltas, the
 * tool lines and the stored answer go to chat state with the thread's id, so a
 * popped-out /chat watches a pane turn live. The conversation-wide `status`
 * event carries no `threadId` and is never published: /chat shows no typing
 * indicator for a wiki turn, only the streamed text and tool lines.
 *
 * Also /chat's own entry point: `POST /chat/conversations/:id/messages` on a
 * `kind = 'wiki'` thread runs {@link runWikiThreadTurnFromChat}, never
 * `processChatMessage`.
 */
import { getLog } from "../logging.ts";
import { getThreadById, type Thread } from "../db/threads.ts";
import { parseDiscussBody, type DiscussEngine, type DiscussMirrorFactory, type DiscussRefusal } from "../wiki/discuss-engine.ts";
import { chatState } from "./state.ts";
import { loadChatConfig } from "./chat-config.ts";

const log = getLog("chat", "wiki-thread");

/** The users /chat lists for a bot: the engine's check of a posted `userId`. */
export async function chatUsersFor(botName: string): Promise<{ id: string; name: string }[]> {
  return ((await loadChatConfig(botName))?.users ?? []).map((u) => ({ id: u.id, name: u.name }));
}

/** The mirror factory both entry points pass the engine. */
export function chatWikiMirror(): DiscussMirrorFactory {
  return async ({ userId, botName, threadId }) => {
    const conv = await chatState.findOrCreateBotConversation({ botName, userId });
    return {
      userMessage: (m) => chatState.addMessage(conv.id, { id: m.id, timestamp: m.createdAt, sender: "user", text: m.text, threadId }),
      delta: (text) => chatState.publishTextDelta(conv.id, text, threadId),
      tool: (t) => chatState.publishToolStatus(conv.id, t.input ? `${t.displayName}: ${t.input}` : t.displayName, threadId, t.name, t.displayName),
      answer: (m) => {
        chatState.publishStreamClear(conv.id, threadId);
        chatState.addMessage(conv.id, { id: m.id ?? crypto.randomUUID(), timestamp: Date.now(), sender: "bot", text: m.text, threadId, model: m.model });
      },
    };
  };
}

/**
 * A refusal from the pane's entry, on a live wiki thread: /chat shows it as it
 * shows a refusal of its own send (a transient error event on the thread's
 * owner's web conversation; nothing is stored). Discuss v2 PR 4.
 */
export async function publishWikiRefusal(threadId: string, message: string): Promise<void> {
  const thread = await getThreadById(threadId);
  if (!thread || thread.kind !== "wiki") return;
  const conv = await chatState.findOrCreateBotConversation({ botName: thread.botName, userId: thread.userId });
  chatState.publishTransientError(conv.id, message, thread.id);
}

/**
 * /chat's send on a wiki thread: an Explore turn on the engine. The bot and
 * connector are the wiki's (`resolveWikiSynthesisBot`, D6): the body's
 * `connector` and the thread's `connector_id` are never read. A refusal is
 * published as a transient error event (never a stored row) and returned for
 * the route to answer; a started turn runs in the background, its events
 * reaching /chat through the mirror.
 */
export async function runWikiThreadTurnFromChat(opts: {
  engine: DiscussEngine;
  conversationId: string;
  thread: Thread;
  text: string;
  role: string;
  mirror?: DiscussMirrorFactory;
}): Promise<DiscussRefusal | { started: true; turnId: string }> {
  const { thread } = opts;
  const refused = (r: DiscussRefusal): DiscussRefusal => {
    chatState.publishTransientError(opts.conversationId, r.body.error, thread.id);
    return r;
  };
  // `wiki === ""` is the default root (the WIKI_DIR override, or a registry with
  // no default): what the engine stores when the pane names no wiki. Sent as no
  // wiki, it resolves the same way the pane's request did.
  if (thread.wiki === undefined || !thread.relPath) {
    return refused({ refused: true, status: 409, body: { error: "this wiki thread has no page to discuss", reason: "no-page" } });
  }
  // The pane's body rules (the question's bound among them), as the pane would send it.
  const body = parseDiscussBody({ wiki: thread.wiki || undefined, relPath: thread.relPath, question: opts.text, discussionId: thread.id, mode: "explore" });
  if (typeof body === "string") return refused({ refused: true, status: 400, body: { error: body } });
  const started = await opts.engine.start({ role: opts.role, threadUser: thread.userId, mirror: opts.mirror ?? chatWikiMirror(), body });
  if (started.refused) return refused(started);
  started
    .run((event, data) => {
      if (event === "app_error") chatState.publishTransientError(opts.conversationId, String((data as { message?: unknown }).message ?? "the turn failed"), thread.id);
    })
    .catch((err) => log.error("wiki thread turn from /chat failed: {error}", { error: err instanceof Error ? err.message : String(err), threadId: thread.id }));
  return { started: true, turnId: started.turnId };
}
