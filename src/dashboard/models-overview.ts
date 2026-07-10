/**
 * Models overview — server-side assembly of the EFFECTIVE model / connector /
 * Haiku backend for every AI job in muninn, after all the defaults resolve.
 *
 * The point is misconfiguration visibility: the #191 class of bug (a bot's
 * Copilot model silently downgrading to Sonnet) is invisible until you can put
 * "what the config says will run" next to "what actually ran recently". This
 * module builds exactly that pairing for the `/models` dashboard page — a
 * read-only diagnostic, it adds no new tracking.
 *
 * Everything is derived from the SAME sources of truth the runtime uses:
 *   - `resolveBackendWithReason` (haiku-direct.ts) for the Haiku backend + why,
 *   - `resolveSummarizerBot` / `resolveResearchBot` (bots/config.ts) for roles,
 *   - `connectorCapabilities` for the TikTok `--add-dir` constraint,
 *   - the `watchers` table for per-watcher gate models,
 *   - `haiku_usage` + `traces` for the "actually used" column.
 */

import type { BotConfig } from "../bots/config.ts";
import { discoverAllBots, resolveResearchBot, resolveSummarizerBot, resolveWikiSynthesisBot } from "../bots/config.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import { getWikiRegistry } from "../wiki/registry-memo.ts";
import { resolveBackendWithReason } from "../ai/haiku-direct.ts";
import { connectorCapabilities } from "../ai/one-shot.ts";
import { DEFAULT_MODEL as HAIKU_DEFAULT_MODEL } from "../scheduler/executor.ts";
import { getAllWatchers } from "../db/watchers.ts";
import type { Watcher } from "../types.ts";
import { getDb } from "../db/client.ts";
import { getRoleOverride, type RoleKey } from "../db/role-overrides.ts";
import { getLog } from "../logging.ts";

const log = getLog("dashboard", "models");

/** Local embeddings model (ai/embeddings.ts) — never a remote call. */
const EMBEDDINGS_MODEL = "Xenova/all-MiniLM-L6-v2";
/** Gardener draft thinking cap — mirror of DRAFT_THINKING_MAX_TOKENS (wiki-gardener.ts). */
const GARDENER_DRAFT_THINKING_MAX_TOKENS = 8_000;

/** Where an effective value came from, shown as a small chip on the page. */
export type Origin =
  | "config"
  | "env"
  | "override"
  | "default"
  | "derived"
  | "legacy"
  | "fixed"
  | "none"
  | "pinned"
  | "owner"
  | "fallback";

export interface EffectiveValue {
  value: string;
  origin: Origin;
}

export interface BotEntry {
  name: string;
  connector: EffectiveValue;
  model: EffectiveValue;
  thinkingMaxTokens: number | null;
  haikuBackend: EffectiveValue;
  /** Human-readable reason from `resolveBackendWithReason` (the winning rule). */
  haikuBackendReason: string;
  /** Distinct chat models seen in traces over the last window ("—" when empty). */
  usedChatModels: string[];
  /** Distinct Haiku models seen across all sources over the last window. */
  usedHaikuModels: string[];
  /** Raw config.json values (undefined = unset) — the editor writes these, not
   *  the resolved effective values above. */
  rawConfig: {
    connector?: string;
    model?: string;
    haikuBackend?: string;
    thinkingMaxTokens?: number;
  };
}

export interface RoleEntry {
  role: string;
  bot: string | null;
  origin: Origin;
  /** Optional secondary note (e.g. the TikTok constraint chip). */
  note?: string;
  /** false ⇒ render the note as an error chip (constraint violated). */
  noteOk?: boolean;
  /** When set, this row is editable — the override key it writes (`POST
   *  /api/models/role`). Rows without it (e.g. the derived What's-new digest)
   *  render read-only. */
  overrideKey?: RoleKey;
  /** The current DB override value, if any (pre-selects the editor). */
  overrideValue?: string;
  /** What the editor picks: a bot name (`bot`) or a Haiku backend (`backend`). */
  editKind?: "bot" | "backend";
}

