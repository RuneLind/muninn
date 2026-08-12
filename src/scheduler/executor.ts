import { getDb } from "../db/client.ts";
import { getLog } from "../logging.ts";
import { pickPrimaryModel } from "../ai/result-parser.ts";
import { StreamParser, type StreamProgressCallback } from "../ai/stream-parser.ts";
import { resolveAgentCwd } from "../ai/agent-cwd.ts";
import { buildInlineMcpConfig, buildInlineSettings } from "../ai/mcp-config-utils.ts";
import { attachToolSpans } from "../core/tool-spans.ts";
import type { ClaudeResult, ToolCall } from "../types.ts";
import type { Tracer } from "../tracing/index.ts";

const log = getLog("scheduler", "executor");

export interface HaikuResult {
  result: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /**
   * The backend that ACTUALLY produced this result — `"cli"` for every
   * `spawnHaiku` path (including the router's error/no-auth fallback to CLI),
   * `"anthropic"`/`"copilot"` for the direct-SDK backends. Lets a traced caller
   * stamp the honest backend on its span (the router resolves cli/anthropic/
   * copilot but callers otherwise couldn't tell which one ran, so router-backed
   * spans rendered blank-backend rows). Typed inline (not `HaikuBackend` from
   * `../ai/haiku-direct.ts`) to avoid an import cycle — that module imports this.
   */
  backend?: "cli" | "anthropic" | "copilot";
  /** Tool calls parsed from the stream (empty/undefined for tool-less Haiku prompts). */
  toolCalls?: ToolCall[];
  /** Number of assistant turns (from the CLI result event). Undefined for direct-SDK backends. */
  numTurns?: number;
  /** Total cost in USD (from the CLI result event). Undefined for direct-SDK backends. */
  costUsd?: number;
}

/**
 * Optional telemetry seams threaded into a `spawnHaiku` call so a Haiku-driven
 * agent (the email/x/anthropic watchers) surfaces its tool use like the chat
 * connector does:
 *  - `onProgress` fills the `/agents` Running card's tool mini-log live.
 *  - `tracer` receives tool child spans (under its root span) so the traces
 *    waterfall + `getToolUsageStats` pick them up.
 *  - `captureToolOutputs` mirrors `config.tracingCaptureToolOutputs`.
 * All optional — a `spawnHaiku` call with none behaves exactly as before.
 */
export interface HaikuTelemetry {
  onProgress?: StreamProgressCallback;
  tracer?: Tracer;
  captureToolOutputs?: boolean;
  /**
   * Fired once per `spawnHaiku` call with the run's final token usage. A checker
   * that makes MULTIPLE spawnHaiku calls (x/anthropic gate + digest) sums across
   * invocations here so the runner can stamp the total onto the `watcher:<type>`
   * span + the `/agents` Running card. Optional — absent for a `spawnHaiku` call
   * outside the watcher runner.
   */
  onUsage?: (usage: HaikuUsage) => void;
  /**
   * Fired once when a `spawnHaiku` call FAILS (timeout, nonzero exit, stream/parse
   * error) — the counterpart to `onUsage`, which only fires on success. Lets the
   * watcher runner distinguish "made no model call" from "attempted a model call
   * that failed" on the `watcher:<type>` span (checkers swallow gate/digest errors,
   * so the span otherwise finishes `ok` with no telemetry either way). Fired
   * BEFORE the error is rethrown; the throw is still the caller's to handle.
   */
  onModelError?: (message: string) => void;
}

/** Final token usage for one Haiku call, delivered to {@link HaikuTelemetry.onUsage}. */
export interface HaikuUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  numTurns?: number;
  costUsd?: number;
}

export const HAIKU_TIMEOUT_MS = 60_000;

export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Parse Haiku stdout as JSON, throwing a descriptive error (including a stdout
 * preview) on failure. Mirrors the email watcher's slice(0,300) preview so an
 * unparseable Haiku response surfaces a useful message instead of a bare
 * "Watcher failed" (the X watcher at watchers/x.ts still uses a bare JSON.parse).
 */
export function parseHaikuJson(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `Failed to parse Haiku JSON output: ${err instanceof Error ? err.message : String(err)} — stdout: ${stdout.slice(0, 300)}`,
    );
  }
}

