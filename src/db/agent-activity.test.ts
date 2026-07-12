import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { saveSpan } from "./traces.ts";
import { getRecentAgentTraces, getRecentExtractorUsage } from "./agent-activity.ts";
import { getDb } from "./client.ts";

setupTestDb();

/** A root chat span (`<platform>_message`). */
function chatRoot(name: string, over: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    name,
    kind: "root" as const,
    botName: "testbot",
    startedAt: new Date(),
    durationMs: 1200,
    ...over,
  };
}

/** A watcher child span (`watcher:<type>`) under a scheduler_tick root. */
function watcherChild(type: string, attributes: Record<string, unknown> = {}) {
  const traceId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    traceId,
    parentId: crypto.randomUUID(),
    name: `watcher:${type}`,
    kind: "span" as const,
    botName: "testbot",
    startedAt: new Date(),
    durationMs: 800,
    attributes,
  };
}

describe("getRecentAgentTraces", () => {
  test("returns chat roots and watcher child spans, keyed by name", async () => {
    const chat = chatRoot("telegram_message");
    const voice = chatRoot("telegram_voice");
    const wat = watcherChild("email", { type: "email", alertsFound: 2 });
    await saveSpan(chat);
    await saveSpan(voice);
    await saveSpan(wat);

    const rows = await getRecentAgentTraces(100);
    const names = rows.map((r) => r.name);
    expect(names).toContain("telegram_message");
    expect(names).toContain("telegram_voice");
    expect(names).toContain("watcher:email");
  });

  test("excludes no-op skip spans (quiet-hours + in-flight guard)", async () => {
    const quiet = watcherChild("email", { type: "email", quietHoursSkipped: true });
    const inflight = watcherChild("x", { type: "x", skippedInFlight: true });
    const real = watcherChild("anthropic", { type: "anthropic", alertsFound: 1 });
    await saveSpan(quiet);
    await saveSpan(inflight);
    await saveSpan(real);

    const rows = await getRecentAgentTraces(200);
    const ids = new Set(rows.map((r) => r.traceId));
    expect(ids.has(quiet.traceId)).toBe(false);
    expect(ids.has(inflight.traceId)).toBe(false);
    expect(ids.has(real.traceId)).toBe(true);
  });

  test("surfaces token totals off a chat root's own attributes (message-processor t.finish stamp)", async () => {
    const chat = chatRoot("telegram_message", { attributes: { inputTokens: 25111, outputTokens: 22 } });
    await saveSpan(chat);

    const rows = await getRecentAgentTraces(400);
    const row = rows.find((r) => r.traceId === chat.traceId)!;
    expect(row).toBeTruthy();
    expect(row.inputTokens).toBe(25111);
    expect(row.outputTokens).toBe(22);
  });

  test("surfaces token totals + model off the watcher span's own attributes", async () => {
    const wat = watcherChild("email", { type: "email", model: "claude-haiku-4-5", inputTokens: 227000, outputTokens: 512 });
    await saveSpan(wat);

    const rows = await getRecentAgentTraces(400);
    const row = rows.find((r) => r.traceId === wat.traceId)!;
    expect(row).toBeTruthy();
    expect(row.inputTokens).toBe(227000);
    expect(row.outputTokens).toBe(512);
    expect(row.model).toBe("claude-haiku-4-5");
  });

  test("does NOT return non-chat root spans or generic child spans", async () => {
    // A scheduler_tick root + an aggregate scheduled_tasks span must not appear.
    const tick = chatRoot("scheduler_tick");
    const agg = { ...chatRoot("scheduled_tasks"), parentId: crypto.randomUUID(), kind: "span" as const };
    await saveSpan(tick);
    await saveSpan(agg);

    const rows = await getRecentAgentTraces(300);
    const ids = new Set(rows.map((r) => r.traceId));
    expect(ids.has(tick.traceId)).toBe(false);
    expect(ids.has(agg.traceId)).toBe(false);
  });
});

describe("getRecentExtractorUsage", () => {
  test("returns only memory/goals/schedule sources with tokens + model", async () => {
    const sql = getDb();
    await sql`INSERT INTO haiku_usage (source, model, bot_name, input_tokens, output_tokens)
              VALUES ('memory', 'claude-haiku-4-5', 'testbot', 30, 12)`;
    await sql`INSERT INTO haiku_usage (source, model, bot_name, input_tokens, output_tokens)
              VALUES ('briefing', 'claude-haiku-4-5', 'testbot', 99, 40)`;

    const rows = await getRecentExtractorUsage(200);
    const mem = rows.find((r) => r.source === "memory" && r.botName === "testbot");
    expect(mem).toBeTruthy();
    expect(mem!.inputTokens).toBe(30);
    expect(mem!.model).toBe("claude-haiku-4-5");
    // 'briefing' is a task source, not an extractor — excluded.
    expect(rows.some((r) => r.source === "briefing")).toBe(false);
  });

  test("includes wiki_gardener_* sources but excludes task/watcher sources", async () => {
    const sql = getDb();
    await sql`INSERT INTO haiku_usage (source, model, bot_name, input_tokens, output_tokens)
              VALUES ('wiki_gardener_draft', 'claude-sonnet-5', 'gardenbot', 4200, 1800)`;
    await sql`INSERT INTO haiku_usage (source, model, bot_name, input_tokens, output_tokens)
              VALUES ('wiki_gardener_cluster', 'claude-haiku-4-5', 'gardenbot', 900, 120)`;
    await sql`INSERT INTO haiku_usage (source, model, bot_name, input_tokens, output_tokens)
              VALUES ('watcher-email', 'claude-haiku-4-5', 'gardenbot', 5000, 40)`;

    const rows = await getRecentExtractorUsage(400);
    const draft = rows.find((r) => r.source === "wiki_gardener_draft" && r.botName === "gardenbot");
    expect(draft).toBeTruthy();
    expect(draft!.inputTokens).toBe(4200);
    expect(rows.some((r) => r.source === "wiki_gardener_cluster")).toBe(true);
    // watcher-* tokens surface via the trace path, NOT here (would double a Recent row).
    expect(rows.some((r) => r.source === "watcher-email")).toBe(false);
  });
});
