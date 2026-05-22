import { basename } from "node:path";
import { getLog } from "../logging.ts";
import type { ChatState, ChatMessage } from "../chat/state.ts";
import type { Platform } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { saveMessage } from "../db/messages.ts";
import { getOrCreatePeerThread, getThreadById, setThreadAutoRespondPaused } from "../db/threads.ts";
import { getBotDefaultUser } from "../db/chat-preferences.ts";
import { processMessage as defaultProcessMessage } from "../core/message-processor.ts";
import type { processMessage as ProcessMessageFn } from "../core/message-processor.ts";
import { Tracer } from "../tracing/index.ts";
import { checkAutoRespond } from "./loop-guard.ts";
import { DEFAULT_MAX_AUTO_TURNS_PER_HOUR } from "./config.ts";
import { getPendingPeer, setPendingPeer, clearPendingPeer } from "./correlation.ts";
import type { HivemindBotClient } from "./client.ts";
import type { Namespace } from "./types.ts";

const log = getLog("hivemind", "router");

export interface InboundPeerMessage {
  fromId: string;
  fromSummary: string;
  fromCwd: string;
  text: string;
  sentAt: string;
  /** Namespace the inbound WebSocket is registered in. Outbound autorespond
   *  goes back through the same namespace's client. */
  namespace: Namespace;
}

/**
 * Stable across peer reconnects — the broker's `from_id` UUID rotates per
 * session, but cwd basename does not.
 */
export function peerNameFor(msg: { fromCwd: string; fromSummary: string; fromId: string }): string {
  const cwdBase = basename(msg.fromCwd).trim();
  if (cwdBase) return cwdBase;
  const summarySlug = msg.fromSummary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (summarySlug) return summarySlug;
  return `peer-${msg.fromId.slice(0, 8)}`;
}

/**
 * Wires a full bot turn (prompt build + connector + DB save + chat broadcast)
 * into the inbound-peer-message router. When omitted, the router degrades to
 * inbound-only routing (no autonomous bot reply).
 */
export interface AutorespondDeps {
  getBotConfig: (botName: string) => BotConfig | undefined;
  /** Get the client for a specific (bot, namespace) — outbound autorespond
   *  must go through the same WS the inbound arrived on. */
  getClient: (botName: string, namespace: Namespace) => HivemindBotClient | null;
  config: Config;
  /** Defaults to the real `processMessage` from `core/message-processor.ts`.
   *  Tests inject a stub to avoid spinning up a real AI connector. */
  processMessage?: typeof ProcessMessageFn;
}

/** Build a peer thread name from the inbound namespace + cwd basename. */
export function peerThreadNameFor(msg: { namespace: Namespace; fromCwd: string; fromSummary: string; fromId: string }): string {
  return `peer:${msg.namespace}/${peerNameFor(msg)}`;
}

/** Parse `peer:<namespace>/<basename>` into its parts. Returns null if the
 *  thread name doesn't match the namespaced format (e.g. legacy unmigrated row). */
export function parsePeerThreadName(name: string): { namespace: Namespace; peerName: string } | null {
  if (!name.startsWith("peer:")) return null;
  const rest = name.slice("peer:".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0 || slashIdx === rest.length - 1) return null;
  return { namespace: rest.slice(0, slashIdx), peerName: rest.slice(slashIdx + 1) };
}

export class HivemindRouter {
  /**
   * In-flight autorespond promise — exposed for tests so they can await the
   * fire-and-forget branch. Production callers don't need this; failures are
   * logged via the `.catch` in `route()`.
   */
  pendingAutorespond: Promise<void> = Promise.resolve();

  constructor(
    private chatState: ChatState,
    private autorespondDeps?: AutorespondDeps,
  ) {}

