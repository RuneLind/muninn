import type { StreamProgressEvent } from "../ai/stream-parser.ts";
import { createProgressCallback } from "../observability/agent-status.ts";
import { getToolStatus } from "../ai/tool-status.ts";
import { formatToolDisplayName } from "../ai/stream-parser.ts";

/** Status header text shown after the last tool finishes and the model
 *  starts streaming the final answer. Replaces the prior tool's status. */
const STATUS_WRITING_RESPONSE = "Writing response...";

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

export interface ToolEndInfo {
  name: string;
  displayName: string;
  /** Approximate token count from the tool's result (chars / 4). */
  tokensEstimate?: number;
}

export interface StreamCallbacks {
  onTextDelta?: (delta: string | null) => void;
  onIntent?: (text: string) => void;
  onToolStatus?: (info: ToolStatusInfo) => void;
  onToolEnd?: (info: ToolEndInfo) => void;
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
  requestId: string,
): (event: StreamProgressEvent) => void {
  const baseProgress = createProgressCallback(requestId, "calling_claude", username);
  const { onTextDelta, onIntent, onToolStatus, onToolEnd, onUsageProgress, setStatus } = callbacks;
  const hasStreamCallbacks =
    onTextDelta || onIntent || onToolStatus || onToolEnd || onUsageProgress || setStatus;

  if (!hasStreamCallbacks) {
    return baseProgress;
  }

  // The chat header status sticks until something else overwrites it. Once a
  // tool sets "Searching: ..." we want it replaced as soon as the model
  // starts streaming the final answer; otherwise the tool line lingers all
  // the way through the response. Flip this on tool events and consume on
  // the first text_delta.
  let pendingPostToolText = false;

  return (event: StreamProgressEvent) => {
    if (event.type === "text_delta") {
      if (pendingPostToolText && setStatus) {
        setStatus(STATUS_WRITING_RESPONSE).catch(() => {});
        pendingPostToolText = false;
      }
      onTextDelta?.(event.text);
    } else if (event.type === "intent") {
      onIntent?.(event.text);
      if (setStatus) setStatus(event.text).catch(() => {});
      // An explicit intent overrides whatever was there — don't double-stomp
      // it with "Writing response..." on the next text chunk.
      pendingPostToolText = false;
    } else if (event.type === "usage_progress") {
      onUsageProgress?.({
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        model: event.model,
      });
    } else if (event.type === "tool_end") {
      // Estimate result tokens from the truncated output's char count
      // (chars / 4 is the standard rough-cut for English/code tokens).
      const tokensEstimate = event.outputSize !== undefined
        ? Math.round(event.outputSize / 4)
        : undefined;
      onToolEnd?.({
        name: event.name,
        displayName: event.displayName,
        tokensEstimate,
      });
      pendingPostToolText = true;
      baseProgress(event);
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
        // Tool just started — its own status takes over, so any pending
        // post-tool transition from a previous tool round is moot.
        pendingPostToolText = false;
      }
      baseProgress(event);
    }
  };
}
