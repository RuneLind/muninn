import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolve } from "node:path";
import { getLog } from "../../logging.ts";
import {
  listBenchmarkRuns,
  getBenchmarkRun,
  listRejudgeChildren,
} from "../../db/benchmark-runs.ts";
import { rejudgeCandidate, type RejudgeJobState } from "../../benchmarks/rejudge.ts";
import { liveJobSupervisor, pipeSubprocessLogs } from "../../benchmarks/live-job.ts";
import {
  discoverIssues,
  discoverTreatments,
} from "../../benchmarks/treatment-discovery.ts";
import { buildCellPreview } from "../../benchmarks/preview.ts";
import { getTrace } from "../../db/traces.ts";
import { renderBenchmarkListPage } from "../views/benchmark/list-page.ts";
import { renderBenchmarkDetailPage } from "../views/benchmark/detail-page.ts";
import { renderBenchmarkRunLivePage } from "../views/benchmark/live-page.ts";

const log = getLog("dashboard", "benchmark");

const activeRejudgeJobs = new Map<string, RejudgeJobState>();

/**
 * In-process pub/sub for live judge stream events keyed by parent run id.
 * The rejudge POST handler publishes here as the judge streams text deltas;
 * the /judge-stream SSE endpoint subscribes per browser tab. Cleared when
 * the rejudge job finishes (and the stream sends a final `done` event so
 * the client can close cleanly).
 */
type JudgeStreamEvent =
  | { type: "delta"; passIndex: number; text: string }
  | { type: "pass_start"; passIndex: number; total: number }
  | { type: "pass_end"; passIndex: number }
  | { type: "done"; passes: number }
  | { type: "error"; error: string };
type JudgeStreamListener = (ev: JudgeStreamEvent) => void;
const judgeStreamListeners = new Map<string, Set<JudgeStreamListener>>();

function emitJudgeStream(parentRunId: string, ev: JudgeStreamEvent): void {
  const set = judgeStreamListeners.get(parentRunId);
  if (!set) return;
  for (const listener of set) {
    try { listener(ev); } catch { /* listener errors are swallowed; SSE handler resubscribes on reconnect */ }
  }
}

/**
 * Spawn run-cell.ts as a detached subprocess with BENCHMARK_TRACE_ID set so
 * the runner's Tracer reuses our pre-allocated UUID. The route handler
 * returns immediately; stdout/stderr are streamed into the live-job supervisor
 * for the UI to tail.
 */
