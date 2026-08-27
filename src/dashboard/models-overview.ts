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

import os from "node:os";
import { resolveVertexConfig, schedulerEnabledFromEnv, type VertexConfig } from "../config.ts";
import { isWikiReadonly, readonlyWikiRoots } from "../wiki/readonly.ts";
import type { BotConfig } from "../bots/config.ts";
import { discoverAllBots, resolveResearchBot, resolveSummarizerBot, resolveWikiSynthesisBot } from "../bots/config.ts";
import type { WikiRegistryEntry } from "../wiki/registry.ts";
import { getWikiRegistry, unmatchedReadonlyWikiRoots } from "../wiki/registry-memo.ts";
import { resolveBackendWithReason, resolveBackendChain } from "../ai/haiku-direct.ts";
import type { BackendChainSource, HaikuBackend } from "../ai/haiku-direct.ts";
import type { ConnectorType } from "../bots/config.ts";
import { connectorCapabilities } from "../ai/one-shot.ts";
import { DEFAULT_MODEL as HAIKU_DEFAULT_MODEL } from "../scheduler/executor.ts";
import { getAllWatchers } from "../db/watchers.ts";
import type { Watcher } from "../types.ts";
import { getDb } from "../db/client.ts";
import { getRoleOverride, type RoleKey } from "../db/role-overrides.ts";
import type { AgentKind } from "../observability/agent-status.ts";
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

/**
 * One display row of the per-bot Haiku-backend resolution chain, powering the
 * "▸ why this Haiku backend?" panel. Derived from `resolveBackendChain`
 * (haiku-direct.ts) — the winning row has `wins: true` (rendered bright + green
 * dot + WINS chip). The five UI levels; the call-site-only `explicit` level is
 * excluded and the `cli` floor is folded into the `connector` row so a plain
 * claude-cli bot still shows a winner. See {@link buildWhyChain}. */
export interface BackendChainRow {
  source: "override" | "env" | "config" | "legacy" | "connector";
  /** Human label, e.g. "DB override (HAIKU_BACKEND)". */
  label: string;
  /** Resolved value at this level, or null when inactive/unset. */
  value: string | null;
  /** Secondary dim detail. */
  detail?: string;
  /** The winning level (exactly one true row per bot). */
  wins: boolean;
}

