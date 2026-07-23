import { readdirSync, existsSync, readFileSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { getLog } from "../logging.ts";
import { parseHivemindConfig, type HivemindBotConfig } from "../hivemind/config.ts";
import type { McpStatusConfig } from "../ai/mcp-status.ts";
import { resolveCorrectiveConfig } from "../ai/corrective-config.ts";
import type { HaikuBackend } from "../ai/haiku-direct.ts";
import type { GardenerConfig } from "../gardener/types.ts";
import { getRoleOverride } from "../db/role-overrides.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";

const log = getLog("bots");

export interface RestrictedToolGroup {
  description: string;
  allowedUsers: string[];
}

export type RestrictedTools = Record<string, RestrictedToolGroup>;

export interface ChannelListeningConfig {
  enabled: boolean;
  /** Cooldown between responses in a channel (default 120000 = 2 min) */
  cooldownMs?: number;
  /** Max responses per hour across all channels (default 10) */
  maxResponsesPerHour?: number;
  /** Haiku relevance threshold (default "medium") */
  relevanceThreshold?: "low" | "medium" | "high";
  /** Number of recent messages to fetch for context (default 10) */
  contextMessages?: number;
  /** Domain keywords to help Haiku assess relevance */
  topicHints?: string[];
}

export type ConnectorType = "claude-cli" | "copilot-sdk" | "openai-compat" | "claude-sdk";

/** Valid `connector` values — shared by discovery validation + the /models editor. */
export const CONNECTOR_VALUES = ["claude-cli", "copilot-sdk", "openai-compat", "claude-sdk"] as const;
/** Valid `haikuBackend` values — shared by discovery validation + the /models editor. */
export const HAIKU_BACKEND_VALUES = ["cli", "anthropic", "copilot"] as const;

/** The per-bot config.json fields editable from the /models dashboard page. */
export const EDITABLE_BOT_FIELDS = ["connector", "model", "thinkingMaxTokens", "haikuBackend"] as const;
export type EditableBotField = (typeof EDITABLE_BOT_FIELDS)[number];

export function isEditableBotField(key: string): key is EditableBotField {
  return (EDITABLE_BOT_FIELDS as readonly string[]).includes(key);
}

/**
 * Validate a single editable config.json field with discovery-aligned rules
 * (enum lists shared via `CONNECTOR_VALUES`/`HAIKU_BACKEND_VALUES`; message
 * phrasing modeled on `validateEnumField`/`validateScalarField` below). The
 * editor is deliberately STRICTER than discovery for scalar fields: it rejects
 * an empty `model` and a negative/non-integer `thinkingMaxTokens`, which
 * discovery would keep silently — never write a value discovery merely
 * tolerates. Returns null when valid, otherwise the rejection message.
 * `value === null` means "clear the field" (revert to default) — always valid.
 */
export function validateBotConfigField(name: string, field: EditableBotField, value: unknown): string | null {
  if (value === null) return null;
  switch (field) {
    case "connector":
      if (typeof value !== "string" || !(CONNECTOR_VALUES as readonly string[]).includes(value)) {
        return `Bot "${name}" has unknown connector "${String(value)}" — valid values: ${CONNECTOR_VALUES.join(", ")}`;
      }
      return null;
    case "haikuBackend":
      if (typeof value !== "string" || !(HAIKU_BACKEND_VALUES as readonly string[]).includes(value)) {
        return `Bot "${name}" has unknown haikuBackend "${String(value)}" — valid values: ${HAIKU_BACKEND_VALUES.join(", ")}`;
      }
      return null;
    case "model":
      if (typeof value !== "string") {
        return `Bot "${name}" config.json field "model" should be a string but is ${typeof value} (${String(value)})`;
      }
      if (value.trim().length === 0) return `Bot "${name}" config.json field "model" must not be empty`;
      return null;
    case "thinkingMaxTokens":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `Bot "${name}" config.json field "thinkingMaxTokens" should be a number but is ${typeof value} (${String(value)})`;
      }
      if (!Number.isInteger(value) || value < 0) {
        return `Bot "${name}" config.json field "thinkingMaxTokens" must be a non-negative integer`;
      }
      return null;
  }
}

