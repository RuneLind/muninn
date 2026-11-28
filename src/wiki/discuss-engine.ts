/**
 * The Discuss engine (mimir plan muninn-wiki-discuss-v2, PR 3): the preflight
 * ladder and the fenced turn of Discuss's wiki agent, lifted out of the pane
 * route so both entry points run it — the pane (`POST /api/wiki/discuss`) and
 * /chat's send route for a `kind = 'wiki'` thread. Never the chat pipeline: no
 * persona, no memory or goal block, no extractor, no personal tools (D7).
 *
 * A turn runs on a wiki thread (`threads.kind = 'wiki'`, one live per user,
 * bot and page, or per user, bot and key for a trace thread: PR 6, whose
 * every turn's pack is rebuilt from the key's mentions payload, `mentions.ts`,
 * with no page, no card and no repo, and only in Explore). The thread id is the discussion id, so the ledger
 * (`wiki_discuss_turns`) stays the prompt's history, and each turn stores two
 * `messages` rows on the thread (`platform 'web'`, `source 'wiki'`): the
 * question (plus one quoted line for the selection) and the answer with its
 * edit block replaced by a marker. The context pack is rebuilt every turn and
 * never stored.
 *
 * One turn is ONE fenced one-shot: the wiki's `.wiki-agent.md` (for the turn's
 * mode, `rulesForMode`) as the system prompt's rules, the context pack and the
 * discussion so far in the prompt, under {@link DISCUSS_TURN_TIMEOUT_MS}. The
 * surface is declared HERE by the owning bot's connector type, never by the
 * rules file or a connector the caller names:
 *
 *  - claude-cli / claude-sdk: `{ readSearch }` over the wiki's snapshot and a
 *    snapshot of each repo in reach (`reposInReach`).
 *  - copilot-sdk: `{ mcpTools }` — {@link COPILOT_DISCUSS_TOOLS}, plus the
 *    research server's wiki read tools for a bot that declares it
 *    ({@link copilotDiscussReach}).
 *  - any other connector is refused in the preflight.
 *
 * Preflight, in order: 403 role not admin · 404 `trace-off` a trace while
 * `MUNINN_AUTH` is not `off` (the mentions route's rule) · 404 an unknown wiki · 403
 * `readonly` a read-only wiki (the egress prologue, right after the wiki
 * resolves) · 404 `no-agent` · 422 `rules-too-large` / 503 `rules-unreadable` ·
 * the page ladder (404/503) · 503 `no-bot` · 422 `connector` · 503 `surface` ·
 * on read-and-search 503 `no-snapshot` and 422 `page-not-in-snapshot` (a trace,
 * on any connector: 503 `no-snapshot` when the wiki is no git work tree or has no commit yet) · 422
 * `no-user` / `unknown-user` the thread's user · 404/409 the discussion (a
 * given id must be this page's live wiki thread) · 409 `origin` (Discuss v3
 * P2: a follow-up's `originTurnId` must be a first turn of that thread) ·
 * 409 `busy` · 429 `busy` (the
 * in-flight cap). Only then is the thread created (so a refused request leaves
 * no empty thread) and the turn row inserted with the user message in one
 * transaction (409 `busy` when the database holds another live turn).
 *
 * A live turn's process touches its row's `heartbeat_at`; a `running` row past
 * {@link DISCUSS_STALE_RUNNING_MS} is closed `abandoned` by the next start and
 * by {@link startDiscussTurnSweep}, with an «(unfinished)» message on its thread.
 */
import path from "node:path";
import type { Config } from "../config.ts";
import { resolveServingProfile } from "../config.ts";
import { getLog } from "../logging.ts";
import { discoverAllBots, resolveWikiSynthesisBot, wikiSynthesisInputsKey, type BotConfig, type ConnectorType } from "../bots/config.ts";
import { executeOneShot } from "../ai/one-shot.ts";
import { toolSurfaceBlocker, type ToolSurface } from "../ai/tool-surface.ts";
import { snapshotRootDir } from "../ai/agent-cwd.ts";
import { codeSnapshot, leaseSnapshot, wikiSnapshot, wikiSnapshotHolds, type Snapshot } from "../ai/snapshots.ts";
import { parseMcpConfig } from "../ai/connectors/copilot-mcp.ts";
import { botExcludesMcpTool } from "../ai/connectors/copilot-sdk.ts";
import { authMode } from "../auth/policy.ts";
import { getBotDefaultUser } from "../db/chat-preferences.ts";
import { getLiveWikiThread, getLiveWikiTraceThread, getOrCreateWikiThread, getOrCreateWikiTraceThread, getThreadById, type Thread } from "../db/threads.ts";
import {
  closeAbandonedDiscussTurns,
  finishDiscussTurn,
  listDiscussTurns,
  markDiscussReaderLeft,
  setDiscussTurnCard,
  startDiscussTurn,
  storeDiscussAssistantMessage,
  touchDiscussTurn,
  unfinishedMessage,
  DiscussTurnConflict,
  type DiscussSentFrom,
  type DiscussStoredPassage,
  type DiscussToolCall,
  type DiscussTurn,
} from "../db/wiki-discuss-turns.ts";
import { researchMcpServer } from "../research/mcp-server.ts";
import { WIKI_TOOL_NAMES, type BotWiki } from "../research/wiki-tools.ts";
import { sha256 } from "../utils/date-hash.ts";
import { parseHandoffBody, type HandoffBody } from "./discuss-body.ts";
import { HANDOFF_CONTEXT_MAX, HANDOFF_SELECTION_MAX } from "./discuss-bounds.ts";
import { buildContextPack } from "./discuss-pack.ts";
import { clampLine } from "./discuss-prompt.ts";
import {
  DISCUSS_TURN_TIMEOUT_MS,
  cardForSnapshot,
  extractProposedEdit,
  pageReposAsked,
  readWikiAgentRules,
  renderAgentSystemPrompt,
  renderAgentTurnPrompt,
  reposInReach,
  rulesForMode,
  stripProposedEdit,
  traceThreadName,
  wikiAgentRulesRefusal,
  wikiThreadName,
  type AgentReach,
  type DiscussMode,
  type PackRepo,
} from "./discuss-agent.ts";
import { parseRepoRoots, realGit, type GitRun } from "./decision-triage/git.ts";
import { keyMentionsSection, renderTraceTurnPrompt } from "./discuss-trace.ts";
import { discussTurnKey } from "./discuss-key.ts";
import { buildMentions, mentionsGitState, parseMentionKey, type MentionsBody, type MentionsInput } from "./mentions.ts";
import { realGhCheckDeps, type GhCheckDeps } from "./work-map/gh-check.ts";
import { planCardConfigFromEnv, planCardRootFor, type PlanCardConfig } from "./plan-card.ts";
import { planCardFromOutcome, runPlanCard } from "./plan-card-run.ts";
import { getWikiRegistry } from "./registry-memo.ts";
import { botWikis, resolveWikiRequest, type WikiRegistryEntry } from "./registry.ts";
import { isReadonlyWikiRoot, wikiNoEgressReason } from "./readonly.ts";
import { getWikiIndex, parseFrontmatter, readWikiPage, readWikiText, resolveWikiRoot, type WikiIndex } from "./store.ts";
import { discussToolLine } from "./discuss-tool-line.ts";

/** The Copilot surface (D2): the knowledge server's search for other pages,
 *  and yggdrasil's listing and graph tools. Never `read_source`,
 *  `detect_changes` or `search_pattern` (the never-list refuses them anyway);
 *  the knowledge server's `get_document` is left out (P2a's check of it
 *  against an ignored file was inconclusive). */
export const COPILOT_DISCUSS_TOOLS: Record<string, string[]> = {
  knowledge: ["search_knowledge"],
  yggdrasil: ["search", "file_outline", "symbol_context", "impact", "list_repos", "list_files"],
};

