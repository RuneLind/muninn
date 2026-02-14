import { simulatorState } from "./state.ts";
import type { ServerWebSocket } from "bun";

export interface SimulatorWsData {
  unsubscribe: (() => void) | null;
}

/** WebSocket handlers for Bun.serve's websocket option */
export const simulatorWebSocket = {
  open(ws: ServerWebSocket<SimulatorWsData>) {
    // Snapshot FIRST (before subscribe, so no events can slip in before it)
    const conversations = simulatorState.getConversations();

    const unsub = simulatorState.subscribe((event) => {
      try {
        ws.send(JSON.stringify(event));
      } catch {
        // Connection closed, will clean up in close handler
      }
    });
    ws.data.unsubscribe = unsub;

    ws.send(JSON.stringify({ type: "snapshot", conversations }));
  },

  close(ws: ServerWebSocket<SimulatorWsData>) {
    ws.data.unsubscribe?.();
  },

  message(_ws: ServerWebSocket<SimulatorWsData>, _msg: string | Buffer) {
    // No client-to-server messages needed yet
  },
};