  async route(botName: string, msg: InboundPeerMessage): Promise<string | null> {
    const peerName = peerNameFor(msg);

    // If this bot recently sent outbound to this peer from some thread, route
    // the reply back into that originating thread instead of the default
    // peer:<ns>/<peerName> bucket. Correlation is set by mcp-server.ts
    // (ask_peer/send_to_peer), chat/routes.ts (`>` outbound), and the
    // autorespond reply below.
    //
    // The originating thread can belong to ANY user — whoever was talking to
    // the peer — which is not necessarily the bot's default user. So we derive
    // the destination user from the correlated thread itself. The bot default
    // user is only used as a fallback for uncorrelated inbound (a peer reaching
    // out unsolicited, with no thread to anchor to).
    let thread: Awaited<ReturnType<typeof getThreadById>> = null;
    const correlatedThreadId = await getPendingPeer(botName, msg.fromId);
    if (correlatedThreadId) {
      const t = await getThreadById(correlatedThreadId);
      if (t && t.botName === botName) {
        thread = t;
      } else {
        // Thread was deleted, or belongs to another bot — the binding is stale.
        // Drop it so it can't keep mis-routing, then fall back below.
        if (t) {
          log.warn(
            "Stale peer correlation for {botName}/{fromId} → thread {threadId} (bot mismatch). Falling back to peer:<ns>/<name>.",
            { botName, fromId: msg.fromId, threadId: correlatedThreadId },
          );
        }
        await clearPendingPeer(botName, msg.fromId);
      }
    }

    if (!thread) {
      const defaultUserId = await getBotDefaultUser(botName);
      if (!defaultUserId) {
        log.warn(
          "Inbound peer message for bot {botName} dropped — no default user configured. " +
            "Set one via the chat page or POST /chat/bot-preferences/{botName}/default-user.",
          { botName, fromId: msg.fromId },
        );
        return null;
      }
      thread = await getOrCreatePeerThread(defaultUserId, botName, `${msg.namespace}/${peerName}`);
    }

    const userId = thread.userId;

    const platform: Platform = "web";
    const [messageId, conv] = await Promise.all([
      saveMessage({
        userId,
        botName,
        role: "peer",
        content: msg.text,
        platform,
        threadId: thread.id,
        fromPeerId: msg.fromId,
      }),
      this.chatState.findOrCreateBotConversation({ botName, userId }),
    ]);

    const chatMessage: ChatMessage = {
      id: messageId,
      timestamp: new Date(msg.sentAt).getTime() || Date.now(),
      sender: "peer",
      text: msg.text,
      threadId: thread.id,
      fromPeerId: msg.fromId,
    };
    this.chatState.addMessage(conv.id, chatMessage);

    log.info(
      "Routed inbound peer message from {fromId} ({peerName}) to thread {threadName}",
      { botName, fromId: msg.fromId, peerName, threadName: thread.name },
    );

    // Phase 3: kick off an autonomous bot turn if the peer is on the allowlist
    // and loop guards permit. Errors are logged but never break inbound delivery.
    this.pendingAutorespond = this.maybeAutorespond({
      botName, userId, peerName, msg, thread, conversationId: conv.id,
    }).catch((err) => {
      log.error("Autorespond failed: {error}", {
        botName, peerName, fromId: msg.fromId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return messageId;
  }

  private async maybeAutorespond(args: {
    botName: string;
    userId: string;
    peerName: string;
    msg: InboundPeerMessage;
    thread: { id: string; name: string; autoRespondPaused: boolean };
    conversationId: string;
  }): Promise<void> {
    const deps = this.autorespondDeps;
    if (!deps) return;

    const botCfg = deps.getBotConfig(args.botName);
    const hiveCfg = botCfg?.hivemind;
    if (!botCfg || !hiveCfg) return;

    const allowlist = hiveCfg.autoRespondPeers ?? [];
    if (!allowlist.includes(args.peerName)) return;

    const maxPerHour = hiveCfg.maxAutoTurnsPerHour ?? DEFAULT_MAX_AUTO_TURNS_PER_HOUR;
    const decision = await checkAutoRespond({
      threadId: args.thread.id,
      alreadyPaused: args.thread.autoRespondPaused,
      maxTurnsPerHour: maxPerHour,
    });
    if (!decision.allowed) {
      if (decision.capHit) {
        await setThreadAutoRespondPaused(args.thread.id, true, decision.reason ?? null);
        log.warn(
          "Autorespond paused on thread {threadName} ({reason})",
          { botName: args.botName, threadName: args.thread.name, reason: decision.reason },
        );
      } else {
        log.debug(
          "Autorespond skipped on thread {threadName}: {reason}",
          { botName: args.botName, threadName: args.thread.name, reason: decision.reason },
        );
      }
      return;
    }

    const tracer = new Tracer("hivemind_autorespond", {
      botName: args.botName,
      userId: args.userId,
      username: args.peerName,
      platform: "web",
    });
    tracer.event("peer_inbound", {
      fromId: args.msg.fromId,
      peerName: args.peerName,
      fromCwd: args.msg.fromCwd,
      text: args.msg.text,
    });

    const runProcessMessage = deps.processMessage ?? defaultProcessMessage;
    try {
      const result = await runProcessMessage({
        text: args.msg.text,
        userId: args.userId,
        username: args.peerName,
        platform: "web",
        botConfig: botCfg,
        config: deps.config,
        say: async (message: string) => {
          this.chatState.appendBotMessage(args.conversationId, message, args.thread.id);
        },
        threadId: args.thread.id,
        skipUserSave: true,
        tracer,
      });

      let outboundSent = false;
      if (result) {
        const client = deps.getClient(args.botName, args.msg.namespace);
        outboundSent = client?.sendMessage(args.msg.fromId, result.responseText) ?? false;
        // Keep follow-up replies from this peer flowing into the same thread.
        if (outboundSent) await setPendingPeer(args.botName, args.msg.fromId, args.thread.id);
      }
      tracer.event("peer_outbound", {
        toId: args.msg.fromId,
        sent: outboundSent,
        length: result?.responseText.length ?? 0,
      });
      tracer.finish("ok", {
        inputTokens: result?.inputTokens,
        outputTokens: result?.outputTokens,
      });

      log.info(
        "Autoresponded to {peerName} on {threadName} ({chars} chars, sent={sent})",
        {
          botName: args.botName, peerName: args.peerName, threadName: args.thread.name,
          chars: result?.responseText.length ?? 0, sent: outboundSent,
        },
      );
    } catch (err) {
      tracer.error(err instanceof Error ? err : String(err));
      throw err;
    }
  }
}
