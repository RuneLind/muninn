import type { StreamProgressEvent } from "../ai/stream-parser.ts";
import { createProgressCallback } from "../dashboard/agent-status.ts";
import { getToolStatus } from "../ai/tool-status.ts";

export interface StreamCallbacks {
  onTextDelta?: (delta: string | null) => void;
  onIntent?: (text: string) => void;
  onToolStatus?: (text: string) => void;
  setStatus?: (status: string) => Promise<void>;
}

/**
 * Build a unified progress callback that routes stream events to the
 * appropriate platform-specific callbacks (text delta, intent, tool status)
 * and falls back to the base dashboard progress callback for other events.
 */
export function buildProgressCallback(
  callbacks: StreamCallbacks,
  username: string,
): (event: StreamProgressEvent) => void {
  const baseProgress = createProgressCallback("calling_claude", username);
  const { onTextDelta, onIntent, onToolStatus, setStatus } = callbacks;
  const hasStreamCallbacks = onTextDelta || onIntent || onToolStatus || setStatus;

  if (!hasStreamCallbacks) {
    return baseProgress;
  }

  return (event: StreamProgressEvent) => {
    if (event.type === "text_delta") {
      onTextDelta?.(event.text);
    } else if (event.type === "intent") {
      onIntent?.(event.text);
      if (setStatus) setStatus(event.text).catch(() => {});
    } else {
      if (event.type === "tool_start") {
        // Clear streaming bubble when tools start (text was intermediate)
        onTextDelta?.(null);
        // Emit human-friendly tool status (appended as separate lines)
        const statusText = getToolStatus(event.name, event.input);
        if (statusText) {
          onToolStatus?.(statusText);
          if (setStatus) setStatus(statusText).catch(() => {});
        }
      }
      baseProgress(event);
    }
  };
}
