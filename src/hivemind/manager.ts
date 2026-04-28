import { getLog } from "../logging.ts";
import type { BotConfig } from "../bots/config.ts";
import { chatState } from "../chat/state.ts";
import { ensureBrokerRunning, brokerPort } from "./broker.ts";
import { HivemindBotClient } from "./client.ts";
import { HivemindMcpServer } from "./mcp-server.ts";
import { HivemindRouter } from "./router.ts";

const log = getLog("hivemind", "manager");

function defaultSummary(bot: BotConfig): string {
  const firstLine = bot.persona.split("\n")[0]?.trim().slice(0, 80) ?? "";
  return firstLine ? `${bot.name} (Muninn) — ${firstLine}` : `${bot.name} (Muninn)`;
}

export class HivemindManager {
  private clients = new Map<string, HivemindBotClient>();
  private mcpServer = new HivemindMcpServer();
  private router = new HivemindRouter(chatState);
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
      const namespace = cfg.namespaces[0]!;
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
        summary: cfg.summary ?? defaultSummary(bot),
        brokerPort: brokerPort(),
      });
      client.onIncomingMessage = (msg) => {
        this.router.route(bot.name, msg).catch((err) => {
          log.error("Router failed for inbound peer message: {error}", {
            botName: bot.name,
            fromId: msg.fromId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      };
      client.start();
      this.clients.set(bot.name, client);

      // exposeToTools=false leaves the peer connected (so messages still flow)
      // but skips MCP registration — the bot's Claude won't see the tools.
      if (cfg.exposeToTools !== false) {
        this.mcpServer.registerBot(bot.name, client);
      }

      log.info(
        "Bot {botName} hivemind active (namespace={ns}, MCP {mcp})",
        { botName: bot.name, ns: namespace, mcp: cfg.exposeToTools !== false ? `${this.mcpServer.url}/mcp/${bot.name}` : "disabled (exposeToTools=false)" },
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

  async stop(): Promise<void> {
    await Promise.all(Array.from(this.clients.values(), (c) => c.stop()));
    this.clients.clear();
    await this.mcpServer.stop();
    this.started = false;
  }
}

export const hivemindManager = new HivemindManager();
