import { test, expect, describe } from "bun:test";
import { Hono } from "hono";
import { setupTestDb } from "../test/setup-db.ts";
import { registerTracesRoutes } from "../dashboard/routes/traces-routes.ts";
import { getDb } from "./client.ts";
import {
  CAPTURE_PROMPT_MAX_BYTES,
  cleanupOldSnapshots,
  getLatestCaptureSnapshotByUrl,
  getPromptSnapshot,
  savePromptSnapshot,
} from "./prompt-snapshots.ts";
import { TRANSCRIPT_TRUNCATION_NOTE } from "../summaries/truncation.ts";
import { runCaptureOneShot, SNAPSHOT_WRITE_BUDGET_MS } from "../summaries/summarizer-shared.ts";
import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Tracer } from "../tracing/tracer.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { Sql } from "postgres";

setupTestDb();

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * `runCaptureOneShot`, with the snapshot write awaited BY THE TEST.
 *
 * The seam waits for the write only up to `SNAPSHOT_WRITE_BUDGET_MS` — a slow
 * Postgres must not stall a capture that has already produced its summary — so
 * a test that read the row straight after the call would be racing any write
 * that outran the budget. `onSnapshotSettled` is the seam's test handle on the
 * whole promise; production callers pass nothing.
 */
async function captureAndSettle(
  opts: Omit<Parameters<typeof runCaptureOneShot>[0], "onSnapshotSettled">,
): Promise<void> {
  const pending: Promise<void>[] = [];
  await runCaptureOneShot({ ...opts, onSnapshotSettled: (p) => pending.push(p) });
  await Promise.all(pending);
}

/** Age a row so a retention window can be driven without waiting days. */
async function ageSnapshot(traceId: string, days: number): Promise<void> {
  await getDb()`
    UPDATE prompt_snapshots
    SET created_at = NOW() - make_interval(days => ${days})
    WHERE trace_id = ${traceId}
  `;
}

