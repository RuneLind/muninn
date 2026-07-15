import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { BotConfig } from "../bots/config.ts";
import type { ScheduledTask } from "../types.ts";

// --- Module mocks (registered before the dynamic import below) ---
// Run in an ISOLATED `bun test src/scheduler/task-executor.test.ts` process (see
// the test/test:handlers scripts) so these mock.module registrations can't leak
// into the large shared test process.

// Fake Tracer that records span lifecycle. `end` throws on an unstarted label,
// mirroring the real Timing.end — so the briefing's `claudeStarted` guard is
// genuinely exercised (an unguarded end after a build-prompt throw would blow up
// the fallback path).
interface FakeSpan { label: string; attrs?: any; ended?: boolean; endAttrs?: any }
class FakeTracer {
  static instances: FakeTracer[] = [];
  static reset() { FakeTracer.instances = []; }
  name: string;
  opts: any;
  traceId: string;
  spans: FakeSpan[] = [];
  finished?: { status: string; attrs?: any };
  errored?: unknown;
  constructor(name: string, opts: any = {}) {
    this.name = name;
    this.opts = opts;
    this.traceId = opts?.traceId ?? "trace-fake";
    FakeTracer.instances.push(this);
  }
  start(label: string, attrs?: any): string {
    this.spans.push({ label, attrs });
    return `span-${label}`;
  }
  end(label: string, attrs?: any): number {
    const span = [...this.spans].reverse().find((s) => s.label === label && !s.ended);
    if (!span) throw new Error(`No active mark for "${label}"`);
    span.ended = true;
    span.endAttrs = attrs;
    return 1;
  }
  finish(status: string, attrs?: any): void {
    this.finished = { status, attrs };
  }
  error(err: unknown): void {
    this.finished = { status: "error", attrs: { error: String(err) } };
    this.errored = err;
  }
  get context() {
    return { traceId: this.traceId, parentId: "root" };
  }
  span(label: string): FakeSpan | undefined {
    return this.spans.find((s) => s.label === label);
  }
}
mock.module("../tracing/index.ts", () => ({ Tracer: FakeTracer }));

const attachToolSpansCalls: Array<{ tracer: unknown; toolCalls: unknown; capture: boolean }> = [];
mock.module("../core/tool-spans.ts", () => ({
  attachToolSpans: mock(async (tracer: unknown, toolCalls: unknown, capture: boolean) => {
    attachToolSpansCalls.push({ tracer, toolCalls, capture });
  }),
}));

// Connector — configurable result/throw.
let connectorResult: any = {
  result: "briefing body",
  model: "claude-sonnet-test",
  inputTokens: 100,
  outputTokens: 20,
  numTurns: 2,
  costUsd: 0.01,
  toolCalls: [{ id: "t1", name: "mcp__x__y", displayName: "y (x)", durationMs: 5 }],
};
let connectorThrows = false;
mock.module("../ai/connector.ts", () => ({
  resolveConnector: () => async () => {
    if (connectorThrows) throw new Error("connector boom");
    return connectorResult;
  },
}));

// briefing-prompt — configurable throw.
let buildPromptThrows = false;
mock.module("./briefing-prompt.ts", () => ({
  buildBriefingPrompt: mock(async () => {
    if (buildPromptThrows) throw new Error("prompt build boom");
    return {
      systemPrompt: "sys",
      userPrompt: "user",
      meta: { buildMs: 1, memoriesCount: 0, goalsCount: 0, scheduledTasksCount: 0, alertsCount: 0 },
    };
  }),
}));

// callHaiku — records the telemetry seam it receives and optionally fires onUsage.
let haikuUsage: any = { model: "claude-haiku-test", inputTokens: 50, outputTokens: 10, numTurns: 1 };
let haikuFiresUsage = true;
const callHaikuCalls: Array<{ args: any[]; telemetry: any }> = [];
mock.module("./executor.ts", () => ({
  callHaiku: mock(async (...args: any[]) => {
    const telemetry = args[6];
    callHaikuCalls.push({ args, telemetry });
    if (haikuFiresUsage && telemetry?.onUsage) telemetry.onUsage(haikuUsage);
    return "haiku text";
  }),
}));

