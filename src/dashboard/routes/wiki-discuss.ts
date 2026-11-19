/**
 * `POST /api/wiki/discuss` — Discuss's wiki agent (mimir plan
 * muninn-wiki-discuss, P2b). Body: the handoff's (`{wiki, relPath, question,
 * selection?, before?, after?, atStart?, atEnd?, edge?, heading?}`, read by
 * `parseHandoffBody`) plus `discussionId?` to continue a discussion. Answers an
 * SSE stream: `turn`, `status`, `delta`, `tool`, then `done` or `app_error`,
 * then `end`.
 *
 * One turn is ONE fenced one-shot: the wiki's `.wiki-agent.md` as the system
 * prompt's rules, the context pack and the discussion so far in the prompt,
 * under {@link DISCUSS_TURN_TIMEOUT_MS}. Not the chat pipeline: no persona, no
 * memory or goal block, no extractor. The surface is declared HERE by the
 * owning bot's connector type, never by the rules file:
 *
 *  - claude-cli / claude-sdk: `{ readSearch }` over the wiki's snapshot and a
 *    snapshot of each repo in reach (`reposInReach`).
 *  - copilot-sdk: `{ mcpTools }` — the knowledge server's search and
 *    yggdrasil's listed tools ({@link COPILOT_DISCUSS_TOOLS}).
 *  - any other connector is refused in the preflight.
 *
 * Preflight, every refusal JSON before the stream, in order: 403 role not
 * admin · 415 not JSON · 413 body too large · 400 a malformed body · 404 an
 * unknown wiki · 403 `readonly` a read-only wiki (the egress prologue, right
 * after the wiki resolves) · 404 `no-agent` no `.wiki-agent.md` (the wiki
 * keeps today's Discuss) · 422 `rules-too-large` / 503 `rules-unreadable` ·
 * the page ladder (404/503) · 503 `no-bot` (no bot, or the wiki's pinned bot
 * is not configured here) · 422 `connector` an uncovered
 * connector · 503 `surface` `toolSurfaceBlocker` refused the surface · 400/404/409
 * the discussion · 429 `busy` · then the turn row is inserted (409 `busy` when
 * the database holds another live turn of the discussion).
 *
 * A live turn is one whose process still beats: the route touches the row's
 * `heartbeat_at` every {@link DISCUSS_HEARTBEAT_MS} from the insert to the
 * end, however long the snapshots, the card or the model take. A `running`
 * row whose heartbeat is older than {@link DISCUSS_STALE_RUNNING_MS} is a
 * process that died: the next start on its discussion closes it as
 * `abandoned` in the insert's transaction, and {@link startDiscussTurnSweep}
 * closes the rest.
 *
 * The turn runs to its end and is stored whether or not its reader is still
 * there: nothing in it reads the request's abort signal, and the stream's
 * writes are guarded. In the `wiki` route group, which `MUNINN_PROFILE=nais`
 * drops; admin-only by the zone model's default-deny too.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Context, Hono, Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import { resolveServingProfile } from "../../config.ts";
import { getLog } from "../../logging.ts";
import { discoverAllBots, resolveWikiSynthesisBot, type BotConfig, type ConnectorType } from "../../bots/config.ts";
import { executeOneShot } from "../../ai/one-shot.ts";
import { toolSurfaceBlocker, type ToolSurface } from "../../ai/tool-surface.ts";
import { snapshotRootDir } from "../../ai/agent-cwd.ts";
import { codeSnapshot, leaseSnapshot, wikiSnapshot, type Snapshot } from "../../ai/snapshots.ts";
import {
  closeAbandonedDiscussTurns,
  finishDiscussTurn,
  listDiscussTurns,
  markDiscussReaderLeft,
  setDiscussTurnCard,
  startDiscussTurn,
  touchDiscussTurn,
  DiscussTurnConflict,
  type DiscussToolCall,
  type DiscussTurn,
} from "../../db/wiki-discuss-turns.ts";
import { sha256 } from "../../gardener/util.ts";
import { HANDOFF_BODY_MAX } from "../../wiki/discuss-bounds.ts";
import { buildContextPack } from "../../wiki/discuss-pack.ts";
import {
  DISCUSS_TURN_TIMEOUT_MS,
  WIKI_AGENT_RULES_MAX_BYTES,
  cardForSnapshot,
  extractProposedEdit,
  pageReposAsked,
  readWikiAgentRules,
  renderAgentSystemPrompt,
  renderAgentTurnPrompt,
  reposInReach,
  type AgentReach,
  type PackRepo,
} from "../../wiki/discuss-agent.ts";
import { parseRepoRoots, realGit, type GitRun } from "../../wiki/decision-triage/git.ts";
import { planCardConfigFromEnv, planCardRootFor, type PlanCardConfig } from "../../wiki/plan-card.ts";
import { planCardFromOutcome, runPlanCard } from "../../wiki/plan-card-run.ts";
import { getWikiRegistry } from "../../wiki/registry-memo.ts";
import { resolveWikiRequest } from "../../wiki/registry.ts";
import { getWikiIndex, parseFrontmatter, readWikiPage, resolveWikiRoot } from "../../wiki/store.ts";
import { requireJsonRequest } from "./json-request.ts";
import { isValidUuid } from "./route-utils.ts";
import { parseHandoffBody, type HandoffBody } from "./wiki-discuss-handoff.ts";
import { egressRefusal } from "./wiki-egress.ts";

export const WIKI_DISCUSS_PATH = "/api/wiki/discuss";

/** The Copilot surface (D2): the knowledge server's search for other pages,
 *  and yggdrasil's listing and graph tools. Never `read_source`,
 *  `detect_changes` or `search_pattern` (the never-list refuses them anyway);
 *  the knowledge server's `get_document` is left out (P2a's check of it
 *  against an ignored file was inconclusive). */
