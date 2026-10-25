/**
 * 🔎 Find links for `/summaries` (plan muninn-summary-links, PR 3): the links a
 * summary names but does not give, found on the web, verified by muninn and
 * accepted one by one into its `## Links` section.
 *
 *  - `GET /api/summaries/links/options?source=&docId=` — whether the document
 *    can take a links save (`preflightSummarySave`, and no unclosed code fence
 *    at its end). One raw read, no model; the doc panel shows the button only
 *    then. It carries no hash: the panel's baseline comes from the candidates
 *    call alone.
 *  - `POST /api/summaries/links/candidates` `{source, docId}` — one Haiku-tier
 *    call over the stored summary (D10) naming the posts, papers, repos, tools
 *    and docs it mentions, minus those the section lists or the body already
 *    links, plus the document's `linksBaseHash` and the selection cap.
 *  - `POST /api/summaries/links/search` `{source, docId, candidates}` (SSE) —
 *    one `{ web: true }` agent per selected candidate (D6), at most 3 at a time,
 *    60 s each, no agent past the run's 120 s; every URL an agent names is
 *    fetched through `safeFetchPage` and labelled before the panel sees it, and
 *    kept server-side as the only URLs a save accepts. Writes no document.
 *  - `POST /api/summaries/links` `{source, docId, baseHash, add: [{url}]}` —
 *    the save: claim, re-read, 409 `links_changed` when the `linksBaseHash`
 *    moved, the verified lines written through `saveSummaryBody`, and the new
 *    hash from a GET of the written file.
 *
 * Every POST takes `application/json` (415 otherwise). Rules and traps:
 * `src/summaries/CLAUDE.md` ("Find links").
 */

import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import { discoverAllBots, resolveSummarizerBot } from "../../bots/config.ts";
import { fetchKnowledgeApiText, KnowledgeApiError } from "../../ai/knowledge-api-client.ts";
import { callHaikuWithFallback } from "../../ai/haiku-direct.ts";
import { connectorCapabilities, type executeOneShot } from "../../ai/one-shot.ts";
import { tracedOneShot } from "../../core/traced-one-shot.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { encodeDocIdPath, getSummarySource, isSafeDocId } from "../../summaries/sources.ts";
import {
  preflightSummarySave,
  readStoredCapture,
  requireSaveDescriptor,
  saveSummaryBody,
  summarySaveClaims,
  titleFromDocId,
  type StoredCapture,
  type SummarySaveClaims,
} from "../../summaries/summary-save.ts";
import type { SummaryIngest } from "../../summaries/summarizer-shared.ts";
import { filterDocumentText } from "../../summaries/source-text.ts";
import { checkedSha256OfRaw, factcheckBodySha256 } from "../../summaries/factcheck-body.ts";
import { endsInsideFence } from "../../summaries/links-section.ts";
import { safeFetchPage, type SafePage } from "../../summaries/safe-fetch.ts";
import {
  buildCandidatesPrompt,
  buildSearchPrompt,
  candidateIsListed,
  candidateSummaryText,
  carriedUrlKeys,
  coerceCandidate,
  FIND_LINKS_AGENT_TIMEOUT_MS,
  FIND_LINKS_CONCURRENCY,
  FIND_LINKS_FETCH_TIMEOUT_MS,
  FIND_LINKS_MAX_ADD,
  FIND_LINKS_MAX_SELECTED,
  FIND_LINKS_RUN_TIMEOUT_MS,
  foundLinkFrom,
  inlineLinkTitles,
  insertFoundLinks,
  judgePage,
  LABEL_ORDER,
  linksBaseHash,
  linkUrlKey,
  parseCandidates,
  parseManifest,
  storedLinks,
  type FoundLink,
  type LinkCandidate,
} from "../../summaries/find-links.ts";
import { runClaimPool } from "./factcheck-sse.ts";
import { requireJsonRequest } from "./json-request.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "summaries-links");

const RAW_READ_TIMEOUT_MS = 10_000;
/** The candidates call's budget (one Haiku-tier call over ≤ 24k chars). */
const CANDIDATES_TIMEOUT_MS = 60_000;
/** How long a save may hold the document: a raw read, an ingest and a re-read. */
export const LINKS_CLAIM_BUDGET_MS = 5 * 60_000;
/** Keeps the search stream visibly alive through a 60 s agent. */
const HEARTBEAT_MS = 20_000;
/** An agent is not launched with less of the run left than this. */
const MIN_AGENT_BUDGET_MS = 5_000;
/** How long the per-document search lock waits on launched agents past the run deadline before it lets go anyway (warned). */
const LOCK_BACKSTOP_MS = 60_000;
/** How long a verified result stays acceptable. */
export const VERIFIED_TTL_MS = 60 * 60_000;
/** Documents whose verified results are kept at once (oldest dropped first). */
const VERIFIED_MAX_DOCS = 100;

