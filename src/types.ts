export type ActivityEventType = "message_in" | "message_out" | "error" | "system";

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  timestamp: number;
  userId?: number;
  username?: string;
  text: string;
  durationMs?: number;
  costUsd?: number;
}

export interface ClaudeResult {
  result: string;
  costUsd: number;
  durationMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface JarvisMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  userId?: number;
}
