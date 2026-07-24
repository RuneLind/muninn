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

    test("pulls connector + model from claude child span", async () => {
      const root = makeRootSpan();
      await saveSpan(root);

      await saveSpan({
        id: crypto.randomUUID(),
        traceId: root.traceId,
        parentId: root.id,
        name: "claude",
        kind: "span" as const,
        startedAt: new Date(),
        attributes: {
          connector: "copilot-sdk",
          requestedModel: "sonnet",
          model: "claude-sonnet-4-6",
          inputTokens: 1000,
          outputTokens: 50,
        },
      });

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.connector).toBe("copilot-sdk");
      expect(found.attributes.requestedModel).toBe("sonnet");
      expect(found.attributes.model).toBe("claude-sonnet-4-6");
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

    test("aggregates watcher child telemetry onto scheduler_tick roots", async () => {
      const root = makeRootSpan({ name: "scheduler_tick", userId: null, username: null, platform: null });
      await saveSpan(root);

      const email = {
        id: crypto.randomUUID(),
        traceId: root.traceId,
        parentId: root.id,
        name: "watcher:email",
        kind: "span" as const,
        startedAt: new Date(),
        attributes: { inputTokens: 95719, outputTokens: 608, model: "claude-haiku-4-5-20251001", connector: "claude-cli" },
      };
      const x = {
        id: crypto.randomUUID(),
        traceId: root.traceId,
        parentId: root.id,
        name: "watcher:x",
        kind: "span" as const,
        startedAt: new Date(),
        attributes: { inputTokens: 1000, outputTokens: 100, model: "claude-haiku-4-5-20251001", connector: "claude-cli" },
      };
      // A tokenless watcher (ran no model) must not affect the aggregate.
      const news = {
        id: crypto.randomUUID(),
        traceId: root.traceId,
        parentId: root.id,
        name: "watcher:news",
        kind: "span" as const,
        startedAt: new Date(),
        attributes: { type: "news" },
      };
      await saveSpan(email);
      await saveSpan(x);
      await saveSpan(news);
      // Tool child spans under the email watcher → tool_count.
      await saveSpan({
        id: crypto.randomUUID(),
        traceId: root.traceId,
        parentId: email.id,
        name: "search_emails (gmail)",
        kind: "span" as const,
        startedAt: new Date(),
        attributes: { toolName: "mcp__gmail__search_emails" },
      });

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.inputTokens).toBe(96719);
      expect(found.attributes.outputTokens).toBe(708);
      expect(found.attributes.model).toBe("claude-haiku-4-5-20251001");
      expect(found.attributes.connector).toBe("claude-cli");
      expect(found.attributes.toolCount).toBe(1);
    });

    test("tick with two watcher models shows 'mixed'", async () => {
      const root = makeRootSpan({ name: "scheduler_tick" });
      await saveSpan(root);
      for (const [type, model] of [["email", "claude-haiku-4-5-20251001"], ["anthropic", "claude-sonnet-4-6"]] as const) {
        await saveSpan({
          id: crypto.randomUUID(),
          traceId: root.traceId,
          parentId: root.id,
          name: `watcher:${type}`,
          kind: "span" as const,
          startedAt: new Date(),
          attributes: { inputTokens: 10, outputTokens: 1, model, connector: "claude-cli" },
        });
      }

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.model).toBe("mixed");
      expect(found.attributes.connector).toBe("claude-cli");
    });

    test("two watchers with different models ⇒ mixed + SUMMED tokens (regression: a single-watcher fixture can coincidentally match w)", async () => {
      const root = makeRootSpan({ name: "scheduler_tick" });
      await saveSpan(root);
      const models = [
        ["email", "claude-haiku-4-5-20251001", 95719, 608],
        ["anthropic", "claude-sonnet-4-6", 1281, 92],
      ] as const;
      for (const [type, model, inputTokens, outputTokens] of models) {
        await saveSpan({
          id: crypto.randomUUID(),
          traceId: root.traceId,
          parentId: root.id,
          name: `watcher:${type}`,
          kind: "span" as const,
          startedAt: new Date(),
          attributes: { inputTokens, outputTokens, model, connector: "claude-cli" },
        });
      }

      const traces = await getRecentTraces(10);
      const found = traces.find((t) => t.id === root.id)!;
      // Summed across both watchers — NOT a single watcher's value.
      expect(found.attributes.inputTokens).toBe(95719 + 1281);
      expect(found.attributes.outputTokens).toBe(608 + 92);
      expect(found.attributes.model).toBe("mixed");
      expect(found.attributes.connector).toBe("claude-cli");
    });
  });

  // ── Rec 1: the walk aggregate (the deterministic connector/model-bearing
  // fallback for trace shapes the `c` fast path and `w` watcher aggregate miss) ──
  describe("walk aggregate (connector-bearing / model-only fallback)", () => {
    test("factcheck-shaped trace: claim-0 + claim-1 + compose summed; connector-less extract span excluded from mixed-collapse AND the token sum", async () => {
      const root = makeRootSpan({ name: "factcheck", userId: null, username: null, platform: null });
      await saveSpan(root);

      // Two indexed claim spans + a compose span, all on the SAME connector/model.
      // Named claude:claim-<i>/compose (NOT "claude"), so they deliberately fall
      // THROUGH the `c` fast path (name='claude' LIMIT 1) to the walk's summing.
      const claim0 = {
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "claude:claim-0", kind: "span" as const, startedAt: new Date(),
        // requestedModel mirrors the seam's start stamp (every claim span now carries it).
        attributes: { connector: "claude-sdk", requestedModel: "sonnet", model: "claude-sonnet-4-6", inputTokens: 1000, outputTokens: 50 },
      };
      await saveSpan(claim0);
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "claude:claim-1", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", requestedModel: "sonnet", model: "claude-sonnet-4-6", inputTokens: 2000, outputTokens: 80 },
      });
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "compose", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", requestedModel: "sonnet", model: "claude-sonnet-4-6", inputTokens: 500, outputTokens: 20 },
      });
      // The Haiku extract span carries a MODEL but no CONNECTOR (it runs through
      // the Haiku router, not the bot connector) — it must be excluded from the
      // connector-set's mixed-collapse and token sum. The router backend is
      // stamped under `haikuBackend` (NOT `connector`) precisely so it stays
      // invisible to the walk's connector collapse (see factcheck-sse.ts).
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "extract", kind: "span" as const, startedAt: new Date(),
        attributes: { model: "claude-haiku-4-5-20251001", haikuBackend: "cli", inputTokens: 9999, outputTokens: 999 },
      });
      // A WebFetch tool child span under a claim → depth-agnostic tool_count.
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: claim0.id,
        name: "WebFetch", kind: "span" as const, startedAt: new Date(),
        attributes: { toolName: "WebFetch" },
      });

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      // Extract's 9999/999 EXCLUDED — only the three connector-bearing spans sum.
      expect(found.attributes.inputTokens).toBe(1000 + 2000 + 500);
      expect(found.attributes.outputTokens).toBe(50 + 80 + 20);
      // Single connector-bearing model despite the extract span's different model.
      expect(found.attributes.model).toBe("claude-sonnet-4-6");
      // Gate (c): the extract span's `haikuBackend` attr does NOT participate in
      // the connector collapse, so the row stays the verify connector — never
      // flipped to 'mixed' by the router backend.
      expect(found.attributes.connector).toBe("claude-sdk");
      expect(found.attributes.connector).not.toBe("mixed");
      expect(found.attributes.toolCount).toBe(1);
    });

    test("factcheck-shaped trace with an ERRORED claim: the errored span (connector + requestedModel, NO model) does NOT flip the row to 'mixed'; tokens sum over the connector-bearing set", async () => {
      // Regression for the seam's central fix: a claim span stamps `requestedModel`
      // (an ALIAS) at START but only stamps the resolved `model` at successful END.
      // When the claim ERRORS, the span carries connector + requestedModel + error
      // but NO `model` — so it contributes nothing to the walk's DISTINCT-model
      // collapse (the row reports the single resolved model, never 'mixed') and its
      // (absent) tokens drop out of the connector-bearing sum. Before the fix the
      // errored span retained the model alias and flipped the row to 'mixed'.
      const root = makeRootSpan({ name: "factcheck", userId: null, username: null, platform: null });
      await saveSpan(root);

      // claim-0 succeeded — resolved model + tokens.
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "claude:claim-0", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", requestedModel: "sonnet", model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 50 },
      });
      // claim-1 ERRORED — start stamp only (connector + requestedModel alias + error),
      // NO resolved `model`, NO tokens.
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "claude:claim-1", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", requestedModel: "sonnet", error: "verify call failed" },
      });
      // compose succeeded — same resolved model.
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "compose", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", requestedModel: "sonnet", model: "claude-sonnet-5", inputTokens: 500, outputTokens: 20 },
      });

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      // Single resolved model despite the errored claim — NOT 'mixed'.
      expect(found.attributes.model).toBe("claude-sonnet-5");
      expect(found.attributes.connector).toBe("claude-sdk");
      // Tokens sum over the connector-bearing set; the errored span carries no
      // tokens and so contributes 0 (claim-0 + compose only).
      expect(found.attributes.inputTokens).toBe(1000 + 500);
      expect(found.attributes.outputTokens).toBe(50 + 20);
    });

    test("task:briefing-shaped nested trace: reads the nested `claude` child, NOT the token-duplicating parent task span (no double count)", async () => {
      // scheduler_tick → task:briefing → claude (nested; `c` only reads a DIRECT
      // root child named 'claude'). The task span carries the SAME tokens as its
      // claude child but NO connector, so it is excluded from the connector-set
      // — proving the walk sums connector-bearing spans only (no double count).
      const root = makeRootSpan({ name: "scheduler_tick", userId: null, username: null, platform: null });
      await saveSpan(root);
      const taskSpan = {
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "task:briefing", kind: "span" as const, startedAt: new Date(),
        attributes: { model: "claude-sonnet-4-6", inputTokens: 5000, outputTokens: 300 },
      };
      await saveSpan(taskSpan);
      const claudeChild = {
        id: crypto.randomUUID(), traceId: root.traceId, parentId: taskSpan.id,
        name: "claude", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", model: "claude-sonnet-4-6", inputTokens: 5000, outputTokens: 300 },
      };
      await saveSpan(claudeChild);
      for (let i = 0; i < 2; i++) {
        await saveSpan({
          id: crypto.randomUUID(), traceId: root.traceId, parentId: claudeChild.id,
          name: `tool-${i}`, kind: "span" as const, startedAt: new Date(),
          attributes: { toolName: `mcp__x__t${i}` },
        });
      }

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.inputTokens).toBe(5000); // NOT 10000
      expect(found.attributes.outputTokens).toBe(300);
      expect(found.attributes.model).toBe("claude-sonnet-4-6");
      expect(found.attributes.connector).toBe("claude-sdk");
      expect(found.attributes.toolCount).toBe(2);
    });

    test("reminder-shaped trace: task span carries its own connector/model/tokens (spawnHaiku, no `claude` child)", async () => {
      const root = makeRootSpan({ name: "scheduler_tick", userId: null, username: null, platform: null });
      await saveSpan(root);
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "task:reminder", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-cli", model: "claude-haiku-4-5-20251001", inputTokens: 800, outputTokens: 40 },
      });

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.inputTokens).toBe(800);
      expect(found.attributes.outputTokens).toBe(40);
      expect(found.attributes.model).toBe("claude-haiku-4-5-20251001");
      expect(found.attributes.connector).toBe("claude-cli");
    });

    test("model-only fallback: a span carrying a model but no connector reports the model with a NULL connector (honest, no fabrication)", async () => {
      const root = makeRootSpan({ name: "interest_profile", userId: null, username: null, platform: null });
      await saveSpan(root);
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "generate", kind: "span" as const, startedAt: new Date(),
        attributes: { model: "claude-haiku-4-5-20251001", inputTokens: 1200, outputTokens: 90 },
      });

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.model).toBe("claude-haiku-4-5-20251001");
      expect(found.attributes.inputTokens).toBe(1200);
      expect(found.attributes.outputTokens).toBe(90);
      // Connector truly absent — never fabricated.
      expect(found.attributes.connector).toBeUndefined();
    });

    test("chat-shaped trace (direct `claude` child) is unchanged by the walk: c fast path still wins", async () => {
      const root = makeRootSpan({ name: "telegram_text" });
      await saveSpan(root);
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "claude", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", model: "claude-sonnet-4-6", requestedModel: "sonnet", inputTokens: 42000, outputTokens: 700, toolCount: 0 },
      });

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.inputTokens).toBe(42000);
      expect(found.attributes.outputTokens).toBe(700);
      expect(found.attributes.model).toBe("claude-sonnet-4-6");
      expect(found.attributes.requestedModel).toBe("sonnet");
      expect(found.attributes.connector).toBe("claude-sdk");
    });

    test("goal-run root (Rec 5): connector + model stamped on the root's OWN attrs render non-blank (mapRow root precedence, no `claude` child, no walk)", async () => {
      // A goal_reminder/goal_checkin trace is a bare root — `callHaiku` → spawnHaiku
      // runs no tools and stamps no `claude` model span, so the honest backend +
      // model ride on the root's own attrs (goalRunMeta). No child spans ⇒ c/w/walk
      // all miss; the row must still show connector 'claude-cli' + the model.
      const root = makeRootSpan({ name: "goal_reminder", platform: "telegram" });
      await saveSpan(root);
      await updateSpan(root.id, {
        attributes: {
          connector: "claude-cli",
          model: "claude-haiku-4-5-20251001",
          inputTokens: 640,
          outputTokens: 55,
        },
      });

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      expect(found.attributes.connector).toBe("claude-cli");
      expect(found.attributes.model).toBe("claude-haiku-4-5-20251001");
      expect(found.attributes.inputTokens).toBe(640);
      expect(found.attributes.outputTokens).toBe(55);
    });

    test("chat trace with co-resident extractor spans (Rec 4): a DISTINCT extractor `connector` does NOT flip the chat row to 'mixed' — the `c` fast path wins", async () => {
      // Rec 4 stamps the Haiku router backend as `connector` (cli/anthropic/
      // copilot) on the memory/goal/schedule extractor spans, which run as DIRECT
      // children of the chat root, sibling to the chat's own `claude` span. The
      // walk would collapse the two distinct connectors to 'mixed', but the chat
      // root is served by the `c` fast path (direct `claude` child), so the row
      // stays the chat connector + tokens — proving the extractor stamp is safe.
      const root = makeRootSpan({ name: "telegram_message" });
      await saveSpan(root);
      await saveSpan({
        id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
        name: "claude", kind: "span" as const, startedAt: new Date(),
        attributes: { connector: "claude-sdk", model: "claude-sonnet-4-6", requestedModel: "sonnet", inputTokens: 30000, outputTokens: 500 },
      });
      // Three extractor siblings on a DIFFERENT (Haiku-router) connector.
      for (const spanName of ["memory_extraction", "goal_detection", "schedule_detection"]) {
        await saveSpan({
          id: crypto.randomUUID(), traceId: root.traceId, parentId: root.id,
          name: spanName, kind: "span" as const, startedAt: new Date(),
          attributes: { connector: "cli", model: "claude-haiku-4-5-20251001", inputTokens: 800, outputTokens: 40 },
        });
      }

      const traces = await getRecentTraces(20);
      const found = traces.find((t) => t.id === root.id)!;
      // The chat `claude` child wins — NOT 'mixed', and the chat's own tokens/model.
      expect(found.attributes.connector).toBe("claude-sdk");
      expect(found.attributes.connector).not.toBe("mixed");
      expect(found.attributes.model).toBe("claude-sonnet-4-6");
      expect(found.attributes.inputTokens).toBe(30000);
      expect(found.attributes.outputTokens).toBe(500);
    });
  });

  describe("mapRow attribute guard", () => {
    test("non-object attributes (null / string / array) collapse to empty object", async () => {
      // Producer code can't write these shapes today, but a hand-INSERTed row
      // shouldn't poison the type contract for callers.
      const { getDb } = await import("./client.ts");
      const sql = getDb();
      const traceId = crypto.randomUUID();
      const ids = { nul: crypto.randomUUID(), str: crypto.randomUUID(), arr: crypto.randomUUID() };

      await sql`INSERT INTO traces (id, trace_id, name, kind, started_at, attributes) VALUES (${ids.nul}, ${traceId}, 'nul', 'root', now(), null)`;
      await sql`INSERT INTO traces (id, trace_id, name, kind, started_at, attributes) VALUES (${ids.str}, ${traceId}, 'str', 'root', now(), '"hi"'::jsonb)`;
      await sql`INSERT INTO traces (id, trace_id, name, kind, started_at, attributes) VALUES (${ids.arr}, ${traceId}, 'arr', 'root', now(), '[1,2]'::jsonb)`;

      const spans = await getTrace(traceId);
      for (const s of spans) {
        expect(typeof s.attributes).toBe("object");
        expect(Array.isArray(s.attributes)).toBe(false);
        expect(s.attributes).not.toBeNull();
      }
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
      await saveSpan(makeRootSpan({ botName: "jira-assistant", name: "slack_message" }));
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
      expect(options.bots.sort()).toEqual(["jarvis", "jira-assistant"]);
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