describe("prompt snapshots: the capture pass a reader gets by default", () => {
  /**
   * The named acceptance of the snapshot slice.
   *
   * A YouTube dense-scan capture runs `runCaptureOneShot` TWICE under one trace
   * root — a `claude:select` selection pass over the frame sheets, then the
   * `claude` summary pass. The row a reader wants is the summary one; the table
   * used to be unique on `trace_id` alone, so the selection pass would have won
   * the trace and the summary prompt would never have been stored at all.
   *
   * Driven through the seam, not through `savePromptSnapshot` directly: what is
   * under test is that the CAPTURE writes a row per pass and that the default
   * read picks the summary one.
   */
  test("a two-pass capture stores both passes, and the default read is the SUMMARY pass", async () => {
    const traceId = crypto.randomUUID();
    const url = "https://example.test/watch?v=two-pass";
    const parentTracer = fakeTracer(traceId);
    const config = { tracingEnabled: true, tracingCaptureToolOutputs: false } as unknown as Config;
    const botConfig = { name: "testbot", connector: "claude-sdk" } as unknown as BotConfig;

    for (const pass of ["claude:select", "claude"]) {
      await captureAndSettle({
        source: "youtube",
        jobId: "job-1",
        title: "A talk",
        url,
        prompt: `user prompt for ${pass}`,
        systemPrompt: `system prompt for ${pass}`,
        config,
        botConfig,
        parentTracer,
        pass,
        takeawayCheck: false,
        attachRun: () => {},
        oneShot: async () => fakeResult(),
      });
    }

    const byDefault = await getPromptSnapshot(traceId);
    expect(byDefault).not.toBeNull();
    expect(byDefault!.systemPrompt).toBe("system prompt for claude");
    expect(byDefault!.userPrompt).toBe("user prompt for claude");
    expect(byDefault!.pass).toBe("claude");
    expect(byDefault!.kind).toBe("capture");

    // The selection pass is stored too — it is what the deep link addresses.
    const selection = await getPromptSnapshot(traceId, "claude:select");
    expect(selection!.systemPrompt).toBe("system prompt for claude:select");
    expect(selection!.pass).toBe("claude:select");
  });

  /**
   * The preference is on the PASS, not on the clock. The two-pass case above
   * runs selection-then-summary, so a plain `created_at DESC` would pass it by
   * coincidence; here the selection row is the NEWER one.
   */
  test("the summary pass wins even when the selection row is newer", async () => {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({
      traceId,
      systemPrompt: "the summary prompt",
      userPrompt: "u",
      pass: "claude",
      kind: "capture",
      sourceUrl: "https://example.test/watch?v=ordering",
    });
    await ageSnapshot(traceId, 1); // the summary row is a day old…
    await savePromptSnapshot({
      traceId,
      systemPrompt: "the selection prompt",
      userPrompt: "u",
      pass: "claude:select",
      kind: "capture",
      sourceUrl: "https://example.test/watch?v=ordering",
    }); // …and the selection row was written just now

    expect((await getPromptSnapshot(traceId))!.systemPrompt).toBe("the summary prompt");
  });

  test("a capture row carries the source url, so the doc panel can find it", async () => {
    const traceId = crypto.randomUUID();
    const url = "https://example.test/watch?v=by-url";
    await captureAndSettle({
      source: "vimeo",
      jobId: "job-2",
      title: "A talk",
      url,
      prompt: "the transcript",
      systemPrompt: "summarize it",
      config: { tracingEnabled: true, tracingCaptureToolOutputs: false } as unknown as Config,
      botConfig: { name: "testbot", connector: "claude-sdk" } as unknown as BotConfig,
      parentTracer: fakeTracer(traceId),
      takeawayCheck: false,
      attachRun: () => {},
      oneShot: async () => fakeResult(),
    });

    const found = await getLatestCaptureSnapshotByUrl(url);
    expect(found).not.toBeNull();
    expect(found!.traceId).toBe(traceId);
    expect(found!.pass).toBe("claude");
    expect(found!.systemPrompt).toBe("summarize it");
  });

  test("writes nothing when tracing is off — there is no trace to key the row on", async () => {
    const traceId = crypto.randomUUID();
    await captureAndSettle({
      source: "youtube",
      jobId: "job-3",
      title: "A talk",
      url: "https://example.test/watch?v=untraced",
      prompt: "the transcript",
      systemPrompt: "summarize it",
      config: { tracingEnabled: false, tracingCaptureToolOutputs: false } as unknown as Config,
      botConfig: { name: "testbot", connector: "claude-sdk" } as unknown as BotConfig,
      parentTracer: fakeTracer(traceId),
      takeawayCheck: false,
      attachRun: () => {},
      oneShot: async () => fakeResult(),
    });
    expect(await getPromptSnapshot(traceId)).toBeNull();
  });
});

describe("prompt snapshots: the chat caller is unchanged", () => {
  /**
   * `src/core/prompt-assembly.ts` passes neither `pass` nor `kind`. Its row must
   * still land, still be what the default read answers, and still be the `chat`
   * kind — which is what keeps it on the 3-day retention rather than the
   * capture one.
   */
  test("a chat row lands with pass='' and kind='chat', and is the default read", async () => {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({ traceId, systemPrompt: "persona", userPrompt: "hello" });

    const snapshot = await getPromptSnapshot(traceId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.systemPrompt).toBe("persona");
    expect(snapshot!.pass).toBe("");
    expect(snapshot!.kind).toBe("chat");
  });

  test("a second write for the same (trace, pass) is ignored, not duplicated", async () => {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({ traceId, systemPrompt: "first", userPrompt: "hello" });
    await savePromptSnapshot({ traceId, systemPrompt: "second", userPrompt: "hello again" });
    const snapshot = await getPromptSnapshot(traceId);
    expect(snapshot!.systemPrompt).toBe("first");
  });
});

