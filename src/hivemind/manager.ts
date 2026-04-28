import { getLog } from "../logging.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { chatState } from "../chat/state.ts";
import { ensureBrokerRunning, brokerPort } from "./broker.ts";
import { HivemindBotClient } from "./client.ts";
import { HivemindMcpServer } from "./mcp-server.ts";
import { HivemindRouter } from "./router.ts";
import type { Namespace } from "./types.ts";

const log = getLog("hivemind", "manager");

function defaultSummary(bot: BotConfig): string {
  const firstLine = bot.persona.split("\n")[0]?.trim().slice(0, 80) ?? "";
  return firstLine ? `${bot.name} (Muninn) — ${firstLine}` : `${bot.name} (Muninn)`;
}

export class HivemindManager {
  /** Keyed by `clientKey(botName, namespace)` — one entry per joined namespace per bot. */
  private clients = new Map<string, HivemindBotClient>();
  private mcpServer = new HivemindMcpServer();
  private botConfigs = new Map<string, BotConfig>();
  // Router is created in start() once the real Config is available; nothing
  // routes inbound messages before start() returns, so the assertion is safe.
  private router!: HivemindRouter;
  private started = false;

  /**
   * Initialize all bots that have `hivemind.enabled = true` in their config.
   * Best-effort — failures don't crash Muninn boot.
   */
  async start(allBotConfigs: BotConfig[], config: Config): Promise<void> {
    if (this.started) return;
    this.router = new HivemindRouter(chatState, {
      getBotConfig: (name) => this.botConfigs.get(name),
      getClient: (name, ns) => this.getClient(name, ns),
      config,
    });

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
      this.botConfigs.set(bot.name, bot);
      const cfg = bot.hivemind!;

      for (const namespace of cfg.namespaces) {
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
              namespace: msg.namespace,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        };
        client.start();
        this.clients.set(`${bot.name}\x00${namespace}`, client);

        // exposeToTools=false leaves the peer connected (so messages still flow)
        // but skips MCP registration — the bot's Claude won't see the tools.
        if (cfg.exposeToTools !== false) {
          this.mcpServer.registerBotClient(bot.name, namespace, client);
        }
      }

      log.info(
        "Bot {botName} hivemind active (namespaces={namespaces}, MCP {mcp})",
        {
          botName: bot.name,
          namespaces: cfg.namespaces.join(","),
          mcp: cfg.exposeToTools !== false
            ? `${this.mcpServer.url}/mcp/${bot.name}`
            : "disabled (exposeToTools=false)",
        },
      );
    }
  }

  /** Get a client by (bot, namespace). Returns null if the bot isn't
   *  registered in that namespace. */
  getClient(botName: string, namespace: Namespace): HivemindBotClient | null {
    return this.clients.get(`${botName}\x00${namespace}`) ?? null;
  }

  /** Best-effort lookup when the namespace is unknown — returns the first
   *  registered client for the bot, in `cfg.namespaces` order. The only
   *  intended caller is the chat `>` outbound path's fallback for legacy
   *  unmigrated peer threads (`peer:<name>` rather than `peer:<ns>/<name>`). */
  getAnyClient(botName: string): HivemindBotClient | null {
    for (const c of this.clients.values()) {
      if (c.botName === botName) return c;
    }
    return null;
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
    this.botConfigs.clear();
    await this.mcpServer.stop();
    this.started = false;
  }
}

export const hivemindManager = new HivemindManager();