export interface BotConfig {
  name: string;
  /** Absolute path to the bot folder — used as cwd for Claude CLI spawns */
  dir: string;
  persona: string;
  telegramBotToken?: string;
  telegramAllowedUserIds: string[];
  slackBotToken?: string;
  slackAppToken?: string;
  slackAllowedUserIds: string[];
  /** AI connector backend — defaults to "claude-cli" */
  connector?: ConnectorType;
  /** Override the Haiku backend for this bot's async extractors + research_knowledge
   *  decomposer. When unset, `resolveBackend()` picks via the connector default
   *  (`copilot-sdk` → `copilot`, else `cli`). The process-wide `HAIKU_BACKEND` env
   *  var still trumps this (debug knob). */
  haikuBackend?: HaikuBackend;
  /** Claude model override (e.g. "opus", "sonnet") — falls back to global CLAUDE_MODEL */
  model?: string;
  /** Max thinking tokens for extended thinking — set 0 to disable, undefined = CLI default */
  thinkingMaxTokens?: number;
  /** Claude timeout override in ms — falls back to global CLAUDE_TIMEOUT_MS */
  timeoutMs?: number;
  /** Base URL for OpenAI-compatible API (e.g. "http://localhost:1234/v1") */
  baseUrl?: string;
  /** Absolute path to the bot's knowledge wiki, browsed by the dashboard `/wiki`
   *  reader. Configured in config.json as a path relative to the bot folder
   *  (same semantics as `.mcp.json` relative paths); resolved to absolute at
   *  discovery. Unset means the bot has no browsable wiki (`/wiki?bot=<name>`
   *  shows an empty state). */
  wikiDir?: string;
  /** Huginn search collections backing this wiki's `/wiki` **Ask** tab (research-
   *  style Q&A scoped to the wiki). Configured in config.json as `wikiCollections`
   *  (a string array). Unset ⇒ the Ask tab has no corpus and returns a clean
   *  "no collection connected" error. Plumbed onto the wiki registry entry. */
  wikiCollections?: string[];
  /** Explicit per-wiki synthesis-bot pin for this bot's OWN wiki. Names the bot
   *  that answers the wiki's Ask / What's-new digest, beating both the owner
   *  fast-gate and the research-bot fallback (see `resolveWikiSynthesisBot`).
   *  Configured in config.json as `wikiSynthesisBot` (a string). Plumbed onto the
   *  wiki registry entry. Unset ⇒ owner/fallback routing. Deliberately bypasses
   *  the opus fast-gate — e.g. capra pinning its own opus bot is an informed
   *  choice. A pin naming no discovered bot is warned + ignored at resolve time. */
  wikiSynthesisBot?: string;
  /** Context window size in tokens — used to show usage percentage (e.g. 32768 for local models) */
  contextWindow?: number;
  /** Per-tool-group user restrictions — tools not listed here are available to all */
  restrictedTools?: RestrictedTools;
  /** Channel listening config — passive relevance-based responses in active channels */
  channelListening?: ChannelListeningConfig;
  /** Show the request progress waterfall overlay in the web chat (default true) */
  showWaterfall?: boolean;
  /** Opt in to teaching the bot the presentational block-component vocabulary
   *  (Callout/Verdict/Pill/Figure/FileRef/ComparisonTable) in its chat system
   *  prompt. Absent/false ⇒ plain markdown only. Web chat renders the components;
   *  Telegram/Slack show the compiler-enforced plain-text fallbacks. */
  componentAnswers?: boolean;
  /** Configurable prompts for research flows */
  prompts?: BotPrompts;
  /**
   * Extra CLI flags appended to the `claude` spawn (between the trailing
   * `--system-prompt` and the `--` separator). Used by the benchmark runner
   * to inject `--strict-mcp-config` and `--disallowedTools` for cell
   * isolation. Prod bots leave this unset.
   */
  spawnArgs?: string[];
  /**
   * Extra directories the run may read from, as **absolute** paths. Set per-call
   * by `executeOneShot` from its `extraDirs` option (never in config.json). The
   * claude-sdk connector maps this to `options.additionalDirectories`; the CLI
   * connector expresses the same grant via `--add-dir` spawnArgs instead (so it
   * never reads this field). Used by the TikTok summarizer to grant Read access
   * to the tmp frame dir. See `connectorCapabilities().supportsExtraDirs`.
   */
  extraDirs?: string[];
  /**
   * Tool names to exclude from the AI session. Set dynamically per-request
   * (e.g. for jira-analysis flows to block native tools and force MCP usage).
   * For copilot-sdk: passed as `excludedTools` to `createSession`.
   * For claude-cli: converted to `--disallowedTools` spawn args.
   */
  excludedTools?: string[];
  /**
   * Tool names to allow (allow-list). For claude-sdk: mapped to the SDK
   * `tools` option (the built-in base set) — under `bypassPermissions` the
   * SDK's own `allowedTools` option only suppresses prompts and cannot
   * restrict the surface. MCP tools are fenced via `excludedTools`
   * (→ `disallowedTools`). Empty/unset ⇒ full surface. Other connectors
   * ignore it today.
   */
  allowedTools?: string[];
  /** Hivemind peer-to-peer integration config — parsed from `hivemind` block in config.json */
  hivemind?: HivemindBotConfig;
  /** MCP status probing config — controls cache TTL and which servers are critical */
  mcpStatus?: McpStatusConfig;
  /** Prompt-level corrective retrieval (Path C). See `resolveCorrectiveConfig`
   *  + CLAUDE.md "Corrective Retrieval" section. */
  correctiveRetrieval?: CorrectiveRetrievalBotConfig;
  /** True when the bot's .mcp.json registers a `research` MCP server (the
   *  muninn-side `research_knowledge` tool). Drives the one-line system-prompt
   *  nudge in `buildPrompt`. Detected once at discovery. */
  hasResearchKnowledge?: boolean;
  /** Default collections from the bot's `knowledge` MCP server env
   *  (`KNOWLEDGE_COLLECTIONS`). Resolved once at discovery so the research MCP
   *  server doesn't re-read .mcp.json on every tool call. `undefined` means
   *  "search all collections huginn knows about". */
  defaultKnowledgeCollections?: string[];
  /** Wiki-gardener config (per-bot config.json `gardener` block). Requires
   *  `wikiDir`. See src/gardener/. */
  gardener?: GardenerConfig;
  /** Auto-commit config for programmatic wiki writes (per-bot config.json
   *  `wikiAutoCommit` block). See `src/wiki/commit.ts`. */
  wikiAutoCommit?: WikiAutoCommitConfig;
}

