import { getLog } from "../logging.ts";
import { peerNameFor } from "./peer-name.ts";
import type { ChatState, ChatMessage } from "../chat/state.ts";
import type { Platform } from "../types.ts";
import type { BotConfig } from "../bots/config.ts";
import type { Config } from "../config.ts";
import { saveMessage } from "../db/messages.ts";
import { getOrCreatePeerThread, getThreadById, setThreadAutoRespondPaused } from "../db/threads.ts";
import { getBotDefaultUser } from "../db/chat-preferences.ts";
import { getUser } from "../db/users.ts";
import { processMessage as defaultProcessMessage } from "../core/message-processor.ts";
import type { processMessage as ProcessMessageFn } from "../core/message-processor.ts";
import { Tracer } from "../tracing/index.ts";
import { checkAutoRespond } from "./loop-guard.ts";
import { DEFAULT_MAX_AUTO_TURNS_PER_HOUR } from "./config.ts";
import { getPendingPeer, setPendingPeer, clearPendingPeer } from "./correlation.ts";
import { getThreadByCorrelationToken, clearCorrelationToken } from "./correlation-tokens.ts";
import { interpretHandoffReply, type InterpretResult } from "./handoff-interpreter.ts";
import { getDevRunById, claimForVerify } from "../db/dev-runs.ts";
import { buildOrchestratePrompt, handoffPathsFor } from "./devloop-prompts.ts";
import { broadcastDevRun } from "../chat/dev-run-broadcast.ts";
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
  /** Opaque token the reply echoed, if any. Resolved against the minted-token
   *  store first (the precise path); absent/foreign tokens fall back to the
   *  `(bot, peer)` table. */
  correlationId?: string;
}

