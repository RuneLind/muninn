export type Platform = "telegram" | "slack_dm" | "slack_channel" | "slack_assistant" | "slack_unknown" | "web";

export interface UserIdentity {
  name: string;
  displayName?: string;
  title?: string;
}

export type ActivityEventType = "message_in" | "message_out" | "error" | "system" | "slack_channel_post";

export interface TimingMetadata {
  totalMs?: number;
  startupMs?: number;
  apiMs?: number;
  promptBuildMs?: number;
  sttMs?: number;
  ttsMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  numTurns?: number;
  /** Extra metadata (e.g. Slack channel name) */
  [key: string]: unknown;
}

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  timestamp: number;
  userId?: string;
  username?: string;
  botName?: string;
  text: string;
  durationMs?: number;
  costUsd?: number;
  metadata?: TimingMetadata;
}

export interface ToolCall {
  id: string;
  name: string;        // e.g. "mcp__gmail__search_emails"
  displayName: string; // e.g. "search_emails (gmail)"
  durationMs: number;
  startOffsetMs: number; // offset from Claude CLI start (for waterfall positioning)
  input?: string;      // abbreviated JSON, max 500 chars
}

export interface ClaudeResult {
  result: string;
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  startupMs?: number;
  numTurns: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls?: ToolCall[];
}

export interface JarvisMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  userId?: string;
}

export interface ConversationMessage extends JarvisMessage {
  id: string;
  username?: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
}

export type MemoryScope = 'personal' | 'shared';

export interface Memory {
  id: string;
  userId: string;
  content: string;
  summary: string;
  tags: string[];
  scope?: MemoryScope;
  createdAt: number;
  similarity?: number;
}

export type TaskType = "reminder" | "briefing" | "custom";

export interface ScheduledTask {
  id: string;
  userId: string;
  botName: string;
  title: string;
  taskType: TaskType;
  prompt: string | null;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDays: number[] | null; // 0=Sun..6=Sat, null=every day
  scheduleIntervalMs: number | null; // alternative: repeat every N ms
  timezone: string;
  platform?: Platform;
  enabled: boolean;
  lastRunAt: number | null; // epoch ms
  nextRunAt: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
}

export type WatcherType = "email" | "calendar" | "github" | "news" | "goal";

export interface Watcher {
  id: string;
  userId: string;
  botName: string;
  name: string;
  type: WatcherType;
  config: Record<string, unknown>;
  intervalMs: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastNotifiedIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface WatcherAlert {
  id: string;
  source: string;
  summary: string;
  urgency: "low" | "medium" | "high";
  sender?: string;
  subject?: string;
}

export interface UserSettings {
  userId: string;
  quietStart: number | null;
  quietEnd: number | null;
  timezone: string;
}

export type GoalStatus = "active" | "completed" | "cancelled";

export interface Goal {
  id: string;
  userId: string;
  botName: string;
  title: string;
  description: string | null;
  status: GoalStatus;
  deadline: number | null; // epoch ms
  tags: string[];
  sourceMessageId: string | null;
  platform?: Platform;
  lastCheckedAt: number | null;
  reminderSentAt: number | null;
  createdAt: number;
  updatedAt: number;
}