export interface SpawnHaikuOptions extends HaikuTelemetry {
  source: string;
  entrypoint?: string;
  /**
   * Bot folder this call needs TOOLS from. Its `.mcp.json` is passed as
   * `--mcp-config` and its `.claude/settings*.json` as `--settings` — it is NOT
   * the process cwd.
   *
   * Callers used to hand `bots/<name>/` in as the cwd, which bought THREE things
   * from the CLI implicitly: MCP server discovery, tool permissions, and the bot's
   * CLAUDE.md persona. It also bought a fourth nobody wanted — the CLI walks parent
   * dirs for CLAUDE.md, and bot folders live INSIDE the checkout, so every call
   * also loaded muninn's ~39 KB CLAUDE.md + CLAUDE.local.md (measured 33 900
   * cache_creation tokens on a real email-watcher-shaped run, $0.070/call) and
   * filed its transcript into the developer's own project folder. The three wanted
   * things are now requested by name — MCP + permissions via this field, persona
   * via {@link system} — and the spawn runs in the agent home like every other
   * muninn-spawned agent. Same shape, same prompt, measured on the argv this
   * function emits: 8 577 cache_creation, $0.0199.
   *
   * Set it ONLY for a call that actually uses MCP tools (today: the email
   * watcher's Gmail). `--strict-mcp-config` is applied EITHER WAY, so what this
   * field changes is which servers exist, never whether the developer's ambient
   * `~/.claude.json` ones leak in.
   */
  botDir?: string;
  botName?: string;
  timeoutMs?: number;
  model?: string;
  /** Max output tokens for direct-SDK backends (anthropic). Ignored by the CLI spawn. */
  maxTokens?: number;
  /**
   * System prompt (bot persona) — `--system-prompt` on the CLI path, `system` on
   * anthropic, `systemMessage` on copilot. Honored by ALL THREE backends since the
   * cwd change above: the CLI used to get the persona for free by running inside
   * the bot folder (so passing it here would have double-injected), and it no
   * longer does.
   *
   * Only the prose callers (goal + task reminders) set it. Extraction/JSON callers
   * deliberately do not — their prompts are self-contained format contracts, and
   * they have always run persona-less on the anthropic/copilot backends, so this
   * makes the CLI match rather than diverge.
   */
  system?: string;
}

/**
 * Every condition warned about below is PERMANENT (a bad path, a broken JSON
 * edit) while the callers are watcher ticks, so an unthrottled warn repeats at
 * tick rate forever. Same shape as `agent-cwd.ts`'s: one warn per distinct
 * value, with a cap, and a clear rather than a stop-admitting rule — a full set
 * that kept warning for every NEW key would reinstate the flood it prevents.
 */
const warnedSpawnPaths = new Set<string>();
const WARNED_SPAWN_MAX = 64;

function warnOnce(key: string, message: string, props: Record<string, unknown>): void {
  if (warnedSpawnPaths.has(key)) return;
  if (warnedSpawnPaths.size >= WARNED_SPAWN_MAX) warnedSpawnPaths.clear();
  warnedSpawnPaths.add(key);
  log.warn(message, props);
}

/** Test seam: the warn set is process-lifetime, which would make the SECOND test
 *  asserting a warn silently pass on zero warns. */
export function _resetSpawnWarningsForTests(): void {
  warnedSpawnPaths.clear();
}

/**
 * The `claude -p` argv for one Haiku spawn. Exported + pure so the flag policy is
 * pinned by a test rather than only by the shape of a live subprocess — the four
 * decisions here (persona delivery, MCP surface, tool permissions, MCP fencing)
 * are each invisible from the outside until a watcher quietly stops working or a
 * bill arrives. The permissions one already did exactly that, once, in this PR.
 */
