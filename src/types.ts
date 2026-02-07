export type ActivityEventType = "message_in" | "message_out" | "error" | "system";

export interface TimingMetadata {
  totalMs: number;
  startupMs?: number;
  apiMs?: number;
  promptBuildMs?: number;
  sttMs?: number;
  ttsMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  numTurns?: number;
}

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  timestamp: number;
  userId?: number;
  username?: string;
  text: string;
  durationMs?: number;
  costUsd?: number;
  metadata?: TimingMetadata;
}

export interface ClaudeResult {
  result: string;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
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

export interface ConversationMessage extends JarvisMessage {
  id: string;
  username?: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}

export interface Memory {
  id: string;
  userId: number;
  content: string;
  summary: string;
  tags: string[];
  createdAt: number;
  similarity?: number;
}
