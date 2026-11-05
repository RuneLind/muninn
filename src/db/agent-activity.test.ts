import { test, expect, describe } from "bun:test";
import { setupTestDb } from "../test/setup-db.ts";
import { saveSpan } from "./traces.ts";
import { getRecentAgentRuns, getRecentAgentTraces, getRecentExtractorUsage } from "./agent-activity.ts";
import { getDb } from "./client.ts";
import { Tracer } from "../tracing/tracer.ts";
import { createJobStore } from "../summaries/job-store.ts";
import { finishAgentRunTrace } from "../tracing/agent-run-trace.ts";

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

  test("does NOT return task:% spans — getRecentAgentRuns reads those (never both)", async () => {
    // /agents Recent sources scheduled_task rows from the registry ring; a
    // task:<type> span surfacing here too would double-count the same run.
    const tick = chatRoot("scheduler_tick");
    const task = { ...chatRoot("task:briefing"), parentId: tick.id, kind: "span" as const, traceId: tick.traceId };
    await saveSpan(tick);
    await saveSpan(task);

    const rows = await getRecentAgentTraces(300);
    expect(rows.some((r) => r.name.startsWith("task:"))).toBe(false);
    expect(rows.some((r) => r.traceId === tick.traceId)).toBe(false);
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

describe("a stamped span on real Postgres", () => {
  async function rootRow(traceId: string) {
    const sql = getDb();
    for (let i = 0; i < 50; i++) {
      const [row] = await sql`SELECT duration_ms, attributes FROM traces WHERE trace_id = ${traceId} AND duration_ms IS NOT NULL`;
      if (row) return row;
      await Bun.sleep(20);
    }
    return null;
  }

  test("a run name with a lone surrogate and a NUL does not lose the finish", async () => {
    // jsonb refuses both, and the failed UPDATE reaches only a log line: the root
    // would stay unfinished on /traces and carry no stamp.
    const tracer = new Tracer("capture:youtube", { botName: "testbot" });
    finishAgentRunTrace(tracer, { kind: "capture", name: "YouTube: a\ud83d\u0000b" }, "ok", { inputTokens: 3 });
    const row = await rootRow(tracer.traceId);
    expect(row).not.toBeNull();
    expect(row!.attributes).toMatchObject({ agentKind: "capture", agentName: "YouTube: a\ufffdb", inputTokens: 3 });
  });

  test("free text anywhere in a span's attributes cannot lose the write", async () => {
    // A connector's error is a bare `slice` of an upstream body, so the same
    // refusal reached a failed run's finish through `error`.
    const tracer = new Tracer("draft:source", { botName: "testbot" });
    tracer.start("claude", { title: "a\ud83d\u0000\u0000b" });
    tracer.end("claude", { error: "c\udc00d", nested: { list: ["e\u0000", 1, null] } }, "error");
    finishAgentRunTrace(tracer, { kind: "capture", name: "two\u0000nuls\u0000" }, "error", { error: "f\ud83dg" });
    const sql = getDb();
    let rows: { name: string; duration_ms: number | null; attributes: Record<string, unknown> }[] = [];
    for (let i = 0; i < 50; i++) {
      rows = (await sql`SELECT name, duration_ms, attributes FROM traces WHERE trace_id = ${tracer.traceId}`) as never;
      if (rows.length === 2 && rows.every((r) => r.duration_ms !== null)) break;
      await Bun.sleep(20);
    }
    const claude = rows.find((r) => r.name === "claude")!;
    const root = rows.find((r) => r.name === "draft:source")!;
    expect(claude.duration_ms).not.toBeNull();
    expect(claude.attributes).toMatchObject({
      title: "a\ufffdb",
      error: "c\ufffdd",
      nested: { list: ["e", 1, null] },
    });
    expect(root.duration_ms).not.toBeNull();
    expect(root.attributes).toMatchObject({ agentName: "twonuls", error: "f\ufffdg" });
  });
});

describe("getRecentAgentRuns", () => {
  /** Every suite shares the table, so read one bot's rows. */
  const runsOf = async (bot: string, windowHours?: number) =>
    (await getRecentAgentRuns(100_000, windowHours)).filter((r) => r.botName === bot);

  function span(bot: string, attributes: Record<string, unknown>, over: Record<string, unknown> = {}) {
    return saveSpan({
      id: crypto.randomUUID(),
      traceId: crypto.randomUUID(),
      name: "wiki_digest",
      kind: "root" as const,
      botName: bot,
      startedAt: new Date(),
      durationMs: 900,
      attributes,
      ...over,
    });
  }

  async function spanFailed(bot: string, attributes: Record<string, unknown>, startedAt: Date) {
    const id = crypto.randomUUID();
    await span(bot, attributes, { id, startedAt });
    await getDb()`UPDATE traces SET status = 'error' WHERE id = ${id}`;
  }

  test("reads what finishAgentRunTrace wrote, through a real Tracer", async () => {
    const bot = `runs-${crypto.randomUUID()}`;
    const tracer = new Tracer("capture:youtube", { botName: bot });
    finishAgentRunTrace(tracer, { kind: "capture", name: "YouTube: a talk" }, "error", {
      model: "m",
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 0,
      error: "boom",
    });
    let rows: Awaited<ReturnType<typeof runsOf>> = [];
    for (let i = 0; i < 50 && rows.length === 0; i++) {
      rows = await runsOf(bot);
      if (rows.length === 0) await Bun.sleep(20);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      traceId: tracer.traceId,
      kind: "capture",
      name: "YouTube: a talk",
      status: "error",
      model: "m",
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 0,
      durationMs: expect.any(Number),
    });
  });

  test("a stamped child span counts, and an unstamped root does not", async () => {
    const bot = `runs-${crypto.randomUUID()}`;
    await span(bot, { agentKind: "scheduled_task", agentName: "Brief" }, { name: "task:briefing", kind: "span", parentId: crypto.randomUUID() });
    await span(bot, { wiki: "from before the stamp" });
    const rows = await runsOf(bot);
    expect(rows.map((r) => r.name)).toEqual(["Brief"]);
  });

  test("reads agentModel first, then model, and null when neither is there", async () => {
    const bot = `runs-${crypto.randomUUID()}`;
    await span(bot, { agentKind: "digest", agentName: "both", agentModel: "agent", model: "plain" });
    await span(bot, { agentKind: "digest", agentName: "plain", model: "plain" });
    await span(bot, { agentKind: "digest", agentName: "neither" });
    const rows = await runsOf(bot);
    const modelOf = (name: string) => rows.find((r) => r.name === name)!.model;
    expect(modelOf("both")).toBe("agent");
    expect(modelOf("plain")).toBe("plain");
    expect(modelOf("neither")).toBeNull();
    expect(rows.find((r) => r.name === "neither")).toMatchObject({ inputTokens: null, outputTokens: null, costUsd: null });
  });

  test("keeps to the window, newest first, and to the limit", async () => {
    const bot = `runs-${crypto.randomUUID()}`;
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000);
    await span(bot, { agentKind: "digest", agentName: "older" }, { startedAt: ago(47) });
    await span(bot, { agentKind: "digest", agentName: "newer" }, { startedAt: ago(1) });
    await span(bot, { agentKind: "digest", agentName: "outside" }, { startedAt: ago(49) });
    const rows = (await getRecentAgentRuns(100_000)).filter((r) => r.botName === bot);
    expect(rows.map((r) => r.name)).toEqual(["newer", "older"]);
    expect((await runsOf(bot, 2)).map((r) => r.name)).toEqual(["newer"]);
    expect(await getRecentAgentRuns(1)).toHaveLength(1);
  });

  test("one run failing every tick does not push the rest out of the read", async () => {
    // A goal whose send fails is picked up again on every tick.
    const bot = `runs-${crypto.randomUUID()}`;
    const other = `runs-${crypto.randomUUID()}`;
    const ago = (m: number) => new Date(Date.now() - m * 60_000);
    await span(bot, { agentKind: "digest", agentName: "older ok" }, { startedAt: ago(600) });
    await span(other, { agentKind: "gardener_drain", agentName: "Backlog drain" }, { startedAt: ago(500) });
    await getDb()`UPDATE traces SET status = 'error' WHERE bot_name = ${other}`;
    await Promise.all(
      Array.from({ length: 45 }, (_, i) =>
        spanFailed(bot, { agentKind: "gardener_drain", agentName: "Backlog drain" }, ago(i + 1)),
      ),
    );
    await spanFailed(bot, { agentKind: "scheduled_task", agentName: "Another name" }, ago(450));
    const rows = await getRecentAgentRuns(100_000);
    const failing = rows.filter((r) => r.botName === bot && r.name === "Backlog drain");
    // The newest three of a bot's failures under one name.
    expect(failing.map((r) => Math.round((Date.now() - r.startedAt) / 60_000))).toEqual([1, 2, 3]);
    expect(rows.filter((r) => r.botName === other && r.status === "error")).toHaveLength(1);
    expect(rows.filter((r) => r.botName === bot && r.name === "Another name")).toHaveLength(1);
    // Past a default read's limit once the failures are capped, the ordinary row is there.
    expect((await getRecentAgentRuns()).some((r) => r.botName === bot && r.name === "older ok")).toBe(true);
  });

  test("a name's ordinary runs are all kept", async () => {
    const bot = `runs-${crypto.randomUUID()}`;
    await Promise.all(Array.from({ length: 5 }, () => span(bot, { agentKind: "digest", agentName: "Wiki digest: w" })));
    expect(await runsOf(bot)).toHaveLength(5);
  });

  test("the index the read relies on exists, with the predicate the read spells", async () => {
    const [row] = await getDb()`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_traces_agent_run'`;
    expect(row!.indexdef).toContain("attributes ? 'agentKind'");
    const here = (p: string) => Bun.file(new URL(p, import.meta.url)).text();
    expect(await here("./agent-activity.ts")).toContain("WHERE attributes ? 'agentKind'");
    const definition = "ON traces (started_at DESC) WHERE attributes ? 'agentKind';";
    expect(await here("../../db/migrations/087-traces-agent-run-index.sql")).toContain(definition);
    expect(await here("../../db/init.sql")).toContain(definition);
  });
});