export interface CorrectiveRetrievalBotConfig {
  enabled?: boolean;
}

/** Per-bot auto-commit config for programmatic wiki writes (gardener apply,
 *  source drafter). `push` defaults to true — opt out to commit locally only.
 *  `catalogKinds` is the wiki's index-cataloging policy — which page kinds get an
 *  index.md catalog line (default `["concept"]`; jarvis adds `"source"`). Entities
 *  are never cataloged regardless of this list (see `catalogPage` in wire.ts). */
export interface WikiAutoCommitConfig {
  push?: boolean;
  catalogKinds?: string[];
}

export interface JiraAnalysisVariant {
  /** Variant id derived from the filename (e.g. "coder" for jiraAnalysis.coder.md). */
  id: string;
  /** Human-readable label from `<!-- label: ... -->` on the first line, or title-cased id. */
  label: string;
  /** Prompt body with the label comment stripped. */
  content: string;
}

export interface BotPrompts {
  /** Default Jira task analysis prompt (from Chrome extension). The Jira content is appended automatically. */
  jiraAnalysis?: string;
  /** Named variants of the Jira analysis prompt — discovered from `prompts/jiraAnalysis.<id>.md`. */
  jiraAnalysisVariants?: JiraAnalysisVariant[];
  /** Prompt for the "Investigate Code" follow-up button after Jira analysis. */
  investigateCode?: string;
  /** Prompt for the "Deep Analysis" follow-up button after code investigation — parallel agent verification. */
  deepAnalysis?: string;
  /** Prompt for the "Generate Test Spec" follow-up button after deep analysis. */
  specGeneration?: string;
  /** Prompt for the "Generate Spec" button after Jira analysis — produces the domain layer
   *  (Forretningsregel + Gitt/Når/Så + Akseptansekriterier) drafted early, before code, for the
   *  fagperson review gate. Distinct from `specGeneration`, which runs late and folds in code findings. */
  specDomain?: string;
}

const SINGLE_PROMPT_KEYS = ["jiraAnalysis", "investigateCode", "deepAnalysis", "specGeneration", "specDomain"] as const satisfies readonly (keyof BotPrompts)[];
const VARIANT_PROMPT_KEYS = ["jiraAnalysis"] as const;

/** Synthetic variant that maps back to the bare `jiraAnalysis.md` prompt. Reserved as
 *  a variant id so a `jiraAnalysis.default.md` file can't collide with it. Shared by the
 *  `/api/research/variants` endpoint and the `promptVariant` resolution in research-routes. */
export const DEFAULT_VARIANT_ID = "default";
export const DEFAULT_VARIANT_LABEL = "Standard";

const LABEL_COMMENT_RE = /^\s*<!--\s*label:\s*(.+?)\s*-->\s*\r?\n?/;

