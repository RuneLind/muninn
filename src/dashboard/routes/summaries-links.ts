/**
 * 🔎 Find links for `/summaries` (plan muninn-summary-links, PR 3): the links a
 * summary names but does not give, found on the web and accepted one by one
 * into its `## Links` section.
 *
 *  - `GET /api/summaries/links/options?source=&docId=` — whether the document
 *    can take a save at all (`preflightSummarySave`); the doc panel shows the
 *    button only then. One raw read, no model.
 *  - `POST /api/summaries/links/candidates` `{source, docId}` — one Haiku-tier
 *    call over the stored summary (D10) naming the posts, papers, repos, tools
 *    and docs it mentions, minus those the section already lists, plus the
 *    document's `linksBaseHash`.
 *  - `POST /api/summaries/links/search` `{source, docId, candidates}` (SSE) —
 *    one `{ web: true }` agent per selected candidate (D6), at most 3 at a time,
 *    60 s each, 120 s for the run; every URL it names is fetched through
 *    `safeFetchPage` and labelled (`matched` / `reachable` / `unread`) before the
 *    panel sees it. Writes nothing.
 *  - `POST /api/summaries/links` `{source, docId, baseHash, add}` — the save:
 *    claim, re-read, 409 `links_changed` when the `linksBaseHash` moved, the new
 *    `found by search` lines written through `saveSummaryBody`, and the new hash
 *    from a GET of the written file.
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
import { executeOneShot } from "../../ai/one-shot.ts";
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
  type SummarySaveClaims,
} from "../../summaries/summary-save.ts";
import type { SummaryIngest } from "../../summaries/summarizer-shared.ts";
import { filterDocumentText } from "../../summaries/source-text.ts";
import { checkedSha256OfRaw, summaryFactcheckBody } from "../../summaries/factcheck-body.ts";
import { sha256 } from "../../gardener/util.ts";
import { safeFetchPage, type SafePage } from "../../summaries/safe-fetch.ts";
import {
  buildCandidatesPrompt,
  buildSearchPrompt,
  candidateIsListed,
  candidateSummaryText,
  coerceCandidate,
  FIND_LINKS_MAX_ADD,
  FIND_LINKS_MAX_SELECTED,
  insertFoundLinks,
  linksBaseHash,
  parseCandidates,
  runFindLinks,
  storedLinks,
  type FindLinksEvent,
  type FindLinksRunDeps,
  type LinkCandidate,
} from "../../summaries/find-links.ts";
import { summaryFactcheckBotRefusal } from "./summaries-factcheck.ts";
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

export interface SummariesLinksDeps {
  /** The raw file (`?raw=1`), or `null` when huginn has no such document. Throws on any other failure. */
  readRaw: (collection: string, docId: string) => Promise<string | null>;
  bots: () => BotConfig[];
  /** The Haiku-tier candidates call: the raw answer. */
  candidatesCall: (prompt: string, bot: BotConfig) => Promise<string>;
  /** One web agent for one candidate: the raw answer. `sourceTitle` is the summarized document's title. */
  agent: (
    c: LinkCandidate,
    index: number,
    timeoutMs: number,
    bot: BotConfig,
    tracer: Tracer | null,
    sourceTitle: string,
  ) => Promise<string>;
  fetchPage: (url: string, timeoutMs: number) => Promise<SafePage | null>;
  /** Builds the run's trace root; `null` runs untraced (tests). */
  tracer?: (bot: BotConfig) => Tracer | null;
  /** Run-level overrides (tests). */
  run?: Partial<Pick<FindLinksRunDeps, "concurrency" | "agentTimeoutMs" | "runTimeoutMs" | "fetchTimeoutMs" | "now">>;
  ingest?: SummaryIngest;
  claims?: SummarySaveClaims;
  /** Test seam threaded into the default agent. */
  oneShot?: typeof executeOneShot;
}