export function buildHaikuArgs(opts: {
  prompt: string;
  model: string;
  system?: string;
  botDir?: string;
}): string[] {
  // `stream-json` + `--verbose` (required together with `-p`) makes the CLI emit
  // NDJSON tool_use / tool_result events, so `StreamParser` can surface the
  // agent's tool calls — the same wire format the chat connector consumes. A
  // missing final `result` event (a known CLI bug) drops us to the legacy
  // single-JSON parse, mirroring src/ai/executor.ts.
  const args = [
    "claude",
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
  ];

  // The persona the bot-dir cwd used to supply implicitly via CLAUDE.md.
  if (opts.system) args.push("--system-prompt", opts.system);

  // The bot's tool PERMISSIONS. Load-bearing and easy to miss: the bot-dir cwd
  // was quietly supplying three things, not two, and this is the third. With the
  // cwd moved, `bots/<name>/.claude/settings.json` stops being discovered, and
  // MCP tool calls are then DENIED — measured two ways on the same argv:
  // `mcp__gmail__list_email_labels` returns "77" WITH `--settings` and
  // "Permission needed for mcp__gmail__list_email_labels" without it. The
  // checker would have surfaced that as a routine empty inbox.
  //
  // (`src/ai/CLAUDE.md` long claimed this file was dead config. That was concluded
  // from a probe of Bash + Write — both already allowed by the user-scope
  // `~/.claude/settings.json`, so the probe could not tell the two scopes apart.
  // For `mcp__*` tools, which no user-scope rule covers, it is decisive.)
  const settings = opts.botDir ? buildInlineSettings(opts.botDir) : null;
  if (settings) args.push("--settings", settings);

  // The bot's MCP servers, re-expressed location-independently — the spawn no
  // longer runs inside the bot folder, so a `.mcp.json` carrying relative paths
  // would otherwise resolve them against the agent home.
  const mcpConfig = opts.botDir ? buildInlineMcpConfig(opts.botDir) : null;

  // A botDir that yields NEITHER is almost always a typo or a broken JSON edit
  // rather than an intent — and every downstream symptom of it (no tools, no
  // permissions) reads as a quiet, empty, successful run. Say so once per path.
  if (opts.botDir && !mcpConfig) {
    warnOnce(`mcp:${opts.botDir}`,
      "No usable .mcp.json under {botDir} — this spawn asked for bot MCP tools and will run with NONE. " +
        "A tool-using checker (the email watcher) degrades to an empty result that looks like a quiet run.",
      { botDir: opts.botDir });
  }
  if (opts.botDir && !settings) {
    warnOnce(`settings:${opts.botDir}`,
      "No readable .claude/settings.json under {botDir} — this spawn's MCP tool calls will be DENIED " +
        "(the denial is reported to the model, not thrown, so the caller sees an empty result).",
      { botDir: opts.botDir });
  }

  // ALWAYS fence the spawn to the servers we passed (none, when we passed none).
  // Without this the CLI also merges the developer's user-scope `~/.claude.json`
  // servers: measured on the as-shipped jarvis argv, 9 servers / 112 `mcp__` tools
  // instead of the bot's 3 — including a `claude.ai Gmail` the bot's allow-list
  // does not cover, which the gate could reach for and be silently denied on, and
  // a jetbrains server exposing `execute_terminal_command`. Fencing costs one
  // token and saves 1 764 cache_creation on the email shape (10 347 → 8 583).
  args.push("--strict-mcp-config");

  // `--mcp-config` is variadic: it stops at the next `-`-prefixed token, so a
  // following FLAG is safe, but a bare positional would be swallowed as a second
  // config. Keeping it last means nobody has to re-derive that.
  if (mcpConfig) args.push("--mcp-config", mcpConfig);

  return args;
}

/**
 * Low-level Haiku spawn: runs Claude Haiku and returns result + token usage.
 * All async Haiku calls should use this to get token tracking.
 *
 * The spawn ALWAYS runs in muninn's agent home ({@link resolveAgentCwd}), never
 * in a bot folder — see {@link SpawnHaikuOptions.botDir} for what replaced the
 * old bot-dir cwd and why.
 */
