import { test, expect } from "bun:test";
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
};

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