export interface PipelineEntry {
  job: string;
  /** Effective backend/router label — e.g. "Claude CLI", "Haiku router", "local". */
  backend: string;
  /** Effective model (after defaults). */
  model: EffectiveValue;
  /** Optional extra note (thinking cap, scope, "report-only"). */
  note?: string;
  /** Distinct models actually seen for this job over the last window. */
  used: string[];
}

/** One registered wiki + the bot that synthesizes its Ask answer / What's-new
 *  digest, with an origin chip: `pinned` (explicit per-wiki `synthesisBot` pin),
 *  `owner` (the owning bot answers its own wiki), or `fallback` (standalone /
 *  opus-owned wiki → the research bot). Read-only. */
export interface WikiSynthesisEntry {
  wiki: string;
  source: WikiRegistryEntry["source"];
  bot: string | null;
  connector: string;
  model: string;
  origin: Extract<Origin, "pinned" | "owner" | "fallback">;
  /** Set when the wiki carries a `synthesisBot` pin that matched no discovered
   *  bot — the pin was ignored and routing fell back to owner/fallback. Renders
   *  a red "pin '<name>' matches no bot — ignored" note (mirrors the
   *  stale-override/env-ignored pattern). */
  ignoredPin?: string;
}

export interface ModelsOverview {
  selectedBot: string;
  generatedAt: number;
  bots: BotEntry[];
  roles: RoleEntry[];
  wikiSynthesis: WikiSynthesisEntry[];
  pipeline: PipelineEntry[];
  errors?: string[];
}

/** A distinct (source, bot, model) tuple from `haiku_usage` in the window. */
export interface HaikuUsageRow {
  source: string;
  botName: string | null;
  model: string;
}

/** A distinct (bot, model) tuple from the `claude` chat spans in the window. */
export interface ChatModelRow {
  botName: string | null;
  model: string;
}

/** Injectable seams so the route test drives the assembly without a live DB. */
export interface ModelsOverviewDeps {
  discoverBots: () => BotConfig[];
  getWatchers: () => Promise<Watcher[]>;
  getHaikuUsage: () => Promise<HaikuUsageRow[]>;
  getChatModels: () => Promise<ChatModelRow[]>;
  /** Registered wikis (shared memo in prod; fabricated in tests). Drives the
   *  read-only Wiki synthesis group — one row per wiki with its resolved bot. */
  getWikiRegistry: () => WikiRegistryEntry[];
}

const USAGE_WINDOW_DAYS = 7;

