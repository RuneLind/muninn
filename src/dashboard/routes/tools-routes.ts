import type { Hono } from "hono";
import { getLog } from "../../logging.ts";
import { renderMcpDebugPage } from "../views/mcp-debug-page.ts";
import { renderSerenaPage } from "../views/serena-page.ts";
import { loadMcpConfig, connectToServer, callTool, disconnectServer } from "../mcp-client.ts";
import { serenaManager } from "../../serena/manager.ts";
import { discoverAllBots } from "../../bots/config.ts";

const log = getLog("dashboard");

const getBotConfigs = () => {
  try {
    // MCP debug doesn't need platform tokens — always discover all bots
    return discoverAllBots();
  } catch {
    return [];
  }
};

export function registerToolsRoutes(app: Hono): void {
  // --- MCP Debug page ---

  app.get("/mcp-debug", (c) => {
    return c.html(renderMcpDebugPage());
  });

  app.get("/api/mcp/bots", (c) => {
    const bots = getBotConfigs().map((b) => b.name);
    return c.json({ bots });
  });

  app.get("/api/mcp/config", async (c) => {
    const botName = c.req.query("bot");
    if (!botName) return c.json({ error: "Missing bot parameter" }, 400);

    const bot = getBotConfigs().find((b) => b.name === botName);
    if (!bot) return c.json({ error: "Bot not found" }, 404);

    const mcpConfig = await loadMcpConfig(bot.dir);
    if (!mcpConfig) return c.json({ error: "No .mcp.json found" }, 404);

    return c.json(mcpConfig);
  });

  app.post("/api/mcp/connect", async (c) => {
    try {
      const { bot: botName, server: serverName } = await c.req.json();
      if (!botName || !serverName) return c.json({ error: "Missing bot or server" }, 400);

      const bot = getBotConfigs().find((b) => b.name === botName);
      if (!bot) return c.json({ error: "Bot not found" }, 404);

      const mcpConfig = await loadMcpConfig(bot.dir);
      if (!mcpConfig?.mcpServers?.[serverName]) {
        return c.json({ error: "Server not found in config" }, 404);
      }

      const result = await connectToServer(botName, serverName, mcpConfig.mcpServers[serverName]);
      return c.json(result);
    } catch (err) {
      log.error("MCP connect failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : "Connection failed" }, 500);
    }
  });

  app.post("/api/mcp/call", async (c) => {
    try {
      const body = await c.req.json();
      const { bot: botName, server: serverName, tool: toolName } = body;
      const args = body.arguments || {};
      if (!botName || !serverName || !toolName) {
        return c.json({ error: "Missing bot, server, or tool" }, 400);
      }

      const result = await callTool(botName, serverName, toolName, args);
      return c.json(result);
    } catch (err) {
      log.error("MCP call failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : "Call failed" }, 500);
    }
  });

  app.post("/api/mcp/disconnect", async (c) => {
    try {
      const { bot: botName, server: serverName } = await c.req.json();
      if (!botName || !serverName) return c.json({ error: "Missing bot or server" }, 400);

      await disconnectServer(botName, serverName);
      return c.json({ ok: true });
    } catch (err) {
      log.error("MCP disconnect failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: err instanceof Error ? err.message : "Disconnect failed" }, 500);
    }
  });

  // --- Serena MCP Proxy ---

  app.get("/serena", (c) => {
    return c.html(renderSerenaPage());
  });

  app.get("/api/serena/instances", (c) => {
    const proxy = serenaManager.getToolProxy();
    const instances = serenaManager.getInstances().map((inst) => ({
      name: inst.config.name,
      displayName: inst.config.displayName,
      projectPath: inst.config.projectPath,
      port: inst.config.port,
      botName: inst.botName,
      status: inst.status,
      error: inst.error,
      startedAt: inst.startedAt,
      mcpUrl: inst.mcpUrl,
      dashboardUrl: inst.dashboardUrl,
    }));
    return c.json({
      instances,
      proxy: {
        running: proxy.isRunning,
        mcpUrl: proxy.isRunning ? proxy.mcpUrl : null,
        toolCount: proxy.toolCount,
        serverCount: proxy.serverCount,
      },
    });
  });

  app.post("/api/serena/:name/start", async (c) => {
    const name = c.req.param("name");
    if (!serenaManager.getInstance(name)) return c.json({ error: `Unknown Serena instance: ${name}` }, 404);
    try {
      await serenaManager.start(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/serena/:name/stop", async (c) => {
    const name = c.req.param("name");
    if (!serenaManager.getInstance(name)) return c.json({ error: `Unknown Serena instance: ${name}` }, 404);
    try {
      await serenaManager.stop(name);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/serena/:name/index", async (c) => {
    const name = c.req.param("name");
    const instance = serenaManager.getInstance(name);
    if (!instance) return c.json({ error: `Unknown Serena instance: ${name}` }, 404);
    if (instance.status === "running" || instance.status === "starting") return c.json({ error: `Stop ${name} before re-indexing` }, 400);
    // Fire and forget — indexing runs in the background, errors logged inside
    serenaManager.index(name).catch(() => {});
    return c.json({ ok: true });
  });
}