/**
 * The Copilot surface for one bot and page: {@link COPILOT_DISCUSS_TOOLS}, plus
 * `research: [wiki_grep, wiki_read, wiki_history]` when the bot's `.mcp.json`
 * declares `research` (else `copilotNamedToolsSession` throws for a server the
 * bot lacks), its `excludedTools` deny none of the three (else it throws for
 * the denied one), this process's research server serves them for the bot
 * (`researchServes`: else the session is built without them and
 * `assertSessionHoldsOnly` refuses the turn), the instance runs with
 * `MUNINN_AUTH=off` and the bot has a wiki. All three or none: the prompt
 * describes them as a set. `wikiToolsWiki` is the page's wiki as the tools
 * name it, only when it is in the bot's list (case-insensitive).
 */
export function copilotDiscussReach(opts: {
  mcpServers: readonly string[];
  botWikis: readonly BotWiki[];
  pageWiki: string;
  authOff: boolean;
  researchServes: boolean;
  excludedTools: string[] | undefined;
}): { tools: Record<string, string[]>; wikiToolsWiki?: string } {
  const denied = WIKI_TOOL_NAMES.some((tool) => botExcludesMcpTool(opts.excludedTools, "research", tool));
  if (!opts.mcpServers.includes("research") || !opts.researchServes || denied || !opts.authOff || opts.botWikis.length === 0) return { tools: COPILOT_DISCUSS_TOOLS };
  const tools = { ...COPILOT_DISCUSS_TOOLS, research: [...WIKI_TOOL_NAMES] };
  const wanted = opts.pageWiki.trim().toLowerCase();
  const hit = wanted ? opts.botWikis.find((w) => w.name.toLowerCase() === wanted) : undefined;
  return hit ? { tools, wikiToolsWiki: hit.name } : { tools };
}

/** Turns one engine runs at once, across every discussion and both entry points. */
export const DISCUSS_MAX_INFLIGHT = 4;
/** How often a running turn touches its row's `heartbeat_at`. */
export const DISCUSS_HEARTBEAT_MS = 15_000;
/** A `running` turn whose heartbeat is older than this belongs to a process
 *  that died: 12 missed beats, so a beat delayed by the wiki snapshot's
 *  synchronous copy (it blocks the event loop) is not read as a death. */
export const DISCUSS_STALE_RUNNING_MS = 3 * 60 * 1000;
/** How long past the engine's deadline the connector's own timeout kills the
 *  run: the engine's timer decides `timeout`, the connector's is cleanup. */
export const DISCUSS_CONNECTOR_GRACE_MS = 15_000;
/** The status line after the last tool call while no text has come (a model
 *  that bursts its answer at the end). */
export const DISCUSS_WRITING_STATUS = "writing the answer";

/** The engine's own deadline on the model call: the only cause stored as `timeout`. */
export class DiscussTurnTimeout extends Error {
  constructor(ms: number) {
    super(`the model call ran past ${ms} ms`);
    this.name = "DiscussTurnTimeout";
  }
}

/** A read-and-search turn whose snapshot does not hold the page the row was
 *  stored with (its `page_hash`, location and pack): never run on another text. */
function snapshotPageError(copy: string | null, pageHash: string): string | null {
  if (copy === null) return "the page is not in the wiki's snapshot (git ignores it, or it is reached through a symlink), so the agent cannot read it";
  if (sha256(copy) !== pageHash) return "the page changed on disk while the turn started, so the snapshot holds another version than the one this turn was stored with; ask again";
  return null;
}

/** How often the sweep closes abandoned turns on every discussion. */
export const DISCUSS_SWEEP_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Close abandoned turns now and every {@link DISCUSS_SWEEP_MS} (idempotent,
 *  unref'd): a turn whose process died is closed within the stale bound plus
 *  one sweep, whether or not its discussion is continued. */
export function startDiscussTurnSweep(close: typeof closeAbandonedDiscussTurns = closeAbandonedDiscussTurns): void {
  if (sweepTimer) return;
  const log = getLog("wiki", "discuss");
  const tick = () => {
    close(DISCUSS_STALE_RUNNING_MS)
      .then((ids) => {
        if (ids.length > 0) log.info("closed {n} abandoned discuss turn(s)", { n: ids.length, turnIds: ids });
      })
      .catch((err) => log.warn("discuss turn sweep failed: {error}", { error: err instanceof Error ? err.message : String(err) }));
  };
  tick();
  sweepTimer = setInterval(tick, DISCUSS_SWEEP_MS);
  sweepTimer.unref?.();
}

export function stopDiscussTurnSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}

/** The model a Discuss turn is asked to run on: the bot's, else the
 *  instance's. One function for the engine's `turn` frame and the reader's
 *  «Runs as» line (Discuss v3 P1), so the two cannot disagree. */
export function discussPlannedModel(bot: Pick<BotConfig, "model">, config: Pick<Config, "claudeModel">): string | null {
  return bot.model ?? config.claudeModel ?? null;
}

/** The bot Discuss runs on for a wiki, by the thread read's rule: a pinned
 *  wiki runs on its pin or on nothing (Ask's resolver falls back; Discuss
 *  refuses `no-bot`). Null when no bot answers. */
export function resolveDiscussBot(entry: WikiRegistryEntry | undefined, bots: BotConfig[]): { bot: BotConfig; origin: "pinned" | "owner" | "fallback" } | null {
  const { bot, origin } = resolveWikiSynthesisBot(entry, bots);
  if (!bot || (entry?.synthesisBot && origin !== "pinned")) return null;
  return { bot, origin };
}

/** Who answers a Discuss turn on this wiki, for the reader's tooltip and who
 *  box: the bot, where it comes from, its connector and planned model. */
export interface DiscussWho {
  bot: string;
  origin: "pinned" | "owner" | "fallback";
  connector: ConnectorType;
  model: string | null;
}

export function discussWhoFor(entry: WikiRegistryEntry | undefined, bots: BotConfig[], config: Pick<Config, "claudeModel">): DiscussWho | null {
  return whoOf(resolveDiscussBot(entry, bots), config);
}

function whoOf(hit: { bot: DiscussBotRef; origin: DiscussWho["origin"] } | null, config: Pick<Config, "claudeModel">): DiscussWho | null {
  if (!hit) return null;
  return { bot: hit.bot.name, origin: hit.origin, connector: hit.bot.connector ?? "claude-cli", model: discussPlannedModel(hit.bot, config) };
}

/** The fields of a bot the reader's who line and the thread read use. */
export type DiscussBotRef = Pick<BotConfig, "name" | "connector" | "model">;

/** Per wiki entry, the last {@link resolveDiscussBot} answer over
 *  `discoverAllBots()`, valid while `wikiSynthesisInputsKey()` is unchanged. */
let botHereInputs: string | null = null;
const botHere = new Map<string, { bot: DiscussBotRef; origin: DiscussWho["origin"] } | null>();

/**
 * {@link resolveDiscussBot} over the discovered bots, memoized for the reads a
 * page navigation makes (the page JSON's `discussWho`, the thread read). A
 * navigation used to walk every bot folder, parse each config.json and, on a
 * wiki pinned to a missing bot, log the resolver's warn — per page. The memo
 * is dropped when `wikiSynthesisInputsKey()` changes (a bot folder or
 * config.json added, removed or edited, `MUNINN_BOTS_DIR`, a RESEARCH_BOT /
 * SUMMARIZER_BOT override or env), so a config edit shows on the next read;
 * that check is a `readdir` and `stat`s, never a parse. A turn
 * (`runDiscussTurn`) still discovers afresh.
 */