/** The span surface the run needs: `tracedOneShot`'s, plus the root finish. */
export type FindLinksTracer = Pick<Tracer, "start" | "end" | "finish" | "spanStartedAt">;

export interface SummariesLinksDeps {
  /** The raw file (`?raw=1`), or `null` when huginn has no such document. Throws on any other failure. */
  readRaw: (collection: string, docId: string) => Promise<string | null>;
  bots: () => BotConfig[];
  /** The Haiku-tier candidates call: the raw answer. */
  candidatesCall: (prompt: string, bot: BotConfig, tracer: FindLinksTracer | null) => Promise<string>;
  /** One web agent for one candidate: the raw answer. */
  agent: (
    c: LinkCandidate,
    index: number,
    timeoutMs: number,
    bot: BotConfig,
    tracer: FindLinksTracer | null,
    sourceTitle: string,
  ) => Promise<string>;
  fetchPage: (url: string, timeoutMs: number) => Promise<SafePage | null>;
  /** A trace root; `null` runs untraced. */
  tracer?: (name: string, bot: BotConfig) => FindLinksTracer | null;
  now?: () => number;
  /** Run-level overrides (tests). */
  run?: {
    concurrency?: number;
    agentTimeoutMs?: number;
    runTimeoutMs?: number;
    fetchTimeoutMs?: number;
    minAgentMs?: number;
    lockBackstopMs?: number;
  };
  ingest?: SummaryIngest;
  claims?: SummarySaveClaims;
}

/**
 * Test seam for the e2e boot wrapper ONLY (`e2e/fixtures/find-links-boot.ts`):
 * the two model calls and the page fetch, replaced in-process before muninn
 * boots, so a spec drives the real routes without a model or the public web.
 * Production never sets it (the `toolSurfaceTestSeam` precedent).
 */
export const findLinksTestSeam: Partial<Pick<SummariesLinksDeps, "candidatesCall" | "agent" | "fetchPage">> = {};

export function defaultSummariesLinksDeps(config: Config, oneShot?: typeof executeOneShot): SummariesLinksDeps {
  return {
    readRaw: async (collection, docId) => {
      try {
        return await fetchKnowledgeApiText(
          config.knowledgeApiUrl,
          `/api/document/${encodeURIComponent(collection)}/${encodeDocIdPath(docId)}?raw=1`,
          { timeoutMs: RAW_READ_TIMEOUT_MS },
        );
      } catch (err) {
        if (err instanceof KnowledgeApiError && err.upstreamStatus === 404) return null;
        throw err;
      }
    },
    bots: discoverAllBots,
    candidatesCall: async (prompt, bot, tracer) => {
      if (findLinksTestSeam.candidatesCall) return findLinksTestSeam.candidatesCall(prompt, bot, tracer);
      const res = await callHaikuWithFallback(prompt, {
        source: "find-links-candidates",
        entrypoint: "find-links",
        botName: bot.name,
        connector: bot.connector,
        haikuBackend: bot.haikuBackend,
        timeoutMs: CANDIDATES_TIMEOUT_MS,
        ...(tracer ? { tracer: tracer as Tracer } : {}),
      });
      return res.result;
    },
    agent: async (c, index, timeoutMs, bot, tracer, sourceTitle) => {
      if (findLinksTestSeam.agent) return findLinksTestSeam.agent(c, index, timeoutMs, bot, tracer, sourceTitle);
      const { systemPrompt, userPrompt } = buildSearchPrompt(c, sourceTitle);
      const t = (tracer ?? new Tracer("find-links", { botName: bot.name, platform: "find-links" })) as Tracer;
      const res = await tracedOneShot(t, `claude:link-${index + 1}`, userPrompt, config, bot, {
        toolSurface: { web: true },
        systemPrompt,
        timeoutMs,
        startAttrs: { candidateIndex: index },
        ...(oneShot ? { oneShot } : {}),
      });
      return res.result ?? "";
    },
    fetchPage: (url, timeoutMs) =>
      findLinksTestSeam.fetchPage ? findLinksTestSeam.fetchPage(url, timeoutMs) : safeFetchPage(url, { timeoutMs, caller: "find-links" }),
    tracer: (name, bot) => new Tracer(name, { botName: bot.name, platform: "find-links" }),
  };
}

