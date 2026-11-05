import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { e2eEnv } from "./e2e-env.ts";
import { e2ePort } from "./ports.ts";
import { TEST_DATABASE_URL as TEST_DB } from "../src/test/test-db-url.ts";

/**
 * `/agents` Recently finished after a process restart.
 *
 * A fresh process has an empty completed-runs ring, so anything this page lists for a
 * ring kind comes from a stamped span in Postgres. This spec writes the spans
 * `finishAgentRunTrace` writes, reads the page, restarts muninn and reads it again. The
 * reverse half, one run present in both sources, cannot exist in a fresh process and is
 * pinned in `src/dashboard/agents-overview.test.ts`.
 *
 * ENV PREREQUISITE: `bun run db:setup:test`. Ports come from `e2e/ports.ts`.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PORT = e2ePort("agents-recent-durable");
const BASE = `http://127.0.0.1:${PORT}`;
const BOT = "e2eagentsrecent";

let server: ChildProcess | undefined;
let botsRoot: string | undefined;
let sql: ReturnType<typeof postgres> | undefined;
const traceIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

async function startServer(): Promise<void> {
  server = spawn("bun", ["run", "src/index.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...e2eEnv(),
      DATABASE_URL: TEST_DB,
      DASHBOARD_PORT: String(PORT),
      DASHBOARD_HOST: "127.0.0.1",
      SCHEDULER_ENABLED: "false",
      MUNINN_BOTS_DIR: botsRoot!,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${BASE}/api/live`)).ok) return;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error("dedicated muninn did not start on port " + PORT);
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function stopServer(): Promise<void> {
  if (!server) return;
  server.kill("SIGTERM");
  server = undefined;
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await fetch(`${BASE}/api/live`);
    } catch {
      return;
    }
    if (Date.now() > deadline) throw new Error("the muninn on port " + PORT + " did not stop");
    await new Promise((r) => setTimeout(r, 200));
  }
}

function cleanup(): void {
  if (botsRoot) rmSync(botsRoot, { recursive: true, force: true });
  botsRoot = undefined;
}

function handleSignal(signal: NodeJS.Signals): void {
  server?.kill("SIGTERM");
  cleanup();
  removeSignalHandlers();
  process.kill(process.pid, signal);
}
const onSigint = () => handleSignal("SIGINT");
const onSigterm = () => handleSignal("SIGTERM");
function removeSignalHandlers(): void {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

async function insertSpan(traceId: string, name: string, status: string, attributes: Record<string, unknown>) {
  await sql!`
    INSERT INTO traces (id, trace_id, parent_id, name, kind, status, bot_name, started_at, duration_ms, attributes)
    VALUES (${crypto.randomUUID()}, ${traceId}, NULL, ${name}, 'root', ${status}, ${BOT},
            now() - interval '5 minutes', 42000, ${sql!.json(attributes as never)})
  `;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  botsRoot = mkdtempSync(path.join(tmpdir(), "muninn-e2e-agents-recent-"));
  mkdirSync(path.join(botsRoot, BOT), { recursive: true });
  writeFileSync(path.join(botsRoot, BOT, "CLAUDE.md"), "# e2e agents recent bot\n");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  sql = postgres(TEST_DB, { max: 2 });
  await insertSpan(traceIds[0]!, "capture:youtube", "ok", {
    agentKind: "capture",
    agentName: "YouTube: a talk that finished",
    model: "claude-sonnet-5",
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.42,
  });
  await insertSpan(traceIds[1]!, "wiki_digest", "error", {
    agentKind: "digest",
    agentName: "Wiki digest: a digest that failed",
    error: "connector down",
  });
  // A root with no stamp is what every trace before the stamp looks like.
  await insertSpan(traceIds[2]!, "wiki_digest", "ok", { wiki: "a digest from before the stamp" });

  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  if (sql) {
    await sql`DELETE FROM traces WHERE trace_id IN ${sql(traceIds)}`;
    await sql.end();
  }
  cleanup();
  removeSignalHandlers();
});

const row = (page: import("@playwright/test").Page, name: string) => page.locator(".rf-row", { hasText: name });

for (const when of ["with an empty ring", "after a restart"]) {
  test(`stamped runs are listed ${when}`, async ({ page }) => {
    if (when === "after a restart") {
      await stopServer();
      await startServer();
    }
    await page.goto(`${BASE}/agents`);

    const finished = row(page, "YouTube: a talk that finished");
    await expect(finished).toHaveCount(1);
    await expect(finished).not.toHaveClass(/failed/);
    await expect(finished.locator(".rf-cost")).toHaveText("$0.42");
    await expect(finished.locator(".rf-dur")).toHaveText("42.0s");
    await expect(finished).toContainText("claude-sonnet-5");
    await expect(finished.locator(".run-link")).toHaveAttribute("href", `/traces#${traceIds[0]}`);

    const failed = row(page, "Wiki digest: a digest that failed");
    await expect(failed).toHaveCount(1);
    await expect(failed).toHaveClass(/failed/);

    const res = await page.request.get(`${BASE}/api/agents/overview`);
    const body = (await res.json()) as { recent: { traceId?: string }[] };
    expect(body.recent.filter((r) => r.traceId === traceIds[2])).toEqual([]);
  });
}