// DB / telegram / observability — inert stubs.
mock.module("../db/scheduled-tasks.ts", () => ({ updateTaskLastRun: mock(async () => {}) }));
mock.module("../db/messages.ts", () => ({ saveMessage: mock(async () => "msg-1") }));
mock.module("../db/threads.ts", () => ({ getActiveThreadId: mock(async () => "thread-1") }));
mock.module("../bot/telegram-format.ts", () => ({ formatTelegramHtml: (s: string) => s }));
mock.module("../observability/activity-log.ts", () => ({ activityLog: { push: () => {} } }));
mock.module("../observability/agent-status.ts", () => ({
  agentStatus: {
    set: () => {},
    startRequest: () => "req-1",
    updatePhase: () => {},
    completeRequest: () => {},
    clearRequest: () => {},
  },
  createProgressCallback: () => () => {},
  setConnectorInfo: () => {},
}));

const { runScheduledTasksFromList } = await import("./task-executor.ts");

const botConfig = { name: "jarvis", dir: "/bots/jarvis", persona: "P", connector: "claude-cli" } as unknown as BotConfig;
const config = { claudeModel: "claude-sonnet-cfg", tracingCaptureToolOutputs: false } as any;

// A fake grammy Api — sendMessage optionally throws.
let sendThrows = false;
const api = { sendMessage: mock(async () => { if (sendThrows) throw new Error("telegram boom"); }) } as any;

function makeTask(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: "task-1",
    userId: "u1",
    botName: "jarvis",
    title: "Test task",
    taskType: "briefing",
    prompt: null,
    scheduleHour: 8,
    ...overrides,
  } as unknown as ScheduledTask;
}

const CTX = { traceId: "tick-1", parentId: "root-1" };

beforeEach(() => {
  FakeTracer.reset();
  attachToolSpansCalls.length = 0;
  callHaikuCalls.length = 0;
  connectorThrows = false;
  buildPromptThrows = false;
  sendThrows = false;
  haikuFiresUsage = true;
  connectorResult = {
    result: "briefing body",
    model: "claude-sonnet-test",
    inputTokens: 100,
    outputTokens: 20,
    numTurns: 2,
    costUsd: 0.01,
    toolCalls: [{ id: "t1", name: "mcp__x__y", displayName: "y (x)", durationMs: 5 }],
  };
  haikuUsage = { model: "claude-haiku-test", inputTokens: 50, outputTokens: 10, numTurns: 1 };
});

