import { getActiveGoals } from "../db/goals.ts";
import { getMemoriesForUser } from "../db/memories.ts";
import { getBotDefaultUser } from "../db/chat-preferences.ts";
import { getInterestProfile, upsertInterestProfile } from "../db/interest-profiles.ts";
import { callHaikuWithFallback } from "../ai/haiku-direct.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { HaikuBackend } from "../ai/haiku-direct.ts";
import { Tracer } from "../tracing/tracer.ts";
import { agentStatus } from "../observability/agent-status.ts";
import { getLog } from "../logging.ts";

const log = getLog("profile", "generator");

/** How many recent memories to feed the distiller. */
const MEMORY_LIMIT = 30;
/** Haiku call timeout for the (cheap, background) distillation. */
const REFRESH_TIMEOUT_MS = 60_000;
/**
 * Hard cap on a persisted profile. 4-8 bullets with a "why" clause lands well
 * under this; anything longer is runaway prose (or content the gate prompts
 * shouldn't carry) — reject rather than truncate, so a half-bullet never ships.
 */
const MAX_PROFILE_CHARS = 1500;
/** A valid profile has at least one markdown bullet line (the prompt's contract). */
const BULLET_LINE_RE = /^[-•*] /m;

/**
 * Shape-gate the model output before it is persisted for 7 days. The distiller
 * can return refusals, apologies, or prose instead of bullets; persisting that
 * would ride every gate prompt until the next refresh. Stale-but-valid beats
 * fresh-but-junk: on rejection the caller keeps the prior profile and the next
 * stale tick retries. Exported for tests.
 */
export function isValidProfileShape(profile: string): boolean {
  return profile.length <= MAX_PROFILE_CHARS && BULLET_LINE_RE.test(profile);
}

/** Options threaded to the Haiku router so the refresh honors the bot's backend. */
export interface RefreshOptions {
  connector?: ConnectorType;
  haikuBackend?: HaikuBackend;
}

const PROMPT_PREAMBLE = `You are distilling a persistent INTEREST PROFILE for a user of a personal AI assistant, from their active goals and recent memories below.

Write a compact 4-8 bullet profile of what this user cares about following and reading — the topics, domains, tools, and questions they'd want proactive alerts about, each with a short "why" clause. Focus on durable interests, not one-off tasks.

Rules:
- Output ONLY the bullets (markdown "- " lines), no preamble, no heading, no closing remark.
- Each bullet: a topic/domain + a short reason it matters to them.
- Do NOT include PII beyond the interests themselves (no names, emails, locations, employers, health details).
- If the inputs are thin, write fewer bullets rather than padding with generic ones.`;

function buildPrompt(
  goals: { title: string; description: string | null; tags: string[] }[],
  memories: { summary: string; tags: string[] }[],
): string {
  const goalLines = goals.length
    ? goals
        .map((g) => {
          const tags = g.tags.length ? ` [${g.tags.join(", ")}]` : "";
          const desc = g.description ? ` — ${g.description}` : "";
          return `- ${g.title}${desc}${tags}`;
        })
        .join("\n")
    : "(none)";
  const memoryLines = memories.length
    ? memories
        .map((m) => {
          const tags = m.tags.length ? ` [${m.tags.join(", ")}]` : "";
          return `- ${m.summary}${tags}`;
        })
        .join("\n")
    : "(none)";
  return `${PROMPT_PREAMBLE}

Active goals:
${goalLines}

Recent memories:
${memoryLines}`;
}

/**
 * Refresh (build + persist) the interest profile for a (user, bot) from the
 * user's active goals + recent memories via one cheap Haiku call. Skips silently
 * — writing NO row — when the user has neither goals nor memories, so an empty
 * user never gets a profile (and the watcher gates stay on the baseline alone).
 * Best-effort: a Haiku or DB error is logged and swallowed, never thrown.
 */
