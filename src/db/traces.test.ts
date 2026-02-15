import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import {
  saveSpan,
  updateSpan,
  getRecentTraces,
  getTrace,
  getTraceFilterOptions,
  cleanupOldTraces,
} from "./traces.ts";

setupTestDb();

function makeRootSpan(overrides: Record<string, unknown> = {}) {
  const traceId = crypto.randomUUID();
  const id = crypto.randomUUID();
  return {
    id,
    traceId,
    name: "telegram_text",
    kind: "root" as const,
    botName: "testbot",
    userId: "user-1",
    username: "testuser",
    platform: "telegram",
    startedAt: new Date(),
    ...overrides,
  };
}

describe("traces", () => {
  describe("saveSpan + getRecentTraces", () => {
    test("saves and retrieves a root span", async () => {
      const span = makeRootSpan();
      await saveSpan(span);

      const traces = await getRecentTraces(10);
      expect(traces.length).toBeGreaterThanOrEqual(1);
      const found = traces.find((t) => t.id === span.id)!;
      expect(found).toBeTruthy();
      expect(found.traceId).toBe(span.traceId);
      expect(found.name).toBe("telegram_text");
      expect(found.botName).toBe("testbot");
      expect(found.kind).toBe("root");
      expect(found.status).toBe("ok");
    });

    test("saves span with object attributes via sql.json", async () => {
      const span = makeRootSpan({
        attributes: { inputTokens: 5000, outputTokens: 200, model: "sonnet" },
      });
      await saveSpan(span);

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === span.id)!;
      expect(found.attributes.inputTokens).toBe(5000);
      expect(found.attributes.outputTokens).toBe(200);
      expect(found.attributes.model).toBe("sonnet");
    });

    test("filters by botName", async () => {
      await saveSpan(makeRootSpan({ botName: "bot-a" }));
      await saveSpan(makeRootSpan({ botName: "bot-b" }));

      const traces = await getRecentTraces(10, 0, "bot-a");
      expect(traces).toHaveLength(1);
      expect(traces[0]!.botName).toBe("bot-a");
    });

    test("filters by name", async () => {
      await saveSpan(makeRootSpan({ name: "telegram_text" }));
      await saveSpan(makeRootSpan({ name: "slack_message" }));

      const traces = await getRecentTraces(10, 0, undefined, "slack_message");
      expect(traces).toHaveLength(1);
      expect(traces[0]!.name).toBe("slack_message");
    });

    test("respects limit and offset", async () => {
      for (let i = 0; i < 5; i++) {
        await saveSpan(makeRootSpan({ startedAt: new Date(Date.now() + i * 1000) }));
      }

      const page1 = await getRecentTraces(2, 0);
      expect(page1).toHaveLength(2);

      const page2 = await getRecentTraces(2, 2);
      expect(page2).toHaveLength(2);

      // No overlap
      expect(page1[0]!.id).not.toBe(page2[0]!.id);
    });
  });

  describe("updateSpan", () => {
    test("updates duration and status", async () => {
      const span = makeRootSpan();
      await saveSpan(span);

      await updateSpan(span.id, { durationMs: 1500, status: "error" });

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === span.id)!;
      expect(found.durationMs).toBe(1500);
      expect(found.status).toBe("error");
    });

    test("merges attributes into existing", async () => {
      const span = makeRootSpan({
        attributes: { initial: true },
      });
      await saveSpan(span);

      await updateSpan(span.id, {
        attributes: { inputTokens: 3000, outputTokens: 100 },
      });

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === span.id)!;
      expect(found.attributes.initial).toBe(true);
      expect(found.attributes.inputTokens).toBe(3000);
      expect(found.attributes.outputTokens).toBe(100);
    });

    test("preserves attributes when none provided", async () => {
      const span = makeRootSpan({
        attributes: { keep: "me" },
      });
      await saveSpan(span);

      await updateSpan(span.id, { durationMs: 500 });

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === span.id)!;
      expect(found.attributes.keep).toBe("me");
    });
  });

  describe("LATERAL JOIN token extraction", () => {
    test("pulls tokens from child claude span with object attributes", async () => {
      const root = makeRootSpan();
      await saveSpan(root);

      // Child claude span with object attributes (post-fix format)
      await saveSpan({
        id: crypto.randomUUID(),
        traceId: root.traceId,
        parentId: root.id,
        name: "claude",
        kind: "span" as const,
        startedAt: new Date(),
        attributes: { inputTokens: 50000, outputTokens: 800, model: "sonnet" },
      });

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.inputTokens).toBe(50000);
      expect(found.attributes.outputTokens).toBe(800);
    });

    test("returns null tokens when no claude child span exists", async () => {
      const root = makeRootSpan();
      await saveSpan(root);

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === root.id)!;
      // No inputTokens/outputTokens since there's no claude child
      expect(found.attributes.inputTokens).toBeUndefined();
      expect(found.attributes.outputTokens).toBeUndefined();
    });

    test("root span tokens take precedence over LATERAL JOIN", async () => {
      const root = makeRootSpan();
      await saveSpan(root);

      // Root span already has tokens (from t.finish("ok", { inputTokens, outputTokens }))
      await updateSpan(root.id, {
        attributes: { inputTokens: 99999, outputTokens: 999 },
      });

      // Child claude span has different token values
      await saveSpan({
        id: crypto.randomUUID(),
        traceId: root.traceId,
        parentId: root.id,
        name: "claude",
        kind: "span" as const,
        startedAt: new Date(),
        attributes: { inputTokens: 50000, outputTokens: 800 },
      });

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === root.id)!;
      // Root's own tokens should win
      expect(found.attributes.inputTokens).toBe(99999);
      expect(found.attributes.outputTokens).toBe(999);
    });
  });

  describe("mapRow legacy attribute normalization", () => {
    test("handles double-encoded string attributes", async () => {
      const { getDb } = await import("./client.ts");
      const sql = getDb();
      const id = crypto.randomUUID();
      const traceId = crypto.randomUUID();

      // Simulate legacy bug: attributes stored as JSON string (double-encoded)
      // In JSONB, '"{}"' is a valid jsonb value of type 'string' containing the text "{}"
      await sql`
        INSERT INTO traces (id, trace_id, name, kind, started_at, attributes)
        VALUES (${id}, ${traceId}, 'legacy_string', 'root', now(), '"{}"'::jsonb)
      `;

      const traces = await getRecentTraces(50);
      const found = traces.find((t) => t.id === id)!;
      expect(found).toBeTruthy();
      // Double-encoded "{}" should be normalized to empty object
      expect(typeof found.attributes).toBe("object");
      expect(Array.isArray(found.attributes)).toBe(false);
    });

    test("handles legacy array-of-strings attributes", async () => {
      const { getDb } = await import("./client.ts");
      const sql = getDb();
      const rootId = crypto.randomUUID();
      const traceId = crypto.randomUUID();

      // Simulate legacy bug: attributes stored as array of JSON strings
      // This happened when saveSpan used JSON.stringify (stored as string "{}"),
      // then updateSpan did `attributes || new_attrs` (Postgres wraps string+object into array)
      await sql`
        INSERT INTO traces (id, trace_id, name, kind, parent_id, started_at, attributes)
        VALUES (${rootId}, ${traceId}, 'claude', 'span', ${crypto.randomUUID()}, now(),
                ${sql.json(["{}",  '{"inputTokens":31849,"outputTokens":258}'])}
        )
      `;

      const spans = await getTrace(traceId);
      const found = spans.find((s) => s.id === rootId)!;
      expect(found).toBeTruthy();
      expect(found.attributes.inputTokens).toBe(31849);
      expect(found.attributes.outputTokens).toBe(258);
    });

    test("handles null attributes gracefully", async () => {
      const { getDb } = await import("./client.ts");
      const sql = getDb();
      const id = crypto.randomUUID();
      const traceId = crypto.randomUUID();

      await sql`
        INSERT INTO traces (id, trace_id, name, kind, started_at, attributes)
        VALUES (${id}, ${traceId}, 'null_attrs', 'root', now(), null)
      `;

      const traces = await getRecentTraces(50);
      const found = traces.find((t) => t.id === id)!;
      expect(found).toBeTruthy();
      expect(typeof found.attributes).toBe("object");
    });
  });

  describe("getTrace", () => {
    test("returns all spans for a trace in order", async () => {
      const root = makeRootSpan();
      await saveSpan(root);

      const childId = crypto.randomUUID();
      await saveSpan({
        id: childId,
        traceId: root.traceId,
        parentId: root.id,
        name: "claude",
        kind: "span" as const,
        startedAt: new Date(Date.now() + 100),
      });

      const eventId = crypto.randomUUID();
      await saveSpan({
        id: eventId,
        traceId: root.traceId,
        parentId: root.id,
        name: "telegram_send",
        kind: "event" as const,
        startedAt: new Date(Date.now() + 200),
      });

      const spans = await getTrace(root.traceId);
      expect(spans).toHaveLength(3);
      expect(spans[0]!.id).toBe(root.id);
      expect(spans[1]!.id).toBe(childId);
      expect(spans[2]!.id).toBe(eventId);
    });
  });

  describe("getTraceFilterOptions", () => {
    test("returns distinct bot names and trace types", async () => {
      await saveSpan(makeRootSpan({ botName: "jarvis", name: "telegram_text" }));
      await saveSpan(makeRootSpan({ botName: "capra", name: "slack_message" }));
      await saveSpan(makeRootSpan({ botName: "jarvis", name: "telegram_text" })); // duplicate

      // Child span — should not appear in types (parent_id IS NULL filter)
      await saveSpan({
        id: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        parentId: crypto.randomUUID(),
        name: "claude",
        kind: "span" as const,
        startedAt: new Date(),
        botName: "jarvis",
      });

      const options = await getTraceFilterOptions();
      expect(options.bots.sort()).toEqual(["capra", "jarvis"]);
      expect(options.types.sort()).toEqual(["slack_message", "telegram_text"]);
    });

    test("excludes null bot names", async () => {
      await saveSpan(makeRootSpan({ botName: null, name: "scheduler_tick" }));
      await saveSpan(makeRootSpan({ botName: "jarvis", name: "telegram_text" }));

      const options = await getTraceFilterOptions();
      expect(options.bots).toEqual(["jarvis"]);
      expect(options.types.sort()).toEqual(["scheduler_tick", "telegram_text"]);
    });

    test("returns empty arrays when no traces exist", async () => {
      const options = await getTraceFilterOptions();
      expect(options.bots).toEqual([]);
      expect(options.types).toEqual([]);
    });
  });

  describe("cleanupOldTraces", () => {
    test("deletes traces older than retention period", async () => {
      const { getDb } = await import("./client.ts");
      const sql = getDb();

      // Insert an old trace
      const oldId = crypto.randomUUID();
      await sql`
        INSERT INTO traces (id, trace_id, name, kind, started_at, created_at)
        VALUES (${oldId}, ${crypto.randomUUID()}, 'old', 'root', now() - interval '30 days', now() - interval '30 days')
      `;

      // Insert a recent trace
      const newSpan = makeRootSpan();
      await saveSpan(newSpan);

      const deleted = await cleanupOldTraces(7);
      expect(deleted).toBe(1);

      const remaining = await getRecentTraces(50);
      expect(remaining.find((t) => t.id === oldId)).toBeUndefined();
      expect(remaining.find((t) => t.id === newSpan.id)).toBeTruthy();
    });
  });
});