async function defaultGetHaikuUsage(): Promise<HaikuUsageRow[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT DISTINCT source, bot_name, model
    FROM haiku_usage
    WHERE created_at >= now() - ${`${USAGE_WINDOW_DAYS} days`}::interval
      AND model IS NOT NULL
  `;
  return rows.map((r) => ({
    source: r.source as string,
    botName: (r.bot_name as string | null) ?? null,
    model: r.model as string,
  }));
}

async function defaultGetChatModels(): Promise<ChatModelRow[]> {
  const sql = getDb();
  // The main chat model lives on the child `claude` span's attributes; join it
  // to its root so we can attribute the model to a bot.
  const rows = await sql`
    SELECT DISTINCT t.bot_name AS bot_name, c.attributes->>'model' AS model
    FROM traces t
    JOIN traces c ON c.trace_id = t.trace_id AND c.parent_id = t.id AND c.name = 'claude'
    WHERE t.parent_id IS NULL
      AND t.created_at >= now() - ${`${USAGE_WINDOW_DAYS} days`}::interval
      AND c.attributes->>'model' IS NOT NULL
  `;
  return rows.map((r) => ({ botName: (r.bot_name as string | null) ?? null, model: r.model as string }));
}

export const DEFAULT_MODELS_OVERVIEW_DEPS: ModelsOverviewDeps = {
  discoverBots: discoverAllBots,
  getWatchers: () => getAllWatchers(),
  getHaikuUsage: defaultGetHaikuUsage,
  getChatModels: defaultGetChatModels,
  getWikiRegistry,
};

/** Sorted, de-duplicated model list — stable output for tests + rendering. */
function uniqSorted(models: Iterable<string>): string[] {
  return [...new Set([...models].filter((m) => m && m.length > 0))].sort();
}

/**
 * Map the winning `resolveBackendWithReason` rule to an origin chip. The reason
 * strings are the single source of truth (haiku-direct.ts) — this only recolors
 * them for the UI.
 */
function haikuBackendOrigin(reason: string): Origin {
  if (reason.includes("HAIKU_BACKEND override")) return "override";
  if (reason.includes("HAIKU_BACKEND env")) return "env";
  if (reason.includes("bot config")) return "config";
  if (reason.includes("legacy")) return "legacy";
  if (reason.includes("connector default")) return "derived";
  if (reason.includes("explicit")) return "config";
  return "default"; // "default" (cli floor)
}

/** Add a model to a `key → Set<model>` map, creating the set on first use. */
function addModel(map: Map<string, Set<string>>, key: string, model: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(model);
}

/**
 * Assemble the full overview. Pure over its injected deps — the route wires the
 * DB-backed defaults, the test wires fabricated ones.
 */
export async function assembleModelsOverview(
  selectedBot: string,
  deps: ModelsOverviewDeps = DEFAULT_MODELS_OVERVIEW_DEPS,
  now: number = Date.now(),
): Promise<ModelsOverview> {
  const bots = deps.discoverBots();
  const globalModelDefault = process.env.CLAUDE_MODEL || "sonnet";
  const errors: string[] = [];

  const [watchers, haikuUsage, chatModels] = await Promise.all([
    deps.getWatchers().catch((err) => {
      errors.push(`watchers: ${err instanceof Error ? err.message : String(err)}`);
      return [] as Watcher[];
    }),
    deps.getHaikuUsage().catch((err) => {
      errors.push(`haiku_usage: ${err instanceof Error ? err.message : String(err)}`);
      return [] as HaikuUsageRow[];
    }),
    deps.getChatModels().catch((err) => {
      errors.push(`traces: ${err instanceof Error ? err.message : String(err)}`);
      return [] as ChatModelRow[];
    }),
  ]);

  // Index usage for the "actually used" column.
  const haikuBySourceBot = new Map<string, Set<string>>(); // `${source}|${bot}` → models
  const haikuBySource = new Map<string, Set<string>>(); // source → models (any bot)
  const haikuByBot = new Map<string, Set<string>>(); // bot → models (any source)
  for (const row of haikuUsage) {
    const bot = row.botName ?? "";
    addModel(haikuBySourceBot, `${row.source}|${bot}`, row.model);
    addModel(haikuBySource, row.source, row.model);
    addModel(haikuByBot, bot, row.model);
  }
  const chatByBot = new Map<string, Set<string>>();
  for (const row of chatModels) {
    addModel(chatByBot, row.botName ?? "", row.model);
  }

  const usedHaikuForSource = (source: string, bot?: string): string[] =>
    uniqSorted(bot ? (haikuBySourceBot.get(`${source}|${bot}`) ?? []) : (haikuBySource.get(source) ?? []));

  // ---- Bots table ----------------------------------------------------------
  const botEntries: BotEntry[] = bots.map((bot) => {
    const { backend, reason } = resolveBackendWithReason({
      connector: bot.connector,
      haikuBackend: bot.haikuBackend,
    });
    return {
      name: bot.name,
      connector: {
        value: bot.connector ?? "claude-cli",
        origin: bot.connector ? "config" : "default",
      },
      model: {
        value: bot.model ?? globalModelDefault,
        origin: bot.model ? "config" : "default",
      },
      thinkingMaxTokens: bot.thinkingMaxTokens ?? null,
      haikuBackend: { value: backend, origin: haikuBackendOrigin(reason) },
      haikuBackendReason: reason,
      usedChatModels: uniqSorted(chatByBot.get(bot.name) ?? []),
      usedHaikuModels: uniqSorted(haikuByBot.get(bot.name) ?? []),
      rawConfig: {
        connector: bot.connector,
        model: bot.model,
        haikuBackend: bot.haikuBackend,
        thinkingMaxTokens: bot.thinkingMaxTokens,
      },
    };
  });

  // ---- Role assignments ----------------------------------------------------
  const summarizer = resolveSummarizerBot(bots);
  const research = resolveResearchBot(bots);
  const roles: RoleEntry[] = [];

  // An env role var only wins when it actually matched a discovered bot —
  // the resolvers warn and fall back on a typo, and showing "env" next to the
  // fallback bot would hide exactly the misconfig class this page surfaces.
  const matchesBot = (value: string | undefined, resolved: { name: string } | undefined) =>
    Boolean(value && resolved && value.trim().toLowerCase() === resolved.name.toLowerCase());
  // A DB override (edited from /models) beats env — mirror the resolver order so
  // the chip reflects what actually won. Written overrides are validated against
  // a real bot, so "set but ignored" only happens if the bot was later removed.
  const summarizerOverride = getRoleOverride("SUMMARIZER_BOT");
  const researchOverride = getRoleOverride("RESEARCH_BOT");
  const summarizerOverrideWon = matchesBot(summarizerOverride, summarizer);
  const researchOverrideWon = matchesBot(researchOverride, research);
  // Stale override (bot removed after the override was written): surface it as
  // an error note like an ignored env var — it silently suppresses env too.
  const summarizerOverrideIgnored = Boolean(summarizerOverride) && !summarizerOverrideWon;
  const researchOverrideIgnored = Boolean(researchOverride) && !researchOverrideWon;
  const summarizerEnvWon = !summarizerOverrideWon && matchesBot(process.env.SUMMARIZER_BOT, summarizer);
  const summarizerEnvIgnored = Boolean(process.env.SUMMARIZER_BOT) && !summarizerEnvWon && !summarizerOverrideWon;
  const researchEnvWon = !researchOverrideWon && matchesBot(process.env.RESEARCH_BOT, research);
  const researchEnvIgnored = Boolean(process.env.RESEARCH_BOT) && !researchEnvWon && !researchOverrideWon;
  const researchOrigin: Origin = researchOverrideWon ? "override" : researchEnvWon ? "env" : "derived";

  // Summarizer + its TikTok constraint chip.
  {
    const origin: Origin = summarizerOverrideWon ? "override" : summarizerEnvWon ? "env" : "default";
    let note: string | undefined;
    let noteOk = true;
    if (summarizer) {
      const ok = connectorCapabilities(summarizer).supportsExtraDirs;
      const mechanism = (summarizer.connector ?? "claude-cli") === "claude-sdk" ? "additionalDirectories" : "--add-dir";
      note = ok
        ? `TikTok frames OK (${mechanism})`
        : `TikTok frames blocked — connector "${summarizer.connector ?? "claude-cli"}" lacks extra-dirs support`;
      noteOk = ok;
    }
    if (summarizerEnvIgnored) {
      note = `SUMMARIZER_BOT="${process.env.SUMMARIZER_BOT}" matches no bot — env ignored, fell back${note ? `; ${note}` : ""}`;
      noteOk = false;
    }
    if (summarizerOverrideIgnored) {
      note = `Override "${summarizerOverride}" matches no bot — ignored (and it suppresses the env fallback); clear it${note ? `; ${note}` : ""}`;
      noteOk = false;
    }
    roles.push({
      role: "Summarizer (YouTube / X / TikTok / anthropic)",
      bot: summarizer?.name ?? null,
      origin,
      note,
      noteOk,
      overrideKey: "SUMMARIZER_BOT",
      overrideValue: summarizerOverride,
      editKind: "bot",
    });
  }

  // Research synthesizer. Unset env means the non-opus derivation picked the
  // bot, so the chip is "derived" (with the env-ignored warning on a typo).
  roles.push({
    role: "Research synthesizer (/research)",
    bot: research?.name ?? null,
    origin: researchOrigin,
    note: researchOverrideIgnored
      ? `Override "${researchOverride}" matches no bot — ignored (and it suppresses the env fallback); clear it`
      : researchEnvIgnored
        ? `RESEARCH_BOT="${process.env.RESEARCH_BOT}" matches no bot — env ignored, fell back`
        : research
          ? "non-opus fast default"
          : undefined,
    ...(researchEnvIgnored || researchOverrideIgnored ? { noteOk: false } : {}),
    overrideKey: "RESEARCH_BOT",
    overrideValue: researchOverride,
    editKind: "bot",
  });

  // What's-new wiki digest + wiki Ask now route per-wiki to the owning bot (see
  // resolveWikiSynthesisBot) — no single bot governs it. Point at the Wiki
  // synthesis group below rather than naming one bot.
  roles.push({
    role: "What's-new wiki digest",
    bot: null,
    origin: "derived",
    note: "per-wiki owner — see Wiki synthesis",
  });

  // Global Haiku backend — the process-wide HAIKU_BACKEND knob (override beats
  // env beats the per-bot connector default). Editable; empty value clears it.
  const haikuOverride = getRoleOverride("HAIKU_BACKEND");
  const haikuEnv = process.env.HAIKU_BACKEND?.trim();
  roles.push({
    role: "Global Haiku backend (HAIKU_BACKEND)",
    bot: haikuOverride ?? (haikuEnv || null),
    origin: haikuOverride ? "override" : haikuEnv ? "env" : "default",
    note: haikuOverride
      ? "DB override — forces every bot's Haiku backend"
      : haikuEnv
        ? "env — forces every bot's Haiku backend"
        : "unset — each bot uses its connector default (see Bots table)",
    overrideKey: "HAIKU_BACKEND",
    overrideValue: haikuOverride,
    editKind: "backend",
  });

  // ---- Wiki synthesis (per-wiki owner routing) -----------------------------
  // One row per registered wiki: which bot answers its Ask / What's-new digest,
  // and whether that's the owning bot (`owner`) or the research-bot fallback
  // (`fallback`, for standalone or opus-owned wikis). Read-only diagnostic.
  let wikiRegistry: WikiRegistryEntry[] = [];
  try {
    wikiRegistry = deps.getWikiRegistry();
  } catch (err) {
    errors.push(`wiki_registry: ${err instanceof Error ? err.message : String(err)}`);
  }
  const wikiSynthesis: WikiSynthesisEntry[] = wikiRegistry.map((entry) => {
    const { bot, origin } = resolveWikiSynthesisBot(entry, bots);
    // A pin that didn't win (origin !== "pinned") named no discovered bot and
    // was ignored — surface it as an error note, like a stale role override.
    const ignoredPin = entry.synthesisBot && origin !== "pinned" ? entry.synthesisBot : undefined;
    return {
      wiki: entry.name,
      source: entry.source,
      bot: bot?.name ?? null,
      connector: bot?.connector ?? "claude-cli",
      model: bot?.model ?? globalModelDefault,
      origin,
      ...(ignoredPin ? { ignoredPin } : {}),
    };
  });

  // ---- Pipeline jobs -------------------------------------------------------
  const selected = bots.find((b) => b.name === selectedBot) ?? bots[0];
  const selectedName = selected?.name ?? selectedBot;
  const selectedBackend = selected
    ? resolveBackendWithReason({ connector: selected.connector, haikuBackend: selected.haikuBackend }).backend
    : "cli";
  const selectedModel = selected?.model ?? globalModelDefault;

  const pipeline: PipelineEntry[] = [];

  // Haiku router jobs (per selected bot).
  const haikuRouterLabel = `Haiku router (${selectedBackend})`;
  for (const [job, source] of [
    ["research_knowledge decomposer", "knowledge-decompose"],
    ["Memory extractor", "memory"],
    ["Goal detector", "goals"],
    ["Schedule detector", "schedule"],
    ["Gardener clustering", "wiki_gardener_cluster"],
  ] as const) {
    pipeline.push({
      job: `${job} · ${selectedName}`,
      backend: haikuRouterLabel,
      model: { value: HAIKU_DEFAULT_MODEL, origin: "default" },
      note: "backend picked per bot connector",
      used: usedHaikuForSource(source, selectedName),
    });
  }

  // Gardener drafts run on the bot's own connector + model, thinking capped 8k.
  pipeline.push({
    job: `Gardener drafts · ${selectedName}`,
    backend: `${selected?.connector ?? "claude-cli"} (bot connector)`,
    model: { value: selectedModel, origin: selected?.model ? "config" : "default" },
    note: `thinking capped ${GARDENER_DRAFT_THINKING_MAX_TOKENS.toLocaleString()} tokens`,
    used: [],
  });

  // Embeddings — always local, never a remote model call.
  pipeline.push({
    job: "Embeddings (hybrid memory search)",
    backend: "local (@huggingface/transformers)",
    model: { value: EMBEDDINGS_MODEL, origin: "fixed" },
    note: "384-dim, quantized, on-device",
    used: [],
  });

  // Watcher gates — backend fixed to CLI (they need Gmail MCP), MODEL per-watcher.
  const gateSourceByType: Partial<Record<Watcher["type"], string>> = {
    email: "watcher-email",
    x: "watcher-x",
    anthropic: "watcher-anthropic",
    "wiki-gardener": "wiki_gardener_cluster",
  };
  for (const w of watchers) {
    if (w.type === "wiki-linter" || w.type === "news") {
      // Report-only / no-AI watchers.
      pipeline.push({
        job: `Watcher: ${w.name} · ${w.botName}`,
        backend: "none",
        model: { value: "—", origin: "none" },
        note: w.type === "wiki-linter" ? "report-only (no AI)" : "no AI (RSS)",
        used: [],
      });
      continue;
    }
    const configModel = typeof w.config?.model === "string" ? (w.config.model as string) : null;
    const source = gateSourceByType[w.type];
    pipeline.push({
      job: `Watcher: ${w.name} · ${w.botName}`,
      backend: w.type === "wiki-gardener" ? `Haiku router / ${w.botName} bot connector` : "Claude CLI (Gmail MCP)",
      model: {
        value: configModel ?? HAIKU_DEFAULT_MODEL,
        origin: configModel ? "config" : "default",
      },
      note: w.type === "wiki-gardener" ? "cluster: Haiku · draft: bot model" : "backend fixed to CLI",
      used: source ? usedHaikuForSource(source, w.botName) : [],
    });
  }

  // Report-only counters with no model.
  pipeline.push({
    job: "Wiki linter / ingest-backlog counter",
    backend: "none",
    model: { value: "—", origin: "none" },
    note: "report-only, no AI",
    used: [],
  });

  if (errors.length > 0) {
    log.warn("models overview assembled with {count} degraded source(s)", { count: errors.length });
  }

  return {
    selectedBot: selectedName,
    generatedAt: now,
    bots: botEntries,
    roles,
    wikiSynthesis,
    pipeline,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function _internalsForTest() {
  return { haikuBackendOrigin, uniqSorted, EMBEDDINGS_MODEL, GARDENER_DRAFT_THINKING_MAX_TOKENS };
}