/** "code-review" → "Code Review". Used when a variant file omits a `<!-- label: -->` line. */
function titleCaseId(id: string): string {
  return id
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function parseLabel(content: string, fallbackId: string): { label: string; content: string } {
  const match = content.match(LABEL_COMMENT_RE);
  if (!match) return { label: titleCaseId(fallbackId), content };
  // Strip the comment line either way; a blank label falls back to the id.
  const body = content.slice(match[0].length);
  const label = match[1]!.trim();
  return { label: label || titleCaseId(fallbackId), content: body };
}

function loadPromptsFromDir(botDir: string, botName: string): BotPrompts | undefined {
  const promptsDir = join(botDir, "prompts");
  let entries: Dirent[];
  try {
    entries = readdirSync(promptsDir, { withFileTypes: true });
  } catch (err) {
    // Missing prompts/ dir is the common case — silent. Anything else (bad perms,
    // a file named "prompts") is worth surfacing without aborting bot discovery.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      log.warn("Bot \"{name}\" prompts/ dir not readable: {error}", { name: botName, error: String(err) });
    }
    return undefined;
  }

  const result: BotPrompts = {};
  const singleKeys = new Set<string>(SINGLE_PROMPT_KEYS);
  const variantKeys = new Set<string>(VARIANT_PROMPT_KEYS);
  const variantsByKey: Record<string, JiraAnalysisVariant[]> = {};

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const stem = entry.name.slice(0, -3);
    const raw = readFileSync(join(promptsDir, entry.name), "utf-8");

    if (singleKeys.has(stem)) {
      result[stem as keyof BotPrompts] = raw as never;
      continue;
    }

    const dotIdx = stem.indexOf(".");
    if (dotIdx > 0) {
      const baseKey = stem.slice(0, dotIdx);
      const variantId = stem.slice(dotIdx + 1);
      if (variantKeys.has(baseKey) && variantId.length > 0) {
        if (variantId === DEFAULT_VARIANT_ID) {
          log.warn("Bot \"{name}\" prompt file prompts/{file} uses the reserved \"{id}\" variant id — rename it (the bare {base}.md is already the default)", {
            name: botName,
            file: entry.name,
            id: DEFAULT_VARIANT_ID,
            base: baseKey,
          });
          continue;
        }
        const { label, content } = parseLabel(raw, variantId);
        (variantsByKey[baseKey] ??= []).push({ id: variantId, label, content });
        continue;
      }
    }

    log.warn("Bot \"{name}\" has unknown prompt file prompts/{file} — expected <key>.md or jiraAnalysis.<id>.md", {
      name: botName,
      file: entry.name,
    });
  }

  if (variantsByKey.jiraAnalysis) {
    variantsByKey.jiraAnalysis.sort((a, b) => a.id.localeCompare(b.id));
    result.jiraAnalysisVariants = variantsByKey.jiraAnalysis;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Discovers all bot folders that have a CLAUDE.md — no platform tokens required.
 * Used by dashboard (MCP debug, chat page).
 */
export function discoverAllBots(): BotConfig[] {
  return discoverBotsInternal({ requireTokens: false });
}

/**
 * Picks the bot used for backend summarization jobs (YouTube / X article /
 * anthropic / TikTok). Honors the `SUMMARIZER_BOT` env var (matched by name,
 * case-insensitive); falls back to the first discovered bot when unset or
 * unmatched. The chosen bot's config decides the connector + model + timeout for
 * these jobs (routed through `executeOneShot`), so without this knob the model
 * silently depends on bot-folder directory order.
 */
export function resolveSummarizerBot(bots: BotConfig[]): BotConfig | undefined {
  if (bots.length === 0) return undefined;
  // A DB override (edited from /models) beats the env var. The snapshot is
  // primed at startup and refreshed on every write, so this stays sync + hot.
  const wanted = (getRoleOverride("SUMMARIZER_BOT") ?? process.env.SUMMARIZER_BOT)?.trim().toLowerCase();
  if (wanted) {
    const match = bots.find((b) => b.name.toLowerCase() === wanted);
    if (match) return match;
    log.warn("SUMMARIZER_BOT=\"{wanted}\" not found among discovered bots — using {fallback}", {
      wanted,
      fallback: bots[0]!.name,
    });
  }
  return bots[0];
}

/**
 * A bot fit to be the *default* interactive Research synthesizer: fast enough
 * for interactive Q&A. Opus is the slow, expensive first-discovered default
 * (capra), so skip it; an unset `model` falls back to the sonnet-class global
 * `CLAUDE_MODEL`, so unset counts as fast. (An explicit `?bot=` may still pin a
 * slow bot — this gate only governs the auto-pick in {@link resolveResearchBot}.)
 * Connector no longer matters: synthesis routes through `executeOneShot`, so
 * every connector (copilot-sdk / openai-compat / claude-sdk / claude-cli) works.
 */
function isFastResearchBot(bot: BotConfig): boolean {
  return !(bot.model ?? "").toLowerCase().includes("opus");
}

/**
 * Picks the bot used to synthesize Research (Claude Learning Center) answers.
 * Unlike the batch summarizer, Research is interactive — and spends a Claude
 * call per follow-up turn — so the default favors speed. Resolution order:
 *   1. `RESEARCH_BOT` env (matched by name, case-insensitive) — explicit override.
 *   2. The first discovered bot fast enough for interactive Q&A (see
 *      `isFastResearchBot`) — skips opus.
 *   3. `resolveSummarizerBot` (which itself honors `SUMMARIZER_BOT`, then
 *      first-discovered) — last resort when every bot is a slow (opus) one.
 * The `?bot=` query param on `/api/research/ask` still overrides all of this.
 */
export function resolveResearchBot(bots: BotConfig[]): BotConfig | undefined {
  if (bots.length === 0) return undefined;
  // A DB override (edited from /models) beats the env var — see the note in
  // resolveSummarizerBot for why this reads a sync in-memory snapshot.
  const wanted = (getRoleOverride("RESEARCH_BOT") ?? process.env.RESEARCH_BOT)?.trim().toLowerCase();
  if (wanted) {
    const match = bots.find((b) => b.name.toLowerCase() === wanted);
    if (match) return match;
    log.warn("RESEARCH_BOT=\"{wanted}\" not found among discovered bots — falling back to a fast bot", {
      wanted,
    });
  }
  return bots.find(isFastResearchBot) ?? resolveSummarizerBot(bots);
}

/**
 * Picks the bot that synthesizes a *wiki's* Ask answer / What's-new digest.
 * Owner-routing: the bot that owns the wiki answers its own wiki (jarvis wiki →
 * jarvis, nav wiki → melosys), so retrieval + synthesis run under the correct
 * identity instead of the single global research bot. Resolution, in order:
 *   - **Explicit pin** (`entry.synthesisBot`, from a bot's `wikiSynthesisBot`
 *     config field or a `WIKI_EXTRA` fourth segment) naming a DISCOVERED bot
 *     (case-insensitive) → `{ bot: pinned, origin: "pinned" }`. A pin
 *     deliberately BYPASSES the opus fast-gate — pinning capra's own opus bot
 *     for capra's wiki, or keeping melosys-kode-wiki on melosys, is an informed
 *     choice. A pin naming no discovered bot is warned + ignored, falling
 *     through to owner/fallback below.
 *   - A bot-owned wiki (`entry.source === "bot"`, its `name` IS the owning bot's
 *     name) whose owner is discovered AND fast enough for interactive Q&A
 *     (`isFastResearchBot`, skips opus) → `{ bot: owner, origin: "owner" }`.
 *   - Everything else — a standalone (`WIKI_EXTRA`) wiki, an unknown/undefined
 *     entry (the ask handler resolves before its unknown-wiki preflight), an
 *     owner missing from discovery, or an *opus* owner (capra) too slow for
 *     interactive answers → `resolveResearchBot` fallback (so the hot
 *     `RESEARCH_BOT` override still steers it), tagged `origin: "fallback"`.
 * Reason-carrying shape mirrors `resolveBackendWithReason`. Takes `bots` (like
 * the other role resolvers) so callers inject discovery and the registry module
 * keeps its "no bot discovery at import" property.
 */
export function resolveWikiSynthesisBot(
  entry: WikiRegistryEntry | undefined,
  bots: BotConfig[],
): { bot: BotConfig | undefined; origin: "pinned" | "owner" | "fallback" } {
  if (entry?.synthesisBot) {
    const pinned = bots.find((b) => b.name.toLowerCase() === entry.synthesisBot!.toLowerCase());
    if (pinned) return { bot: pinned, origin: "pinned" };
    log.warn(
      "Wiki \"{wiki}\" pins synthesisBot \"{pin}\" — no discovered bot by that name; ignoring pin, falling back to owner/research",
      { wiki: entry.name, pin: entry.synthesisBot },
    );
  }
  if (entry?.source === "bot") {
    const owner = bots.find((b) => b.name.toLowerCase() === entry.name.toLowerCase());
    if (owner && isFastResearchBot(owner)) return { bot: owner, origin: "owner" };
  }
  return { bot: resolveResearchBot(bots), origin: "fallback" };
}

/**
 * Discovers bots that have both a CLAUDE.md and at least one platform token
 * (Telegram or Slack). Used for starting actual bot instances.
 */
export function discoverActiveBots(): BotConfig[] {
  return discoverBotsInternal({ requireTokens: true });
}

function validateEnumField<T extends string>(
  settings: Record<string, unknown>,
  key: string,
  valid: readonly T[],
  botName: string,
): void {
  const value = settings[key];
  if (value && !valid.includes(value as T)) {
    log.warn(
      `Bot "{name}" has unknown ${key} "{value}" — valid values: {valid}`,
      { name: botName, value: String(value), valid: valid.join(", ") },
    );
    delete settings[key];
  }
}

/**
 * Guards a scalar config.json field against the wrong JSON type. The fields are
 * read back with blind `as number`/`as boolean`/`as string` casts, so an entry
 * like `"timeoutMs": "180000"` (string) would otherwise flow through untyped and
 * misbehave downstream (NaN math, wrong spawn args). On a type mismatch we warn
 * and drop the key so the field falls back to its default — same graceful
 * posture as {@link validateEnumField}.
 */
function validateScalarField(
  settings: Record<string, unknown>,
  key: string,
  expected: "string" | "number" | "boolean",
  botName: string,
): void {
  const value = settings[key];
  if (value !== undefined && typeof value !== expected) {
    log.warn(
      `Bot "{name}" config.json field "${key}" should be a ${expected} but is {type} ({value}) — ignoring it (using default)`,
      { name: botName, type: typeof value, value: String(value) },
    );
    delete settings[key];
  }
}

/**
 * Guards a string-array config.json field (e.g. `wikiCollections`). A non-array,
 * or an array containing a non-string element, is warned about and dropped whole
 * so the field falls back to its default (undefined) — same graceful posture as
 * {@link validateScalarField}. An empty array is valid (kept).
 */
function validateStringArrayField(
  settings: Record<string, unknown>,
  key: string,
  botName: string,
): void {
  const value = settings[key];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    log.warn(
      `Bot "{name}" config.json field "${key}" should be an array of strings — ignoring it (using default)`,
      { name: botName, value: String(value) },
    );
    delete settings[key];
  }
}

