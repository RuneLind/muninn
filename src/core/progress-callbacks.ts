import type { StreamProgressEvent } from "../ai/stream-parser.ts";
import { createProgressCallback } from "../dashboard/agent-status.ts";
import { getToolStatus } from "../ai/tool-status.ts";
import { formatToolDisplayName } from "../ai/stream-parser.ts";

export interface UsageProgress {
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

export interface ToolStatusInfo {
  text: string;
  name: string;
  displayName: string;
}

export interface StreamCallbacks {
  onTextDelta?: (delta: string | null) => void;
  onIntent?: (text: string) => void;
  onToolStatus?: (info: ToolStatusInfo) => void;
  onUsageProgress?: (usage: UsageProgress) => void;
  setStatus?: (status: string) => Promise<void>;
}

/**
 * Build a unified progress callback that routes stream events to the
 * appropriate platform-specific callbacks (text delta, intent, tool status,
 * usage progress) and falls back to the base dashboard progress callback
 * for other events.
 */
export function buildProgressCallback(
  callbacks: StreamCallbacks,
  username: string,
): (event: StreamProgressEvent) => void {
  const baseProgress = createProgressCallback("calling_claude", username);
  const { onTextDelta, onIntent, onToolStatus, onUsageProgress, setStatus } = callbacks;
  const hasStreamCallbacks =
    onTextDelta || onIntent || onToolStatus || onUsageProgress || setStatus;

  if (!hasStreamCallbacks) {
    return baseProgress;
  }

  return (event: StreamProgressEvent) => {
    if (event.type === "text_delta") {
      onTextDelta?.(event.text);
    } else if (event.type === "intent") {
      onIntent?.(event.text);
      if (setStatus) setStatus(event.text).catch(() => {});
    } else if (event.type === "usage_progress") {
      onUsageProgress?.({
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        model: event.model,
      });
    } else {
      if (event.type === "tool_start") {
        // Clear streaming bubble when tools start (text was intermediate)
        onTextDelta?.(null);
        // Emit human-friendly tool status (appended as separate lines).
        // Pass structured name + displayName alongside the text so the chat
        // layer can aggregate per-tool counts live in the inspector card.
        const statusText = getToolStatus(event.name, event.input);
        if (statusText) {
          onToolStatus?.({
            text: statusText,
            name: event.name,
            displayName: event.displayName || formatToolDisplayName(event.name),
          });
          if (setStatus) setStatus(statusText).catch(() => {});
        }
      }
      baseProgress(event);
    }
  };
}
