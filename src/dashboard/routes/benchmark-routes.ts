import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import {
  listBenchmarkRuns,
  getBenchmarkRun,
  listRejudgeChildren,
} from "../../db/benchmark-runs.ts";
import { rejudgeCandidate } from "../../benchmarks/rejudge.ts";
import {
  renderBenchmarkListPage,
  renderBenchmarkDetailPage,
} from "../views/benchmark-page.ts";

const log = getLog("dashboard", "benchmark");

/** In-flight re-judge jobs keyed by parent run id. */
interface RejudgeJobState {
  parentRunId: string;
  totalPasses: number;
  completedPasses: number;
  startedAt: number;
  status: "running" | "done" | "error";
  error: string | null;
  childRunIds: string[];
}

const activeRejudgeJobs = new Map<string, RejudgeJobState>();

export function registerBenchmarkRoutes(app: Hono): void {
  app.get("/benchmark", async (c) => {
    try {
      const runs = await listBenchmarkRuns(50);
      return c.html(renderBenchmarkListPage(runs));
    } catch (err) {
      log.error("Failed to render benchmark list: {error}", {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.html("Failed to load benchmark runs", 500);
    }
  });

  app.get("/benchmark/runs/:id", async (c) => {
    try {
      const id = c.req.param("id");
      const run = await getBenchmarkRun(id);
      if (!run) return c.html("Benchmark run not found", 404);
      const children = run.parentRunId ? [] : await listRejudgeChildren(id);
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
    // /api/benchmark/runs/:id/rejudge-children to see progress.
    void (async () => {
      try {
        const result = await rejudgeCandidate(id, {
          passes,
          judgePromptPath: body.judgePromptPath,
          budgetUsd: body.budgetUsd,
        });
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
