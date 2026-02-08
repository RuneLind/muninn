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

export type TaskType = "reminder" | "briefing" | "custom";

export interface ScheduledTask {
  id: string;
  userId: number;
  title: string;
  taskType: TaskType;
  prompt: string | null;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDays: number[] | null; // 0=Sun..6=Sat, null=every day
  scheduleIntervalMs: number | null; // alternative: repeat every N ms
  timezone: string;
  enabled: boolean;
  lastRunAt: number | null; // epoch ms
  nextRunAt: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
}

export type WatcherType = "email" | "calendar" | "github" | "news" | "goal";

export interface Watcher {
  id: string;
  userId: number;
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
}

export interface UserSettings {
  userId: number;
  quietStart: number | null;
  quietEnd: number | null;
  timezone: string;
}

export type GoalStatus = "active" | "completed" | "cancelled";

export interface Goal {
  id: string;
  userId: number;
  title: string;
  description: string | null;
  status: GoalStatus;
  deadline: number | null; // epoch ms
  tags: string[];
  sourceMessageId: string | null;
  lastCheckedAt: number | null;
  reminderSentAt: number | null;
  createdAt: number;
  updatedAt: number;
}