export async function refreshInterestProfile(
  userId: string,
  botName: string,
  opts: RefreshOptions = {},
): Promise<void> {
  // Declared out here so the `finally` settles them on EVERY path — including the
  // empty-output and shape-gate early returns, which neither throw nor fall
  // through to the end (a run registered but never completed would sit on the
  // /agents Running list until restart).
  let tracer: Tracer | undefined;
  let reqId: string | undefined;
  let usage: { inputTokens?: number; outputTokens?: number; numTurns?: number } = {};
  let model: string | undefined;
  let status: "ok" | "error" = "ok";

  try {
    const [goals, memories] = await Promise.all([
      getActiveGoals(userId, botName),
      getMemoriesForUser(userId, MEMORY_LIMIT, botName),
    ]);

    if (goals.length === 0 && memories.length === 0) {
      log.info("Skipping interest-profile refresh — no goals or memories", { botName, userId });
      return;
    }

    // Observability starts HERE, not at function entry: the skip above fires on
    // every tick for an empty user, and registering earlier would spam /agents
    // with flash-runs and /traces with empty traces. From this point on there IS
    // a model call to account for. `profile` was a declared AgentKind with no
    // producer until now — the weekly distillation ran entirely unobserved.
    tracer = new Tracer("interest_profile", { botName, userId, platform: "profile" });
    reqId = agentStatus.startRequest(botName, "calling_claude", undefined, {
      kind: "profile",
      name: `Interest profile: ${botName}`,
    });
    tracer.start("haiku", { goals: goals.length, memories: memories.length });

    const prompt = buildPrompt(goals, memories);
    const haiku = await callHaikuWithFallback(prompt, {
      source: "interest_profile",
      entrypoint: `${botName}-interest-profile`,
      botName,
      timeoutMs: REFRESH_TIMEOUT_MS,
      connector: opts.connector,
      haikuBackend: opts.haikuBackend,
      // The join: this refresh already builds a tracer above — hand it to the
      // router so the `interest_profile` haiku_usage row ties back to this trace
      // (NULL before; the span already stamps model/tokens itself at finish).
      tracer,
    });
    const { result } = haiku;

    usage = {
      inputTokens: haiku.inputTokens,
      outputTokens: haiku.outputTokens,
      ...(haiku.numTurns !== undefined ? { numTurns: haiku.numTurns } : {}),
    };
    model = haiku.model;
    tracer.end("haiku", { ...usage, model });
    if (model) agentStatus.setModel(reqId, model);

    const profile = result.trim();
    if (!profile) {
      log.warn("Interest-profile refresh produced empty output — leaving prior profile intact", { botName, userId });
      return;
    }
    // Shape gate: never persist a refusal/apology/prose blob for 7 days of gate
    // prompts. Stale-but-valid beats fresh-but-junk — the next stale tick retries.
    if (!isValidProfileShape(profile)) {
      log.warn(
        "Interest-profile refresh output failed shape gate ({len} chars, bullets={bullets}) — leaving prior profile intact",
        { botName, userId, len: profile.length, bullets: BULLET_LINE_RE.test(profile) },
      );
      return;
    }

    await upsertInterestProfile({
      userId,
      botName,
      profile,
      derivedFrom: { goals: goals.length, memories: memories.length },
    });
    log.info("Refreshed interest profile from {goals} goal(s) + {memories} memory/ies", {
      botName,
      userId,
      goals: goals.length,
      memories: memories.length,
    });
  } catch (err) {
    status = "error";
    const message = err instanceof Error ? err.message : String(err);
    // End the span too, not just the root: a Haiku call that throws (timeout,
    // backend down) still ran for a while, and an unended span carries no
    // duration at all in the waterfall.
    tracer?.end("haiku", { error: message });
    tracer?.finish("error", { error: message });
    log.error("Interest-profile refresh failed: {error}", {
      botName,
      userId,
      error: message,
    });
  } finally {
    if (status === "ok") tracer?.finish("ok", { ...usage, ...(model ? { model } : {}) });
    if (reqId) agentStatus.completeRequest(reqId, usage);
  }
}

/**
 * Load the stored interest-profile text for a bot's primary user (resolved via
 * `bot_default_user`), for a single watcher run. Returns null — so gate prompts
 * stay identical to today — when the bot has no default user, no profile row, or
 * on ANY error (best-effort; a DB hiccup must never break a watcher run).
 */
export async function loadInterestProfileForBot(botName: string | undefined): Promise<string | null> {
  if (!botName) return null;
  try {
    const userId = await getBotDefaultUser(botName);
    if (!userId) return null;
    const profile = await getInterestProfile(userId, botName);
    return profile?.profile ?? null;
  } catch (err) {
    log.warn("Failed to load interest profile for {botName}: {error}", {
      botName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Load the stored interest-profile text for an EXPLICIT user (the identity the
 * agent actually runs as — e.g. `watcher.userId`), rather than resolving via
 * `bot_default_user` (which the web-chat dropdown clobbers, and which leaks one
 * user's interests into another's alerts on a multi-user bot). Same best-effort
 * contract as `loadInterestProfileForBot`: returns null — so gate prompts stay
 * byte-identical to today — on missing user/bot, no profile row, or ANY error
 * (a DB hiccup must never break a watcher run; PR2/PR4 lean on "null ⇒ unchanged
 * prompt").
 */
export async function loadInterestProfile(
  userId: string | undefined,
  botName: string | undefined,
): Promise<string | null> {
  if (!userId || !botName) return null;
  try {
    const profile = await getInterestProfile(userId, botName);
    return profile?.profile ?? null;
  } catch (err) {
    log.warn("Failed to load interest profile for {botName}/{userId}: {error}", {
      botName,
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
