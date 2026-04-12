import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { listBenchmarkRuns, getBenchmarkRun } from "../../db/benchmark-runs.ts";
import { renderBenchmarkListPage, renderBenchmarkDetailPage } from "../views/benchmark-page.ts";

const log = getLog("dashboard", "benchmark");

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
      return c.html(renderBenchmarkDetailPage(run));
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
}