describe("a run that fails after its span finished ok", () => {
  const rowsOf = async (traceId: string) =>
    (await getDb()`SELECT status, attributes FROM traces WHERE trace_id = ${traceId} AND attributes ? 'agentKind'`) as unknown as {
      status: string;
      attributes: Record<string, unknown>;
    }[];
  async function until(traceId: string, status: string) {
    for (let i = 0; i < 150; i++) {
      const [row] = await rowsOf(traceId);
      if (row?.status === status) return row;
      await Bun.sleep(20);
    }
    return (await rowsOf(traceId))[0];
  }
  const store = createJobStore<"pending" | "complete" | "error", { videoId: string }>({
    subsystem: "test",
    label: "Late",
    initialStatus: "pending",
  });

  async function jobWithFinishedRoot(title: string) {
    const id = store.createJob({ videoId: "v", title, url: "u" });
    const tracer = new Tracer("capture:youtube", { botName: "testbot" });
    const run = store.attachRun(id, { traceId: tracer.traceId });
    finishAgentRunTrace(tracer, run, "ok", { inputTokens: 5 });
    await until(tracer.traceId, "ok");
    return { id, tracer };
  }

  test("a failed job marks its stamped span, so the row stays red after a restart", async () => {
    const { id, tracer } = await jobWithFinishedRoot("ingest fails");
    store.failJob(id, "ingest refused");
    const row = await until(tracer.traceId, "error");
    expect(row!.status).toBe("error");
    expect(row!.attributes).toMatchObject({ error: "ingest refused", inputTokens: 5, agentName: "Late: ingest fails" });
  });

  test("a failure right after the finish still lands, though the stamp had not", async () => {
    // The finish is fire-and-forget, so with no `await` between them the mark reaches
    // Postgres first and matches nothing.
    for (let i = 0; i < 5; i++) {
      const id = store.createJob({ videoId: "v", title: `no gap ${i}`, url: "u" });
      const tracer = new Tracer("capture:youtube", { botName: "testbot" });
      const run = store.attachRun(id, { traceId: tracer.traceId });
      finishAgentRunTrace(tracer, run, "ok", { inputTokens: 5 });
      store.failJob(id, "huginn refused the ingest");
      const row = await until(tracer.traceId, "error");
      expect(row!.status).toBe("error");
    }
  });

  test("a finished job leaves its span ok", async () => {
    const { id, tracer } = await jobWithFinishedRoot("all fine");
    store.completeJob(id, "s", "c");
    await Bun.sleep(60);
    expect((await rowsOf(tracer.traceId))[0]!.status).toBe("ok");
  });

  test("only the run's own span is marked, not a sibling in the same trace", async () => {
    const { id, tracer } = await jobWithFinishedRoot("named");
    const sibling = new Tracer("task:briefing", { botName: "testbot", traceId: tracer.traceId, parentId: crypto.randomUUID() });
    finishAgentRunTrace(sibling, { kind: "scheduled_task", name: "Sibling" }, "ok");
    for (let i = 0; i < 50 && (await rowsOf(tracer.traceId)).length < 2; i++) await Bun.sleep(20);
    store.failJob(id, "boom");
    await until(tracer.traceId, "error");
    await Bun.sleep(60);
    const rows = await rowsOf(tracer.traceId);
    expect(rows.find((r) => r.attributes.agentName === "Sibling")!.status).toBe("ok");
    expect(rows.find((r) => r.attributes.agentName === "Late: named")!.status).toBe("error");
  });

  test("a span already in error keeps its own message", async () => {
    const id = store.createJob({ videoId: "v", title: "model failed", url: "u" });
    const tracer = new Tracer("capture:youtube", { botName: "testbot" });
    const run = store.attachRun(id, { traceId: tracer.traceId });
    finishAgentRunTrace(tracer, run, "error", { error: "the model's own error" });
    await until(tracer.traceId, "error");
    store.failJob(id, "wrapped message");
    await Bun.sleep(60);
    expect((await rowsOf(tracer.traceId))[0]!.attributes.error).toBe("the model's own error");
  });
});

test("getRecentAgentRuns reads at most 40 rows unless told otherwise", async () => {
  const bot = `runs-${crypto.randomUUID()}`;
  await Promise.all(
    Array.from({ length: 41 }, () =>
      saveSpan({
        id: crypto.randomUUID(),
        traceId: crypto.randomUUID(),
        name: "wiki_digest",
        kind: "root" as const,
        botName: bot,
        startedAt: new Date(),
        durationMs: 1,
        attributes: { agentKind: "digest", agentName: "n" },
      }),
    ),
  );
  expect(await getRecentAgentRuns()).toHaveLength(40);
});