export function resolveDiscussBotHere(entry: WikiRegistryEntry | undefined): { bot: DiscussBotRef; origin: DiscussWho["origin"] } | null {
  const inputs = wikiSynthesisInputsKey();
  if (inputs !== botHereInputs) {
    botHere.clear();
    botHereInputs = inputs;
  }
  const key = `${entry?.name ?? ""}\0${entry?.source ?? ""}\0${entry?.synthesisBot ?? ""}`;
  if (botHere.has(key)) return botHere.get(key)!;
  const hit = resolveDiscussBot(entry, discoverAllBots());
  const ref = hit ? { bot: { name: hit.bot.name, connector: hit.bot.connector, model: hit.bot.model }, origin: hit.origin } : null;
  botHere.set(key, ref);
  return ref;
}

/** {@link discussWhoFor} through {@link resolveDiscussBotHere}. */
export function discussWhoHere(entry: WikiRegistryEntry | undefined, config: Pick<Config, "claudeModel">): DiscussWho | null {
  return whoOf(resolveDiscussBotHere(entry), config);
}

type SurfaceKind = "readSearch" | "mcpTools";

/** The connector table: which surface a connector type gets, or null when it is not covered. */
export function discussSurfaceKind(connector: ConnectorType | undefined): SurfaceKind | null {
  switch (connector ?? "claude-cli") {
    case "claude-cli":
    case "claude-sdk":
      return "readSearch";
    case "copilot-sdk":
      return "mcpTools";
    default:
      return null;
  }
}

export interface DiscussStore {
  start: typeof startDiscussTurn;
  finish: typeof finishDiscussTurn;
  readerLeft: typeof markDiscussReaderLeft;
  setCard: typeof setDiscussTurnCard;
  list: typeof listDiscussTurns;
  heartbeat: typeof touchDiscussTurn;
  /** The turn's assistant message on its thread; default `storeDiscussAssistantMessage`. */
  assistant?: typeof storeDiscussAssistantMessage;
}

const dbStore: DiscussStore = {
  start: startDiscussTurn,
  finish: finishDiscussTurn,
  readerLeft: markDiscussReaderLeft,
  setCard: setDiscussTurnCard,
  list: listDiscussTurns,
  heartbeat: touchDiscussTurn,
  assistant: storeDiscussAssistantMessage,
};

/** The wiki threads the engine reads and creates; default the DB's. */
export interface DiscussThreadStore {
  get: typeof getThreadById;
  live: typeof getLiveWikiThread;
  getOrCreate: typeof getOrCreateWikiThread;
  /** A key's trace thread (PR 6); default the DB's. */
  liveTrace?: typeof getLiveWikiTraceThread;
  getOrCreateTrace?: typeof getOrCreateWikiTraceThread;
}

const dbThreads: DiscussThreadStore = { get: getThreadById, live: getLiveWikiThread, getOrCreate: getOrCreateWikiThread, liveTrace: getLiveWikiTraceThread, getOrCreateTrace: getOrCreateWikiTraceThread };

export interface DiscussEngineDeps {
  store?: DiscussStore;
  threads?: DiscussThreadStore;
  /** The users /chat lists for a bot (`loadChatConfig(bot).users`). Injected by
   *  the route: `src/chat/` sits above this layer. Without it a posted
   *  `userId` is refused. */
  chatUsers?: (botName: string) => Promise<{ id: string; name: string }[]>;
  /** The bot's `bot_default_user`; default `getBotDefaultUser`. */
  defaultUser?: (botName: string) => Promise<string | null>;
  bots?: () => BotConfig[];
  oneShot?: typeof executeOneShot;
  surfaceBlocker?: typeof toolSurfaceBlocker;
  wikiSnapshot?: (dir: string) => Promise<Snapshot>;
  codeSnapshot?: (dir: string) => Promise<Snapshot>;
  git?: GitRun;
  /** The bot's `.mcp.json` servers by name; default `parseMcpConfig`. */
  mcpServers?: (botDir: string) => Record<string, unknown>;
  /** Whether this process's research MCP server serves the wiki read tools
   *  for the bot; default `researchMcpServer.servesWikiTools`. */
  researchWikiTools?: (botName: string) => boolean;
  planCard?: typeof runPlanCard;
  /** A trace turn's mentions payload (PR 6); default `buildMentions` with the
   *  work map's `gh` refresh and this engine's `git`. */
  mentions?: (input: MentionsInput) => Promise<{ ok: true; body: MentionsBody } | { ok: false; error: string }>;
  /** `MUNINN_AUTH`'s mode; default the auth policy's. A trace turn runs only where it is `off`, as the mentions route answers. */
  authMode?: () => string;
  planCardConfig?: () => PlanCardConfig;
  /** `DECISION_TRIAGE_REPO_ROOTS`'s raw value; default the config's. */
  repoRoots?: () => string | null;
  timeoutMs?: number;
  /** Default {@link DISCUSS_HEARTBEAT_MS} and {@link DISCUSS_STALE_RUNNING_MS}. */
  heartbeatMs?: number;
  staleRunningMs?: number;
  log?: { info(msg: string, props: Record<string, unknown>): void; warn(msg: string, props: Record<string, unknown>): void; error(msg: string, props: Record<string, unknown>): void };
}

export interface DiscussBody extends HandoffBody {
  /** A trace turn (PR 6): the key, in place of a page (`relPath` is then "",
   *  and no selection is taken). */
  traceKey?: string;
  discussionId?: string;
  /** Explore (the default) or Edit: the rules file's edit section only in Edit. */
  mode?: DiscussMode;
  /** The thread's user; else the bot's `bot_default_user`. */
  userId?: string;
  /** Discuss v3 P2 (D9): a card's follow-up names its card's first turn,
   *  which must be a first turn of the thread this turn runs on (409 `origin`). */
  originTurnId?: string;
  /** A card's first turn: the passage as the reader held it in DOM order
   *  (`holdPassage`), for re-placing the card (D12). Its own text only when it
   *  differs from `selection`. Never with `originTurnId`. */
  held?: { before: string; after: string; at: number; passage?: string };
  /** Where the reader typed the turn, as the pane's body names it. */
  sentFrom?: "card" | "tab";
}

/** A trace on an authenticating instance: the mentions route's 404, as JSON. */
export const TRACE_AUTH_REFUSAL = { error: "Trace is not served on an instance that authenticates", reason: "trace-off" } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID_MAX = 200;

/** The handoff body plus `discussionId`, `mode` and `userId`; a string is the
 *  400 message. A trace body names `traceKey` (the mentions route's key rule)
 *  instead of `relPath`, with no selection fields, and only in Explore. */
