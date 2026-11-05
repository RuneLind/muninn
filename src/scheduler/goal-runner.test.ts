/**
 * The `/agents` identity on a goal run's trace root, on both goal paths.
 *
 * Runs in its own `bun test` process (its own link in the `test` and `test:handlers`
 * chains): `mock.module` on the DB and Haiku modules would leak into every other
 * file sharing the process. `src/test/mock-isolation.test.ts` pins that placement.
 */
import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { Api } from "grammy";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import type { Goal } from "../types.ts";

class FakeTracer {
  static instances: FakeTracer[] = [];
  traceId = `trace-${FakeTracer.instances.length}`;
  finished: Array<{ status: string; attrs?: Record<string, unknown> }> = [];
  constructor(readonly name: string) {
    FakeTracer.instances.push(this);
  }
  finish(status: string, attrs?: Record<string, unknown>) {
    this.finished.push({ status, attrs });
  }
}
mock.module("../tracing/index.ts", () => ({ Tracer: FakeTracer }));

let sendThrows = false;
const completed: Array<Record<string, unknown>> = [];
const usage = { model: "claude-haiku-test", inputTokens: 5, outputTokens: 2, backend: "cli" };
mock.module("../ai/haiku-direct.ts", () => ({
  callHaikuMessageWithFallback: async () => ({ text: "reminder text", usage }),
  backendConnector: (b: string) => b,
}));
mock.module("../db/goals.ts", () => ({
  updateGoalReminderSentAt: async () => {},
  updateGoalCheckedAt: async () => {},
}));
mock.module("../db/messages.ts", () => ({ saveMessage: async () => "m" }));
mock.module("../db/threads.ts", () => ({ getActiveThreadId: async () => "t" }));
mock.module("../bot/telegram-format.ts", () => ({ formatTelegramHtml: (s: string) => s }));
mock.module("../observability/activity-log.ts", () => ({ activityLog: { push: () => {} } }));
mock.module("../observability/agent-status.ts", () => ({
  agentStatus: {
    set: () => {},
    startRequest: () => "req-1",
    updatePhase: () => {},
    completeRequest: (_id: string, meta: Record<string, unknown>) => void completed.push(meta),
    clearRequest: () => {},
  },
  setConnectorInfo: () => {},
}));

const { runGoalRemindersFromList, runGoalCheckinsFromList } = await import("./goal-runner.ts");

const api = {
  sendMessage: async () => {
    if (sendThrows) throw new Error("send boom");
    return {};
  },
} as unknown as Api;
const config = { claudeModel: "sonnet" } as Config;
const bot = { name: "jarvis", connector: "claude-cli" } as BotConfig;
const goal = { id: "g1", userId: "u1", title: "Ship it", description: "", status: "active", tags: [] } as unknown as Goal;

const paths = [
  ["reminder", runGoalRemindersFromList, "Goal reminder: Ship it"],
  ["check-in", runGoalCheckinsFromList, "Goal check-in: Ship it"],
] as const;

describe.each(paths)("goal %s", (_label, run, name) => {
  beforeEach(() => {
    FakeTracer.instances = [];
    completed.length = 0;
    sendThrows = false;
  });

  test("the finished root carries the run's identity and spend", async () => {
    await run(api, config, bot, [goal]);
    expect(FakeTracer.instances[0]!.finished).toHaveLength(1);
    expect(FakeTracer.instances[0]!.finished[0]).toMatchObject({
      status: "ok",
      attrs: { agentKind: "scheduled_task", agentName: name, model: "claude-haiku-test", inputTokens: 5 },
    });
    // The ring row names this root, which is what keeps it from being listed twice.
    expect(completed[0]).toMatchObject({ traceId: FakeTracer.instances[0]!.traceId });
  });

  test("a failed run still leaves a stamped error root: it has no ring row", async () => {
    sendThrows = true;
    await run(api, config, bot, [goal]);
    expect(completed).toEqual([]);
    expect(FakeTracer.instances[0]!.finished).toEqual([
      {
        status: "error",
        attrs: {
          connector: "cli",
          model: "claude-haiku-test",
          inputTokens: 5,
          outputTokens: 2,
          error: "send boom",
          agentKind: "scheduled_task",
          agentName: name,
        },
      },
    ]);
  });
});