async function spawnRunCellSubprocess(
  traceId: string,
  issueKey: string,
  treatmentPath: string,
): Promise<void> {
  const muninnRoot = resolve(import.meta.dir, "../../..");
  // The subprocess inherits the full process env — safe because the
  // Bug-11 fence lives inside the runner (--strict-mcp-config +
  // --disallowedTools applied when spawning claude-cli), not at this
  // subprocess boundary. Filtering env here wouldn't add isolation, it
  // would just break any legitimate parent env the runner depends on
  // (DATABASE_URL, CLAUDE_MODEL, etc.).
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "benchmarks/scripts/run-cell.ts",
      issueKey,
      treatmentPath,
      "--n-runs",
      "1",
    ],
    {
      cwd: muninnRoot,
      env: {
        ...process.env,
        BENCHMARK_TRACE_ID: traceId,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  liveJobSupervisor.markRunning(traceId, proc);
  log.info("Spawned live run-cell.ts pid={pid} trace={traceId}", {
    traceId,
    pid: proc.pid,
    issueKey,
    treatmentPath,
  });

  // Pipe logs in the background; don't await — let the caller return the 202
  // immediately. proc.exited is awaited separately to record the final state.
  void pipeSubprocessLogs(traceId, proc.stdout, "stdout");
  void pipeSubprocessLogs(traceId, proc.stderr, "stderr");
  void (async () => {
    try {
      const exitCode = await proc.exited;
      liveJobSupervisor.markDone(traceId, exitCode);
      log.info("Live run-cell.ts finished trace={traceId} exit={exitCode}", {
        traceId,
        exitCode,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      liveJobSupervisor.markError(traceId, msg);
      log.error("Live run-cell.ts errored trace={traceId}: {error}", {
        traceId,
        error: msg,
      });
    }
  })();
}

export function registerBenchmarkRoutes(app: Hono): void {
  app.get("/benchmark", async (c) => {
    try {
      const [runs, issues, treatments] = await Promise.all([
        listBenchmarkRuns(50),
        discoverIssues().catch(() => []),
        discoverTreatments().catch(() => []),
      ]);
      return c.html(renderBenchmarkListPage(runs, issues, treatments));
    } catch (err) {
      log.error("Failed to render benchmark list: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.html("Failed to load benchmark runs", 500);
    }
  });

  app.get("/benchmark/run-live/:traceId", async (c) => {
    const traceId = c.req.param("traceId");
    const job = liveJobSupervisor.get(traceId);
    if (!job) return c.html("Live job not found (or evicted after 10 min)", 404);
    return c.html(renderBenchmarkRunLivePage(job));
  });

  app.get("/api/benchmark/preview", async (c) => {
    const issueKey = c.req.query("issueKey");
    const treatmentPath = c.req.query("treatmentPath");
    if (!issueKey || !treatmentPath) {
      return c.json({ error: "Missing required query params: issueKey, treatmentPath" }, 400);
    }
    const muninnRoot = resolve(import.meta.dir, "../../..");
    const resolvedTreatment = resolve(treatmentPath);
    const treatmentsDir = resolve(muninnRoot, "benchmarks/treatments");
    if (!resolvedTreatment.startsWith(treatmentsDir)) {
      return c.json(
        { error: "treatmentPath must resolve under benchmarks/treatments/" },
        400,
      );
    }
    const manifestPath = resolve(muninnRoot, "benchmarks/issues", `${issueKey}.yml`);
    try {
      const preview = await buildCellPreview({
        manifestPath,
        treatmentPath: resolvedTreatment,
      });
      return c.json(preview);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Failed to build preview: {error}", { error: msg });
      return c.json({ error: msg }, 500);
    }
  });

  app.post("/api/benchmark/cells", async (c) => {
    let body: { issueKey?: string; treatmentPath?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const { issueKey, treatmentPath } = body;
    if (!issueKey || !treatmentPath) {
      return c.json(
        { error: "Missing required fields: issueKey, treatmentPath" },
        400,
      );
    }

    const resolvedTreatment = resolve(treatmentPath);
    const muninnRoot = resolve(import.meta.dir, "../../..");
    const treatmentsDir = resolve(muninnRoot, "benchmarks/treatments");
    if (!resolvedTreatment.startsWith(treatmentsDir)) {
      return c.json(
        { error: "treatmentPath must resolve under benchmarks/treatments/" },
        400,
      );
    }

    const treatmentLabel = resolvedTreatment
      .slice(treatmentsDir.length + 1)
      .replace(/\.json$/, "");
    const traceId = crypto.randomUUID();
    liveJobSupervisor.register(traceId, issueKey, resolvedTreatment, treatmentLabel);

    try {
      await spawnRunCellSubprocess(traceId, issueKey, resolvedTreatment);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      liveJobSupervisor.markError(traceId, msg);
      return c.json({ error: `Failed to spawn: ${msg}`, traceId }, 500);
    }

    return c.json({ ok: true, traceId }, 202);
  });

  app.get("/api/benchmark/cells/live/:traceId", async (c) => {
    const traceId = c.req.param("traceId");
    const job = liveJobSupervisor.get(traceId);
    if (!job) return c.json({ error: "Not found" }, 404);
    try {
      const spans = await getTrace(traceId);
      return c.json({ job, spans });
    } catch (err) {
      log.error("Failed to fetch live job trace {traceId}: {error}", {
        traceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ job, spans: [], error: "trace_fetch_failed" });
    }
  });

  app.post("/api/benchmark/cells/live/:traceId/kill", async (c) => {
    const traceId = c.req.param("traceId");
    const killed = liveJobSupervisor.kill(traceId);
    if (!killed) return c.json({ error: "Job not running" }, 404);
    return c.json({ ok: true });
  });

  app.get("/benchmark/runs/:id", async (c) => {
    try {
      const id = c.req.param("id");
      // Parent row + children load in parallel. On a child row the children
      // query returns zero rows (partial index on parent_run_id keeps it
      // cheap), and we discard the result — one wasted lookup on a rare
      // path beats an extra round-trip on every detail view.
      const [run, childrenRaw] = await Promise.all([
        getBenchmarkRun(id),
        listRejudgeChildren(id),
      ]);
      if (!run) return c.html("Benchmark run not found", 404);
      const children = run.parentRunId ? [] : childrenRaw;
      const job = activeRejudgeJobs.get(id) ?? null;
      return c.html(renderBenchmarkDetailPage(run, children, job));
    } catch (err) {
      log.error("Failed to render benchmark detail: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.html("Failed to load benchmark run", 500);
    }
  });

  app.get("/api/benchmark/runs", async (c) => {
    try {
      const runs = await listBenchmarkRuns(100);
      return c.json({ runs });
    } catch (err) {
      log.error("Failed to fetch benchmark runs: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to fetch benchmark runs" }, 500);
    }
  });

  app.get("/api/benchmark/runs/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const run = await getBenchmarkRun(id);
      if (!run) return c.json({ error: "Not found" }, 404);
      return c.json(run);
    } catch (err) {
      log.error("Failed to fetch benchmark run: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to fetch benchmark run" }, 500);
    }
  });

  app.get("/api/benchmark/runs/:id/rejudge-children", async (c) => {
    try {
      const id = c.req.param("id");
      const children = await listRejudgeChildren(id);
      const job = activeRejudgeJobs.get(id) ?? null;
      return c.json({ children, job });
    } catch (err) {
      log.error("Failed to fetch re-judge children: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: "Failed to fetch re-judge children" }, 500);
    }
  });

  // SSE: live judge stream for a rejudge job. Subscribers receive
  // `pass_start`, `delta` (text chunks), `pass_end`, and a final `done` (or
  // `error`) event. Closes when the job finishes or the client disconnects.
  app.get("/api/benchmark/runs/:id/judge-stream", (c) => {
    const id = c.req.param("id");
    return streamSSE(c, async (stream) => {
      let alive = true;
      const listener: JudgeStreamListener = async (ev) => {
        if (!alive) return;
        try {
          await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
          if (ev.type === "done" || ev.type === "error") {
            alive = false;
          }
        } catch {
          alive = false;
        }
      };
      let set = judgeStreamListeners.get(id);
      if (!set) {
        set = new Set();
        judgeStreamListeners.set(id, set);
      }
      set.add(listener);

      // Send a snapshot of the current job so a late subscriber can render
      // status immediately rather than waiting for the next event.
      const job = activeRejudgeJobs.get(id);
      if (job) {
        await stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify({ status: job.status, completedPasses: job.completedPasses, totalPasses: job.totalPasses }),
        });
        if (job.status !== "running") {
          // Job already finished — let the client close right away.
          await stream.writeSSE({ event: "done", data: JSON.stringify({ type: "done", passes: job.completedPasses }) });
          alive = false;
        }
      } else {
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ status: "no-job" }) });
        alive = false;
      }

      const heartbeat = setInterval(async () => {
        if (!alive) return;
        try { await stream.writeSSE({ event: "heartbeat", data: "{}" }); }
        catch { alive = false; }
      }, 30_000);

      stream.onAbort(() => {
        alive = false;
        const s = judgeStreamListeners.get(id);
        if (s) {
          s.delete(listener);
          if (s.size === 0) judgeStreamListeners.delete(id);
        }
        clearInterval(heartbeat);
      });

      while (alive) {
        await Bun.sleep(500);
      }
      const s = judgeStreamListeners.get(id);
      if (s) {
        s.delete(listener);
        if (s.size === 0) judgeStreamListeners.delete(id);
      }
      clearInterval(heartbeat);
    });
  });

  app.post("/api/benchmark/runs/:id/rejudge", async (c) => {
    const id = c.req.param("id");
    if (activeRejudgeJobs.get(id)?.status === "running") {
      return c.json({ error: "A re-judge job for this run is already in progress" }, 409);
    }
    let body: { passes?: number; judgePromptPath?: string; budgetUsd?: number };
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const passes = Math.max(1, Math.min(10, Math.floor(body.passes ?? 3)));

    const parent = await getBenchmarkRun(id);
    if (!parent) return c.json({ error: "Parent run not found" }, 404);
    if (parent.parentRunId) {
      return c.json(
        {
          error:
            "Cannot re-judge a re-judge pass — open the original parent run and re-judge from there.",
        },
        400,
      );
    }

    const job: RejudgeJobState = {
      parentRunId: id,
      totalPasses: passes,
      completedPasses: 0,
      startedAt: Date.now(),
      status: "running",
      error: null,
      childRunIds: [],
    };
    activeRejudgeJobs.set(id, job);

    // Fire-and-forget — the route returns immediately, the client polls
    // /api/benchmark/runs/:id/rejudge-children to see progress and (when
    // it cares about live deltas) opens an SSE on /judge-stream.
    void (async () => {
      // Track which pass we're on by intercepting passIndex in the callback.
      // rejudge.ts runs passes sequentially so this stays in lockstep.
      let lastPassIndex = -1;
      try {
        const result = await rejudgeCandidate(id, {
          passes,
          judgePromptPath: body.judgePromptPath,
          budgetUsd: body.budgetUsd,
          onProgress: (ev) => {
            if (ev.passIndex !== lastPassIndex) {
              if (lastPassIndex >= 0) {
                emitJudgeStream(id, { type: "pass_end", passIndex: lastPassIndex });
              }
              emitJudgeStream(id, { type: "pass_start", passIndex: ev.passIndex, total: passes });
              lastPassIndex = ev.passIndex;
            }
            if (ev.type === "text_delta" && ev.text) {
              emitJudgeStream(id, { type: "delta", passIndex: ev.passIndex, text: ev.text });
            }
          },
        });
        if (lastPassIndex >= 0) {
          emitJudgeStream(id, { type: "pass_end", passIndex: lastPassIndex });
        }
        emitJudgeStream(id, { type: "done", passes: result.passes.length });
        job.completedPasses = result.passes.length;
        job.childRunIds = result.passes.map((p) => p.runId);
        job.status = "done";
        log.info("Re-judge done for {parentRunId}: mean hit={meanHit}", {
          parentRunId: id,
          meanHit: result.meanHitRate,
          passes: result.passes.length,
        });
        // Leave the done state in the map for 5 min so a page refresh
        // right after completion can still show "just finished".
        setTimeout(() => activeRejudgeJobs.delete(id), 5 * 60 * 1000);
      } catch (err) {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
        emitJudgeStream(id, { type: "error", error: job.error });
        log.error("Re-judge failed for {parentRunId}: {error}", {
          parentRunId: id,
          error: job.error,
        });
        setTimeout(() => activeRejudgeJobs.delete(id), 5 * 60 * 1000);
      }
    })();

    return c.json({ ok: true, parentRunId: id, passes }, 202);
  });
}