describe("runScheduledTasksFromList — task tracing", () => {
  test("briefing opens a task:briefing child tracer under the tick with a claude span + tool spans", async () => {
    await runScheduledTasksFromList(api, config, botConfig, [makeTask({ taskType: "briefing" })], CTX);

    expect(FakeTracer.instances.length).toBe(1);
    const tt = FakeTracer.instances[0]!;
    expect(tt.name).toBe("task:briefing");
    // Child of the tick: shares its traceId + parentId.
    expect(tt.opts.traceId).toBe("tick-1");
    expect(tt.opts.parentId).toBe("root-1");

    const claude = tt.span("claude");
    expect(claude).toBeDefined();
    expect(claude!.ended).toBe(true);
    expect(claude!.endAttrs.model).toBe("claude-sonnet-test");
    expect(claude!.endAttrs.inputTokens).toBe(100);
    expect(claude!.endAttrs.outputTokens).toBe(20);
    expect(claude!.endAttrs.toolCount).toBe(1);

    // Tool spans hang off the claude span via attachToolSpans.
    expect(attachToolSpansCalls.length).toBe(1);
    expect(attachToolSpansCalls[0]!.tracer).toBe(tt);
    expect((attachToolSpansCalls[0]!.toolCalls as any[]).length).toBe(1);

    // Span settled ok with the task's token totals.
    expect(tt.finished?.status).toBe("ok");
    expect(tt.finished?.attrs.taskType).toBe("briefing");
    expect(tt.finished?.attrs.inputTokens).toBe(100);
    expect(tt.finished?.attrs.model).toBe("claude-sonnet-test");
  });

  test("no trace context (manual-trigger path) writes no trace at all", async () => {
    await runScheduledTasksFromList(api, config, botConfig, [makeTask({ taskType: "briefing" })]);

    expect(FakeTracer.instances.length).toBe(0);
    expect(attachToolSpansCalls.length).toBe(0);
    // The task still ran (message sent).
    expect(api.sendMessage).toHaveBeenCalled();
  });

  test("reminder threads tracer + onUsage through callHaiku; span carries coarse tokens, no claude span", async () => {
    await runScheduledTasksFromList(api, config, botConfig, [makeTask({ taskType: "reminder", title: "Take a break" })], CTX);

    expect(FakeTracer.instances.length).toBe(1);
    const tt = FakeTracer.instances[0]!;
    expect(tt.name).toBe("task:reminder");
    // Haiku paths stamp NO claude child span.
    expect(tt.span("claude")).toBeUndefined();

    // callHaiku received the telemetry seam (7th positional arg).
    expect(callHaikuCalls.length).toBe(1);
    const telemetry = callHaikuCalls[0]!.telemetry;
    expect(telemetry.tracer).toBe(tt);
    expect(typeof telemetry.onUsage).toBe("function");

    // Token totals from onUsage rode onto the span's finish attrs.
    expect(tt.finished?.status).toBe("ok");
    expect(tt.finished?.attrs.inputTokens).toBe(50);
    expect(tt.finished?.attrs.outputTokens).toBe(10);
    expect(attachToolSpansCalls.length).toBe(0);
  });

  test("custom task with a prompt also traces via the Haiku path", async () => {
    await runScheduledTasksFromList(api, config, botConfig, [makeTask({ taskType: "custom", prompt: "do the thing" })], CTX);

    const tt = FakeTracer.instances[0]!;
    expect(tt.name).toBe("task:custom");
    expect(tt.span("claude")).toBeUndefined();
    expect(callHaikuCalls[0]!.telemetry.tracer).toBe(tt);
    expect(tt.finished?.status).toBe("ok");
  });

  test("error path (send throws) settles the span as error, no leaked/unfinished span", async () => {
    sendThrows = true;

    await runScheduledTasksFromList(api, config, botConfig, [makeTask({ taskType: "reminder" })], CTX);

    const tt = FakeTracer.instances[0]!;
    expect(tt.finished?.status).toBe("error");
    expect(tt.errored).toBeInstanceOf(Error);
  });

  test("briefing build-prompt throw: claude span never opened, guard avoids ending an unstarted span", async () => {
    buildPromptThrows = true;

    // Must not reject — the briefing catch returns a fallback and the task
    // succeeds. If the claudeStarted guard were missing, tracer.end('claude')
    // would throw ('No active mark') and surface here.
    await runScheduledTasksFromList(api, config, botConfig, [makeTask({ taskType: "briefing" })], CTX);

    const tt = FakeTracer.instances[0]!;
    // No claude span was opened.
    expect(tt.span("claude")).toBeUndefined();
    // Fallback message still sent, task settled ok.
    expect(api.sendMessage).toHaveBeenCalled();
    expect(tt.finished?.status).toBe("ok");
    expect(attachToolSpansCalls.length).toBe(0);
  });

  test("briefing connector throw: claude span ended with error, task falls back and settles ok", async () => {
    connectorThrows = true;

    await runScheduledTasksFromList(api, config, botConfig, [makeTask({ taskType: "briefing" })], CTX);

    const tt = FakeTracer.instances[0]!;
    const claude = tt.span("claude");
    // Span was opened then ended with an error attr (not left unfinished).
    expect(claude).toBeDefined();
    expect(claude!.ended).toBe(true);
    expect(claude!.endAttrs.error).toContain("connector boom");
    // Briefing degraded to fallback ⇒ the task itself succeeded.
    expect(tt.finished?.status).toBe("ok");
    expect(attachToolSpansCalls.length).toBe(0);
  });
});