export interface BotEntry {
  name: string;
  connector: EffectiveValue;
  model: EffectiveValue;
  thinkingMaxTokens: number | null;
  haikuBackend: EffectiveValue;
  /** Human-readable reason from `resolveBackendWithReason` (the winning rule). */
  haikuBackendReason: string;
  /** The per-bot Haiku-backend resolution chain (why-panel rows). */
  chain: BackendChainRow[];
  /** Distinct chat models seen in traces over the last window ("—" when empty). */
  usedChatModels: string[];
  /** Distinct Haiku models seen across all sources over the last window. */
  usedHaikuModels: string[];
  /** True when a used chat model diverged from the configured one (the #191
   *  silent-fallback class). Computed once in the pure assembly so the warning
   *  border / callout / "N mismatch" meta all consume this single field. */
  mismatch: boolean;
  /** The specific used-but-not-configured chat models (drives the callout text). */
  mismatchModels: string[];
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
  /**
   * Additive runtime-match hints (PR 4) — let the `/models` page merge live
   * `/api/agents/overview` runs onto this row WITHOUT parsing the `job` string
   * client-side. Only rows that map to a trackable `AgentKind` set them (today:
   * watcher rows and the gardener-drain row); rows with no `matchKind` never
   * show a runtime chip. See `mergePipelineRuntime` in `models-runtime.ts`.
   */
  matchKind?: AgentKind;
  matchBot?: string;
  /** Stable run name to disambiguate same-kind rows (watcher rows). */
  matchName?: string;
  /** Alternate accepted name — watcher TYPE, matching trace-sourced `recent[]`
   *  entries (named by `watcher:<type>` span, not display name). */
  matchRecentName?: string;
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

/**
 * Which muninn instance the reader is looking at — the "Machine" card.
 *
 * Muninn runs on two machines (laptop + Mac mini) against the same wikis, and
 * the profile difference is entirely env: no bot tokens, `SCHEDULER_ENABLED`
 * off, `MUNINN_WIKI_READONLY` on. None of that is visible anywhere else, so a
 * flag set on the wrong host is invisible until two instances write one wiki.
 * This makes the drift readable instead of implied.
 */
export interface MachineInfo {
  hostname: string;
  schedulerEnabled: boolean;
  wikiReadonly: boolean;
  /**
   * Does THIS instance own programmatic wiki page writes? Exactly
   * `!wikiReadonly` — named for the question it answers, since "readonly: false"
   * reads as an absence rather than a responsibility.
   */
  wikiWriteOwner: boolean;
  /**
   * Discovered bot folders in discovery order, each flagged with whether the
   * process actually STARTED it. `discoverAllBots` lists every folder with a
   * `CLAUDE.md`, but `discoverActiveBots` (what `src/index.ts` starts) requires a
   * platform token and logs "Skipping bot X — no platform tokens" for the rest.
   * On the readonly mini that is typically ALL of them, so a bare name list
   * claimed bots that poll nothing.
   */
  bots: { name: string; polling: boolean }[];
  /**
   * Registered wikis — the set this instance could write if it owned writes.
   * Deliberately NO `root`: it was never rendered, and publishing absolute
   * filesystem paths on a reader-facing API is the `base_url` mistake again.
   */
  wikis: { name: string; source: WikiRegistryEntry["source"]; readonly?: boolean }[];
  /**
   * Resolved `WIKI_READONLY_ROOTS` entries — the per-wiki mechanism beside the
   * instance flag. Rendered so the drift between this var and `WIKI_EXTRA` is
   * readable without issuing a POST: an entry matching no wiki above guards
   * nothing (it fails closed for itself, which is safe and invisible).
   *
   * Roots ARE published here, unlike `wikis[].root`. The difference is that this
   * list is not derivable from anything else on the page — its whole value is
   * showing which absolute path is protected — and it is what makes a typo
   * diagnosable at a glance.
   */
  readonlyRoots: string[];
  /**
   * The subset of `readonlyRoots` matching NO registered wiki above — the drift
   * between `WIKI_READONLY_ROOTS` and `WIKI_EXTRA`/a bot's `wikiDir`. Rendered
   * DISTINCTLY from the matched ones, because they are opposite facts: a matched
   * root guards a wiki, an unmatched one guards nothing at all. Collapsed into a
   * single count, "Read-only wikis: 1" was true of a typo that protected nothing.
   *
   * Same realpath-aware comparison the registry's no-match warn uses
   * (`unmatchedReadonlyWikiRoots`), so the card and the log line agree.
   */
  readonlyRootsUnmatched: string[];
  /**
   * Did the registry actually load? `wikis: []` is ambiguous — an install with no
   * wikis and a registry that THREW look identical, and the second reading makes
   * a readonly instance look harmless. The detail is in `errors[]`.
   */
  wikisKnown: boolean;
  /**
   * The Vertex credential seam, or null when this instance declares none.
   *
   * On `/models` because that is where "what would actually run" already lives,
   * and because the two failure shapes are invisible everywhere else: a project
   * set under muninn's `VERTEX_PROJECT_ID` while the Agent SDK reads
   * `ANTHROPIC_VERTEX_PROJECT_ID` (so the card names the WINNING variable, not
   * just the value), and `CLAUDE_CODE_USE_VERTEX` off while the region and
   * project are configured — a bot that looks Vertex-bound and is not.
   *
   * The project id IS published, unlike `wikis[].root`. The two are not the same
   * call: a filesystem path was never rendered and had no diagnostic use, while
   * naming the project is the whole point of the row — a Vertex card that hid it
   * could not tell an operator they are pointed at the wrong one. A GCP project
   * id is also not a secret — it appears in every Vertex request URL.
   * (`/models` is admin-zone in `src/auth/zones.ts` — but only in an
   * authenticating mode, and `MUNINN_AUTH` defaults to `off`, which mounts no
   * middleware at all. So the zone is a reason, not the reason.)
   *
   * `null` rather than a zeroed record when nothing is configured, so the card
   * can omit the block instead of asserting "Vertex: not configured" on the many
   * instances for which that is not a fact worth a row.
   */
  vertex: VertexConfig | null;
}

export interface ModelsOverview {
  selectedBot: string;
  generatedAt: number;
  machine: MachineInfo;
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
  /** This machine's hostname (the Machine card's identity). Injected so a test
   *  asserts a fixed string rather than the runner's host. */
  getHostname: () => string;
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
  getHostname: () => os.hostname(),
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

/**
 * The used-vs-configured mismatch predicate (the #191 silent-fallback class),
 * lifted out of the client so the warning border, callout, and "N mismatch"
 * meta all consume ONE rule. A used chat model counts as a mismatch when it is
 * neither equal to the configured model nor a bidirectional substring of it —
 * the substring tolerance absorbs id-shape drift (Copilot `claude-haiku-4.5` vs
 * Anthropic `claude-haiku-4-5-20251001`). Returns the offending models.
 */
export function computeModelMismatch(configured: string, usedChatModels: string[]): string[] {
  return usedChatModels.filter(
    (m) => m !== configured && !m.includes(configured) && !configured.includes(m),
  );
}

/**
 * Build the five-level "why this Haiku backend?" display chain from the raw
 * 7-level `resolveBackendChain`. Excludes the call-site-only `explicit` level
 * and folds the `cli` floor into the `connector` row (so a plain claude-cli bot
 * still shows a winning row). Legacy renders only when the flag is set.
 */
export function buildWhyChain(opts: { connector?: ConnectorType; haikuBackend?: HaikuBackend }): BackendChainRow[] {
  const links = resolveBackendChain({ connector: opts.connector, haikuBackend: opts.haikuBackend });
  const winner = links.find((l) => l.wins);
  const won = (src: BackendChainSource) => winner?.source === src;
  const link = (src: BackendChainSource) => links.find((l) => l.source === src)!;

  const rows: BackendChainRow[] = [
    { source: "override", label: "DB override (HAIKU_BACKEND)", value: link("override").value, detail: "hot — beats env", wins: won("override") },
    { source: "env", label: "env HAIKU_BACKEND", value: link("env").value, detail: "process-wide debug knob", wins: won("env") },
    { source: "config", label: "per-bot config (haikuBackend)", value: link("config").value, detail: "bots/<name>/config.json", wins: won("config") },
  ];
  // Legacy is deprecated — surface it only when actually set.
  if (link("legacy").value != null) {
    rows.push({ source: "legacy", label: "legacy HAIKU_DIRECT_ENABLED", value: link("legacy").value, detail: "deprecated alias for anthropic", wins: won("legacy") });
  }
  // Connector default folds the cli floor: copilot-sdk → copilot, else → cli.
  // Wins when either the connector link OR the floor `default` link won.
  const isCopilot = opts.connector === "copilot-sdk";
  rows.push({
    source: "connector",
    label: "connector default",
    value: isCopilot ? "copilot" : "cli",
    detail: isCopilot ? "copilot-sdk → copilot" : `${opts.connector ?? "claude-cli"} → cli floor`,
    wins: won("connector") || won("default"),
  });
  return rows;
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
    const usedChatModels = uniqSorted(chatByBot.get(bot.name) ?? []);
    const configuredModel = bot.model ?? globalModelDefault;
    const mismatchModels = computeModelMismatch(configuredModel, usedChatModels);
    return {
      name: bot.name,
      connector: {
        value: bot.connector ?? "claude-cli",
        origin: bot.connector ? "config" : "default",
      },
      model: {
        value: configuredModel,
        origin: bot.model ? "config" : "default",
      },
      thinkingMaxTokens: bot.thinkingMaxTokens ?? null,
      haikuBackend: { value: backend, origin: haikuBackendOrigin(reason) },
      haikuBackendReason: reason,
      chain: buildWhyChain({ connector: bot.connector, haikuBackend: bot.haikuBackend }),
      usedChatModels,
      usedHaikuModels: uniqSorted(haikuByBot.get(bot.name) ?? []),
      mismatch: mismatchModels.length > 0,
      mismatchModels,
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
  // Tracked separately from the (empty) list: the Machine card must be able to
  // say "unknown" rather than "none" when this threw.
  let wikiRegistryKnown = true;
  try {
    wikiRegistry = deps.getWikiRegistry();
  } catch (err) {
    wikiRegistryKnown = false;
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
  // A manual backlog drain registers a `gardener_drain` run under this bot, so
  // this row can light up "running now" (the weekly watcher runs as a `watcher`
  // kind — matched by its own watcher row below, not here).
  pipeline.push({
    job: `Gardener drafts · ${selectedName}`,
    backend: `${selected?.connector ?? "claude-cli"} (bot connector)`,
    model: { value: selectedModel, origin: selected?.model ? "config" : "default" },
    note: `thinking capped ${GARDENER_DRAFT_THINKING_MAX_TOKENS.toLocaleString()} tokens`,
    used: [],
    matchKind: "gardener_drain",
    matchBot: selectedName,
    matchName: "Backlog drain",
  });

  // Embeddings — always local, never a remote model call.
  pipeline.push({
    job: "Embeddings (hybrid memory search)",
    backend: "local (@huggingface/transformers)",
    model: { value: EMBEDDINGS_MODEL, origin: "fixed" },
    note: "384-dim, quantized, on-device",
    used: [],
  });

  // Watcher gates. email/x/anthropic run the Gmail-MCP CLI path; the gardener
  // watchers draft on the bot's OWN connector via executeOneShot (mirroring
  // watcherConnectorInfo), so they are NOT "backend fixed to CLI".
  // `gateSourceByType` only names the Haiku sources that write `haiku_usage` rows —
  // the consolidation gardener clusters DETERMINISTICALLY (`computeClusters`, no
  // Haiku cluster call), so it has no gate source and its `used` column stays empty.
  const gateSourceByType: Partial<Record<Watcher["type"], string>> = {
    email: "watcher-email",
    x: "watcher-x",
    anthropic: "watcher-anthropic",
    "wiki-gardener": "wiki_gardener_cluster",
  };
  for (const w of watchers) {
    if (w.type === "wiki-linter" || w.type === "wiki-committer" || w.type === "news") {
      // Report-only / no-AI watchers (linter reports, committer sweeps git, news RSS).
      const noAiNote =
        w.type === "wiki-linter"
          ? "report-only (no AI)"
          : w.type === "wiki-committer"
            ? "commit sweeper (no AI)"
            : "no AI (RSS)";
      pipeline.push({
        job: `Watcher: ${w.name} · ${w.botName}`,
        backend: "none",
        model: { value: "—", origin: "none" },
        note: noAiNote,
        used: [],
        matchKind: "watcher",
        matchBot: w.botName,
        matchName: w.name,
        matchRecentName: w.type,
      });
      continue;
    }
    const configModel = typeof w.config?.model === "string" ? (w.config.model as string) : null;
    const source = gateSourceByType[w.type];
    if (w.type === "wiki-gardener" || w.type === "consolidation-gardener") {
      // Both draft on the bot's own connector (the dominant work). The wiki
      // gardener ALSO runs a Haiku cluster call (hence "Haiku router / …" +
      // HAIKU_DEFAULT_MODEL); the consolidation gardener clusters deterministically,
      // so its row is purely the bot-connector synthesis draft on the bot's model.
      const wBot = bots.find((b) => b.name === w.botName);
      if (w.type === "consolidation-gardener") {
        pipeline.push({
          job: `Watcher: ${w.name} · ${w.botName}`,
          backend: `${wBot?.connector ?? "claude-cli"} (bot connector)`,
          model: {
            value: configModel ?? wBot?.model ?? globalModelDefault,
            origin: configModel || wBot?.model ? "config" : "default",
          },
          note: "synthesis draft: bot model",
          used: source ? usedHaikuForSource(source, w.botName) : [],
          matchKind: "watcher",
          matchBot: w.botName,
          matchName: w.name,
          matchRecentName: w.type,
        });
      } else {
        pipeline.push({
          job: `Watcher: ${w.name} · ${w.botName}`,
          backend: `Haiku router / ${w.botName} bot connector`,
          model: {
            value: configModel ?? HAIKU_DEFAULT_MODEL,
            origin: configModel ? "config" : "default",
          },
          note: "cluster: Haiku · draft: bot model",
          used: source ? usedHaikuForSource(source, w.botName) : [],
          matchKind: "watcher",
          matchBot: w.botName,
          matchName: w.name,
          matchRecentName: w.type,
        });
      }
      continue;
    }
    pipeline.push({
      job: `Watcher: ${w.name} · ${w.botName}`,
      backend: "Claude CLI (Gmail MCP)",
      model: {
        value: configModel ?? HAIKU_DEFAULT_MODEL,
        origin: configModel ? "config" : "default",
      },
      note: "backend fixed to CLI",
      used: source ? usedHaikuForSource(source, w.botName) : [],
      matchKind: "watcher",
      matchBot: w.botName,
      matchName: w.name,
      matchRecentName: w.type,
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

  // BEFORE the warn below, deliberately: it can push an error of its own, and a
  // warn line that counted every degraded source except this one would be wrong
  // exactly when a boot-refusing misconfiguration is what degraded the page.
  const vertex = vertexInfo(errors);

  if (errors.length > 0) {
    log.warn("models overview assembled with {count} degraded source(s)", { count: errors.length });
  }

  // ---- Machine (which instance is this?) -----------------------------------
  // Env-only profile, read at request time (the flags are process-scoped and
  // fixed for the process, but reading them here keeps the card honest under a
  // test that sets them). `wikiRegistry` is the same list the synthesis group
  // used, so the two cards can never disagree about which wikis exist.
  // `isWikiReadonly()` — the SAME reader the write seams and route guards use,
  // not `wikiReadonlyFromEnv()`. The card's whole job is to report what this
  // instance actually enforces; reading a level below the enforcement point let
  // the two disagree.
  const wikiReadonly = isWikiReadonly();
  const machine: MachineInfo = {
    hostname: deps.getHostname(),
    schedulerEnabled: schedulerEnabledFromEnv(),
    wikiReadonly,
    wikiWriteOwner: !wikiReadonly,
    // "Polling" mirrors `discoverBotsInternal`'s own token test: a Telegram token,
    // or BOTH Slack tokens.
    bots: bots.map((b) => ({
      name: b.name,
      polling: !!b.telegramBotToken || (!!b.slackBotToken && !!b.slackAppToken),
    })),
    wikis: wikiRegistry.map((e) => ({
      name: e.name,
      source: e.source,
      ...(e.readonly ? { readonly: true } : {}),
    })),
    readonlyRoots: readonlyWikiRoots(),
    // A registry that THREW gives an empty list, which would report EVERY
    // configured root as unmatched — a loud false alarm on a degraded read. The
    // honest answer there is "unknown", and `wikisKnown` already says so.
    readonlyRootsUnmatched: wikiRegistryKnown
      ? unmatchedReadonlyWikiRoots(wikiRegistry, readonlyWikiRoots())
      : [],
    wikisKnown: wikiRegistryKnown,
    // Resolved above, through the SAME resolver the boot refusal uses — reading
    // a level below the enforcement point is what let the readonly card and the
    // readonly seams disagree. It can THROW (a `global` region), which on a
    // booted instance is unreachable because `loadConfig` already refused;
    // catching it keeps a diagnostic page from 5xx-ing on the one instance that
    // most needs to be read.
    vertex,
  };

  return {
    selectedBot: selectedName,
    generatedAt: now,
    machine,
    bots: botEntries,
    roles,
    wikiSynthesis,
    pipeline,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

/**
 * The Vertex block for the Machine card. Returns null when nothing is
 * configured — which is every field unset, not merely "the switch is off": an
 * instance with a project and region declared but `CLAUDE_CODE_USE_VERTEX`
 * absent is exactly the state the card exists to show, so it renders.
 */
function vertexInfo(errors: string[]): VertexConfig | null {
  try {
    const vertex = resolveVertexConfig();
    // `perModelRegions` is part of "is anything configured?" — omitting it hid the
    // whole block for an instance whose ONLY Vertex setting is a per-model region
    // override, which is exactly the case the override row exists to report,
    // since there is then no region line for it to contradict.
    if (!vertex.enabled && !vertex.projectId && !vertex.region && !vertex.baseUrl
        && vertex.perModelRegions.length === 0) return null;
    return vertex;
  } catch (err) {
    errors.push(`vertex config: ${(err as Error).message}`);
    return null;
  }
}

export function _internalsForTest() {
  return { haikuBackendOrigin, uniqSorted, computeModelMismatch, buildWhyChain, vertexInfo, EMBEDDINGS_MODEL, GARDENER_DRAFT_THINKING_MAX_TOKENS };
}