export function defaultSummariesLinksDeps(config: Config): SummariesLinksDeps {
  const deps: SummariesLinksDeps = {
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
    candidatesCall: async (prompt, bot) =>
      (
        await callHaikuWithFallback(prompt, {
          source: "find-links-candidates",
          entrypoint: "find-links",
          botName: bot.name,
          connector: bot.connector,
          haikuBackend: bot.haikuBackend,
          timeoutMs: CANDIDATES_TIMEOUT_MS,
        })
      ).result,
    agent: async (c, index, timeoutMs, bot, tracer, sourceTitle) => {
      const { systemPrompt, userPrompt } = buildSearchPrompt(c, sourceTitle);
      const opts = {
        toolSurface: { web: true } as const,
        systemPrompt,
        timeoutMs,
        startAttrs: { candidateIndex: index },
        ...(deps.oneShot ? { oneShot: deps.oneShot } : {}),
      };
      const res = tracer
        ? await tracedOneShot(tracer, `claude:link-${index + 1}`, userPrompt, config, bot, opts)
        : await (deps.oneShot ?? executeOneShot)(userPrompt, config, bot, {
            toolSurface: { web: true },
            systemPrompt,
            timeoutMs,
          });
      return res.result ?? "";
    },
    fetchPage: (url, timeoutMs) => safeFetchPage(url, { timeoutMs, caller: "find-links" }),
    tracer: (bot) => new Tracer("find-links", { botName: bot.name, platform: "find-links" }),
  };
  return deps;
}

type Fail = { status: 400 | 404 | 409 | 502 | 503; body: Record<string, unknown> };
const fail = (status: Fail["status"], code: string, error: string): Fail => ({ status, body: { error, code } });

interface Target {
  sourceId: string;
  collection: string;
  docId: string;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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

async function loadRaw(deps: SummariesLinksDeps, t: Target): Promise<string | Fail> {
  try {
    const raw = await deps.readRaw(t.collection, t.docId);
    return raw ?? fail(404, "not_found", "No such document.");
  } catch (err) {
    log.warn("Find links: raw read failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
    return fail(502, "upstream", "Could not read the stored document.");
  }
}

/** One accepted line from the client, bounded; a string names what is wrong. */
function coerceAdd(raw: unknown): { url: string; title: string; detail: string }[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "add must be a non-empty array";
  if (raw.length > FIND_LINKS_MAX_ADD) return `too many links — the cap is ${FIND_LINKS_MAX_ADD} per save`;
  const out: { url: string; title: string; detail: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return "every link must be an object";
    const o = item as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || url.length > 2_000) {
      return "every link needs an http(s) url";
    }
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 300) : "";
    if (!title) return "every link needs a title";
    const detail = typeof o.detail === "string" ? o.detail.trim().slice(0, 300) : "";
    out.push({ url, title, detail });
  }
  return out;
}