describe("prompt snapshots: the capture cap", () => {
  const oversized = () => "あ".repeat(CAPTURE_PROMPT_MAX_BYTES); // 3 bytes each ⇒ 3× the cap

  test("a capture user prompt over the cap is stored truncated, with the note", async () => {
    const traceId = crypto.randomUUID();
    const text = `### [00:00:00]\n${oversized()}`;
    await savePromptSnapshot({
      traceId,
      systemPrompt: "summarize it",
      userPrompt: text,
      pass: "claude",
      kind: "capture",
      sourceUrl: "https://example.test/watch?v=huge",
    });

    const stored = (await getPromptSnapshot(traceId))!.userPrompt;
    expect(bytes(stored)).toBeLessThanOrEqual(CAPTURE_PROMPT_MAX_BYTES);
    // Not merely "under the cap": most of the prompt is kept, and the cut says so.
    expect(stored.endsWith(TRANSCRIPT_TRUNCATION_NOTE)).toBe(true);
    expect(bytes(stored)).toBeGreaterThan(CAPTURE_PROMPT_MAX_BYTES - 4096);
    expect(stored.startsWith("### [00:00:00]\n")).toBe(true);
    // Byte-safe: a 3-byte code point cut in half would decode to U+FFFD.
    expect(stored).not.toContain("�");
  });

  test("a capture prompt UNDER the cap is stored byte-for-byte", async () => {
    const traceId = crypto.randomUUID();
    const text = "### [00:00:00]\nshort enough";
    await savePromptSnapshot({
      traceId,
      systemPrompt: "s",
      userPrompt: text,
      pass: "claude",
      kind: "capture",
      sourceUrl: "https://example.test/watch?v=small",
    });
    expect((await getPromptSnapshot(traceId))!.userPrompt).toBe(text);
  });

  test("a CHAT prompt of the same size is not capped", async () => {
    const traceId = crypto.randomUUID();
    const text = oversized();
    await savePromptSnapshot({ traceId, systemPrompt: "persona", userPrompt: text });
    const stored = (await getPromptSnapshot(traceId))!.userPrompt;
    expect(stored).toBe(text);
    expect(bytes(stored)).toBeGreaterThan(CAPTURE_PROMPT_MAX_BYTES);
  });
});

describe("prompt snapshots: retention is per kind", () => {
  /**
   * Chat prompts are swept after 3 days; a capture's prompt has to outlive its
   * TRACE (7 days) to be worth showing on the summary months later, so it gets
   * its own window. A single retention number would delete the capture rows
   * with the chat ones.
   */
  test("a capture row older than the chat window but younger than the capture window survives", async () => {
    const chatTrace = crypto.randomUUID();
    const captureTrace = crypto.randomUUID();
    await savePromptSnapshot({ traceId: chatTrace, systemPrompt: "persona", userPrompt: "hi" });
    await savePromptSnapshot({
      traceId: captureTrace,
      systemPrompt: "summarize",
      userPrompt: "transcript",
      pass: "claude",
      kind: "capture",
      sourceUrl: "https://example.test/watch?v=retained",
    });
    await ageSnapshot(chatTrace, 30);
    await ageSnapshot(captureTrace, 30);

    const deleted = await cleanupOldSnapshots({ chatDays: 3, captureDays: 90 });

    expect(deleted).toBe(1);
    expect(await getPromptSnapshot(chatTrace)).toBeNull();
    expect(await getPromptSnapshot(captureTrace)).not.toBeNull();
  });

  test("a capture row past the capture window is swept", async () => {
    const captureTrace = crypto.randomUUID();
    await savePromptSnapshot({
      traceId: captureTrace,
      systemPrompt: "summarize",
      userPrompt: "transcript",
      pass: "claude",
      kind: "capture",
      sourceUrl: "https://example.test/watch?v=swept",
    });
    await ageSnapshot(captureTrace, 120);

    expect(await cleanupOldSnapshots({ chatDays: 3, captureDays: 90 })).toBe(1);
    expect(await getPromptSnapshot(captureTrace)).toBeNull();
  });
});

describe("getLatestCaptureSnapshotByUrl", () => {
  const url = "https://example.test/watch?v=lookup";

  async function seed(pass: string, kind: "capture" | "chat", systemPrompt: string, ageDays: number) {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({
      traceId,
      systemPrompt,
      userPrompt: "u",
      pass,
      kind,
      sourceUrl: url,
    });
    await ageSnapshot(traceId, ageDays);
    return traceId;
  }

  test("answers the newest SUMMARY-pass capture row for that url", async () => {
    await seed("claude", "capture", "older summary", 5);
    const newest = await seed("claude", "capture", "newest summary", 1);
    await seed("claude:select", "capture", "selection pass", 0);

    const found = await getLatestCaptureSnapshotByUrl(url);
    expect(found!.systemPrompt).toBe("newest summary");
    expect(found!.traceId).toBe(newest);
  });

  test("answers null for a url with no capture snapshot", async () => {
    expect(await getLatestCaptureSnapshotByUrl("https://example.test/watch?v=never")).toBeNull();
  });
});