export function parseDiscussBody(raw: unknown): DiscussBody | string {
  const r0 = raw as Record<string, unknown> | null;
  const traced = !!r0 && typeof r0 === "object" && !Array.isArray(r0) && r0.traceKey !== undefined && r0.traceKey !== null;
  let traceKey: string | undefined;
  if (traced) {
    const r = r0!;
    if (typeof r.traceKey !== "string") return "traceKey must be a string";
    if (r.relPath !== undefined && r.relPath !== null) return "send relPath or traceKey, not both";
    for (const k of ["selection", "before", "after", "atStart", "atEnd", "edge", "heading"]) if (r[k] !== undefined && r[k] !== null) return `a trace turn takes no ${k}`;
    if (r.mode === "edit") return "a trace turn is an Explore turn: there is no page to edit";
    const key = parseMentionKey(r.traceKey);
    if ("error" in key) return `traceKey: ${key.error}`;
    traceKey = key.key;
  }
  // A trace body passes the handoff checks on a stand-in page, which nothing reads.
  const body = parseHandoffBody(traced ? { ...r0, relPath: "(trace)" } : raw);
  if (typeof body === "string") return body;
  const r = raw as Record<string, unknown>;
  const out: DiscussBody = traceKey !== undefined ? { ...body, relPath: "", traceKey } : { ...body };
  const id = r.discussionId;
  if (id !== undefined && id !== null) {
    if (typeof id !== "string" || !UUID_RE.test(id)) return "discussionId must be a uuid";
    out.discussionId = id.toLowerCase();
  }
  const mode = r.mode;
  if (mode !== undefined && mode !== null) {
    if (mode !== "explore" && mode !== "edit") return 'mode must be "explore" or "edit"';
    out.mode = mode;
  }
  const user = r.userId;
  if (user !== undefined && user !== null) {
    if (typeof user !== "string" || !user.trim() || user.length > USER_ID_MAX) return `userId must be a non-empty string of at most ${USER_ID_MAX} characters`;
    out.userId = user;
  }
  const origin = r.originTurnId;
  if (origin !== undefined && origin !== null) {
    if (typeof origin !== "string" || !UUID_RE.test(origin)) return "originTurnId must be a uuid";
    out.originTurnId = origin.toLowerCase();
  }
  const sentFrom = r.sentFrom;
  if (sentFrom !== undefined && sentFrom !== null) {
    if (sentFrom !== "card" && sentFrom !== "tab") return 'sentFrom must be "card" or "tab"';
    out.sentFrom = sentFrom;
  }
  const held = r.held;
  if (held !== undefined && held !== null) {
    if (out.traceKey !== undefined) return "a trace turn takes no held";
    if (out.originTurnId) return "a follow-up takes no held passage: its card's first turn stores it";
    if (out.selection === undefined) return "held needs a selection";
    if (typeof held !== "object" || Array.isArray(held)) return "held must be an object";
    const h = held as Record<string, unknown>;
    if (typeof h.before !== "string" || typeof h.after !== "string") return "held.before and held.after must be strings";
    if (h.before.length > HANDOFF_CONTEXT_MAX || h.after.length > HANDOFF_CONTEXT_MAX) return `held.before and held.after are at most ${HANDOFF_CONTEXT_MAX} characters`;
    if (typeof h.at !== "number" || !Number.isFinite(h.at) || h.at < 0) return "held.at must be a number of at least 0";
    if (h.passage !== undefined && h.passage !== null) {
      if (typeof h.passage !== "string" || !h.passage.trim()) return "held.passage must be a non-empty string";
      if (h.passage.length > HANDOFF_SELECTION_MAX) return `held.passage is at most ${HANDOFF_SELECTION_MAX} characters`;
    }
    out.held = { before: h.before, after: h.after, at: h.at, ...(typeof h.passage === "string" && h.passage.trim() ? { passage: h.passage } : {}) };
  }
  return out;
}

const compactText = (s: string) => s.replace(/\s+/g, "");

/** A card's first turn's stored passage (D12): the context the reader sent in
 *  authored order, and its held passage, whose text is kept only when it
 *  differs from the selection with white space ignored (DOM and authored
 *  order part on a selection across DecisionLog items shown newest first).
 *  Null for a follow-up, a trace turn and a turn with no selection. */
export function storedPassageFor(body: DiscussBody): DiscussStoredPassage | null {
  if (body.originTurnId || body.traceKey !== undefined || !body.selection?.trim()) return null;
  const out: DiscussStoredPassage = {
    before: body.before ?? "",
    after: body.after ?? "",
    heading: body.heading ?? "",
    atStart: body.atStart === true,
    atEnd: body.atEnd === true,
    ...(body.edge ? { edge: body.edge } : {}),
  };
  if (body.held) {
    const { passage, ...sides } = body.held;
    out.held = passage !== undefined && compactText(passage) !== compactText(body.selection) ? { ...sides, passage } : sides;
  }
  return out;
}

/** What a refused request answers: the status and the JSON body. */
export interface DiscussRefusal {
  refused: true;
  status: 400 | 403 | 404 | 409 | 422 | 429 | 500 | 503;
  body: { error: string; reason?: string; [key: string]: unknown };
  /** Set only on a refusal about the state of the requester's own thread,
   *  raised after that thread was checked as theirs (same bot and page): a
   *  turn still running on it (`busy`) or it was closed (`closed`). The pane's
   *  entry mirrors only these to /chat (PR 4); every other refusal, any raised
   *  before the thread is checked among them, carries none. */
  ownThread?: string;
}

const refuse = (status: DiscussRefusal["status"], body: DiscussRefusal["body"], ownThread?: string): DiscussRefusal =>
  ownThread ? { refused: true, status, body, ownThread } : { refused: true, status, body };

/** The /chat mirror of one turn: built by each entry point for the thread's
 *  user and bot (the engine never imports chat state). Every call is
 *  best-effort; a throw is logged and the turn goes on. */
export interface DiscussMirror {
  userMessage(m: { id: string; text: string; createdAt: number }): void;
  delta(text: string): void;
  tool(m: { name: string; displayName: string; input: string; label: string; detail: string }): void;
  /** The stored answer (the edit block replaced, «(unfinished)» when it did not end done). */
  answer(m: { id: string | null; text: string; model: string | null; endState: string }): void;
}

export type DiscussMirrorFactory = (ctx: { userId: string; botName: string; threadId: string }) => DiscussMirror | Promise<DiscussMirror>;

export interface DiscussRequest {
  /** The caller's role: Discuss's wiki agent is for admins. */
  role: string;
  body: DiscussBody;
  /** The /chat entry: the thread's owner, already checked against the
   *  session; replaces the body's `userId` and the default user. */
  threadUser?: string;
  /** Builds the /chat mirror once the thread's user and bot are known. */
  mirror?: DiscussMirrorFactory;
  /** Where the reader typed the turn (`sent_from`, migration 095): set by
   *  each entry point (/chat's `chat`, the pane's `trace` for a key, else the
   *  pane body's `card`/`tab`); null when it names none. */
  sentFrom?: DiscussSentFrom | null;
}

/** A turn that passed the preflight: its row is inserted and the user message
 *  stored. `run` streams it (v1's events through `emit`) and must be called
 *  exactly once; `release` frees its in-flight slot when `run` never is. */
export interface StartedDiscussTurn {
  refused: false;
  turnId: string;
  seq: number;
  /** The thread id, which is the discussion id. */
  discussionId: string;
  userId: string;
  botName: string;
  location: unknown;
  run(emit: (event: string, data: unknown) => void): Promise<void>;
  /** Mark the turn's reader as gone (the pane's stream closed). */
  readerLeft(): void;
  release(): void;
}

/**
 * Discuss v3 P1 fix round 3 (the class check): would the engine take
 * `userId` if a request posted it? `resolveUser`'s own rule: a posted id must
 * be one of the bot's chat users. The one place that decides it, for every
 * answer that names a user (both thread reads, the trace read and the `turn`
 * frame), so the client never guesses it from `users` (empty on an
 * authenticating instance) or from holding a thread.
 */
export function discussUserPostable(users: readonly { id: string }[], userId: string): boolean {
  return users.some((u) => u.id === userId);
}

export interface DiscussEngine {
  start(req: DiscussRequest): Promise<DiscussRefusal | StartedDiscussTurn>;
  /** The thread's user for a page read (`GET /api/wiki/discuss/thread`): the
   *  posted id (refused unless /chat lists it), else the bot's default user. */
  resolveUser(botName: string, posted: string | undefined): Promise<{ userId: string; username: string | null; users: { id: string; name: string }[] } | DiscussRefusal>;
}

function abbreviate(s: string | undefined, max = 300): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** A tool call as stored and streamed: its input cut to `max`, its reader's
 *  line made from the whole input first. */
function toolCall(name: string, input: string | undefined, max = 300): Required<DiscussToolCall> {
  return { name, input: abbreviate(input, max), ...discussToolLine(name, input ?? "") };
}

/** A thread's user message: the bare question, plus one quoted line for the selection. */
export function threadUserMessage(question: string, selection: string | undefined): string {
  const q = question.trim();
  const sel = selection?.replace(/\s+/g, " ").trim();
  return sel ? `> ${clampLine(sel, 200)}\n\n${q}` : q;
}