export const COPILOT_DISCUSS_TOOLS: Record<string, string[]> = {
  knowledge: ["search_knowledge"],
  yggdrasil: ["search", "file_outline", "symbol_context", "impact", "list_repos", "list_files"],
};

/** Turns this process runs at once, across every discussion. */
export const DISCUSS_MAX_INFLIGHT = 4;
/** How often a running turn touches its row's `heartbeat_at`. */
export const DISCUSS_HEARTBEAT_MS = 15_000;
/** A `running` turn whose heartbeat is older than this belongs to a process
 *  that died: 12 missed beats, so a beat delayed by the wiki snapshot's
 *  synchronous copy (it blocks the event loop) is not read as a death. */
export const DISCUSS_STALE_RUNNING_MS = 3 * 60 * 1000;
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
}

const dbStore: DiscussStore = {
  start: startDiscussTurn,
  finish: finishDiscussTurn,
  readerLeft: markDiscussReaderLeft,
  setCard: setDiscussTurnCard,
  list: listDiscussTurns,
  heartbeat: touchDiscussTurn,
};

export interface DiscussRouteDeps {
  store?: DiscussStore;
  bots?: () => BotConfig[];
  oneShot?: typeof executeOneShot;
  surfaceBlocker?: typeof toolSurfaceBlocker;
  wikiSnapshot?: (dir: string) => Promise<Snapshot>;
  codeSnapshot?: (dir: string) => Promise<Snapshot>;
  git?: GitRun;
  planCard?: typeof runPlanCard;
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
  discussionId?: string;
}

/** The handoff body plus `discussionId`; a string is the 400 message. */
export function parseDiscussBody(raw: unknown): DiscussBody | string {
  const body = parseHandoffBody(raw);
  if (typeof body === "string") return body;
  const id = (raw as Record<string, unknown>).discussionId;
  if (id === undefined || id === null) return body;
  if (typeof id !== "string" || !isValidUuid(id)) return "discussionId must be a uuid";
  return { ...body, discussionId: id.toLowerCase() };
}

function abbreviate(s: string | undefined, max = 300): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

