import { test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import type { BotConfig } from "../../bots/config.ts";
import { registerModelsRoutes } from "./models-routes.ts";
import type { ModelsOverviewDeps } from "../models-overview.ts";

function bot(name: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    name,
    dir: `/bots/${name}`,
    persona: "",
    telegramAllowedUserIds: [],
    slackAllowedUserIds: [],
    ...over,
  } as BotConfig;
}

const DEPS: ModelsOverviewDeps = {
  discoverBots: () => [bot("jarvis"), bot("melosys", { connector: "copilot-sdk" })],
  getWatchers: async () => [],
  getHaikuUsage: async () => [],
  getChatModels: async () => [],
  getWikiRegistry: () => [],
};

// Isolate env knobs the assembly reads (Bun auto-loads the developer's .env,
// where e.g. HAIKU_DIRECT_ENABLED may be set).
const SAVED = { ...process.env };
beforeEach(() => {
  delete process.env.SUMMARIZER_BOT;
  delete process.env.RESEARCH_BOT;
  delete process.env.HAIKU_BACKEND;
  delete process.env.HAIKU_DIRECT_ENABLED;
  delete process.env.CLAUDE_MODEL;
});
afterEach(() => {
  process.env = { ...SAVED };
});

function appWith(deps: ModelsOverviewDeps): Hono {
  const app = new Hono();
  registerModelsRoutes(app, deps);
  return app;
}

test("GET /models renders the page (200 HTML)", async () => {
  const res = await appWith(DEPS).request("/models");
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Muninn - Models");
  expect(html).toContain("Pipeline jobs");
});

test("GET /api/models/overview returns 200 + the expected shape", async () => {
  const res = await appWith(DEPS).request("/api/models/overview?bot=jarvis");
  expect(res.status).toBe(200);
  const body = await res.json();

  expect(body.selectedBot).toBe("jarvis");
  expect(typeof body.generatedAt).toBe("number");
  expect(Array.isArray(body.bots)).toBe(true);
  expect(Array.isArray(body.roles)).toBe(true);
  expect(Array.isArray(body.pipeline)).toBe(true);

  const j = body.bots.find((b: any) => b.name === "jarvis");
  expect(j.connector.value).toBe("claude-cli");
  expect(j.haikuBackend.value).toBe("cli");

  // Roles always include the three global assignments.
  expect(body.roles.map((r: any) => r.role).some((s: string) => s.startsWith("Summarizer"))).toBe(true);
  expect(body.roles.map((r: any) => r.role).some((s: string) => s.startsWith("Research"))).toBe(true);
});

test("defaults bot to jarvis when ?bot= omitted", async () => {
  const res = await appWith(DEPS).request("/api/models/overview");
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.selectedBot).toBe("jarvis");
});

// ---- Edit endpoints: validation (400) paths (no DB / no file writes) -------

async function post(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test("POST /api/models/role rejects an unknown role", async () => {
  const { status, body } = await post(appWith(DEPS), "/api/models/role", { role: "NOPE", value: "jarvis" });
  expect(status).toBe(400);
  expect(body.error).toContain("unknown role");
});

test("POST /api/models/role rejects an invalid HAIKU_BACKEND value", async () => {
  const { status, body } = await post(appWith(DEPS), "/api/models/role", { role: "HAIKU_BACKEND", value: "gemini" });
  expect(status).toBe(400);
  expect(body.error).toContain("unknown HAIKU_BACKEND");
});

test("POST /api/models/role rejects a bot-role value naming no discovered bot", async () => {
  // discoverAllBots() reads the real bots/ dir; "definitely-not-a-bot" won't match.
  const { status, body } = await post(appWith(DEPS), "/api/models/role", {
    role: "SUMMARIZER_BOT",
    value: "definitely-not-a-bot",
  });
  expect(status).toBe(400);
  expect(body.error).toContain("no bot named");
});

test("POST /api/models/bot-config rejects an invalid connector with discovery's message", async () => {
  // Validation happens before the bot-folder check, so any bot name reaches it.
  const { status, body } = await post(appWith(DEPS), "/api/models/bot-config", {
    bot: "jarvis",
    field: "connector",
    value: "gpt-cli",
  });
  expect(status).toBe(400);
  expect(body.error).toBe(
    'Bot "jarvis" has unknown connector "gpt-cli" — valid values: claude-cli, copilot-sdk, openai-compat, claude-sdk',
  );
});

test("POST /api/models/bot-config rejects an unknown editable field", async () => {
  const { status, body } = await post(appWith(DEPS), "/api/models/bot-config", {
    bot: "jarvis",
    field: "timeoutMs",
    value: 999,
  });
  expect(status).toBe(400);
  expect(body.error).toContain("Unknown editable field");
});

test("POST /api/models/bot-config requires bot + field", async () => {
  const { status, body } = await post(appWith(DEPS), "/api/models/bot-config", { field: "model", value: "x" });
  expect(status).toBe(400);
  expect(body.error).toContain("required");
});