export async function spawnHaiku(
  prompt: string,
  opts: SpawnHaikuOptions,
): Promise<HaikuResult> {
  const {
    source,
    entrypoint = "jarvis-scheduler",
    botDir,
    botName,
    timeoutMs = HAIKU_TIMEOUT_MS,
    model,
    system,
    onProgress,
    tracer,
    captureToolOutputs,
    onUsage,
    onModelError,
  } = opts;
  const effectiveModel = model || DEFAULT_MODEL;
  const wallStart = performance.now();

  const proc = Bun.spawn(
    buildHaikuArgs({ prompt, model: effectiveModel, system, botDir }),
    {
      // Always muninn's own agent home: never a bot folder, never the inherited
      // repo root. See SpawnHaikuOptions.botDir.
      cwd: resolveAgentCwd(botName),
      env: {
        ...process.env,
        CLAUDE_CODE_ENTRYPOINT: entrypoint,
      },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    },
  );

  let timeoutTimer: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => {
      log.error("Haiku process timed out after {timeoutMs}ms — killing PID {pid}", { botName: botName ?? "haiku", timeoutMs, pid: proc.pid });
      proc.kill();
      reject(new Error(`Haiku timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  // Drain stderr eagerly so a chatty child can't block on a full stderr pipe
  // while we read stdout.
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  const resultPromise = (async (): Promise<HaikuResult> => {
    // Read stdout line-by-line so tool progress callbacks + tool timing are live.
    const { result: streamed, rawLines } = await readAndParseHaikuStream(
      proc.stdout, wallStart, onProgress, botName,
    );
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await stderrPromise;
      throw new Error(`Claude Haiku exited with code ${exitCode}: ${stderr}`);
    }

    const haiku = streamed
      ? claudeResultToHaiku(streamed, effectiveModel)
      // Fallback: stream parser didn't complete (known CLI bug — missing result
      // event, or the CLI degraded to a single legacy JSON blob). Recover the
      // result/tokens from the raw output via the legacy parser.
      : parseLegacyHaikuOutput(rawLines.join("\n"), effectiveModel);

    if (!streamed) {
      log.warn("Haiku stream parser incomplete, falling back to legacy JSON parse ({lineCount} lines)", {
        botName: botName ?? "haiku", lineCount: rawLines.length,
      });
    }

    // Track usage async — don't block the caller. Thread the telemetry Tracer's
    // trace id so the row ties back to the request trace (NULL without telemetry).
    trackUsage(source, haiku.model, haiku.inputTokens, haiku.outputTokens, botName, tracer?.traceId);

    // Hand the final usage to the runner's accumulator so multi-call checkers
    // (x/anthropic) can sum tokens across invocations for the span + Running card.
    onUsage?.({
      model: haiku.model,
      inputTokens: haiku.inputTokens,
      outputTokens: haiku.outputTokens,
      numTurns: haiku.numTurns,
      costUsd: haiku.costUsd,
    });

    // Emit tool child spans under the tracer's root span (the `watcher:<type>`
    // span) so the waterfall + getToolUsageStats pick them up. attachToolSpans'
    // "claude" parent label is absent here, so it falls back to the root span.
    if (tracer && haiku.toolCalls && haiku.toolCalls.length > 0) {
      await attachToolSpans(tracer, haiku.toolCalls, captureToolOutputs ?? false);
    }

    return haiku;
  })();

  try {
    return await Promise.race([resultPromise, timeoutPromise]);
  } catch (err) {
    onModelError?.(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    clearTimeout(timeoutTimer!);
  }
}

/** Map a StreamParser `ClaudeResult` into a `HaikuResult`. */
function claudeResultToHaiku(r: ClaudeResult, effectiveModel: string): HaikuResult {
  return {
    result: r.result,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    model: r.model && r.model !== "unknown" ? r.model : effectiveModel,
    // spawnHaiku unconditionally spawns `claude -p` — the honest backend is CLI.
    backend: "cli",
    toolCalls: r.toolCalls,
    numTurns: r.numTurns,
    costUsd: r.costUsd,
  };
}

/**
 * Legacy single-JSON parse — the pre-stream-json extraction, kept as the
 * fallback for the known CLI bug where the final `result` event goes missing
 * (or the CLI degrades to `--output-format json` output). Preserves the CLI-2.x
 * result-as-object normalization the original spawnHaiku carried.
 */
export function parseLegacyHaikuOutput(stdout: string, effectiveModel: string): HaikuResult {
  const parsed = parseHaikuJson(stdout);

  const inputTokens = parsed.usage
    ? (parsed.usage.input_tokens ?? 0)
      + (parsed.usage.cache_creation_input_tokens ?? 0)
      + (parsed.usage.cache_read_input_tokens ?? 0)
    : 0;
  const outputTokens = parsed.usage?.output_tokens ?? 0;
  const model = parsed.modelUsage
    ? pickPrimaryModel(parsed.modelUsage) ?? effectiveModel
    : effectiveModel;

  // Normalize result to string — CLI 2.x may return an object
  let resultText: string;
  if (typeof parsed.result === "string") {
    resultText = parsed.result;
  } else if (parsed.result?.content) {
    // CLI 2.x object format: { content: [{ type: "text", text: "..." }] }
    const textBlock = parsed.result.content.find((b: any) => b.type === "text");
    resultText = textBlock?.text ?? "";
  } else {
    resultText = String(parsed.result ?? "");
  }

  return {
    result: resultText,
    inputTokens,
    outputTokens,
    model,
    // Legacy fallback is still a `claude -p` spawn — CLI backend.
    backend: "cli",
    numTurns: parsed.num_turns ?? 1,
    costUsd: parsed.total_cost_usd ?? parsed.cost_usd ?? 0,
  };
}

interface HaikuStreamResult {
  /** Parsed result when the stream completed with a `result` event, else null. */
  result: ClaudeResult | null;
  rawLines: string[];
}

/**
 * Read Haiku stdout line-by-line, feeding each NDJSON line to a StreamParser for
 * real-time tool progress + timing. Mirrors src/ai/executor.ts'
 * readAndParseIncrementally: a Claude `is_error` result rethrows immediately, any
 * other parse hiccup drops to the legacy fallback (null result + rawLines).
 */
export async function readAndParseHaikuStream(
  stdout: ReadableStream<Uint8Array>,
  referenceTimestamp: number,
  onProgress: StreamProgressCallback | undefined,
  botName: string | undefined,
): Promise<HaikuStreamResult> {
  const parser = new StreamParser(referenceTimestamp, onProgress);
  const rawLines: string[] = [];
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let parseError: Error | null = null;

  const feed = (line: string): void => {
    if (!line.trim()) return;
    rawLines.push(line);
    if (parseError) return;
    try {
      parser.parseLine(line, performance.now());
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Claude error:")) throw e;
      parseError = e instanceof Error ? e : new Error(String(e));
      log.warn("Haiku stream parser failed, will use legacy fallback: {error}", { botName: botName ?? "haiku", error: String(e) });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        feed(line);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Handle remaining buffer (no trailing newline)
  if (buffer.trim()) feed(buffer);

  if (!parseError && parser.complete) {
    return { result: parser.getResult(), rawLines };
  }
  return { result: null, rawLines };
}

/**
 * High-level Haiku call with fallback — used by scheduler runner.
 *
 * `telemetry` threads the {@link HaikuTelemetry} `tracer` + `onUsage` seams into
 * the underlying {@link spawnHaiku} so a traced caller (the scheduled-task
 * reminder/custom paths) gets the `haiku_usage` row joined to its trace
 * (`trace_id`, #267) and the call's token usage surfaced. Absent ⇒ byte-identical
 * to the untelemetered call. `onProgress`/`captureToolOutputs` are intentionally
 * not exposed here — these prompts run no tools.
 */
export async function callHaiku(
  prompt: string,
  fallback: string,
  source = "task",
  botDir?: string,
  botName?: string,
  timeoutMs?: number,
  telemetry?: Pick<HaikuTelemetry, "tracer" | "onUsage">,
): Promise<string> {
  try {
    const { result } = await spawnHaiku(prompt, {
      source,
      botDir,
      botName,
      timeoutMs,
      ...(telemetry?.tracer ? { tracer: telemetry.tracer } : {}),
      ...(telemetry?.onUsage ? { onUsage: telemetry.onUsage } : {}),
    });
    return result.trim();
  } catch {
    return fallback;
  }
}

export function trackUsage(
  source: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  botName?: string,
  traceId?: string,
): void {
  if (inputTokens === 0 && outputTokens === 0) return;

  const sql = getDb();
  sql`
    INSERT INTO haiku_usage (source, model, input_tokens, output_tokens, bot_name, trace_id)
    VALUES (${source}, ${model}, ${inputTokens}, ${outputTokens}, ${botName ?? null}, ${traceId ?? null})
  `.catch((err) => {
    log.error("Failed to track Haiku usage: {error}", { botName: botName ?? "haiku", error: err instanceof Error ? err.message : String(err) });
  });
}