type Fail = { status: 400 | 404 | 409 | 502 | 503; body: Record<string, unknown> };
const fail = (status: Fail["status"], code: string, error: string): Fail => ({ status, body: { error, code } });

interface Target {
  sourceId: string;
  collection: string;
  docId: string;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const docKey = (t: Target) => JSON.stringify([t.sourceId, t.docId]);

function resolveTarget(sourceId: string, docId: string): Target | Fail {
  const source = getSummarySource(sourceId);
  if (!source) return fail(400, "bad_source", `unknown summary source "${sourceId}"`);
  if (!docId || !isSafeDocId(docId)) return fail(400, "bad_doc_id", "docId is not a document path");
  return { sourceId, collection: source.collection, docId };
}

/** The JSON gate, then the body's `{source, docId}`. */
async function readJsonTarget(c: Context): Promise<{ target: Target; body: Record<string, unknown> } | Response> {
  const notJson = requireJsonRequest(c);
  if (notJson) return notJson;
  const parsed: unknown = await c.req.json().catch(() => null);
  const body: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const t = resolveTarget(
    typeof body.source === "string" ? body.source.trim() : "",
    typeof body.docId === "string" ? body.docId.trim() : "",
  );
  if ("status" in t) return c.json(t.body, t.status);
  return { target: t, body };
}

/** The bot the search runs on, or the refusal: Find links needs web tools (D6). */
function webBot(deps: SummariesLinksDeps): BotConfig | Fail {
  const bot = resolveSummarizerBot(deps.bots());
  if (!bot) return fail(503, "no_bot", "No bots are configured to find links.");
  if (!connectorCapabilities(bot).supportsWebTools) {
    return fail(
      503,
      "no_web_tools",
      `The summarizer bot (${bot.name}) has no web tools, so it cannot search for links. Set SUMMARIZER_BOT to a claude-cli or claude-sdk bot.`,
    );
  }
  return bot;
}

/** The read plus every refusal a links save would meet: missing, `preflightSummarySave`, and an unclosed fence at the body's end. */
async function loadSavable(deps: SummariesLinksDeps, t: Target): Promise<{ raw: string; stored: StoredCapture } | Fail> {
  let raw: string | null;
  try {
    raw = await deps.readRaw(t.collection, t.docId);
  } catch (err) {
    log.warn("Find links: raw read failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
    return fail(502, "upstream", "Could not read the stored document.");
  }
  if (raw === null) return fail(404, "not_found", "No such document.");
  const stored = readStoredCapture(raw);
  const pre = preflightSummarySave(stored, t.docId);
  if (!pre.ok) return { status: pre.status, body: { error: pre.error, code: pre.code } };
  if (endsInsideFence(stored.body)) {
    return fail(409, "open_fence", "The summary ends inside an unclosed code block, so a Links section cannot be added below it.");
  }
  return { raw, stored };
}

/** Verified results per document: the only URLs a save accepts (D6 — nothing reaches the section that `safeFetchPage` did not resolve). */
class VerifiedLinks {
  private readonly docs = new Map<string, Map<string, { link: FoundLink; at: number }>>();
  constructor(private readonly now: () => number) {}

  add(key: string, links: readonly FoundLink[]): void {
    const m = this.docs.get(key) ?? new Map();
    this.docs.delete(key);
    for (const link of links) m.set(linkUrlKey(link.url), { link, at: this.now() });
    this.docs.set(key, m);
    while (this.docs.size > VERIFIED_MAX_DOCS) this.docs.delete(this.docs.keys().next().value!);
  }

  get(key: string, url: string): FoundLink | null {
    const hit = this.docs.get(key)?.get(linkUrlKey(url));
    return hit && this.now() - hit.at <= VERIFIED_TTL_MS ? hit.link : null;
  }
}

/** One candidate's terminal state on the wire. */
type Outcome = "found" | "not_found" | "error" | "timeout" | "skipped";
interface CandidateResult {
  outcome: Outcome;
  results: FoundLink[];
  error?: string;
}

export function registerSummariesLinksRoutes(
  app: Hono,
  config: Config,
  deps: SummariesLinksDeps = defaultSummariesLinksDeps(config),
): void {
  const claims = deps.claims ?? summarySaveClaims;
  const now = deps.now ?? Date.now;
  const verified = new VerifiedLinks(now);
  const respond = (c: Context, f: Fail) => c.json(f.body, f.status);
  /** One search per document at a time, held until every launched agent settled. */
  const searching = new Set<string>();

  app.get("/api/summaries/links/options", async (c) => {
    const t = resolveTarget(c.req.query("source") ?? "", c.req.query("docId") ?? "");
    if ("status" in t) return respond(c, t);
    const doc = await loadSavable(deps, t);
    if ("status" in doc) {
      if (doc.status === 502 || doc.status === 404) return respond(c, doc);
      return c.json({ available: false, ...doc.body });
    }
    return c.json({ available: true });
  });

  app.post("/api/summaries/links/candidates", async (c) => {
    const req = await readJsonTarget(c);
    if (req instanceof Response) return req;
    const t = req.target;
    const bot = webBot(deps);
    if ("status" in bot) return respond(c, bot);
    const doc = await loadSavable(deps, t);
    if ("status" in doc) return respond(c, doc);
    const hash = linksBaseHash(doc.raw);
    const summary = candidateSummaryText(doc.stored.body);
    if (!summary) return c.json({ candidates: [], listed: 0, linked: 0, maxSelected: FIND_LINKS_MAX_SELECTED, linksBaseHash: hash });
    const tracer = deps.tracer?.("find-links-candidates", bot) ?? null;
    let answer: string;
    tracer?.start("candidates", { doc: t.docId, source: t.sourceId });
    try {
      answer = await deps.candidatesCall(buildCandidatesPrompt(summary), bot, tracer);
      tracer?.end("candidates", { answerChars: answer.length });
    } catch (err) {
      tracer?.end("candidates", { error: errText(err) }, "error");
      tracer?.finish("error");
      log.warn("Find links: candidates call failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
      return c.json({ error: "The candidates call failed. Try again.", code: "model_failed" }, 502);
    }
    const parsed = parseCandidates(answer);
    if (parsed === null) {
      tracer?.finish("error", { error: "no JSON array" });
      log.warn("Find links: candidates answer for {doc} held no JSON array", { doc: t.docId });
      return c.json({ error: "The candidates call answered no list. Try again.", code: "model_unparseable" }, 502);
    }
    const sectionTitles = storedLinks(doc.stored.body).titles;
    const linkTitles = inlineLinkTitles(doc.stored.body);
    let listed = 0;
    let linked = 0;
    const candidates = parsed.filter((cand) => {
      if (candidateIsListed(cand, sectionTitles)) return (listed++, false);
      if (candidateIsListed(cand, linkTitles)) return (linked++, false);
      return true;
    });
    tracer?.finish("ok", { candidates: candidates.length, listed, linked });
    return c.json({ candidates, listed, linked, maxSelected: FIND_LINKS_MAX_SELECTED, linksBaseHash: hash });
  });

  app.post("/api/summaries/links/search", async (c) => {
    const req = await readJsonTarget(c);
    if (req instanceof Response) return req;
    const t = req.target;
    const list = req.body.candidates;
    if (!Array.isArray(list) || list.length === 0) {
      return c.json({ error: "candidates must be a non-empty array", code: "bad_request" }, 400);
    }
    if (list.length > FIND_LINKS_MAX_SELECTED) {
      return c.json({ error: `too many candidates — the cap is ${FIND_LINKS_MAX_SELECTED} per search`, code: "bad_request" }, 400);
    }
    const candidates = list.map(coerceCandidate);
    if (candidates.some((x) => x === null)) {
      return c.json({ error: "every candidate needs a topic or a title", code: "bad_request" }, 400);
    }
    const bot = webBot(deps);
    if ("status" in bot) return respond(c, bot);
    const key = docKey(t);
    if (searching.has(key)) return c.json({ error: "A search on this summary is already running.", code: "running" }, 409);
    const doc = await loadSavable(deps, t);
    if ("status" in doc) return respond(c, doc);
    if (searching.has(key)) return c.json({ error: "A search on this summary is already running.", code: "running" }, 409);
    searching.add(key);

    const concurrency = deps.run?.concurrency ?? FIND_LINKS_CONCURRENCY;
    const agentTimeoutMs = deps.run?.agentTimeoutMs ?? FIND_LINKS_AGENT_TIMEOUT_MS;
    const runTimeoutMs = deps.run?.runTimeoutMs ?? FIND_LINKS_RUN_TIMEOUT_MS;
    const fetchTimeoutMs = deps.run?.fetchTimeoutMs ?? FIND_LINKS_FETCH_TIMEOUT_MS;
    const minAgentMs = deps.run?.minAgentMs ?? MIN_AGENT_BUDGET_MS;
    const lockBackstopMs = deps.run?.lockBackstopMs ?? LOCK_BACKSTOP_MS;
    const sourceTitle = titleFromDocId(t.docId);
    // D19 9: a URL the section or the body already carries is never a result.
    const carried = carriedUrlKeys(doc.stored.body);
    const deadline = now() + runTimeoutMs;
    /** Every agent call launched, settled or not: the lock waits on these. */
    const launched: Promise<unknown>[] = [];
    let released = false;
    // Armed with the lock, not at the stream's end: a client that never reads
    // stalls every write, and the stream's `finally` with them.
    const backstop = setTimeout(() => {
      if (released) return;
      log.warn("Find links: the search on {doc} still holds its lock {ms} ms past the run deadline; releasing it", {
        doc: t.docId,
        ms: lockBackstopMs,
      });
      release();
    }, runTimeoutMs + lockBackstopMs);
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(backstop);
      searching.delete(key);
    };
    const releaseWhenSettled = () => {
      void Promise.allSettled(launched).then(release);
    };

    try {
      return streamSSE(c, async (stream) => {
        let gone = false;
        stream.onAbort(() => {
          gone = true;
        });
        // One chain, so events leave in the order they were emitted.
        let chain: Promise<unknown> = Promise.resolve();
        const write = (event: string, data: unknown) => {
          chain = chain
            .then(() => (gone ? undefined : stream.writeSSE({ event, data: JSON.stringify(data) })))
            .catch(() => {
              gone = true;
            });
        };
        let beat: ReturnType<typeof setInterval> | undefined;
        let tracer: FindLinksTracer | null = null;
        let status: "ok" | "error" = "ok";
        try {
          beat = setInterval(() => {
            chain = chain.then(() => (gone ? undefined : stream.write(": ping\n\n"))).catch(() => {
              gone = true;
            });
          }, HEARTBEAT_MS);
          tracer = deps.tracer?.("find-links", bot) ?? null;
          write("start", { total: candidates.length });

          const searchOne = async (index: number): Promise<CandidateResult> => {
            const cand = candidates[index]!;
            write("state", { index, state: "searching" });
            const budget = Math.min(agentTimeoutMs, deadline - now());
            const call = deps.agent(cand, index, budget, bot, tracer, sourceTitle);
            launched.push(call.catch(() => {}));
            let timer: ReturnType<typeof setTimeout> | undefined;
            let raw: string;
            try {
              raw = await Promise.race([
                call,
                new Promise<never>((_, reject) => {
                  timer = setTimeout(() => reject(new Error(`timed out after ${budget}ms`)), budget);
                }),
              ]);
            } catch (err) {
              const message = errText(err);
              return { outcome: /timed out/i.test(message) ? "timeout" : "error", results: [], error: message };
            } finally {
              clearTimeout(timer);
            }
            write("state", { index, state: "checking" });
            const checked = await Promise.all(
              parseManifest(raw).map(async (entry) => {
                const left = deadline - now();
                if (left <= 0 || carried.has(linkUrlKey(entry.url))) return null;
                try {
                  const page = await deps.fetchPage(entry.url, Math.min(fetchTimeoutMs, left));
                  if (!page || carried.has(linkUrlKey(page.finalUrl))) return null;
                  return foundLinkFrom(cand, page, entry, judgePage(cand, page, entry.quote));
                } catch (err) {
                  log.warn("Find links: checking {url} failed: {error}", { url: entry.url, error: errText(err) });
                  return null;
                }
              }),
            );
            const byKey = new Map<string, FoundLink>();
            for (const r of checked) {
              if (!r) continue;
              const k = linkUrlKey(r.url);
              const prev = byKey.get(k);
              if (!prev || LABEL_ORDER[r.label] < LABEL_ORDER[prev.label]) byKey.set(k, r);
            }
            const results = [...byKey.values()].sort((a, b) => LABEL_ORDER[a.label] - LABEL_ORDER[b.label]);
            verified.add(key, results);
            return { outcome: results.length > 0 ? "found" : "not_found", results };
          };

          await runClaimPool<CandidateResult>({
            total: candidates.length,
            concurrency,
            // The launch gate: a reader who left, or a run with too little time
            // left for an agent, launches nothing more.
            shouldSkip: () => gone || deadline - now() < minAgentMs,
            verify: async (i) => {
              try {
                return await searchOne(i);
              } catch (err) {
                log.warn("Find links: candidate {index} on {doc} failed: {error}", { index: i, doc: t.docId, error: errText(err) });
                return { outcome: "error", results: [], error: errText(err) };
              }
            },
            onSkip: () => ({ outcome: "skipped", results: [], error: gone ? "the reader left" : "the run's time ran out" }),
            onDone: (index, r) => write("result", { index, ...r }),
          });
          write("done", { gone });
        } catch (err) {
          status = "error";
          log.warn("Find links: search failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
          write("app_error", { error: "The search failed." });
        } finally {
          clearInterval(beat);
          await chain;
          tracer?.finish(status);
          releaseWhenSettled();
        }
      });
    } catch (err) {
      release();
      throw err;
    }
  });

  app.post("/api/summaries/links", async (c) => {
    const req = await readJsonTarget(c);
    if (req instanceof Response) return req;
    const t = req.target;
    const baseHash = typeof req.body.baseHash === "string" ? req.body.baseHash : "";
    if (!/^[0-9a-f]{64}$/.test(baseHash)) return c.json({ error: "baseHash is required", code: "bad_request" }, 400);
    const raw = req.body.add;
    if (!Array.isArray(raw) || raw.length === 0) return c.json({ error: "add must be a non-empty array", code: "bad_request" }, 400);
    if (raw.length > FIND_LINKS_MAX_ADD) {
      return c.json({ error: `too many links — the cap is ${FIND_LINKS_MAX_ADD} per save`, code: "bad_request" }, 400);
    }
    // Only a URL this process verified for this document: the title and the
    // attribution are the server's, never the client's.
    const key = docKey(t);
    const add: FoundLink[] = [];
    for (const item of raw) {
      const url = item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url : "";
      const found = url ? verified.get(key, url) : null;
      if (!found) {
        return c.json(
          { error: "That link was not verified by a Find links search on this summary. Search again.", code: "not_verified" },
          409,
        );
      }
      add.push(found);
    }

    // Claim BEFORE the read this write rebuilds from.
    const claim = claims.claim(t.sourceId, t.docId, LINKS_CLAIM_BUDGET_MS);
    if (!claim) return c.json({ error: "Another write on this summary is under way.", code: "in_flight" }, 409);
    let wrote = false;
    try {
      const doc = await loadSavable(deps, t);
      if ("status" in doc) return respond(c, doc);
      const current = linksBaseHash(doc.raw);
      if (current !== baseHash) {
        return c.json(
          {
            error: "The summary changed since Find links read it (a re-run or a fact-check write). Run Find links again.",
            code: "links_changed",
          },
          409,
        );
      }
      const next = insertFoundLinks(doc.stored.body, add);
      if (next.added === 0) return c.json({ ok: true, added: 0, skipped: next.skipped, linksBaseHash: current });
      // D14 by construction (the checked text excludes `## Links`); asserted,
      // because a write that moved it would stale every applied fact check.
      if (factcheckBodySha256(filterDocumentText(next.body)) !== checkedSha256OfRaw(doc.raw)) {
        log.error("Find links: the new lines would move the checked text of {doc}; not written", { doc: t.docId });
        return c.json({ error: "Adding the links would change the checked text. Nothing was written.", code: "hash_drift" }, 500);
      }
      wrote = true;
      const saved = await saveSummaryBody({
        descriptor: requireSaveDescriptor(t.sourceId),
        stored: doc.stored,
        docId: t.docId,
        summary: next.body,
        claim,
        knowledgeApiUrl: config.knowledgeApiUrl,
        ...(deps.ingest ? { ingest: deps.ingest } : {}),
        logContext: { route: "find-links" },
      });
      if (!saved.ok) {
        return c.json(
          { error: saved.error, code: saved.code, ...(saved.siblingDocId !== undefined ? { siblingDocId: saved.siblingDocId } : {}) },
          saved.status,
        );
      }
      // huginn normalizes on write, so the next accept's hash comes from the written file.
      let after: string | null = null;
      try {
        const reread = await deps.readRaw(t.collection, t.docId);
        after = reread === null ? null : linksBaseHash(reread);
      } catch (err) {
        log.warn("Find links: re-read after save failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
      }
      log.info("Find links saved {added} line(s) to {collection}/{doc}", { added: next.added, collection: t.collection, doc: t.docId });
      return c.json({ ok: true, added: next.added, skipped: next.skipped, linksBaseHash: after });
    } finally {
      if (wrote) claims.release(claim);
      else claims.abandon(claim);
    }
  });
}