interface Prepared {
  /** The live thread, or null when the turn creates it. */
  thread: Thread | null;
  earlier: DiscussTurn[];
  wiki: string;
  wikiRoot: string;
  /** A trace turn's key (PR 6); then `relPath`, `raw`, `pageHash` are "" and `title` is the key. */
  traceKey: string | null;
  index: WikiIndex;
  relPath: string;
  title: string;
  raw: string;
  pageHash: string;
  fm: Record<string, string | string[]>;
  project: string | undefined;
  allow: string[] | null;
  rules: string;
  mode: DiscussMode;
  bot: BotConfig;
  connector: ConnectorType;
  kind: SurfaceKind;
  copilot: ReturnType<typeof copilotDiscussReach> | null;
  body: DiscussBody;
  location: unknown;
  userId: string;
  username: string | null;
  /** {@link discussUserPostable} for `userId`: rides the `turn` frame. */
  userPostable: boolean;
}

export function createDiscussEngine(config: Config, deps: DiscussEngineDeps = {}): DiscussEngine {
  const log = deps.log ?? getLog("wiki", "discuss");
  const store = deps.store ?? dbStore;
  const storeAssistant = store.assistant ?? storeDiscussAssistantMessage;
  const threads = deps.threads ?? dbThreads;
  const oneShot = deps.oneShot ?? executeOneShot;
  const blocker = deps.surfaceBlocker ?? toolSurfaceBlocker;
  const researchWikiTools = deps.researchWikiTools ?? ((name: string) => researchMcpServer.servesWikiTools(name));
  const git = deps.git ?? realGit;
  const timeoutMs = deps.timeoutMs ?? DISCUSS_TURN_TIMEOUT_MS;
  const heartbeatMs = deps.heartbeatMs ?? DISCUSS_HEARTBEAT_MS;
  const staleRunningMs = deps.staleRunningMs ?? DISCUSS_STALE_RUNNING_MS;
  const defaultUser = deps.defaultUser ?? getBotDefaultUser;
  let gh: GhCheckDeps | undefined;
  // Read-only roots never get here (the egress prologue refuses them), so a miss may start the refresh.
  const defaultMentions = (input: MentionsInput) => buildMentions(input, { git, gh: (gh ??= realGhCheckDeps()), now: Date.now });
  let inflight = 0;
  /** The model a turn is asked to run on (`discussPlannedModel`). */
  const plannedModel = (p: Prepared): string | null => discussPlannedModel(p.bot, config);

  async function resolveUser(botName: string, posted: string | undefined): Promise<{ userId: string; username: string | null; users: { id: string; name: string }[] } | DiscussRefusal> {
    const users = deps.chatUsers ? await deps.chatUsers(botName) : [];
    if (posted !== undefined) {
      const hit = users.find((u) => u.id === posted);
      if (!hit) return refuse(422, { error: `the user "${posted}" is not one of ${botName}'s chat users`, reason: "unknown-user", users: users.map((u) => ({ id: u.id, name: u.name })) });
      return { userId: hit.id, username: hit.name, users: users.map((u) => ({ id: u.id, name: u.name })) };
    }
    const def = await defaultUser(botName);
    if (!def) return refuse(422, { error: `pick the user this discussion belongs to: ${botName} has no default chat user`, reason: "no-user", bot: botName, users: users.map((u) => ({ id: u.id, name: u.name })) });
    return { userId: def, username: users.find((u) => u.id === def)?.name ?? null, users: users.map((u) => ({ id: u.id, name: u.name })) };
  }

  async function prepare(req: DiscussRequest): Promise<Prepared | DiscussRefusal> {
    const body = req.body;
    if ((req.role || "admin") !== "admin") return refuse(403, { error: "Discuss's wiki agent is for admins" });
    // A trace spawns git grep, git log and a background gh refresh, which the
    // mentions route it mirrors never does on an authenticating instance.
    if (body.traceKey !== undefined && (deps.authMode ?? authMode)() !== "off") return refuse(404, TRACE_AUTH_REFUSAL);
    const { entry, unknownWiki, wiki } = resolveWikiRequest(getWikiRegistry(), body.wiki, undefined, process.env.WIKI_DIR);
    if (unknownWiki) return refuse(404, { error: `no wiki configured for "${wiki || "(none)"}"` });
    // The egress prologue, right after the wiki resolves: before the rules,
    // the index, the bot and the DB. Keyed on the root the request would be
    // served from, the env override's too (`readonlyCandidateRoot`'s rule).
    const servedRoot = entry ? entry.root : resolveWikiRoot(undefined);
    if (isReadonlyWikiRoot(servedRoot)) {
      log.info("Read-only wiki {wiki} refused Discuss (no model calls)", { wiki: entry?.name ?? "(default root)" });
      return refuse(403, { error: wikiNoEgressReason(entry?.name ?? ""), readonly: true });
    }
    const wikiRoot = path.resolve(resolveWikiRoot(entry?.root));

    const rules = await readWikiAgentRules(wikiRoot);
    if (rules.state === "absent") {
      return refuse(404, { error: "this wiki has no wiki agent (no .wiki-agent.md at its root); Discuss keeps its chat thread here", reason: "no-agent" });
    }
    if (rules.state !== "ok") {
      const refused = wikiAgentRulesRefusal(rules)!;
      return refuse(refused.status, refused.body);
    }

    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return refuse(503, { error: "wiki directory not found" });
    // A trace turn (PR 6) has no page: no page ladder, no snapshot check of one.
    const traceKey = body.traceKey ?? null;
    let page: { meta: NonNullable<ReturnType<WikiIndex["resolveRelPath"]>>; raw: string } | null = null;
    if (traceKey === null) {
      const meta = index.resolveRelPath(body.relPath);
      if (!meta) return refuse(404, { error: `no wiki page for relPath "${body.relPath}"` });
      const raw = await readWikiPage(index, meta);
      if (raw === null) return refuse(503, { error: "page file unreadable" });
      page = { meta, raw };
    }

    const { bot, origin } = resolveWikiSynthesisBot(entry, (deps.bots ?? discoverAllBots)());
    // A pinned wiki runs on its pinned bot or not at all: the resolver's
    // fallback would move a wiki pinned to Copilot (melosys-kode-wiki, D2/D6)
    // onto a Claude connector on a machine without that bot.
    if (entry?.synthesisBot && origin !== "pinned") {
      return refuse(503, { error: `this wiki is pinned to the bot "${entry.synthesisBot}", which is not configured here`, reason: "no-bot", bot: entry.synthesisBot });
    }
    if (!bot) return refuse(503, { error: "no bot is configured to answer on this wiki", reason: "no-bot" });
    const connector = bot.connector ?? "claude-cli";
    const kind = discussSurfaceKind(connector);
    if (!kind) {
      return refuse(422, { error: `the wiki agent does not run on the ${connector} connector (${bot.name}); it covers claude-cli, claude-sdk and copilot-sdk`, reason: "connector" });
    }
    // The pre-flight's surface: the real tool list, or a snapshot dir that
    // does not exist yet, so nothing is built before the run could start.
    const copilot =
      kind === "mcpTools"
        ? copilotDiscussReach({
            mcpServers: Object.keys((deps.mcpServers ?? parseMcpConfig)(bot.dir)),
            botWikis: botWikis(getWikiRegistry(), bot.name, isReadonlyWikiRoot),
            pageWiki: entry?.name ?? "",
            authOff: authMode() === "off",
            researchServes: researchWikiTools(bot.name),
            excludedTools: bot.excludedTools,
          })
        : null;
    const probe: ToolSurface = copilot ? { mcpTools: copilot.tools } : { readSearch: [path.join(snapshotRootDir(), "preflight")] };
    const refused = await blocker(connector, probe);
    if (refused) return refuse(503, { error: `the wiki agent cannot run on ${bot.name}: ${refused}`, reason: "surface" });
    if (!page) {
      // The key's mentions are read with git, on every connector: refused here,
      // before a thread or a turn exists, rather than failing inside the turn.
      const state = await mentionsGitState(wikiRoot, git);
      if (state === "not-a-work-tree") {
        return refuse(503, { error: "a trace reads the wiki's files and history with git, and this wiki is not a git work tree", reason: "no-snapshot" });
      }
      if (state === "no-commit") {
        return refuse(503, { error: "a trace reads the wiki's history with git, and this wiki has no commit yet", reason: "no-snapshot" });
      }
    } else if (kind === "readSearch") {
      // The agent reads the page from the wiki's snapshot: refuse a page the
      // snapshot would not hold before a turn is stored for it.
      const holds = await wikiSnapshotHolds(wikiRoot, page.meta.relPath, git);
      if (!holds.ok && holds.reason === "not-a-work-tree") {
        return refuse(503, { error: "the wiki agent reads a snapshot of the wiki, and this wiki is not a git work tree", reason: "no-snapshot" });
      }
      if (!holds.ok) {
        const why = holds.reason === "not-listed" ? "git ignores it" : "it is reached through a symlink or is not a regular file";
        return refuse(422, { error: `the wiki agent cannot read this page: its snapshot of the wiki leaves it out (${why})`, reason: "page-not-in-snapshot" });
      }
    }

    // The thread's user: the /chat entry's thread owner, else the body's
    // (one /chat lists for the bot), else the bot's default chat user.
    let userId: string;
    let username: string | null = null;
    let userPostable: boolean;
    if (req.threadUser) {
      userId = req.threadUser;
      userPostable = discussUserPostable(deps.chatUsers ? await deps.chatUsers(bot.name) : [], userId);
    } else {
      const who = await resolveUser(bot.name, body.userId);
      if ("refused" in who) return who;
      userId = who.userId;
      username = who.username;
      userPostable = discussUserPostable(who.users, userId);
    }

    const wikiName = entry?.name ?? "";
    let thread: Thread | null;
    if (body.discussionId) {
      // Checked against its `threads` row, never its first ledger row: an old
      // one-shot discussion (no thread) stays read-only.
      thread = await threads.get(body.discussionId);
      if (!thread || thread.kind !== "wiki") {
        return refuse(404, { error: "no live wiki discussion with that id (an old discussion stays read-only; ask without it to start the page's thread)", reason: "unknown-discussion" });
      }
      if (thread.wiki !== wikiName || (page ? thread.relPath !== page.meta.relPath : thread.traceKey !== traceKey)) {
        return refuse(409, { error: page ? "that discussion is about another page" : "that discussion is about another key", reason: "other-page" });
      }
      if (thread.closedAt !== undefined) {
        // Answered first for everyone, as before; marked as the requester's own only when it is.
        const own = thread.userId === userId && thread.botName === bot.name;
        return refuse(409, { error: "that discussion was closed (Start over); ask without it to start a new one", reason: "closed" }, own ? thread.id : undefined);
      }
      if (thread.userId !== userId) return refuse(409, { error: "that discussion belongs to another user", reason: "other-user" });
      if (thread.botName !== bot.name) {
        return refuse(409, { error: `that discussion ran on ${thread.botName}, and the wiki now answers on ${bot.name}; start over`, reason: "other-bot" });
      }
    } else if (page) {
      thread = await threads.live(userId, bot.name, wikiName, page.meta.relPath);
    } else {
      thread = await (threads.liveTrace ?? getLiveWikiTraceThread)(userId, bot.name, wikiName, traceKey!);
    }
    const earlier = thread ? await store.list(thread.id) : [];
    if (body.originTurnId) {
      // D9: a card's first turn of this very thread (no thread yet: none is).
      const origin = earlier.find((t) => t.id === body.originTurnId);
      if (!origin || origin.originTurnId !== null) {
        return refuse(409, { error: "that card's first turn is not a first turn of this page's discussion; select the passage again to ask", reason: "origin" });
      }
    }
    const last = earlier[earlier.length - 1];
    if (last && last.endState === "running" && Date.now() - last.heartbeatAt < staleRunningMs) {
      // `thread` is the requester's: checked above, or found by their user, bot and page.
      return refuse(409, { error: "the discussion's last turn is still running", reason: "busy" }, thread?.id);
    }

    const raw = page?.raw ?? "";
    const pageHash = page ? sha256(raw) : "";
    const fm = page ? parseFrontmatter(raw) : {};
    const location = page && body.selection
      ? (() => {
          const pack = buildContextPack({ wiki: wikiName, relPath: page.meta.relPath, title: page.meta.title, absPath: "", raw, ...packSelection(body) });
          const loc = pack.location;
          return loc ? { found: loc.found, reason: loc.reason, tier: loc.tier, fromLine: loc.fromLine, toLine: loc.toLine, ambiguous: loc.ambiguous } : null;
        })()
      : null;
    return {
      thread,
      earlier,
      wiki: wikiName,
      wikiRoot,
      traceKey,
      index,
      relPath: page?.meta.relPath ?? "",
      title: page?.meta.title ?? traceKey ?? "",
      raw,
      pageHash,
      fm,
      project: page?.meta.project,
      allow: index.readerConfig?.discuss?.repos ?? null,
      rules: rules.text,
      mode: body.mode ?? "explore",
      bot,
      connector,
      kind,
      copilot,
      body,
      location,
      userId,
      username,
      userPostable,
    };
  }

  function packSelection(body: DiscussBody) {
    return {
      selection: body.selection,
      before: body.before,
      after: body.after,
      atStart: body.atStart,
      atEnd: body.atEnd,
      edge: body.edge,
      heading: body.heading,
    };
  }

  async function start(req: DiscussRequest): Promise<DiscussRefusal | StartedDiscussTurn> {
    let prepared: Prepared | DiscussRefusal;
    try {
      prepared = await prepare(req);
    } catch (err) {
      log.error("discuss preflight failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return refuse(500, { error: "could not start the turn" });
    }
    if ("refused" in prepared) return prepared;
    const p = prepared;

    // Check and reserve with no await between, so requests that arrive
    // together cannot all pass; every path below releases exactly once.
    if (inflight >= DISCUSS_MAX_INFLIGHT) {
      return refuse(429, { error: `${DISCUSS_MAX_INFLIGHT} discuss turns are already running; try again when one has finished`, reason: "busy" });
    }
    inflight++;
    let reserved = true;
    const release = () => {
      if (reserved) {
        reserved = false;
        inflight--;
      }
    };

    let threadId: string;
    let turn: { id: string; seq: number; userMessageId: string | null };
    const question = p.body.question.trim();
    const userText = threadUserMessage(question, p.body.selection);
    try {
      // Created only now, after every refusal: a refused request leaves no empty thread.
      const thread =
        p.thread ??
        (p.traceKey !== null
          ? await (threads.getOrCreateTrace ?? getOrCreateWikiTraceThread)(p.userId, p.bot.name, p.wiki, p.traceKey, (suffix) => traceThreadName(p.traceKey!, suffix))
          : await threads.getOrCreate(p.userId, p.bot.name, p.wiki, p.relPath, (suffix) => wikiThreadName(p.title, suffix)));
      threadId = thread.id;
      turn = await store.start(
        {
          discussionId: threadId,
          threadId,
          wiki: p.wiki,
          relPath: p.traceKey !== null ? null : p.relPath,
          pageHash: p.traceKey !== null ? null : p.pageHash,
          traceKey: p.traceKey,
          selection: p.body.selection?.trim() || null,
          question,
          location: p.location,
          botName: p.bot.name,
          connector: p.connector,
          model: plannedModel(p),
          surface: { kind: p.kind, mode: p.mode },
          originTurnId: p.body.originTurnId ?? null,
          passage: p.traceKey !== null ? null : storedPassageFor(p.body),
          sentFrom: req.sentFrom ?? null,
          userMessage: { userId: p.userId, botName: p.bot.name, username: p.username, content: userText },
        },
        { staleRunningMs },
      );
    } catch (err) {
      release();
      if (err instanceof DiscussTurnConflict) return refuse(409, { error: err.message, reason: "busy" }, p.thread?.id);
      log.error("discuss turn insert failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return refuse(500, { error: "could not store the turn" });
    }

    let mirror: DiscussMirror | null = null;
    if (req.mirror) {
      try {
        mirror = await req.mirror({ userId: p.userId, botName: p.bot.name, threadId });
      } catch (err) {
        log.warn("discuss chat mirror failed: {error}", { error: String(err) });
      }
    }
    const mirrored = (f: (m: DiscussMirror) => void) => {
      if (!mirror) return;
      try {
        f(mirror);
      } catch (err) {
        log.warn("discuss chat mirror failed: {error}", { error: String(err) });
      }
    };
    if (turn.userMessageId) {
      const id = turn.userMessageId;
      mirrored((m) => m.userMessage({ id, text: userText, createdAt: Date.now() }));
    }

    let ran = false;
    let leftMarked = false;
    return {
      refused: false,
      turnId: turn.id,
      seq: turn.seq,
      discussionId: threadId,
      userId: p.userId,
      botName: p.bot.name,
      location: p.location,
      release,
      readerLeft: () => {
        if (leftMarked) return;
        leftMarked = true;
        store.readerLeft(turn.id).catch((err) => log.warn("discuss reader-left mark failed: {error}", { error: String(err) }));
      },
      run: async (emit) => {
        if (ran) throw new Error("a discuss turn runs once");
        ran = true;
        // The row's heartbeat, from here to the end of the turn: what keeps a
        // live turn from being read as abandoned.
        const beat = setInterval(() => {
          store.heartbeat(turn.id).catch((err) => log.warn("discuss turn heartbeat failed: {error}", { error: String(err) }));
        }, heartbeatMs);
        beat.unref?.();
        try {
          // The planned model rides the `turn` event: the first frame, before
          // the snapshot and card phases, so the reader sees it from the start.
          emit("turn", { turnId: turn.id, discussionId: threadId, threadId, userId: p.userId, userName: p.username, userPostable: p.userPostable, seq: turn.seq, location: p.location, mode: p.mode, model: plannedModel(p), connector: p.connector, originTurnId: p.body.originTurnId ?? null, sentFrom: req.sentFrom ?? null });
          await runTurn(p, threadId, turn, emit, mirrored);
        } finally {
          clearInterval(beat);
          release();
        }
      },
    };
  }

  /** The card for this page and discussion: reused from an earlier turn on the
   *  same page hash, else built once by plan-card (a plan page in a plan-card
   *  root, with `PLAN_CARD_BIN` set). */
  async function cardFor(p: Prepared, earlier: DiscussTurn[], turnId: string): Promise<{ card: string | null; note: string | null; built: boolean }> {
    const reuse = [...earlier].reverse().find((t) => t.pageHash === p.pageHash && t.card);
    if (reuse?.card) return { card: reuse.card, note: null, built: false };
    if (p.fm.plan_status === undefined) return { card: null, note: null, built: false };
    const profile = config.profile ?? resolveServingProfile();
    const cfg = deps.planCardConfig ? deps.planCardConfig() : planCardConfigFromEnv(process.env, profile);
    const root = planCardRootFor(p.wikiRoot, cfg.roots);
    if (!cfg.bin || !root) return { card: null, note: null, built: false };
    const outcome = await (deps.planCard ?? runPlanCard)({ bin: cfg.bin, abs: path.join(root, p.relPath), port: config.dashboardPort });
    const card = planCardFromOutcome(outcome);
    if (!card.ok) return { card: null, note: `The card could not be built (${card.error}); read the page instead.`, built: false };
    await store.setCard(turnId, card.text).catch((err) => log.warn("discuss card store failed: {error}", { error: String(err) }));
    return { card: card.text, note: null, built: true };
  }

  async function runTurn(
    p: Prepared,
    threadId: string,
    turn: { id: string; seq: number },
    emit: (event: string, data: unknown) => void,
    mirrored: (f: (m: DiscussMirror) => void) => void,
  ): Promise<void> {
    const t0 = performance.now();
    const releases: (() => void)[] = [];
    let card: string | null = null;
    // What the reader was shown, kept for a turn that fails before `res`.
    let streamed = "";
    const streamedTools: DiscussToolCall[] = [];
    let pastDeadline = false;
    // Text since the last tool call: after the last tool, while none has
    // come, the status says the answer is being written.
    let textSinceTool = true;
    const storeAnswer = async (content: string, endState: string, meta: { model?: string | null; costUsd?: number | null; durationMs?: number | null }) => {
      let id: string | null = null;
      try {
        id = await storeAssistant(turn.id, content, meta);
      } catch (err) {
        log.error("discuss answer message failed: {error}", { error: err instanceof Error ? err.message : String(err), turnId: turn.id });
      }
      mirrored((m) => m.answer({ id, text: content, model: meta.model ?? null, endState }));
      return id;
    };
    try {
      // The discussion as the insert left it: a turn it closed as abandoned
      // reads so in the prompt, not as running.
      const earlier = (await store.list(threadId).catch(() => p.earlier)).filter((t) => t.id !== turn.id);
      let reach: AgentReach;
      let pagePath: string;
      if (p.traceKey !== null) {
        // A trace turn (PR 6): the wiki's snapshot or the Copilot tools, no page
        // and no repo (a key belongs to no page's `repos:`), and the pack below.
        if (p.kind === "readSearch") {
          emit("status", { phase: "snapshots" });
          const wiki = await (deps.wikiSnapshot ?? wikiSnapshot)(p.wikiRoot);
          releases.push(leaseSnapshot(wiki));
          reach = { kind: "readSearch", wikiSnapshot: wiki.dir, repos: [], missed: [], own: [] };
        } else {
          const copilot = p.copilot ?? { tools: COPILOT_DISCUSS_TOOLS };
          reach = { kind: "mcpTools", tools: copilot.tools, ...(copilot.wikiToolsWiki ? { wikiToolsWiki: copilot.wikiToolsWiki } : {}) };
        }
        pagePath = "";
      } else if (p.kind === "readSearch") {
        emit("status", { phase: "snapshots" });
        const wiki = await (deps.wikiSnapshot ?? wikiSnapshot)(p.wikiRoot);
        releases.push(leaseSnapshot(wiki));
        const asked = pageReposAsked(p.fm, p.project);
        const roots = (deps.repoRoots ?? (() => config.decisionTriageRepoRoots ?? null))();
        const r = await reposInReach({ asked, allow: p.allow, roots: roots ? parseRepoRoots(roots) : null, wikiRoot: p.wikiRoot, git });
        const repos: PackRepo[] = [];
        const missed = [...r.missed];
        for (const repo of r.inReach) {
          try {
            const snap = await (deps.codeSnapshot ?? codeSnapshot)(repo.dir);
            releases.push(leaseSnapshot(snap));
            repos.push({ name: repo.name, dir: snap.dir, ref: `origin/${snap.branch ?? "?"} at ${(snap.commit ?? "").slice(0, 10)}` });
          } catch (err) {
            missed.push({ name: repo.name, why: `not in reach on this wiki (its snapshot failed: ${abbreviate(err instanceof Error ? err.message : String(err), 160)})` });
          }
        }
        reach = { kind: "readSearch", wikiSnapshot: wiki.dir, repos, missed, own: r.own };
        pagePath = path.join(wiki.dir, p.relPath);
        // One page text per turn: the copy the agent will Read is the text the
        // row's hash, location and the pack describe (a snapshot is never
        // rewritten). The Copilot path has no snapshot; its hash is the live read's.
        // Read as `readWikiPage` reads (a leading BOM dropped), so both hashes are of one decoding.
        const copy = await readWikiText(pagePath).catch((err: NodeJS.ErrnoException) => {
          if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
          throw err;
        });
        const mismatch = snapshotPageError(copy, p.pageHash);
        if (mismatch) throw new Error(mismatch);
      } else {
        const copilot = p.copilot ?? { tools: COPILOT_DISCUSS_TOOLS };
        reach = { kind: "mcpTools", tools: copilot.tools, ...(copilot.wikiToolsWiki ? { wikiToolsWiki: copilot.wikiToolsWiki } : {}) };
        pagePath = p.relPath;
      }

      const history = earlier.map((t) => ({ question: t.question, selection: t.selection, answer: t.answer, endState: t.endState }));
      let prompt: string;
      if (p.traceKey !== null) {
        // Rebuilt every turn, as a page turn's pack is: a follow-up sees the files and PR states as they are now.
        emit("status", { phase: "mentions" });
        const m = await (deps.mentions ?? defaultMentions)({ wiki: p.wiki, root: p.wikiRoot, key: p.traceKey, index: p.index });
        if (!m.ok) throw new Error(`the key's mentions could not be read (${m.error})`);
        prompt = renderTraceTurnPrompt({ wiki: p.wiki, mentions: m.body, reach, earlier: history, question: p.body.question });
      } else {
        emit("status", { phase: "card" });
        const c = await cardFor(p, earlier, turn.id);
        card = c.card;
        const cardText = card && reach.kind === "readSearch" ? cardForSnapshot(card, p.wikiRoot, reach.wikiSnapshot) : card;
        const pack = buildContextPack({ wiki: p.wiki, relPath: p.relPath, title: p.title, absPath: pagePath, raw: p.raw, ...packSelection(p.body) });
        // A question (or its selection) that names a key gets that key's
        // mentions up front, as a trace turn does: no grep, so the answer can stream.
        // Not on an instance that authenticates: there the mentions route 404s,
        // a trace is refused (`TRACE_AUTH_REFUSAL`) and the Copilot wiki tools are
        // left out (`authOff`), since mentions spawn git and a background gh refresh.
        let keyMentions: { key: string; lines: string[]; complete: boolean } | null = null;
        const key = (deps.authMode ?? authMode)() === "off" ? discussTurnKey({ question: p.body.question, selection: p.body.selection }, p.index.readerConfig) : null;
        if (key) {
          emit("status", { phase: "mentions" });
          const m = await (deps.mentions ?? defaultMentions)({ wiki: p.wiki, root: p.wikiRoot, key, index: p.index });
          if (m.ok && m.body.totalLines > 0) keyMentions = { key, ...keyMentionsSection(p.wiki, m.body) };
          else if (!m.ok) log.warn("discuss turn on {wiki}: the mentions of {key} could not be read ({error}); the turn runs without them", { wiki: p.wiki, key, error: m.error });
        }
        prompt = renderAgentTurnPrompt({ pack, reach, card: cardText, cardNote: c.note, earlier: history, question: p.body.question, keyMentions });
      }
      const surface: ToolSurface = reach.kind === "readSearch" ? { readSearch: [reach.wikiSnapshot, ...reach.repos.map((r) => r.dir)] } : { mcpTools: reach.tools };
      emit("status", { phase: "model", read: reach.kind === "readSearch" ? { wiki: true, repos: reach.repos.map((r) => r.name), missed: reach.missed.map((m) => m.name) } : { tools: reach.tools } });

      // The engine owns the deadline: its timer alone makes a `timeout`. The
      // connector's own timeout lands later, to stop the run it leaves behind.
      // Past the deadline the connector's events reach no one: not the stream
      // (finish and the closing writes are still to come) and not the row.
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => {
          pastDeadline = true;
          reject(new DiscussTurnTimeout(timeoutMs));
        }, timeoutMs);
      });
      const call = oneShot(prompt, config, p.bot, {
        toolSurface: surface,
        systemPrompt: renderAgentSystemPrompt(p.wiki, rulesForMode(p.rules, p.mode, (msg) => log.warn(msg, { wiki: p.wiki })), p.traceKey ?? undefined),
        timeoutMs: timeoutMs + DISCUSS_CONNECTOR_GRACE_MS,
        onProgress: (ev) => {
          if (pastDeadline) return;
          if (ev.type === "text_delta") {
            streamed += ev.text;
            textSinceTool = true;
            emit("delta", { text: ev.text });
            mirrored((m) => m.delta(ev.text));
          } else if (ev.type === "tool_start") {
            textSinceTool = false;
            streamedTools.push(toolCall(ev.name, ev.input));
            const live = toolCall(ev.name, ev.input, 200);
            emit("tool", live);
            mirrored((m) => m.tool({ ...live, displayName: ev.displayName }));
          } else if (ev.type === "tool_end") {
            if (!textSinceTool) emit("status", { phase: "writing", text: DISCUSS_WRITING_STATUS });
          }
        },
      });
      call.catch(() => {}); // after the deadline nobody awaits it
      let res: Awaited<typeof call>;
      try {
        res = await Promise.race([call, deadline]);
      } finally {
        clearTimeout(deadlineTimer);
      }
      const answer = res.result ?? "";
      const toolCalls: DiscussToolCall[] = (res.toolCalls ?? []).map((tc) => toolCall(tc.name, tc.input));
      // A trace has no page to edit and Apply refuses its turns: an edit block
      // there is left in the answer as the model wrote it, and is no proposed edit.
      const proposedEdit = p.traceKey !== null ? null : extractProposedEdit(answer);
      const durationMs = Math.round(performance.now() - t0);
      await store.finish(turn.id, { endState: "done", answer, card, toolCalls, proposedEdit, costUsd: res.costUsd ?? null, durationMs });
      const assistantMessageId = await storeAnswer(p.traceKey !== null ? answer : stripProposedEdit(answer), "done", { model: res.model ?? plannedModel(p), costUsd: res.costUsd ?? null, durationMs });
      log.info("discuss turn on {wiki} {relPath}: done", { wiki: p.wiki, relPath: p.traceKey ?? p.relPath, traceKey: p.traceKey, turnId: turn.id, seq: turn.seq, threadId, mode: p.mode, bot: p.bot.name, connector: p.connector, tools: toolCalls.length, edit: proposedEdit !== null, ms: durationMs });
      emit("done", { turnId: turn.id, discussionId: threadId, threadId, assistantMessageId, endState: "done", answer, proposedEdit, toolCalls, costUsd: res.costUsd ?? null, durationMs, model: res.model ?? plannedModel(p) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const endState = err instanceof DiscussTurnTimeout ? "timeout" : "error";
      const durationMs = Math.round(performance.now() - t0);
      await store
        .finish(turn.id, { endState, answer: streamed, error: message, card, toolCalls: streamedTools.slice(), durationMs })
        .catch((e) => log.error("discuss turn finish failed: {error}", { error: String(e) }));
      await storeAnswer(unfinishedMessage(p.traceKey !== null ? streamed : stripProposedEdit(streamed)), endState, { model: plannedModel(p), durationMs });
      log.warn("discuss turn on {wiki} {relPath}: {endState}", { wiki: p.wiki, relPath: p.traceKey ?? p.relPath, traceKey: p.traceKey, turnId: turn.id, threadId, endState, error: message, ms: durationMs });
      emit("app_error", { type: "error", turnId: turn.id, endState, message: endState === "timeout" ? `The turn ran past ${Math.round(timeoutMs / 60000)} minutes and was stopped.` : `The turn failed: ${message}` });
    } finally {
      for (const release of releases) release();
    }
  }

  return { start, resolveUser };
}

let shared: DiscussEngine | null = null;

/** The process's engine, shared by the pane route and /chat's send route so
 *  the in-flight cap covers both. `chatUsers` is passed by the first caller
 *  that has it (the routes layer). */
export function sharedDiscussEngine(config: Config, deps: Pick<DiscussEngineDeps, "chatUsers"> = {}): DiscussEngine {
  if (!shared) shared = createDiscussEngine(config, deps);
  return shared;
}