export function registerSummariesLinksRoutes(
  app: Hono,
  config: Config,
  deps: SummariesLinksDeps = defaultSummariesLinksDeps(config),
): void {
  const claims = deps.claims ?? summarySaveClaims;
  const respond = (c: Context, f: Fail) => c.json(f.body, f.status);
  /** One search per document at a time: a second would spend a second set of agents. */
  const searching = new Set<string>();

  app.get("/api/summaries/links/options", async (c) => {
    const t = resolveTarget(c.req.query("source") ?? "", c.req.query("docId") ?? "");
    if ("status" in t) return respond(c, t);
    const raw = await loadRaw(deps, t);
    if (typeof raw !== "string") return respond(c, raw);
    const pre = preflightSummarySave(readStoredCapture(raw), t.docId);
    if (!pre.ok) return c.json({ available: false, code: pre.code, error: pre.error });
    return c.json({ available: true, linksBaseHash: linksBaseHash(raw) });
  });

  app.post("/api/summaries/links/candidates", async (c) => {
    const req = await readJsonTarget(c);
    if (req instanceof Response) return req;
    const t = req.target;
    const bot = resolveSummarizerBot(deps.bots());
    if (!bot) return c.json({ error: "No bots configured to find links.", code: "no_bot" }, 503);
    const raw = await loadRaw(deps, t);
    if (typeof raw !== "string") return respond(c, raw);
    const stored = readStoredCapture(raw);
    const pre = preflightSummarySave(stored, t.docId);
    if (!pre.ok) return c.json({ error: pre.error, code: pre.code }, pre.status);
    const summary = candidateSummaryText(stored.body);
    if (!summary) return c.json({ candidates: [], listed: 0, linksBaseHash: linksBaseHash(raw) });
    let answer: string;
    try {
      answer = await deps.candidatesCall(buildCandidatesPrompt(summary), bot);
    } catch (err) {
      log.warn("Find links: candidates call failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
      return c.json({ error: "The candidates call failed. Try again.", code: "model_failed" }, 502);
    }
    const parsed = parseCandidates(answer);
    if (parsed === null) {
      log.warn("Find links: candidates answer for {doc} held no JSON array", { doc: t.docId });
      return c.json({ error: "The candidates call answered no list. Try again.", code: "model_unparseable" }, 502);
    }
    const { titles } = storedLinks(stored.body);
    const candidates = parsed.filter((cand) => !candidateIsListed(cand, titles));
    return c.json({ candidates, listed: parsed.length - candidates.length, linksBaseHash: linksBaseHash(raw) });
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
    const bot = resolveSummarizerBot(deps.bots());
    const refusal = summaryFactcheckBotRefusal(bot);
    if (refusal || !bot) return c.json({ error: refusal?.replace("web fact-checks", "web searches"), code: "no_web_tools" }, 503);
    const key = `${t.sourceId}\u0000${t.docId}`;
    if (searching.has(key)) return c.json({ error: "A search on this summary is already running.", code: "running" }, 409);
    searching.add(key);

    return streamSSE(c, async (stream) => {
      let gone = false;
      stream.onAbort(() => {
        gone = true;
      });
      // One chain, so events leave in the order they were emitted and the
      // stream closes only after the last one is written.
      let chain: Promise<unknown> = Promise.resolve();
      const enqueue = (send: () => Promise<unknown>) => {
        chain = chain.then(() => (gone ? undefined : send())).catch(() => {
          gone = true;
        });
      };
      const write = (event: string, data: unknown) => enqueue(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
      const beat = setInterval(() => enqueue(() => stream.write(": ping\n\n")), HEARTBEAT_MS);
      const tracer = deps.tracer?.(bot) ?? null;
      let status: "ok" | "error" = "ok";
      try {
        write("start", { total: candidates.length });
        await runFindLinks(
          candidates as LinkCandidate[],
          {
            agent: (cand, index, timeoutMs) => deps.agent(cand, index, timeoutMs, bot, tracer, titleFromDocId(t.docId)),
            fetchPage: deps.fetchPage,
            ...deps.run,
          },
          (e: FindLinksEvent) => write(e.type, e),
        );
        write("done", {});
      } catch (err) {
        status = "error";
        log.warn("Find links: search failed for {doc}: {error}", { doc: t.docId, error: errText(err) });
        write("app_error", { error: "The search failed." });
      } finally {
        clearInterval(beat);
        await chain;
        searching.delete(key);
        tracer?.finish(status);
      }
    });
  });

  app.post("/api/summaries/links", async (c) => {
    const req = await readJsonTarget(c);
    if (req instanceof Response) return req;
    const t = req.target;
    const baseHash = typeof req.body.baseHash === "string" ? req.body.baseHash : "";
    if (!/^[0-9a-f]{64}$/.test(baseHash)) return c.json({ error: "baseHash is required", code: "bad_request" }, 400);
    const add = coerceAdd(req.body.add);
    if (typeof add === "string") return c.json({ error: add, code: "bad_request" }, 400);

    // Claim BEFORE the read this write rebuilds from.
    const claim = claims.claim(t.sourceId, t.docId, LINKS_CLAIM_BUDGET_MS);
    if (!claim) return c.json({ error: "Another write on this summary is under way.", code: "in_flight" }, 409);
    try {
      const raw = await loadRaw(deps, t);
      if (typeof raw !== "string") return respond(c, raw);
      const stored = readStoredCapture(raw);
      const pre = preflightSummarySave(stored, t.docId);
      if (!pre.ok) return c.json({ error: pre.error, code: pre.code }, pre.status);
      const current = linksBaseHash(raw);
      if (current !== baseHash) {
        return c.json(
          {
            error: "The summary changed since Find links read it (a re-run or a fact-check write). Run Find links again.",
            code: "links_changed",
          },
          409,
        );
      }
      const next = insertFoundLinks(stored.body, add);
      if (next.added === 0) return c.json({ ok: true, added: 0, skipped: next.skipped, linksBaseHash: current });
      // D14 by construction (the checked text excludes `## Links`); asserted,
      // because a write that moved it would stale every applied fact check.
      if (sha256(summaryFactcheckBody(filterDocumentText(next.body))) !== checkedSha256OfRaw(raw)) {
        log.error("Find links: the new lines would move the checked text of {doc} — not written", { doc: t.docId });
        return c.json({ error: "Adding the links would change the checked text. Nothing was written.", code: "hash_drift" }, 500);
      }
      const saved = await saveSummaryBody({
        descriptor: requireSaveDescriptor(t.sourceId),
        stored,
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
      claims.release(claim);
    }
  });
}
