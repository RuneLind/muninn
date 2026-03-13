import type { Hono } from "hono";
import type { Config } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { renderLogsPage } from "../views/logs-page.ts";

const log = getLog("dashboard");

/** Read and parse a JSONL log file, returning parsed entries. */
async function readLogEntries(logDir: string, date: string): Promise<Record<string, unknown>[]> {
  const filePath = `${logDir}/${date}.log`;
  const file = Bun.file(filePath);
  if (!(await file.exists())) return [];
  const text = await file.text();
  return text.trim().split("\n").filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export function registerLogsRoutes(app: Hono, config: Config): void {
  const LOG_DIR = config.logDir;

  app.get("/logs", (c) => {
    return c.html(renderLogsPage());
  });

  app.get("/api/logs/dates", async (c) => {
    try {
      const glob = new Bun.Glob("*.log");
      const dates: string[] = [];
      for await (const file of glob.scan(LOG_DIR)) {
        const match = file.match(/^(\d{4}-\d{2}-\d{2})\.log$/);
        if (match && match[1]) dates.push(match[1]);
      }
      dates.sort((a, b) => b.localeCompare(a)); // newest first
      return c.json({ dates });
    } catch (err) {
      log.error("Failed to scan log dates: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ dates: [] });
    }
  });

  app.get("/api/logs", async (c) => {
    try {
      const date = c.req.query("date");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: "Invalid date format" }, 400);
      }
      const entries = await readLogEntries(LOG_DIR, date);
      return c.json({ entries });
    } catch (err) {
      log.error("Failed to read log file: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to read logs" }, 500);
    }
  });

  app.get("/api/logs/tail", async (c) => {
    try {
      const date = c.req.query("date");
      const after = c.req.query("after");
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return c.json({ error: "Invalid date format" }, 400);
      }
      if (!after) {
        return c.json({ error: "Missing 'after' parameter" }, 400);
      }
      const entries = (await readLogEntries(LOG_DIR, date))
        .filter((e) => (e as { ts: string }).ts > after);
      return c.json({ entries });
    } catch (err) {
      log.error("Failed to tail log file: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "Failed to tail logs" }, 500);
    }
  });
}
