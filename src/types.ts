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
  /**
   * Tool result captured from the connector. JSON-stringified, capped at 16 KB.
   * If the original exceeded the cap, the value is `{"_truncated":true,"_originalBytes":N,"head":"..."}`.
   * Undefined when `TRACING_CAPTURE_TOOL_OUTPUTS=false` or the connector could not surface a result.
   */
  output?: string;
  /**
   * Parsed Huginn search trace (when the tool call returned one). The connector
   * is expected to peel this off the raw tool output so it doesn't pollute the
   * `output` snapshot or the LLM context. Surfaces in the inspector under
   * `attributes.searchTrace`. See src/ai/huginn-trace.ts.
   */
  searchTrace?: unknown;
  /**
   * Phase 2 trace channel: a fetch URL the connector parsed from a
   * `huginn-trace-id`/`huginn-trace-url` pointer line in the tool result.
   * Set when the tool ran but `searchTrace` is not yet resolved — message-processor
   * awaits {@link searchTraceFetch} (started eagerly by the connector at peel time)
   * and merges the result into the span. See src/ai/huginn-trace-pointer.ts.
   */
  searchTracePointer?: string;
  /**
   * In-flight fetch for {@link searchTracePointer}, started by the connector the
   * moment the pointer is extracted. Huginn's trace store has a short TTL, so a
   * deferred fetch (waiting for the full claude session to end) returns 404 for
   * pointers emitted at the start of long multi-tool sessions. Eagerly kicking
   * off the fetch keeps the latency near zero. Resolves to `null` on any error
   * (404, timeout, network) — see {@link fetchHuginnTrace}.
   */
  searchTraceFetch?: Promise<unknown | null>;
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
  /** Last turn's input tokens — actual context window consumption (vs cumulative inputTokens) */
  contextTokens?: number;
  /** Cache-read input tokens (cumulative across turns). Subset of inputTokens. */
  cacheReadTokens?: number;
  /** Cache-creation input tokens (cumulative across turns). Subset of inputTokens. */
  cacheCreationTokens?: number;
  toolCalls?: ToolCall[];
}

export interface ChatMessage {
  role: "user" | "assistant" | "peer";
  text: string;
  timestamp: number;
  userId?: string;
}

export interface ConversationMessage extends ChatMessage {
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

export type WatcherType = "email" | "calendar" | "github" | "news" | "goal" | "x";

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
  forceNextRun: boolean;
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
  /** Extra IDs to track in lastNotifiedIds for dedup (e.g. individual tweet IDs in a digest) */
  trackingIds?: string[];
  /** If true, the runner persists trackingIds but skips sending/saving. Used by quiet-mode digests that evaluated tweets but chose not to surface them. */
  silent?: boolean;
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
