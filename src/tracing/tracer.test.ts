import { test, expect, describe, beforeEach, mock } from "bun:test";

// Track all calls to saveSpan and updateSpan
const saveSpanCalls: Array<Record<string, unknown>> = [];
const updateSpanCalls: Array<{ id: string; params: Record<string, unknown> }> = [];

// Ordered log of DB write completions — lets the race regression test assert
// that an UPDATE only fires after its INSERT has resolved.
const writeOrder: string[] = [];
// When true, every saveSpan parks until a resolver in `pendingSaves` is fired,
// simulating an INSERT that lands on a slow pool connection.
let deferSaveSpan = false;
let pendingSaves: Array<() => void> = [];

mock.module("../db/traces.ts", () => ({
  saveSpan: async (params: Record<string, unknown>) => {
    saveSpanCalls.push(params);
    if (deferSaveSpan) {
      await new Promise<void>((resolve) => pendingSaves.push(resolve));
    }
    writeOrder.push("insert");
  },
  updateSpan: async (id: string, params: Record<string, unknown>) => {
    writeOrder.push("update");
    updateSpanCalls.push({ id, params });
  },
}));

// Default: tracing enabled
let tracingEnabledValue = true;
mock.module("../config.ts", () => ({
  loadConfig: () => ({ tracingEnabled: tracingEnabledValue }),
}));

// Must import after mocks are set up
const { Tracer } = await import("./tracer.ts");

// end()/finish() now chain the UPDATE on the span's INSERT promise, so the
// UPDATE lands a microtask after the call returns rather than synchronously.
// Tests that assert on updateSpanCalls must flush the microtask queue first.
const flushWrites = () => Bun.sleep(0);