/**
 * The route half of the pass, driven against the real read.
 *
 * `GET /api/prompts/:traceId` reaches the DB directly — there is no seam to
 * inject — so the only place its `?pass=` passthrough is observable is beside a
 * database. Here rather than in a `src/dashboard/routes/` file for that reason:
 * those run in the DB-less chunk.
 */
describe("GET /api/prompts/:traceId?pass=", () => {
  async function appWithTrace(): Promise<{ app: Hono; traceId: string }> {
    const traceId = crypto.randomUUID();
    for (const [pass, systemPrompt] of [["claude", "the summary prompt"], ["claude:select", "the selection prompt"]]) {
      await savePromptSnapshot({
        traceId,
        systemPrompt: systemPrompt!,
        userPrompt: "u",
        pass: pass!,
        kind: "capture",
        sourceUrl: "https://example.test/watch?v=route",
      });
    }
    const app = new Hono();
    registerTracesRoutes(app);
    return { app, traceId };
  }

  test("serves the named pass", async () => {
    const { app, traceId } = await appWithTrace();
    const res = await app.request(`/api/prompts/${traceId}?pass=claude%3Aselect`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { systemPrompt: string; pass: string };
    expect([body.pass, body.systemPrompt]).toEqual(["claude:select", "the selection prompt"]);
  });

  test("with no pass, serves the summary one", async () => {
    const { app, traceId } = await appWithTrace();
    const body = (await (await app.request(`/api/prompts/${traceId}`)).json()) as { pass: string };
    expect(body.pass).toBe("claude");
  });

  test("404s for a pass that trace never ran", async () => {
    const { app, traceId } = await appWithTrace();
    expect((await app.request(`/api/prompts/${traceId}?pass=nope`)).status).toBe(404);
  });
});

/**
 * A `Tracer` stand-in: the seam only reads `traceId` and records spans, and a
 * real one would write trace rows this test does not assert on. `parentTracer`
 * (rather than the `tracer` seam) is what a two-pass caller passes, and it is
 * what makes both calls share one trace id.
 */
function fakeTracer(traceId: string): Tracer {
  return {
    traceId,
    start: () => "span",
    end: () => 1,
    finish: () => {},
    event: () => {},
    addChildSpan: () => "child",
    addSubSpan: () => "sub",
  } as unknown as Tracer;
}

function fakeResult(): ClaudeExecResult {
  return {
    result: "CATEGORY: ai/general\n\nSUMMARY:\nok",
    model: "claude-sonnet-5",
    inputTokens: 10,
    outputTokens: 5,
    numTurns: 1,
    costUsd: 0.01,
    durationMs: 10,
  } as ClaudeExecResult;
}

/**
 * The write is BOUNDED — waited for, but only up to a budget — and this is what
 * says so.
 *
 * A capture's summary is already produced by the time the prompt is stored, so
 * a Postgres that is slow, locked or gone must not hold the job open behind a
 * debugging artefact. But an entirely unattended write settles wherever the
 * event loop next goes, and in a single-process `bun test` chunk that is inside
 * somebody else's test: a rejected INSERT logged its warn into
 * `src/summaries/frames.test.ts`'s log capture, whose assertion is that its own
 * warning list is empty. So the seam waits `SNAPSHOT_WRITE_BUDGET_MS` and no
 * longer — which is unbounded headroom for a write that answers, and a bounded
 * bill for one that never does.
 *
 * Both halves are here, because either alone is satisfied by the wrong code: a
 * write that is always awaited passes the first, and one that is never awaited
 * passes the second.
 */
describe("prompt snapshots: the capture waits for the write, but only so long", () => {
  const captureOpts = (traceId: string, jobId: string) => ({
    source: "youtube",
    jobId,
    title: "A talk",
    url: `https://example.test/watch?v=${jobId}`,
    prompt: "the transcript",
    systemPrompt: "summarize it",
    config: { tracingEnabled: true, tracingCaptureToolOutputs: false } as unknown as Config,
    botConfig: { name: "testbot", connector: "claude-sdk" } as unknown as BotConfig,
    parentTracer: fakeTracer(traceId),
    // No takeaway check, so NOTHING between the write and the return awaits on
    // its own account: what these cases read is decided by the seam's own wait,
    // not by how many turns of the loop happened to pass afterwards.
    takeawayCheck: false as const,
    attachRun: () => {},
    oneShot: async () => fakeResult(),
  });

  test("a write that ANSWERS has landed by the time runCaptureOneShot resolves", async () => {
    const traceId = crypto.randomUUID();
    let settled: Promise<void> | null = null;
    // Flipped by a continuation registered INSIDE the seam, i.e. before the
    // seam's own wait subscribes to the same promise — so this is true on
    // return if and only if the seam waited for the write.
    let writeFinished = false;
    await runCaptureOneShot({
      ...captureOpts(traceId, "job-bounded"),
      onSnapshotSettled: (p) => { settled = p; p.then(() => { writeFinished = true; }); },
    });

    expect(settled).not.toBeNull();
    expect(writeFinished).toBe(true);
    // Read WITHOUT awaiting `settled`: the row is there because the capture
    // waited for it, not because this line did.
    expect((await getPromptSnapshot(traceId))!.systemPrompt).toBe("summarize it");
  });

  test("a write BLOCKED past the budget does not hold the capture open", async () => {
    const traceId = crypto.randomUUID();
    let releaseLock!: () => void;
    let lockTaken!: () => void;
    const lockHeld = new Promise<void>((r) => { lockTaken = r; });
    const releaseRequested = new Promise<void>((r) => { releaseLock = r; });

    // A stalled database, without one: `EXCLUSIVE` conflicts with the
    // `ROW EXCLUSIVE` an INSERT takes, so the snapshot write blocks inside
    // Postgres for as long as this transaction stays open.
    // `TransactionSql` loses its call signatures in the types (the documented
    // `src/db/CLAUDE.md` pitfall), so the tagged-template form needs the cast.
    const lockTx = getDb().begin(async (tx) => {
      await (tx as unknown as Sql)`LOCK TABLE prompt_snapshots IN EXCLUSIVE MODE`;
      lockTaken();
      await releaseRequested;
    });
    await lockHeld;
    // A lock nothing can release is a hung SUITE, not a failed test: the
    // `finally` below is only reached once the capture returns, so a seam that
    // waits for the write forever would also hold this transaction — and every
    // later `setupTestDb` TRUNCATE — open. The safety release turns that into
    // an ordinary assertion failure on the elapsed bound.
    const safetyRelease = setTimeout(() => releaseLock(), 10_000);

    let settled: Promise<void> | null = null;
    let writeFinished = false;
    const startedAt = Date.now();
    try {
      const result = await runCaptureOneShot({
        ...captureOpts(traceId, "job-blocked"),
        onSnapshotSettled: (p) => { settled = p; p.then(() => { writeFinished = true; }); },
      });
      const elapsedMs = Date.now() - startedAt;

      // The capture answered, with its summary, while the write was still stuck.
      expect(result.result).toContain("SUMMARY:");
      expect(writeFinished).toBe(false);
      // It DID wait — the budget is a bound, not a skip…
      expect(elapsedMs).toBeGreaterThanOrEqual(SNAPSHOT_WRITE_BUDGET_MS - 50);
      // …and it waited only that long, rather than for the lock.
      expect(elapsedMs).toBeLessThan(SNAPSHOT_WRITE_BUDGET_MS + 1_000);
    } finally {
      clearTimeout(safetyRelease);
      releaseLock();
      await lockTx;
    }

    // Abandoned, not cancelled: released, the write still lands.
    await settled;
    expect(writeFinished).toBe(true);
    expect((await getPromptSnapshot(traceId))!.systemPrompt).toBe("summarize it");
  }, 20_000);
});

describe("prompt snapshots: a url-less capture stores NULL", () => {
  /**
   * `src/article/summarizer.ts` passes `url: ""` for a pasted article with no
   * source link. Stored verbatim, every one of those rows shares the key `''`
   * — and `getLatestCaptureSnapshotByUrl('')` would then answer one arbitrary
   * article's prompt for all of them.
   */
  test("an empty source url is stored as NULL, not as an empty string", async () => {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({
      traceId,
      systemPrompt: "summarize the pasted text",
      userPrompt: "u",
      pass: "claude",
      kind: "capture",
      sourceUrl: "",
    });
    const [row] = await getDb()`SELECT source_url FROM prompt_snapshots WHERE trace_id = ${traceId}`;
    expect(row!.source_url).toBeNull();
  });

  test("and the by-url lookup finds nothing for the empty string", async () => {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({
      traceId,
      systemPrompt: "summarize the pasted text",
      userPrompt: "u",
      pass: "claude",
      kind: "capture",
      sourceUrl: "",
    });
    expect(await getLatestCaptureSnapshotByUrl("")).toBeNull();
  });

  test("an absent source url is NULL too — the chat caller's shape", async () => {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({ traceId, systemPrompt: "persona", userPrompt: "hello" });
    const [row] = await getDb()`SELECT source_url FROM prompt_snapshots WHERE trace_id = ${traceId}`;
    expect(row!.source_url).toBeNull();
  });
});

describe("cleanupOldSnapshots refuses a non-positive window", () => {
  /**
   * `NOW() - 0 days` is NOW, so a retention of 0 deletes the whole table on the
   * next scheduler tick. `src/config.ts` clamps the env vars, but this function
   * is exported and called with two numbers — the guard is here as well so a
   * caller that computes a window cannot bypass the clamp.
   */
  async function seedOne(): Promise<string> {
    const traceId = crypto.randomUUID();
    await savePromptSnapshot({
      traceId,
      systemPrompt: "summarize",
      userPrompt: "transcript",
      pass: "claude",
      kind: "capture",
      sourceUrl: `https://example.test/watch?v=${traceId}`,
    });
    return traceId;
  }

  test("chatDays 0 throws and deletes nothing", async () => {
    const traceId = await seedOne();
    await expect(cleanupOldSnapshots({ chatDays: 0, captureDays: 90 })).rejects.toThrow(/at least 1 day/);
    expect(await getPromptSnapshot(traceId)).not.toBeNull();
  });

  test("captureDays 0 throws and deletes nothing", async () => {
    const traceId = await seedOne();
    await expect(cleanupOldSnapshots({ chatDays: 3, captureDays: 0 })).rejects.toThrow(/at least 1 day/);
    expect(await getPromptSnapshot(traceId)).not.toBeNull();
  });

  test("a negative window throws too", async () => {
    const traceId = await seedOne();
    await expect(cleanupOldSnapshots({ chatDays: 3, captureDays: -1 })).rejects.toThrow(/at least 1 day/);
    expect(await getPromptSnapshot(traceId)).not.toBeNull();
  });

  test("1 day is allowed — the floor is a floor, not a ban", async () => {
    const traceId = await seedOne();
    await ageSnapshot(traceId, 5);
    expect(await cleanupOldSnapshots({ chatDays: 1, captureDays: 1 })).toBe(1);
  });
});

describe("getLatestCaptureSnapshotByUrl is scoped to capture rows", () => {
  /**
   * The `kind = 'capture'` predicate has no other test standing on it: dropping
   * it left the whole suite green, because nothing else writes a CHAT row that
   * carries a source url. A chat row can carry one — the column is nullable,
   * not kind-constrained — so the filter is pinned directly here, against a row
   * inserted past `savePromptSnapshot`.
   */
  const url = "https://example.test/watch?v=kind-scope";

  test("a chat row with the same source url is never answered", async () => {
    const chatTrace = crypto.randomUUID();
    await getDb()`
      INSERT INTO prompt_snapshots (trace_id, system_prompt, user_prompt, pass, kind, source_url)
      VALUES (${chatTrace}, 'a chat prompt', 'u', 'claude', 'chat', ${url})
    `;
    expect(await getLatestCaptureSnapshotByUrl(url)).toBeNull();

    // And once a real capture row exists for that url, THAT is what comes back
    // — so the null above is the filter, not an empty table.
    const captureTrace = crypto.randomUUID();
    await savePromptSnapshot({
      traceId: captureTrace,
      systemPrompt: "a capture prompt",
      userPrompt: "u",
      pass: "claude",
      kind: "capture",
      sourceUrl: url,
    });
    const found = await getLatestCaptureSnapshotByUrl(url);
    expect(found!.systemPrompt).toBe("a capture prompt");
    expect(found!.traceId).toBe(captureTrace);
  });
});