/**
 * Validate the nested `gardener` config block (per-bot config.json). A non-object
 * value is dropped whole; individual mistyped sub-fields warn + drop (falling back
 * to the code default), matching {@link validateScalarField}'s graceful posture.
 */
function validateGardenerConfig(settings: Record<string, unknown>, botName: string): void {
  const value = settings.gardener;
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    log.warn(
      `Bot "{name}" config.json field "gardener" should be an object — ignoring it (using defaults)`,
      { name: botName },
    );
    delete settings.gardener;
    return;
  }
  const g = value as Record<string, unknown>;
  validateScalarField(g, "enabled", "boolean", botName);
  validateScalarField(g, "minClusterSize", "number", botName);
  validateScalarField(g, "lookbackDays", "number", botName);
  validateScalarField(g, "maxProposalsPerRun", "number", botName);
}

/** The page kinds a wiki may list in `wikiAutoCommit.catalogKinds`. `entity` is
 *  accepted for symmetry but has no effect — entities are hard-skipped from the
 *  index regardless (see `catalogPage` in gardener/wire.ts). */
const VALID_CATALOG_KINDS = new Set(["concept", "source", "entity"]);

/**
 * Validate the nested `wikiAutoCommit` config block (per-bot config.json). A
 * non-object value is dropped whole; a mistyped `push` sub-field warns + drops
 * (falling back to the code default of push-on); a mistyped `catalogKinds`
 * (non-array / non-string element) drops the whole field, and any UNKNOWN element
 * value (e.g. a "concpt" typo) is warned about and removed while the valid ones
 * are kept. An empty `catalogKinds` array is preserved as an explicit
 * "catalog nothing".
 */