// `peerNameFor` now lives in `peer-name.ts` (shared with delegate_task's handoff
// recording, so both sides of the (run_id, peer_name) join derive it identically).
// Imported above for internal use; re-exported here so existing importers
// (router.test.ts, config docs) keep working unchanged.
export { peerNameFor };

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

  /**
   * In-flight handoff-interpret promise (Phase 4) — same test-only seam as
   * `pendingAutorespond`. The interpreter parses a peer's `run:<id>` marker and
   * rolls up the dev_run off the delivery path; failures are logged, never
   * surfaced to inbound delivery.
   */
  pendingHandoffInterpret: Promise<void> = Promise.resolve();

  /**
   * In-flight auto-advance promise (Phase 6a / v2) — same test-only seam as the
   * two above. After the interpreter rolls a run up, this fires the autonomous
   * code-triggered turn (auto-orchestrate) when the bot opted in. No-op (and
   * v1's park-and-confirm stands) unless `hivemind.devLoop.autoOrchestrate` is on.
   * Tests await `pendingHandoffInterpret` then this.
   */
  pendingAdvanceRun: Promise<void> = Promise.resolve();

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
    //
    // Caveat: correlation is keyed (botName, peerId) last-write-wins, so if two
    // users message the SAME peer on the SAME bot near-simultaneously, the later
    // outbound overwrites the binding and the peer's reply routes to that user's
    // thread. Dropping the old `t.userId === userId` guard widens the blast
    // radius of that race from "default-user only" to any user. Rare for the
    // single-primary-user bots we run today; the real fix is per-turn
    // correlation tokens (bind threadId per MCP session) — see CLAUDE.md.
    let thread: Awaited<ReturnType<typeof getThreadById>> = null;

    // Precise path first: if the reply echoed a token, resolve it against the
    // minted-token store. Only tokens muninn issued resolve, so a foreign or
    // absent token simply misses and we drop to the (bot, peer) fallback below.
    // Same #136 validation as the fallback (bot match; user derived from thread).
    if (msg.correlationId) {
      const tokenThreadId = await getThreadByCorrelationToken(botName, msg.correlationId);
      if (tokenThreadId) {
        const t = await getThreadById(tokenThreadId);
        if (t && t.botName === botName) {
          thread = t;
        } else {
          // Thread deleted or belongs to another bot — the token is stale.
          if (t) {
            log.warn(
              "Stale correlation token for {botName}/{cid} → thread {threadId} (bot mismatch). Falling back.",
              { botName, cid: msg.correlationId, threadId: tokenThreadId },
            );
          }
          await clearCorrelationToken(botName, msg.correlationId);
        }
      }
    }

    // Fallback: the (bot, peer) last-write-wins table — covers replies that
    // carried no token (raw peers that didn't echo, or pre-broker-rollout).
    if (!thread) {
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
    // Pass the user's real name so a peer-recreated conversation shell isn't
    // stamped with the "chat-user" placeholder (which a later typed message
    // would otherwise persist over the user's real username).
    const user = await getUser(userId);

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
      this.chatState.findOrCreateBotConversation({ botName, userId, username: user?.username }),
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

    // Phase 4: interpret a handoff reply (run:<id> marker → dev_run roll-up) off
    // the delivery path, AFTER persist/broadcast — a parse failure must never
    // block inbound delivery. Cheap no-op (a regex miss) for ordinary chatter.
    this.pendingHandoffInterpret = interpretHandoffReply({
      botName,
      peerName,
      text: msg.text,
      routedThreadId: thread.id,
      deps: { getBotDir: (name) => this.autorespondDeps?.getBotConfig(name)?.dir },
    })
      .then(async (result) => {
        // Phase 5: push the rolled-up run to any open chat tab so the live run
        // card + per-handoff rows update without a refresh. Best-effort — a
        // broadcast failure must not surface to inbound delivery either.
        if (result.runId) await broadcastDevRun(this.chatState, { runId: result.runId });
        // Phase 6a / v2: autonomously advance the run (auto-fire orchestrate)
        // when the bot opted in. Off the interpret promise as its own seam so a
        // slow bot turn doesn't hold the interpret chain; no-op when not opted in.
        this.pendingAdvanceRun = this.maybeAdvanceRun(result).catch((err) => {
          log.error("Auto-advance failed: {error}", {
            botName, peerName, fromId: msg.fromId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      })
      .catch((err) => {
        log.error("Handoff interpret failed: {error}", {
          botName, peerName, fromId: msg.fromId,
          error: err instanceof Error ? err.message : String(err),
        });
      });

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
        // Replying → echo the inbound token verbatim (never mint a fresh one),
        // so the peer that initiated can resolve our reply against its own
        // store. Rule: initiating → mint+store (mcp-server / chat `>`);
        // replying → echo. Undefined when the inbound carried no token.
        outboundSent = client?.sendMessage(args.msg.fromId, result.responseText, args.msg.correlationId) ?? false;
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

  /**
   * Phase 6a / v2 — autonomously advance a run past the verify gate. When the
   * interpreter rolls a run up to `ready_to_verify` (build ∧ test done) and the
   * bot opted into `hivemind.devLoop.autoOrchestrate`, fire the orchestrate turn
   * here instead of parking for the user's confirm. This is a CODE-TRIGGERED bot
   * turn on the research thread (no peer to relay to — the bot's own
   * `delegate_task` does the outbound), the same shape as `maybeAutorespond`.
   *
   * Guards, in order: opt-in flag → an **atomic CAS claim** (`ready_to_verify →
   * verifying`, so two concurrent interpreter invocations can't both fire) →
   * the loop-guard hourly cap. Off by default ⇒ v1 park-and-confirm is unchanged.
   */
  private async maybeAdvanceRun(result: InterpretResult): Promise<void> {
    const deps = this.autorespondDeps;
    if (!deps) return;
    if (result.runStatus !== "ready_to_verify" || !result.runId) return;

    const run = await getDevRunById(result.runId);
    if (!run || !run.threadId) return;
    const threadId = run.threadId;

    const botCfg = deps.getBotConfig(run.botName);
    // Opt-in only — absent flag keeps v1's park-and-confirm.
    if (!botCfg?.hivemind?.devLoop?.autoOrchestrate) return;

    // Atomic claim: only one concurrent interpret wins the right to fire
    // orchestrate (build-done + test-done markers can roll up in parallel).
    const claimed = await claimForVerify(run.id);
    if (!claimed) return;
    // Reflect the verifying status immediately so the (now-moot) orchestrate
    // confirm button — gated on ready_to_verify — doesn't render in open tabs.
    await broadcastDevRun(this.chatState, { runId: run.id });

    // Loop-guard backstop on the research thread (a flapping run can't spin).
    const thread = await getThreadById(threadId);
    if (!thread) return;
    const maxPerHour = botCfg.hivemind.maxAutoTurnsPerHour ?? DEFAULT_MAX_AUTO_TURNS_PER_HOUR;
    const decision = await checkAutoRespond({
      threadId,
      alreadyPaused: thread.autoRespondPaused,
      maxTurnsPerHour: maxPerHour,
    });
    if (!decision.allowed) {
      log.warn("Auto-orchestrate skipped on run {run}: {reason}", {
        botName: run.botName, run: run.id, reason: decision.reason,
      });
      return;
    }

    const user = await getUser(run.userId);
    const conv = await this.chatState.findOrCreateBotConversation({
      botName: run.botName, userId: run.userId, username: user?.username,
    });
    const { specPath } = handoffPathsFor(botCfg.dir, run.userId, run.issueKey);

    const tracer = new Tracer("devloop_autostep", {
      botName: run.botName, userId: run.userId, username: user?.username ?? run.userId, platform: "web",
    });
    tracer.event("auto_orchestrate", { runId: run.id, issueKey: run.issueKey });

    const runProcessMessage = deps.processMessage ?? defaultProcessMessage;
    try {
      const turn = await runProcessMessage({
        text: buildOrchestratePrompt(specPath),
        userId: run.userId,
        username: user?.username ?? run.userId,
        platform: "web",
        botConfig: botCfg,
        config: deps.config,
        say: async (message: string) => {
          this.chatState.appendBotMessage(conv.id, message, threadId);
        },
        threadId,
        // The orchestrate prompt is an internal instruction, not a user message —
        // don't persist it; `text` still reaches the model (assemblePrompt uses it).
        skipUserSave: true,
        tracer,
      });
      tracer.finish("ok", { inputTokens: turn?.inputTokens, outputTokens: turn?.outputTokens });
      log.info("Auto-fired orchestrate for run {run} ({issueKey})", {
        botName: run.botName, run: run.id, issueKey: run.issueKey,
      });
    } catch (err) {
      tracer.error(err instanceof Error ? err : String(err));
      throw err;
    }

    // Re-broadcast so the new orchestrate handoff row shows live.
    await broadcastDevRun(this.chatState, { runId: run.id });
  }
}
