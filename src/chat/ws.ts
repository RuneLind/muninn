import { chatState } from "./state.ts";
import type { ServerWebSocket } from "bun";

export interface ChatWsData {
  unsubscribe: (() => void) | null;
}

/** WebSocket handlers for Bun.serve's websocket option */
export const chatWebSocket = {
  open(ws: ServerWebSocket<ChatWsData>) {
    // Snapshot FIRST (before subscribe, so no events can slip in before it)
    const conversations = chatState.getConversations();

    const unsub = chatState.subscribe((event) => {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // Connection closed, will clean up in close handler
      }
    });
    ws.data.unsubscribe = unsub;

    ws.send(JSON.stringify({ type: "snapshot", conversations }));
  },

  close(ws: ServerWebSocket<ChatWsData>) {
    ws.data.unsubscribe?.();
  },

  message(_ws: ServerWebSocket<ChatWsData>, _msg: string | Buffer) {
    // No client-to-server messages needed yet
  },
};