function validateWikiAutoCommitConfig(settings: Record<string, unknown>, botName: string): void {
  const value = settings.wikiAutoCommit;
  if (value === undefined) return;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    log.warn(
      `Bot "{name}" config.json field "wikiAutoCommit" should be an object — ignoring it (using defaults)`,
      { name: botName },
    );
    delete settings.wikiAutoCommit;
    return;
  }
  const block = value as Record<string, unknown>;
  validateScalarField(block, "push", "boolean", botName);
  validateStringArrayField(block, "catalogKinds", botName);
  // Shape is now a string array (or absent). Drop unknown element values, keeping
  // the rest — an empty result stays as-is (explicit "catalog nothing").
  if (Array.isArray(block.catalogKinds)) {
    const kinds = block.catalogKinds as string[];
    const unknown = kinds.filter((k) => !VALID_CATALOG_KINDS.has(k));
    if (unknown.length > 0) {
      log.warn(
        `Bot "{name}" config.json field "wikiAutoCommit.catalogKinds" has unknown value(s) {unknown} — dropping them (valid: concept, source, entity)`,
        { name: botName, unknown: unknown.join(", ") },
      );
      block.catalogKinds = kinds.filter((k) => VALID_CATALOG_KINDS.has(k));
    }
  }
}

function discoverBotsInternal(opts: { requireTokens: boolean }): BotConfig[] {
  const botsDir = resolve(import.meta.dir, "../../bots");

  if (!existsSync(botsDir)) {
    log.warn("bots/ directory not found at {path}", { path: botsDir });
    return [];
  }

  const entries = readdirSync(botsDir, { withFileTypes: true });
  const bots: BotConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const name = entry.name;
    const dir = join(botsDir, name);
    const claudeMdPath = join(dir, "CLAUDE.md");

    if (!existsSync(claudeMdPath)) continue;

    const envName = name.toUpperCase();
    const telegramToken = process.env[`TELEGRAM_BOT_TOKEN_${envName}`];
    const slackBotToken = process.env[`SLACK_BOT_TOKEN_${envName}`];
    const slackAppToken = process.env[`SLACK_APP_TOKEN_${envName}`];

    // Bot needs at least one platform token
    const hasTelegram = !!telegramToken;
    const hasSlack = !!slackBotToken && !!slackAppToken;

    if (opts.requireTokens && !hasTelegram && !hasSlack) {
      log.info("Skipping bot \"{name}\" — no platform tokens found (need TELEGRAM_BOT_TOKEN_{env} or SLACK_BOT_TOKEN_{env} + SLACK_APP_TOKEN_{env})", { botName: name, name, env: envName });
      continue;
    }

    const telegramAllowedIdsEnv = process.env[`TELEGRAM_ALLOWED_USER_IDS_${envName}`] ?? "";
    const telegramAllowedUserIds = telegramAllowedIdsEnv
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    if (hasTelegram && telegramAllowedUserIds.length === 0) {
      log.warn("Bot \"{name}\" has a Telegram token but no TELEGRAM_ALLOWED_USER_IDS_{env} — all messages will be rejected", { name, env: envName });
    }

    const slackAllowedIdsEnv = process.env[`SLACK_ALLOWED_USER_IDS_${envName}`] ?? "";
    const slackAllowedUserIds = slackAllowedIdsEnv
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    const persona = readFileSync(claudeMdPath, "utf-8");

    // Read optional per-bot config.json
    const configJsonPath = join(dir, "config.json");
    let botSettings: Record<string, unknown> = {};
    const hasConfigJson = existsSync(configJsonPath);
    if (hasConfigJson) {
      try {
        botSettings = JSON.parse(readFileSync(configJsonPath, "utf-8"));
        // Warn about unknown keys to catch typos
        const knownKeys = new Set(["connector", "haikuBackend", "model", "thinkingMaxTokens", "timeoutMs", "restrictedTools", "channelListening", "serena", "baseUrl", "showWaterfall", "componentAnswers", "contextWindow", "hivemind", "mcpStatus", "correctiveRetrieval", "wikiDir", "wikiCollections", "wikiSynthesisBot", "gardener", "wikiAutoCommit"]);
        const unknownKeys = Object.keys(botSettings).filter((k) => !knownKeys.has(k));
        if (unknownKeys.length > 0) {
          const hint = unknownKeys.includes("prompts")
            ? " (note: `prompts` moved to bots/<name>/prompts/<key>.md — see CLAUDE.md)"
            : "";
          log.warn("Bot \"{name}\" config.json has unknown keys: {keys} — possible typo?" + hint, { name, keys: unknownKeys.join(", ") });
        }
        validateEnumField(botSettings, "connector", CONNECTOR_VALUES, name);
        validateEnumField(botSettings, "haikuBackend", HAIKU_BACKEND_VALUES, name);
        validateScalarField(botSettings, "model", "string", name);
        validateScalarField(botSettings, "baseUrl", "string", name);
        validateScalarField(botSettings, "wikiDir", "string", name);
        validateStringArrayField(botSettings, "wikiCollections", name);
        validateScalarField(botSettings, "wikiSynthesisBot", "string", name);
        validateScalarField(botSettings, "thinkingMaxTokens", "number", name);
        validateScalarField(botSettings, "timeoutMs", "number", name);
        validateScalarField(botSettings, "contextWindow", "number", name);
        validateScalarField(botSettings, "showWaterfall", "boolean", name);
        validateScalarField(botSettings, "componentAnswers", "boolean", name);
        validateGardenerConfig(botSettings, name);
        validateWikiAutoCommitConfig(botSettings, name);
      } catch (e) {
        log.warn("Failed to parse {path}: {error}", { path: configJsonPath, error: String(e) });
      }
    }

    const mcpJsonPath = join(dir, ".mcp.json");
    const hasMcp = existsSync(mcpJsonPath);
    const hasSettings = existsSync(join(dir, ".claude", "settings.json")) || existsSync(join(dir, ".claude", "settings.local.json"));

    let hasResearchKnowledge = false;
    let defaultKnowledgeCollections: string[] | undefined;
    if (hasMcp) {
      try {
        const mcp = JSON.parse(readFileSync(mcpJsonPath, "utf-8")) as {
          mcpServers?: Record<string, { env?: Record<string, string> } | undefined>;
        };
        hasResearchKnowledge = !!mcp.mcpServers?.["research"];
        for (const server of Object.values(mcp.mcpServers ?? {})) {
          const value = server?.env?.KNOWLEDGE_COLLECTIONS;
          if (value) {
            defaultKnowledgeCollections = value
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            break;
          }
        }
      } catch (err) {
        log.warn("Failed to parse .mcp.json for bot \"{name}\": {error}", {
          botName: name,
          name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const platforms: string[] = [];
    if (hasTelegram) platforms.push("telegram");
    if (hasSlack) platforms.push("slack");

    const correctiveRetrieval = botSettings.correctiveRetrieval as CorrectiveRetrievalBotConfig | undefined;

    bots.push({
      name,
      dir,
      persona,
      telegramBotToken: telegramToken,
      telegramAllowedUserIds,
      slackBotToken,
      slackAppToken,
      slackAllowedUserIds,
      connector: botSettings.connector as ConnectorType | undefined,
      haikuBackend: botSettings.haikuBackend as HaikuBackend | undefined,
      model: botSettings.model as string | undefined,
      thinkingMaxTokens: botSettings.thinkingMaxTokens as number | undefined,
      timeoutMs: botSettings.timeoutMs as number | undefined,
      baseUrl: botSettings.baseUrl as string | undefined,
      wikiDir:
        typeof botSettings.wikiDir === "string"
          ? resolve(dir, botSettings.wikiDir)
          : undefined,
      wikiCollections: botSettings.wikiCollections as string[] | undefined,
      wikiSynthesisBot: botSettings.wikiSynthesisBot as string | undefined,
      restrictedTools: botSettings.restrictedTools as RestrictedTools | undefined,
      channelListening: botSettings.channelListening as ChannelListeningConfig | undefined,
      showWaterfall: botSettings.showWaterfall as boolean | undefined,
      componentAnswers: botSettings.componentAnswers as boolean | undefined,
      prompts: loadPromptsFromDir(dir, name),
      contextWindow: botSettings.contextWindow as number | undefined,
      hivemind: parseHivemindConfig(botSettings.hivemind) ?? undefined,
      mcpStatus: botSettings.mcpStatus as McpStatusConfig | undefined,
      correctiveRetrieval,
      hasResearchKnowledge,
      defaultKnowledgeCollections,
      gardener: botSettings.gardener as GardenerConfig | undefined,
      wikiAutoCommit: botSettings.wikiAutoCommit as WikiAutoCommitConfig | undefined,
    });

    const configParts: string[] = [];
    if (botSettings.connector) configParts.push(`connector: ${botSettings.connector}`);
    if (botSettings.haikuBackend) configParts.push(`haikuBackend: ${botSettings.haikuBackend}`);
    if (botSettings.model) configParts.push(`model: ${botSettings.model}`);
    if (botSettings.thinkingMaxTokens !== undefined) configParts.push(`thinking: ${botSettings.thinkingMaxTokens}`);
    if (botSettings.timeoutMs !== undefined) configParts.push(`timeout: ${botSettings.timeoutMs}ms`);
    if (botSettings.baseUrl) configParts.push(`baseUrl: ${botSettings.baseUrl}`);
    if (resolveCorrectiveConfig({ correctiveRetrieval }).enabled) {
      configParts.push("correctiveRetrieval: on");
    } else if (correctiveRetrieval) {
      configParts.push("correctiveRetrieval: off (configured but disabled)");
    }

    const channelListening = botSettings.channelListening as ChannelListeningConfig | undefined;

    log.info(
      "Discovered bot \"{name}\" (platforms: {platforms}, " +
        `telegram users: ${telegramAllowedUserIds.length}, slack users: ${slackAllowedUserIds.length}, ` +
        `MCP: ${hasMcp ? "yes" : "no"}, ` +
        `settings: ${hasSettings ? "yes" : "no"}, ` +
        `config.json: ${hasConfigJson ? `yes (${configParts.join(", ") || "empty"})` : "no"}, ` +
        `channelListening: ${channelListening?.enabled ? "yes" : "no"}, ` +
        `dir: ${dir})`,
      { botName: name, name, platforms: platforms.join("+") },
    );
  }

  return bots;
}
