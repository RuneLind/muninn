import type { SaveMessageParams } from "../db/messages.ts";

let counter = 0;
function uid(): string {
  return String(++counter);
}

export function makeMessage(overrides: Partial<SaveMessageParams> = {}): SaveMessageParams {
  return {
    userId: "user-1",
    botName: "testbot",
    username: "testuser",
    role: "user",
    content: `Test message ${uid()}`,
    ...overrides,
  };
}

export function makeMemory(overrides: Partial<{
  userId: string;
  botName: string;
  content: string;
  summary: string;
  tags: string[];
  sourceMessageId: string;
  embedding: number[] | null;
  scope: "personal" | "shared";
}> = {}) {
  return {
    userId: "user-1",
    botName: "testbot",
    content: `Memory content ${uid()}`,
    summary: `Memory summary ${uid()}`,
    tags: ["test"],
    ...overrides,
  };
}

export function makeGoal(overrides: Partial<{
  userId: string;
  botName: string;
  title: string;
  description: string | null;
  deadline: Date | null;
  tags: string[];
  sourceMessageId: string | null;
}> = {}) {
  return {
    userId: "user-1",
    botName: "testbot",
    title: `Goal ${uid()}`,
    ...overrides,
  };
}

export function makeScheduledTask(overrides: Partial<{
  userId: string;
  botName: string;
  title: string;
  taskType: "reminder" | "briefing" | "custom";
  prompt: string | null;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDays: number[] | null;
  scheduleIntervalMs: number | null;
  timezone: string;
}> = {}) {
  return {
    userId: "user-1",
    botName: "testbot",
    title: `Task ${uid()}`,
    taskType: "reminder" as const,
    scheduleHour: 8,
    scheduleMinute: 0,
    timezone: "Europe/Oslo",
    ...overrides,
  };
}

export function makeWatcher(overrides: Partial<{
  userId: string;
  botName: string;
  name: string;
  type: "email" | "calendar" | "github" | "news" | "goal";
  config: Record<string, string | number | boolean | null>;
  intervalMs: number;
}> = {}) {
  return {
    userId: "user-1",
    botName: "testbot",
    name: `Watcher ${uid()}`,
    type: "email" as const,
    ...overrides,
  };
}

export function makeActivity(overrides: Partial<{
  type: "message_in" | "message_out" | "error" | "system";
  userId: string;
  username: string;
  botName: string;
  text: string;
  durationMs: number;
  costUsd: number;
}> = {}) {
  return {
    type: "message_in" as const,
    userId: "user-1",
    username: "testuser",
    botName: "testbot",
    text: `Activity ${uid()}`,
    ...overrides,
  };
}

export function resetFixtureCounter(): void {
  counter = 0;
}
