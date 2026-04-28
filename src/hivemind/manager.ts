import { getLog } from "../logging.ts";
import type { BotConfig } from "../bots/config.ts";
import { ensureBrokerRunning, brokerPort } from "./broker.ts";
import { HivemindBotClient } from "./client.ts";
import { HivemindMcpServer } from "./mcp-server.ts";

const log = getLog("hivemind", "manager");

/**
 * Singleton that owns one HivemindBotClient per enabled bot plus the shared
 * HTTP MCP server. Started from `src/index.ts` after DB init.
 *
 * Phase 1: each bot uses the FIRST namespace from its config. Multi-namespace
 * (one client per namespace per bot) lands in Phase 4.
 */
export class HivemindManager {
  private clients = new Map<string, HivemindBotClient>();
  private mcpServer = new HivemindMcpServer();
  private started = false;

  /**
   * Initialize all bots that have `hivemind.enabled = true` in their config.
   * Best-effort — failures don't crash Muninn boot.
   */
  async start(allBotConfigs: BotConfig[]): Promise<void> {
    if (this.started) return;

    const enabledBots = allBotConfigs.filter((b) => b.hivemind?.enabled);
    if (enabledBots.length === 0) {
      log.info("No bots have hivemind.enabled — skipping startup");
      return;
    }

    const brokerOk = await ensureBrokerRunning();
    if (!brokerOk) {
      log.warn(
        "Hivemind broker is not available — bot peer connections will not be established. " +
          "Install claude-hivemind at ~/source/private/claude-hivemind or set HIVEMIND_BROKER_SCRIPT.",
      );
      return;
    }

    this.mcpServer.start();
    this.started = true;

    for (const bot of enabledBots) {
      const cfg = bot.hivemind!;
      // Phase 1: take the first namespace only. Phase 4 will iterate all of them.
      const namespace = cfg.namespaces[0];
      if (!namespace) {
        log.warn("Bot {botName} has hivemind.enabled but no namespaces — skipping", { botName: bot.name });
        continue;
      }
      if (cfg.namespaces.length > 1) {
        log.info(
          "Bot {botName} configured for {count} namespaces — Phase 1 only joins the first ({first}). Multi-namespace lands in Phase 4.",
          { botName: bot.name, count: cfg.namespaces.length, first: namespace },
        );
      }

      const client = new HivemindBotClient({
        botName: bot.name,
        namespace,
        cwd: bot.dir,
        summary: cfg.summary ?? `${bot.name} (Muninn) — ${bot.persona.split("\n")[0]?.slice(0, 80) ?? ""}`,
        brokerPort: brokerPort(),
      });
      client.start();

      this.clients.set(bot.name, client);
      this.mcpServer.registerBot(bot.name, client);

      log.info(
        "Bot {botName} hivemind active (namespace={ns}, MCP url={url}/mcp/{botName})",
        { botName: bot.name, ns: namespace, url: this.mcpServer.url },
      );
    }
  }

  /** Get a client by bot name — used by chat UI / dashboard panels later. */
  getClient(botName: string): HivemindBotClient | null {
    return this.clients.get(botName) ?? null;
  }

  /** All currently active clients. */
  allClients(): HivemindBotClient[] {
    return Array.from(this.clients.values());
  }

  /** Whether the manager has been started. */
  get isStarted(): boolean {
    return this.started;
  }

  /** Hivemind MCP server URL (for diagnostics / dashboard). */
  get mcpServerUrl(): string {
    return this.mcpServer.url;
  }

  /** Shut down all clients and the MCP server. */
  async stop(): Promise<void> {
    for (const c of this.clients.values()) {
      await c.stop();
    }
    this.clients.clear();
    await this.mcpServer.stop();
    this.started = false;
  }
}

export const hivemindManager = new HivemindManager();