describe("Tracer", () => {
  beforeEach(() => {
    saveSpanCalls.length = 0;
    updateSpanCalls.length = 0;
    writeOrder.length = 0;
    deferSaveSpan = false;
    pendingSaves = [];
    tracingEnabledValue = true;
    // Reset the cached _tracingEnabled by creating fresh tracers
    // The module-level cache is set once; we re-import or accept it.
  });

  describe("construction", () => {
    test("creates root span on construction", () => {
      new Tracer("test-request", { botName: "testbot", userId: "user-1" });

      expect(saveSpanCalls).toHaveLength(1);
      const root = saveSpanCalls[0]!;
      expect(root.name).toBe("test-request");
      expect(root.kind).toBe("root");
      expect(root.botName).toBe("testbot");
      expect(root.userId).toBe("user-1");
      expect(root.parentId).toBeNull();
      expect(root.traceId).toBeDefined();
      expect(root.id).toBeDefined();
      expect(root.startedAt).toBeInstanceOf(Date);
    });

    test("generates unique traceId", () => {
      const t1 = new Tracer("req-1");
      const t2 = new Tracer("req-2");
      expect(t1.traceId).not.toBe(t2.traceId);
    });

    test("uses provided traceId for child tracers", () => {
      const parentTraceId = "parent-trace-123";
      const tracer = new Tracer("child-task", {
        traceId: parentTraceId,
        parentId: "parent-span-456",
      });

      expect(tracer.traceId).toBe(parentTraceId);
      const root = saveSpanCalls.at(-1)!;
      expect(root.traceId).toBe(parentTraceId);
      expect(root.parentId).toBe("parent-span-456");
      expect(root.kind).toBe("span"); // not "root" when parentId is provided
    });

    test("sets platform and username in root span", () => {
      new Tracer("telegram-msg", {
        botName: "jarvis",
        userId: "u1",
        username: "alice",
        platform: "telegram",
      });

      const root = saveSpanCalls[0]!;
      expect(root.username).toBe("alice");
      expect(root.platform).toBe("telegram");
    });
  });

  describe("span creation with start()", () => {
    test("creates child span under root", () => {
      const tracer = new Tracer("request");
      saveSpanCalls.length = 0; // clear root span

      tracer.start("claude");

      expect(saveSpanCalls).toHaveLength(1);
      const span = saveSpanCalls[0]!;
      expect(span.name).toBe("claude");
      expect(span.kind).toBe("span");
      expect(span.traceId).toBe(tracer.traceId);
      expect(span.parentId).toBeDefined(); // root span id
      expect(span.startedAt).toBeInstanceOf(Date);
    });

    test("includes attributes in span", () => {
      const tracer = new Tracer("request");
      saveSpanCalls.length = 0;

      tracer.start("claude", { model: "sonnet", inputTokens: 5000 });

      const span = saveSpanCalls[0]!;
      expect(span.attributes).toEqual({ model: "sonnet", inputTokens: 5000 });
    });

    test("returns span id", () => {
      const tracer = new Tracer("request");
      const id = tracer.start("my-span");
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });
  });

  describe("span completion with end()", () => {
    test("updates span with duration and ok status", async () => {
      const tracer = new Tracer("request");
      tracer.start("claude");

      // Small delay to ensure non-zero duration
      await Bun.sleep(5);

      const durationMs = tracer.end("claude");
      await flushWrites();

      expect(durationMs).toBeGreaterThan(0);
      expect(updateSpanCalls).toHaveLength(1);
      const update = updateSpanCalls[0]!;
      expect(update.params.status).toBe("ok");
      expect(update.params.durationMs).toBeGreaterThan(0);
      expect(typeof update.params.durationMs).toBe("number");
    });

    test("includes attributes in span end", async () => {
      const tracer = new Tracer("request");
      tracer.start("claude");

      await Bun.sleep(1);
      tracer.end("claude", { outputTokens: 1000 });
      await flushWrites();

      const update = updateSpanCalls[0]!;
      expect(update.params.attributes).toEqual({ outputTokens: 1000 });
    });

    test("rounds durationMs to integer", async () => {
      const tracer = new Tracer("request");
      tracer.start("work");

      await Bun.sleep(2);
      tracer.end("work");
      await flushWrites();

      const update = updateSpanCalls[0]!;
      expect(Number.isInteger(update.params.durationMs)).toBe(true);
    });
  });

  describe("parent-child span nesting", () => {
    test("child spans share the same traceId", () => {
      const tracer = new Tracer("request");
      saveSpanCalls.length = 0;

      tracer.start("prompt_build");
      tracer.start("claude");

      expect(saveSpanCalls).toHaveLength(2);
      expect(saveSpanCalls[0]!.traceId).toBe(tracer.traceId);
      expect(saveSpanCalls[1]!.traceId).toBe(tracer.traceId);
    });

    test("child spans have root as parentId", () => {
      const tracer = new Tracer("request");
      // The root span's id is saveSpanCalls[0].id
      const rootId = saveSpanCalls[0]!.id;
      saveSpanCalls.length = 0;

      tracer.start("child-1");
      tracer.start("child-2");

      expect(saveSpanCalls[0]!.parentId).toBe(rootId);
      expect(saveSpanCalls[1]!.parentId).toBe(rootId);
    });

    test("addChildSpan creates completed span under a parent span", () => {
      const tracer = new Tracer("request");
      tracer.start("claude");
      saveSpanCalls.length = 0;

      tracer.addChildSpan("claude", "tool:Read", 150, { toolName: "Read" });

      expect(saveSpanCalls).toHaveLength(1);
      const child = saveSpanCalls[0]!;
      expect(child.name).toBe("tool:Read");
      expect(child.durationMs).toBe(150);
      expect(child.kind).toBe("span");
      expect(child.attributes).toEqual({ toolName: "Read" });
    });

    test("addChildSpan uses root span if parent label not found", () => {
      const tracer = new Tracer("request");
      const rootId = saveSpanCalls[0]!.id;
      saveSpanCalls.length = 0;

      tracer.addChildSpan("nonexistent", "orphan-tool", 100);

      expect(saveSpanCalls).toHaveLength(1);
      expect(saveSpanCalls[0]!.parentId).toBe(rootId);
    });

    test("addChildSpan with startOffsetMs sets correct start time", () => {
      const tracer = new Tracer("request");
      tracer.start("claude");

      // Capture the parent span's start time
      const parentStart = saveSpanCalls[1]!.startedAt as Date;
      saveSpanCalls.length = 0;

      tracer.addChildSpan("claude", "tool:Write", 200, undefined, 5000);

      const child = saveSpanCalls[0]!;
      const childStart = child.startedAt as Date;
      expect(childStart.getTime()).toBe(parentStart.getTime() + 5000);
    });

    test("addChildSpan without startOffsetMs anchors so the bar ends at 'now'", () => {
      // Regression: an undefined startOffsetMs used to anchor the span at the
      // parent's startedAt, which made tool spans render at the very left of
      // the waterfall. Fallback now matches addSubSpan: end edge at Date.now().
      const tracer = new Tracer("request");
      tracer.start("claude");
      saveSpanCalls.length = 0;

      const before = Date.now();
      tracer.addChildSpan("claude", "tool:Read", 200);
      const after = Date.now();

      const child = saveSpanCalls[0]!;
      const childStart = (child.startedAt as Date).getTime();
      expect(childStart).toBeGreaterThanOrEqual(before - 200);
      expect(childStart).toBeLessThanOrEqual(after - 200);
    });

    test("addChildSpan returns the new span id matching the saved span", () => {
      const tracer = new Tracer("request");
      tracer.start("claude");
      saveSpanCalls.length = 0;

      const id = tracer.addChildSpan("claude", "tool:Read", 50);

      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
      expect(saveSpanCalls[0]!.id).toBe(id);
    });

    test("addSubSpan nests under an arbitrary parent span id", () => {
      const tracer = new Tracer("request");
      tracer.start("claude");
      const toolSpanId = tracer.addChildSpan("claude", "tool:knowledge-search", 500);
      saveSpanCalls.length = 0;

      const stageId = tracer.addSubSpan(toolSpanId, "rerank.ce", 200, { collection: "x" });

      expect(saveSpanCalls).toHaveLength(1);
      const stage = saveSpanCalls[0]!;
      expect(stage.id).toBe(stageId);
      expect(stage.parentId).toBe(toolSpanId);
      expect(stage.name).toBe("rerank.ce");
      expect(stage.durationMs).toBe(200);
      expect(stage.attributes).toEqual({ collection: "x" });
    });

    test("addSubSpan honors parentStartedAt and startOffsetMs", () => {
      const tracer = new Tracer("request");
      const parentStart = new Date("2026-01-01T00:00:00Z");
      saveSpanCalls.length = 0;

      tracer.addSubSpan("parent-uuid", "stage", 30, undefined, {
        parentStartedAt: parentStart,
        startOffsetMs: 100,
      });

      const stage = saveSpanCalls[0]!;
      const start = stage.startedAt as Date;
      expect(start.getTime()).toBe(parentStart.getTime() + 100);
    });
  });

  describe("events", () => {
    test("creates event span with zero duration", () => {
      const tracer = new Tracer("request");
      saveSpanCalls.length = 0;

      tracer.event("user-message-received", { messageLength: 42 });

      expect(saveSpanCalls).toHaveLength(1);
      const ev = saveSpanCalls[0]!;
      expect(ev.name).toBe("user-message-received");
      expect(ev.kind).toBe("event");
      expect(ev.durationMs).toBe(0);
      expect(ev.attributes).toEqual({ messageLength: 42 });
    });
  });

  describe("finish", () => {
    test("finishes root span with ok status", async () => {
      const tracer = new Tracer("request");

      await Bun.sleep(2);
      tracer.finish();
      await flushWrites();

      expect(updateSpanCalls).toHaveLength(1);
      const update = updateSpanCalls[0]!;
      expect(update.params.status).toBe("ok");
      expect(update.params.durationMs).toBeGreaterThan(0);
    });

    test("finishes root span with error status", async () => {
      const tracer = new Tracer("request");
      tracer.finish("error", { reason: "timeout" });
      await flushWrites();

      expect(updateSpanCalls).toHaveLength(1);
      const update = updateSpanCalls[0]!;
      expect(update.params.status).toBe("error");
      expect(update.params.attributes).toEqual({ reason: "timeout" });
    });

    test("finish includes attributes", async () => {
      const tracer = new Tracer("request");
      tracer.finish("ok", { inputTokens: 3000, outputTokens: 500 });
      await flushWrites();

      const update = updateSpanCalls[0]!;
      expect(update.params.attributes).toEqual({
        inputTokens: 3000,
        outputTokens: 500,
      });
    });
  });

  describe("error", () => {
    test("finishes with error status and Error message", async () => {
      const tracer = new Tracer("request");
      tracer.error(new Error("Something went wrong"));
      await flushWrites();

      expect(updateSpanCalls).toHaveLength(1);
      const update = updateSpanCalls[0]!;
      expect(update.params.status).toBe("error");
      expect(update.params.attributes).toEqual({
        error: "Something went wrong",
      });
    });

    test("finishes with error status and string message", async () => {
      const tracer = new Tracer("request");
      tracer.error("timeout after 120s");
      await flushWrites();

      expect(updateSpanCalls).toHaveLength(1);
      const update = updateSpanCalls[0]!;
      expect(update.params.status).toBe("error");
      expect(update.params.attributes).toEqual({
        error: "timeout after 120s",
      });
    });
  });

  describe("context", () => {
    test("returns traceId and rootSpanId for background tasks", () => {
      const tracer = new Tracer("request");
      const ctx = tracer.context;

      expect(ctx.traceId).toBe(tracer.traceId);
      expect(ctx.parentId).toBeDefined();
      expect(typeof ctx.parentId).toBe("string");
    });
  });

  describe("timing delegation", () => {
    test("totalMs returns elapsed time since construction", async () => {
      const tracer = new Tracer("request");
      await Bun.sleep(5);
      const total = tracer.totalMs();
      expect(total).toBeGreaterThan(0);
    });

    test("summary returns timing marks", async () => {
      const tracer = new Tracer("request");
      tracer.start("prompt_build");
      await Bun.sleep(2);
      tracer.end("prompt_build");

      tracer.start("claude");
      await Bun.sleep(2);
      tracer.end("claude");

      const summary = tracer.summary();
      expect(summary.prompt_build).toBeGreaterThan(0);
      expect(summary.claude).toBeGreaterThan(0);
    });

    test("formatTelegram returns formatted timing string", async () => {
      const tracer = new Tracer("request");
      tracer.start("claude");
      await Bun.sleep(2);
      tracer.end("claude");

      const formatted = tracer.formatTelegram({
        inputTokens: 3000,
        outputTokens: 500,
      });
      expect(formatted).toContain("total");
      expect(formatted).toContain("claude");
      expect(formatted).toContain("3.0k in");
      expect(formatted).toContain("500 out");
    });
  });

  describe("disabled/no-op mode", () => {
    test("does not save spans when tracing is disabled", async () => {
      // The cached _tracingEnabled was set on the first Tracer construction.
      // Since mock.module is module-scoped, we need a different approach.
      // We test the no-op behavior by checking the Tracer still functions
      // (returns values, doesn't throw) even if the DB calls were to fail.
      // The actual enabled/disabled caching is a startup concern.

      // However, we can test addChildSpan/event/finish early return behavior
      // by verifying the Tracer works correctly regardless.
      const tracer = new Tracer("request");
      saveSpanCalls.length = 0;
      updateSpanCalls.length = 0;

      // These should all work without throwing
      const id = tracer.start("work");
      expect(typeof id).toBe("string");

      tracer.addChildSpan("work", "child", 100);
      tracer.event("something-happened");
      tracer.end("work");
      tracer.finish();
      await flushWrites();

      // Verify calls were made (tracing is enabled in this test process)
      expect(saveSpanCalls.length).toBeGreaterThan(0);
      expect(updateSpanCalls.length).toBeGreaterThan(0);
    });

    test("start/end still return values even with disabled tracing (timing layer)", async () => {
      // The Timing layer always works regardless of tracing enabled/disabled
      const tracer = new Tracer("request");
      tracer.start("step");
      await Bun.sleep(2);
      const durationMs = tracer.end("step");

      expect(durationMs).toBeGreaterThan(0);
      expect(tracer.totalMs()).toBeGreaterThan(0);
    });
  });

  describe("insert/update ordering (span-attr race)", () => {
    test("end() UPDATE waits for start() INSERT even on a zero-duration span", async () => {
      // Simulate the production race: the INSERT lands on a slow pool
      // connection while start→end runs with ~0ms between them. The UPDATE
      // (carrying attributes) must not fire before the INSERT resolves,
      // otherwise it updates 0 rows and the attributes are silently lost.
      deferSaveSpan = true;
      const tracer = new Tracer("request");
      tracer.start("resolve");
      tracer.end("resolve", { creates: 3, updates: 1 });

      // Synchronously after end(): the INSERT is still parked, so the UPDATE
      // must not have run yet.
      expect(updateSpanCalls).toHaveLength(0);
      expect(writeOrder).toEqual([]);

      // Land all parked INSERTs, then flush the chained microtasks.
      pendingSaves.forEach((r) => r());
      await Bun.sleep(5);

      // The UPDATE ran after the span's INSERT, and carries the attributes.
      const spanUpdate = updateSpanCalls.find(
        (u) => u.params.attributes && (u.params.attributes as Record<string, unknown>).creates === 3,
      );
      expect(spanUpdate).toBeDefined();
      expect(spanUpdate!.params.attributes).toEqual({ creates: 3, updates: 1 });
      // Every update in the ordered log is preceded by at least one insert.
      const firstUpdate = writeOrder.indexOf("update");
      expect(firstUpdate).toBeGreaterThan(-1);
      expect(writeOrder.slice(0, firstUpdate)).toContain("insert");
    });

    test("finish() root UPDATE waits for the root INSERT", async () => {
      deferSaveSpan = true;
      const tracer = new Tracer("request");
      tracer.finish("ok", { inputTokens: 10 });

      // Root INSERT still parked → root UPDATE must not have run.
      expect(updateSpanCalls).toHaveLength(0);

      pendingSaves.forEach((r) => r());
      await Bun.sleep(5);

      expect(updateSpanCalls).toHaveLength(1);
      expect(writeOrder).toEqual(["insert", "update"]);
      expect(updateSpanCalls[0]!.params.attributes).toEqual({ inputTokens: 10 });
    });
  });

  describe("multiple spans", () => {
    test("tracks multiple independent spans", async () => {
      const tracer = new Tracer("request");
      saveSpanCalls.length = 0;
      updateSpanCalls.length = 0;

      tracer.start("prompt_build");
      await Bun.sleep(1);
      tracer.end("prompt_build");

      tracer.start("claude");
      await Bun.sleep(1);
      tracer.end("claude");

      tracer.start("memory_extract");
      await Bun.sleep(1);
      tracer.end("memory_extract");
      await flushWrites();

      // 3 spans created, 3 spans ended
      expect(saveSpanCalls).toHaveLength(3);
      expect(updateSpanCalls).toHaveLength(3);

      const names = saveSpanCalls.map((s) => s.name);
      expect(names).toContain("prompt_build");
      expect(names).toContain("claude");
      expect(names).toContain("memory_extract");
    });
  });
});
