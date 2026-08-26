import { chatState, type ChatEvent } from "./state.ts";
import type { ServerWebSocket } from "bun";
import { getLog } from "../logging.ts";

const log = getLog("chat", "ws");

export interface ChatWsData {
  unsubscribe: (() => void) | null;
  /**
   * The identity `src/auth/ws-upgrade.ts` resolved at the handshake, or `null`
   * with auth off — where no middleware is mounted on the HTTP side either and
   * the socket stays exactly as unfiltered as it is today.
   */
  userId: string | null;
  /** `"admin"` sees every conversation, as on the REST side. `null` with auth
   *  off. `local` identities always resolve to `"user"` — see `role.ts`. */
  role: "user" | "admin" | null;
  /** Epoch ms the credential expires, or `null` for one that does not. */
  expiresAt: number | null;
  /** The lifetime cap's timer, cleared on close. */
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * The `ws.data` a resolved upgrade produces.
 *
 * It lives here, beside {@link ChatWsData}, rather than as an object literal in
 * `src/index.ts`: the shape and its one constructor belong together, and a
 * hand-written literal that spelled `userId: null` would typecheck, upgrade
 * fine, and silently deliver an UNFILTERED socket — the exact defect PR D
 * exists to close, reintroduced by a wiring slip no type checker can see.
 */
export function wsDataFor(decision: {
  identity: { userId: string; expiresAt: number | null } | null;
  role: "user" | "admin" | null;
}): ChatWsData {
  return {
    unsubscribe: null,
    userId: decision.identity?.userId ?? null,
    role: decision.role,
    expiresAt: decision.identity?.expiresAt ?? null,
    expiryTimer: null,
  };
}

/**
 * Close code for a socket whose credential ran out.
 *
 * 4401 rather than 1008: the 4000–4999 range is reserved for applications, and
 * the client turns this one into §8's reload-to-login rather than into the
 * ordinary 2 s reconnect (which would spin against a 401 forever).
 */
export const WS_CLOSE_EXPIRED = 4401;

/**
 * Whether a socket owned by `viewer` may hear this event.
 *
 * Pure, and exported, because this is the assertion acceptance 8 makes: with B
 * sending a turn, A's socket carries **zero** references to B. Every branch is
 * reachable from a test; none of them needs a socket.
 *
 * The rules, and why each is what it is:
 *
 *  - **auth off (`viewer === null`)** ⇒ everything. Off is off.
 *  - **`admin`** ⇒ everything. The dashboard's own pages consume this socket.
 *    Inert in `local` mode, where `resolveRole` answers `user` unconditionally.
 *  - **`mcp_status`** ⇒ everything. It is the one event carrying no
 *    `conversationId` AND no user data — a per-bot server list — and the chat
 *    page's inspector panel consumes it. §6 names it explicitly: silently
 *    dropping unaddressed events is what would blank that panel.
 *  - **everything else** ⇒ resolved through the conversation's owner. An event
 *    for a conversation that is no longer resident is DROPPED, not delivered:
 *    the fail-closed direction, and unreachable in practice since PR A stopped
 *    evicting shells.
 *
 * `conversation_created` carries the whole conversation rather than only an id,
 * so it is answered from the payload — it is also the one event that can arrive
 * before the shell is readable by id from another async context.
 */
export function eventVisibleTo(
  event: ChatEvent,
  viewer: string | null,
  role: "user" | "admin" | null,
  // Injectable so the table below can be driven without touching the process-wide
  // `chatState` singleton, which other test files in the same `bun test` chunk
  // share. The production call site passes nothing.
  ownerOf: (conversationId: string) => string | undefined = (id) => chatState.conversationOwner(id),
): boolean {
  if (viewer === null) return true;
  if (role === "admin") return true;
  if (event.type === "mcp_status") return true;
  if (event.type === "conversation_created") return event.conversation.userId === viewer;
  const owner = ownerOf(event.conversationId);
  return owner !== undefined && owner === viewer;
}

/** WebSocket handlers for Bun.serve's websocket option */
export const chatWebSocket = {
  open(ws: ServerWebSocket<ChatWsData>) {
    const viewer = ws.data.userId;
    const role = ws.data.role;

    // Snapshot FIRST (before subscribe, so no events can slip in before it).
    //
    // The snapshot is the largest single disclosure on this socket: it publishes
    // `id`, `userId` and `username` for every conversation in memory, and a web
    // conversation id is `sha256("<userId>:<botName>:web")[0:16]` — derivable,
    // and the thing every `requireOwnedResource` route is protecting. Filtering
    // the per-event fan-out while shipping an unfiltered snapshot would close
    // nothing.
    const conversations = chatState.getConversations().filter(
      (conv) => viewer === null || role === "admin" || conv.userId === viewer,
    );

    const unsub = chatState.subscribe((event) => {
      if (!eventVisibleTo(event, viewer, role)) return;
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // Connection closed, will clean up in close handler
      }
    });
    ws.data.unsubscribe = unsub;

    ws.send(JSON.stringify({ type: "snapshot", conversations }));

    // §6's socket lifetime: the upgrade authenticates ONCE, so without this a
    // credential that expires (or a session invalidated by rotating
    // `MUNINN_LOCAL_TOKEN`) keeps streaming live events until the tab closes.
    // Capping at the introspected expiry is the cheaper half of §6's "re-
    // introspect on a timer OR cap at exp" — one timer per socket, no polling,
    // and nothing to get wrong on the happy path. `expiresAt` is null for the
    // raw shared secret and with auth off, where there is nothing to cap.
    const expiresAt = ws.data.expiresAt;
    if (expiresAt !== null) {
      const remaining = expiresAt - Date.now();
      if (remaining <= 0) {
        ws.close(WS_CLOSE_EXPIRED, "session expired");
        return;
      }
      const timer = setTimeout(() => {
        log.info("Closing a WebSocket whose session expired");
        try {
          ws.close(WS_CLOSE_EXPIRED, "session expired");
        } catch {
          // Already gone.
        }
      }, remaining);
      // Never hold the process open for a 7-day timer. `unref` is present on
      // Bun's timer handle; guarded because the type is `Timeout | number`
      // depending on the lib set.
      (timer as { unref?: () => void }).unref?.();
      ws.data.expiryTimer = timer;
    }
  },

  close(ws: ServerWebSocket<ChatWsData>) {
    ws.data.unsubscribe?.();
    if (ws.data.expiryTimer !== null) clearTimeout(ws.data.expiryTimer);
    ws.data.expiryTimer = null;
  },

  message(_ws: ServerWebSocket<ChatWsData>, _msg: string | Buffer) {
    // No client-to-server messages needed yet
  },
};