export function registerWikiDiscussRoute(app: Hono, config: Config, deps: DiscussRouteDeps = {}): void {
  const log = deps.log ?? getLog("wiki", "discuss");
  const store = deps.store ?? dbStore;
  const oneShot = deps.oneShot ?? executeOneShot;
  const blocker = deps.surfaceBlocker ?? toolSurfaceBlocker;
  const git = deps.git ?? realGit;
  const timeoutMs = deps.timeoutMs ?? DISCUSS_TURN_TIMEOUT_MS;
  const heartbeatMs = deps.heartbeatMs ?? DISCUSS_HEARTBEAT_MS;
  const staleRunningMs = deps.staleRunningMs ?? DISCUSS_STALE_RUNNING_MS;
  let inflight = 0;

  const gate = async (c: Context, next: Next) => {
    if ((c.get("role") ?? "admin") !== "admin") return c.json({ error: "Discuss's wiki agent is for admins" }, 403);
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    await next();
  };
  const limit = bodyLimit({
    maxSize: HANDOFF_BODY_MAX,
    onError: (c) => c.json({ error: `request body is larger than ${HANDOFF_BODY_MAX} bytes`, code: "too_large" }, 413),
  });

  app.post(WIKI_DISCUSS_PATH, gate, limit, async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body is not valid JSON" }, 400);
    }
    const body = parseDiscussBody(raw);
    if (typeof body === "string") return c.json({ error: body }, 400);

    let prepared: Prepared | Response;
    try {
      prepared = await prepare(c, body);
    } catch (err) {
      log.error("discuss preflight failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "could not start the turn" }, 500);
    }
    if (prepared instanceof Response) return prepared;
    const p = prepared;

    // Check and reserve with no await between, so requests that arrive
    // together cannot all pass; every path below releases exactly once.
    if (inflight >= DISCUSS_MAX_INFLIGHT) {
      return c.json({ error: `${DISCUSS_MAX_INFLIGHT} discuss turns are already running; try again when one has finished`, reason: "busy" }, 429);
    }
    inflight++;
    let reserved = true;
    const release = () => {
      if (reserved) {
        reserved = false;
        inflight--;
      }
    };
    let turn: { id: string; seq: number };
    try {
      turn = await store.start(
        {
          discussionId: p.discussionId,
          wiki: p.wiki,
          relPath: p.relPath,
          pageHash: p.pageHash,
          selection: body.selection?.trim() || null,
          question: body.question.trim(),
          location: p.location,
          botName: p.bot.name,
          connector: p.connector,
          model: p.bot.model ?? config.claudeModel ?? null,
          surface: { kind: p.kind },
        },
        { staleRunningMs },
      );
    } catch (err) {
      release();
      if (err instanceof DiscussTurnConflict) return c.json({ error: err.message, reason: "busy" }, 409);
      log.error("discuss turn insert failed: {error}", { error: err instanceof Error ? err.message : String(err) });
      return c.json({ error: "could not store the turn" }, 500);
    }

    try {
      return streamSSE(c, async (stream) => {
        let gone = false;
        let leftMarked = false;
        const emit = (event: string, data: unknown) => {
          if (gone) return;
          stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => {
            gone = true;
          });
        };
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        // The row's heartbeat, from here to the end of the turn: what keeps a
        // live turn from being read as abandoned.
        const beat = setInterval(() => {
          store.heartbeat(turn.id).catch((err) => log.warn("discuss turn heartbeat failed: {error}", { error: String(err) }));
        }, heartbeatMs);
        beat.unref?.();
        try {
          heartbeat = setInterval(() => emit("heartbeat", {}), 30_000);
          stream.onAbort(() => {
            gone = true;
            clearInterval(heartbeat);
            if (!leftMarked) {
              leftMarked = true;
              store.readerLeft(turn.id).catch((err) => log.warn("discuss reader-left mark failed: {error}", { error: String(err) }));
            }
          });
          emit("turn", { turnId: turn.id, discussionId: p.discussionId, seq: turn.seq, location: p.location });
          await runTurn(p, turn, emit);
          if (!gone) await stream.writeSSE({ event: "end", data: "{}" }).catch(() => {});
        } finally {
          release();
          clearInterval(heartbeat);
          clearInterval(beat);
        }
      });
    } catch (err) {
      release();
      throw err;
    }
  });

  interface Prepared {
    discussionId: string;
    earlier: DiscussTurn[];
    wiki: string;
    wikiRoot: string;
    relPath: string;
    title: string;
    raw: string;
    pageHash: string;
    fm: Record<string, string | string[]>;
    project: string | undefined;
    allow: string[] | null;
    rules: string;
    bot: BotConfig;
    connector: ConnectorType;
    kind: SurfaceKind;
    body: DiscussBody;
    location: unknown;
  }

  async function prepare(c: Context, body: DiscussBody): Promise<Prepared | Response> {
    const { entry, unknownWiki, wiki } = resolveWikiRequest(getWikiRegistry(), body.wiki, undefined, process.env.WIKI_DIR);
    if (unknownWiki) return c.json({ error: `no wiki configured for "${wiki || "(none)"}"` }, 404);
    // The egress prologue, right after the wiki resolves: before the rules,
    // the index, the bot and the DB.
    const egress = egressRefusal(c, entry, unknownWiki);
    if (egress) return egress;
    const wikiRoot = path.resolve(resolveWikiRoot(entry?.root));

    const rules = await readWikiAgentRules(wikiRoot);
    if (rules.state === "absent") {
      return c.json({ error: "this wiki has no wiki agent (no .wiki-agent.md at its root); Discuss keeps its chat thread here", reason: "no-agent" }, 404);
    }
    if (rules.state === "too-large") {
      return c.json({ error: `the wiki's .wiki-agent.md is ${rules.bytes} bytes, over the ${WIKI_AGENT_RULES_MAX_BYTES}-byte bound`, reason: "rules-too-large" }, 422);
    }
    if (rules.state !== "ok") return c.json({ error: "the wiki's .wiki-agent.md cannot be read", reason: "rules-unreadable" }, 503);

    const index = await getWikiIndex({ root: entry?.root });
    if (!index) return c.json({ error: "wiki directory not found" }, 503);
    const meta = index.resolveRelPath(body.relPath);
    if (!meta) return c.json({ error: `no wiki page for relPath "${body.relPath}"` }, 404);
    const raw = await readWikiPage(index, meta);
    if (raw === null) return c.json({ error: "page file unreadable" }, 503);

    const { bot, origin } = resolveWikiSynthesisBot(entry, (deps.bots ?? discoverAllBots)());
    // A pinned wiki runs on its pinned bot or not at all: the resolver's
    // fallback would move a wiki pinned to Copilot (melosys-kode-wiki, D2) onto
    // a Claude connector on a machine without that bot.
    if (entry?.synthesisBot && origin !== "pinned") {
      return c.json({ error: `this wiki is pinned to the bot "${entry.synthesisBot}", which is not configured here`, reason: "no-bot", bot: entry.synthesisBot }, 503);
    }
    if (!bot) return c.json({ error: "no bot is configured to answer on this wiki", reason: "no-bot" }, 503);
    const connector = bot.connector ?? "claude-cli";
    const kind = discussSurfaceKind(connector);
    if (!kind) {
      return c.json({ error: `the wiki agent does not run on the ${connector} connector (${bot.name}); it covers claude-cli, claude-sdk and copilot-sdk`, reason: "connector" }, 422);
    }
    // The pre-flight's surface: the real tool list, or a snapshot dir that
    // does not exist yet, so nothing is built before the run could start.
    const probe: ToolSurface = kind === "mcpTools" ? { mcpTools: COPILOT_DISCUSS_TOOLS } : { readSearch: [path.join(snapshotRootDir(), "preflight")] };
    const refused = await blocker(connector, probe);
    if (refused) return c.json({ error: `the wiki agent cannot run on ${bot.name}: ${refused}`, reason: "surface" }, 503);

    let discussionId = body.discussionId;
    let earlier: DiscussTurn[] = [];
    if (discussionId) {
      earlier = await store.list(discussionId);
      if (earlier.length === 0) return c.json({ error: "no discussion with that id", reason: "unknown-discussion" }, 404);
      const first = earlier[0]!;
      if (first.wiki !== (entry?.name ?? "") || first.relPath !== meta.relPath) {
        return c.json({ error: "that discussion is about another page", reason: "other-page" }, 409);
      }
      const last = earlier[earlier.length - 1]!;
      if (last.endState === "running" && Date.now() - last.heartbeatAt < staleRunningMs) {
        return c.json({ error: "the discussion's last turn is still running", reason: "busy" }, 409);
      }
    } else discussionId = randomUUID();

    const pageHash = sha256(raw);
    const fm = parseFrontmatter(raw);
    const location = body.selection
      ? (() => {
          const pack = buildContextPack({ wiki: entry?.name ?? "", relPath: meta.relPath, title: meta.title, absPath: "", raw, ...packSelection(body) });
          const loc = pack.location;
          return loc ? { found: loc.found, reason: loc.reason, tier: loc.tier, fromLine: loc.fromLine, toLine: loc.toLine, ambiguous: loc.ambiguous } : null;
        })()
      : null;
    return {
      discussionId,
      earlier,
      wiki: entry?.name ?? "",
      wikiRoot,
      relPath: meta.relPath,
      title: meta.title,
      raw,
      pageHash,
      fm,
      project: meta.project,
      allow: index.readerConfig?.discuss?.repos ?? null,
      rules: rules.text,
      bot,
      connector,
      kind,
      body,
      location,
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

  /** The card for this page and discussion: reused from an earlier turn on the
   *  same page hash, else built once by plan-card (a plan page in a plan-card
   *  root, with `PLAN_CARD_BIN` set). */
  async function cardFor(p: Prepared, turnId: string): Promise<{ card: string | null; note: string | null; built: boolean }> {
    const reuse = [...p.earlier].reverse().find((t) => t.pageHash === p.pageHash && t.card);
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

  async function runTurn(p: Prepared, turn: { id: string; seq: number }, emit: (event: string, data: unknown) => void): Promise<void> {
    const t0 = performance.now();
    const releases: (() => void)[] = [];
    let card: string | null = null;
    // What the reader was shown, kept for a turn that fails before `res`.
    let streamed = "";
    const streamedTools: DiscussToolCall[] = [];
    try {
      // The discussion as the insert left it: a turn it closed as abandoned
      // reads so in the prompt, not as running.
      const earlier = (await store.list(p.discussionId).catch(() => p.earlier)).filter((t) => t.id !== turn.id);
      let reach: AgentReach;
      let pagePath: string;
      if (p.kind === "readSearch") {
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
      } else {
        reach = { kind: "mcpTools", tools: COPILOT_DISCUSS_TOOLS };
        pagePath = p.relPath;
      }

      emit("status", { phase: "card" });
      const c = await cardFor(p, turn.id);
      card = c.card;
      const cardText = card && reach.kind === "readSearch" ? cardForSnapshot(card, p.wikiRoot, reach.wikiSnapshot) : card;

      const pack = buildContextPack({ wiki: p.wiki, relPath: p.relPath, title: p.title, absPath: pagePath, raw: p.raw, ...packSelection(p.body) });
      const prompt = renderAgentTurnPrompt({
        pack,
        reach,
        card: cardText,
        cardNote: c.note,
        earlier: earlier.map((t) => ({ question: t.question, selection: t.selection, answer: t.answer, endState: t.endState })),
        question: p.body.question,
      });
      const surface: ToolSurface = reach.kind === "readSearch" ? { readSearch: [reach.wikiSnapshot, ...reach.repos.map((r) => r.dir)] } : { mcpTools: reach.tools };
      emit("status", { phase: "model", read: reach.kind === "readSearch" ? { wiki: true, repos: reach.repos.map((r) => r.name), missed: reach.missed.map((m) => m.name) } : { tools: reach.tools } });

      const res = await oneShot(prompt, config, p.bot, {
        toolSurface: surface,
        systemPrompt: renderAgentSystemPrompt(p.wiki, p.rules),
        timeoutMs,
        onProgress: (ev) => {
          if (ev.type === "text_delta") {
            streamed += ev.text;
            emit("delta", { text: ev.text });
          } else if (ev.type === "tool_start") {
            streamedTools.push({ name: ev.name, input: abbreviate(ev.input) });
            emit("tool", { name: ev.name, input: abbreviate(ev.input, 200) });
          }
        },
      });
      const answer = res.result ?? "";
      const toolCalls: DiscussToolCall[] = (res.toolCalls ?? []).map((tc) => ({ name: tc.name, input: abbreviate(tc.input) }));
      const proposedEdit = extractProposedEdit(answer);
      const durationMs = Math.round(performance.now() - t0);
      await store.finish(turn.id, { endState: "done", answer, card, toolCalls, proposedEdit, costUsd: res.costUsd ?? null, durationMs });
      log.info("discuss turn on {wiki} {relPath}: done", { wiki: p.wiki, relPath: p.relPath, turnId: turn.id, seq: turn.seq, bot: p.bot.name, connector: p.connector, tools: toolCalls.length, edit: proposedEdit !== null, ms: durationMs });
      emit("done", { turnId: turn.id, discussionId: p.discussionId, endState: "done", answer, proposedEdit, toolCalls, costUsd: res.costUsd ?? null, durationMs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const endState = /timed out after/i.test(message) ? "timeout" : "error";
      const durationMs = Math.round(performance.now() - t0);
      await store
        .finish(turn.id, { endState, answer: streamed, error: message, card, toolCalls: streamedTools, durationMs })
        .catch((e) => log.error("discuss turn finish failed: {error}", { error: String(e) }));
      log.warn("discuss turn on {wiki} {relPath}: {endState}", { wiki: p.wiki, relPath: p.relPath, turnId: turn.id, endState, error: message, ms: durationMs });
      emit("app_error", { type: "error", turnId: turn.id, endState, message: endState === "timeout" ? `The turn ran past ${Math.round(timeoutMs / 60000)} minutes and was stopped.` : `The turn failed: ${message}` });
    } finally {
      for (const release of releases) release();
    }
  }
}
