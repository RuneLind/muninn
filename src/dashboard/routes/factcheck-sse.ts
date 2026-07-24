/**
 * Dedicated SSE streaming lifecycle for the wiki reader's **Fact check** feature
 * (`GET /api/wiki/factcheck`). A sibling of `research-sse.ts`, but deliberately
 * NOT built on `streamResearchAnswer`: fact-check does no huginn retrieval and no
 * coverage gate. It runs a THREE-phase pipeline:
 *
 *   1. **Extraction** (Haiku, fast) — pull the checkable claims out of the page
 *      (article mode) or the selected passage (sel mode) as JSON.
 *   2. **Verification** — a bounded-parallel fan-out (`FACTCHECK_CLAIM_CONCURRENCY`)
 *      of tool-enabled `executeOneShot` calls, one per claim, each verifying its
 *      claim against the LIVE web (WebFetch) and emitting one verdict block.
 *   3. **Compose** (multi-claim only) — a small call (`thinkingMaxTokens: 0`) that
 *      writes the overall-assessment lede; the server assembles `lede + blocks`.
 *      Tools remain available (they are NOT disabled) — a tool excursion here just
 *      burns the 30s compose budget and degrades to the neutral header (the catch
 *      handles it). For a single claim the lone verify block IS the answer (no
 *      compose, no latency regress).
 *
 * It reuses the outer SSE scaffold shape (heartbeat, `app_error` masking, terminal
 * `end`, `finally` teardown) so the wire contract matches Ask/Explain — the
 * client's shared `runAskStream` consumes `delta`/`done`/`answer_html`/`app_error`/
 * `end` unchanged, plus the new `claims`/`claim_result`/`tool` events (fact-check
 * only). `streamResearchSSE`/`streamResearchAnswer` are left byte-untouched.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { StreamProgressEvent } from "../../ai/stream-parser.ts";
import { callHaikuWithFallback } from "../../ai/haiku-direct.ts";
import { getToolProgress, rawUrlField } from "../../ai/tool-status.ts";
import { agentStatus, setConnectorInfo } from "../../observability/agent-status.ts";
import { Tracer } from "../../tracing/tracer.ts";
import { tracedOneShot } from "../../core/traced-one-shot.ts";
import { locateExcerpt } from "../../wiki/explain-context.ts";
import {
  stripFactcheckBlock,
  buildClaimExtractionPrompt,
  parseClaimList,
  buildClaimVerifyPrompt,
  buildComposePrompt,
  FACTCHECK_ARTICLE_BODY_MAX,
  FACTCHECK_MAX_CLAIMS,
  type Claim,
} from "../../wiki/factcheck-context.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "factcheck-sse");

/**
 * Raised timeout for the WHOLE fact-check run. The default `CLAUDE_TIMEOUT_MS`
 * (120s) would intermittently kill a multi-claim check. 280s leaves headroom for
 * the `FACTCHECK_MAX_CLAIMS` (8) cap under bounded concurrency while staying inside
 * the plan's 240–300s budget. The claim fan-out enforces this as a launch deadline
 * (below) rather than an executeOneShot-level abort (the one-shot has none).
 */
export const FACTCHECK_TIMEOUT_MS = 280_000;

/** Per-claim verify timeout. A hung claim yields one ❓ "verification timed out"
 *  block, not a dead run. Generous — task 0 measured ~15s/web-verified-claim. */
export const FACTCHECK_CLAIM_TIMEOUT_MS = 90_000;

/** Max claims verified concurrently in the fan-out (bounded worker pool). */
export const FACTCHECK_CLAIM_CONCURRENCY = 2;

/** Time reserved at the tail for the compose call — the fan-out stops launching
 *  new claims once `deadline = start + FACTCHECK_TIMEOUT_MS − COMPOSE_BUDGET_MS`
 *  passes, so compose always has room. Also the compose call's own timeout. */
export const COMPOSE_BUDGET_MS = 30_000;

export interface FactcheckSseOptions {
  config: Config;
  /** The synthesizing bot. `null` ⇒ the helper emits the "no bots" app_error. */
  botConfig: BotConfig | null;
  /** Route-computed preflight error (unknown wiki, no page, non-web connector, …).
   *  When set, emitted as an `app_error`; no model call. */
  preflightError?: string | null;
  /** Page body — raw markdown, or `htmlToText(explainer)` for explainer pages.
   *  Prior fact-check blocks are stripped inside the SSE (runtime prompt-build). */
  body: string;
  /** Page metadata for framing the prompts + the `/agents` run name. */
  meta: { title: string; tags: string[]; type: string };
  wikiName: string;
  mode: "sel" | "article";
  /** The reader-selected passage (`sel` mode only). */
  sel?: string;
  /** Nearest-heading hint for the selection (`sel` mode only). */
  ctx?: string;
  /** Claim cap (defaults to {@link FACTCHECK_MAX_CLAIMS}). */
  maxClaims?: number;
  /** Bot folder — CWD for the extraction Haiku CLI fallback (MCP/settings). */
  botDir?: string;
  /** sha256 of the checked page's on-disk content — round-tripped on `done` so
   *  the ➕ POST can detect a drifted page. */
  baseHash: string;
  /** Final-render hook: markdown answer → reader HTML, emitted as a trailing
   *  `answer_html` (same shape as Ask/Explain). A throw is swallowed — the
   *  streamed plain text stands. */
  renderAnswerHtml?: (answer: string) => string;
}

/** Shared liveness flag: the client-abort handler (registered on the outer stream)
 *  flips `gone`, and both the launch-gate and every write-guard read it. */
interface ClientState {
  gone: boolean;
}

/** The four verdict markers, for parsing a block's leading verdict emoji. The
 *  VS16 (U+FE0F) on ⚠️ is optional — models routinely emit the bare ⚠ (U+26A0)
 *  without it; the captured verdict is normalized to the VS16 form below. */
const VERDICT_RE = /^###\s*(✅|⚠️?|❌|❓)/mu;

/** Extract a block's leading verdict emoji, defaulting to ❓ when absent. A bare
 *  ⚠ (no VS16) is normalized to ⚠️ so the client always receives the VS16 form. */
export function verdictOf(block: string): string {
  const m = block.match(VERDICT_RE);
  if (!m) return "❓";
  return m[1] === "⚠" ? "⚠️" : m[1]!;
}

/** A synthetic ❓ block for a claim we could not verify (skipped / timed out).
 *  Excluded from the final claim count (only real verify blocks are counted). */
function synthBlock(index: number, total: number, title: string, reason: string): string {
  return `### ❓ Claim ${index}/${total} — ${title}\n\n${reason}`;
}

/** Per-claim live-UI outcome. Distinct from the block's ❓ markdown vocabulary
 *  (which stays unchanged in the persisted answer) — the disambiguation between
 *  "the web genuinely doesn't know" (`unverifiable`) and "we ran out of time /
 *  crashed" (`timeout`/`skipped`/`error`) lives here, in the SSE `claim_result`
 *  event, so the client can label + tally honestly. `verified` = any real
 *  model ruling (✅/⚠️/❌, or a model-chosen ❓ counts as `unverifiable`). */
export type ClaimOutcome = "verified" | "unverifiable" | "timeout" | "error" | "skipped";

/** Confidence line — evidence-strength score the model emits after the reasoning
 *  paragraph (`Confidence: NN/100`), independent of the verdict emoji. */
const CONFIDENCE_RE = /^Confidence:\s*(\d{1,3})\/100/im;

/** Parse a block's `Confidence: NN/100` line → a 0–100 int (clamped), or
 *  undefined when the line is absent/malformed. Never derives the verdict; the
 *  emoji is semantic, the score is evidence strength. */
export function parseConfidence(block: string): number | undefined {
  const m = block.match(CONFIDENCE_RE);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.trunc(n)));
}

/** Classify a REAL (non-synthetic) model verify block into its live outcome: a
 *  model-chosen ❓ verdict means the web genuinely couldn't confirm it
 *  (`unverifiable`); any other verdict is a real ruling (`verified`). */
export function realOutcome(block: string): ClaimOutcome {
  return verdictOf(block) === "❓" ? "unverifiable" : "verified";
}

/** One claim's verdict outcome. `real` distinguishes a genuine model verdict
 *  (counted) from a synthetic ❓ skip/timeout block (excluded from the count);
 *  `outcome` carries the finer live-UI classification and `confidence` the
 *  parsed evidence-strength score (synthetic blocks carry none). */
export interface ClaimVerifyOutcome {
  block: string;
  real: boolean;
  outcome: ClaimOutcome;
  confidence?: number;
}

/**
 * Bounded-concurrency worker pool over `total` claims (pure — the caller injects
 * `verify`/`onSkip`/`onDone`/`shouldSkip`, so the ordering + launch-gate + skip
 * behaviour unit-test without any real model call). At most `concurrency` verifies
 * are in flight. BEFORE launching each claim the pool checks `shouldSkip()`
 * (client gone / past the deadline) — a skipped claim gets `onSkip(i)`'s synthetic
 * block instead of a verify. Returns outcomes in CLAIM ORDER; `onDone(i, outcome)`
 * fires per completion (in completion order) for SSE emission + progress.
 */
export async function runClaimPool(opts: {
  total: number;
  concurrency: number;
  shouldSkip: () => boolean;
  verify: (i: number) => Promise<ClaimVerifyOutcome>;
  onSkip: (i: number) => ClaimVerifyOutcome;
  onDone: (i: number, outcome: ClaimVerifyOutcome) => void;
}): Promise<ClaimVerifyOutcome[]> {
  const outcomes: ClaimVerifyOutcome[] = new Array(opts.total);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++; // atomic between awaits (single-threaded event loop)
      if (i >= opts.total) return;
      const outcome = opts.shouldSkip() ? opts.onSkip(i) : await opts.verify(i);
      outcomes[i] = outcome;
      opts.onDone(i, outcome);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(opts.concurrency, opts.total)) }, () => worker()),
  );
  return outcomes;
}

/** An existing markdown link `[text](http(s)://…)` (group 1 = text, group 2 = the
 *  href — the href group allows one level of balanced parens so a Wikipedia-style
 *  `…/Foo_(bar)` disambiguator survives) OR a bare http(s) URL (group 3). Bare
 *  URLs now allow `(`/`)` in the body (only whitespace/angle-brackets stop them);
 *  an UNMATCHED trailing `)` is peeled back off by {@link splitTrailingUrl} (the
 *  standard balanced-paren autolinker heuristic). Matching a markdown link first
 *  is what stops a bare-URL double-wrap. */
const SOURCES_URL_RE =
  /\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))*)\)|(https?:\/\/[^\s<>]+)/gi;

/** Percent-encode literal parens in a URL so the SHARED `web-format.ts`
 *  markdown-link parser (`\[..\]\(([^)]+)\)`, which we must NOT touch — global
 *  blast radius) doesn't stop the href at the first `)`. `%28`/`%29` carry no
 *  literal parens, so re-running this is a no-op (idempotent — never `%2528`). */
function encodeParens(url: string): string {
  return url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Peel trailing text a model routinely writes right after a bare URL off the
 *  URL so it stays OUTSIDE the generated link's href: plain punctuation
 *  (comma/period/…) AND an UNBALANCED trailing `)` (a wrapper paren like
 *  `(see https://x.com/a)` — more `)` than `(` in the URL). A BALANCED paren
 *  (Wikipedia's `…/Foo_(bar)`) is kept. Peels alternately from the right so
 *  `…/a).` splits both. */
function splitTrailingUrl(input: string): [string, string] {
  let url = input;
  let trailing = "";
  while (url.length > 0) {
    const p = url.match(/[.,;:!?'"\]]+$/);
    if (p) {
      trailing = p[0] + trailing;
      url = url.slice(0, url.length - p[0].length);
      continue;
    }
    if (url.endsWith(")")) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) {
        trailing = ")" + trailing;
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return [url, trailing];
}

/**
 * Fact-check-scoped fallback linkifier (belt-and-suspenders to the markdown-link
 * `Sources:` prompt contract): on every line starting with `Sources:`, wrap any
 * BARE http(s) URL into a `[hostname](url)` markdown link so the reader/web
 * pipeline renders it clickable (`formatWebHtml` linkifies markdown links but has
 * no bare-URL autolinker). Pure + deterministic + idempotent + factcheck-only —
 * deliberately NOT a global autolinker on the shared web-format.
 *
 * Parens handling (FIX 1): both a newly-wrapped bare URL AND an already-present
 * markdown link have literal `(`/`)` percent-encoded in the emitted HREF
 * (`encodeParens`, link text untouched) so the shared `web-format.ts` parser —
 * which stops an href at the first `)` and which we must NOT modify — resolves
 * the full URL. Bare URLs keep BALANCED parens (Wikipedia disambig) but shed a
 * wrapper `)` (`splitTrailingUrl`). Existing markdown links are normalized in
 * place (an intentional scope extension); the encoding is idempotent so a second
 * pass is a no-op. Leaves non-`Sources:` lines and non-http(s) URLs untouched.
 */
export function linkifySourcesLines(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => {
      if (!/^Sources:/.test(line)) return line;
      return line.replace(
        SOURCES_URL_RE,
        (match: string, mdText?: string, mdHref?: string, bareUrl?: string) => {
          if (typeof mdHref === "string") {
            // An existing markdown link — normalize parens in the href in place
            // (idempotent), leave the link text as-is.
            return `[${mdText ?? ""}](${encodeParens(mdHref)})`;
          }
          if (typeof bareUrl !== "string") return match;
          const [url, trailing] = splitTrailingUrl(bareUrl);
          let host: string;
          try {
            host = new URL(url).hostname.replace(/^www\./, "") || url;
          } catch {
            return match; // unparseable — leave the bare URL untouched
          }
          return `[${host}](${encodeParens(url)})${trailing}`;
        },
      );
    })
    .join("\n");
}

/** Assemble the final fact-check markdown: for a multi-claim check, the compose
 *  `lede` on top of the verdict blocks; for a single claim, the lone block IS the
 *  answer (no lede). Blocks are always in claim order. `Sources:` lines are
 *  linkified (bare URL → `[hostname](url)`) so they render clickable everywhere the
 *  markdown lands (streamed answer, `answer_html`, the appended `> [!factcheck]`). */
export function assembleFactcheckAnswer(lede: string, blocks: string[]): string {
  const answer = blocks.length > 1
    ? `${lede}\n\n${blocks.join("\n\n")}`.trim()
    : (blocks[0] ?? "").trim();
  return linkifySourcesLines(answer);
}

/**
 * Run the whole SSE lifecycle for one fact-check request. Never throws (a model
 * failure is reported as an `app_error` event); always emits a terminal `end`
 * sentinel so the client can close deterministically.
 */
export function streamFactcheckSSE(c: Context, opts: FactcheckSseOptions): Response {
  return streamSSE(c, async (stream) => {
    // A web-verification pass can leave a long gap with no client-visible events
    // (the model is fetching pages); a heartbeat keeps the connection alive
    // through any proxy with a shorter idle window. Clients have no 'heartbeat'
    // listener, so these are silently ignored.
    let alive = true;
    const clientState: ClientState = { gone: false };
    const heartbeat = setInterval(() => {
      if (!alive) return;
      stream.writeSSE({ event: "heartbeat", data: "{}" }).catch(() => { alive = false; });
    }, 30_000);
    // onAbort must set `clientState.gone` (not just clear the heartbeat) — the
    // claim launch-gate reads it to stop launching new verifies for a gone client.
    stream.onAbort(() => { alive = false; clientState.gone = true; clearInterval(heartbeat); });

    const appError = (message: string) =>
      stream.writeSSE({ event: "app_error", data: JSON.stringify({ type: "error", message }) });

    try {
      if (opts.preflightError) {
        await appError(opts.preflightError);
      } else if (!opts.botConfig) {
        await appError("No bots configured to run a fact check.");
      } else {
        await runFactcheck(stream, opts, opts.botConfig, clientState);
      }
      // Terminal sentinel so the client closes the EventSource deterministically.
      await stream.writeSSE({ event: "end", data: "{}" });
    } finally {
      alive = false;
      clientState.gone = true;
      clearInterval(heartbeat);
    }
  });
}

type SseStream = { writeSSE: (m: { event: string; data: string }) => Promise<void> };

/** Aggregate usage across the extraction + verify + compose calls, for the
 *  completed `/agents` run + the trace finish. */
interface Usage {
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  costUsd: number;
}

/** The multi-phase fact-check pipeline (Phase 1 extract → Phase 2 fan-out → Phase 3
 *  compose), wrapped in a `factcheck` trace + an `/agents` run. */
async function runFactcheck(
  stream: SseStream,
  opts: FactcheckSseOptions,
  botConfig: BotConfig,
  clientState: ClientState,
): Promise<void> {
  const { config } = opts;
  const maxClaims = opts.maxClaims ?? FACTCHECK_MAX_CLAIMS;
  const runName = factcheckRunName(opts);

  // /agents registry mirror. Kind `factcheck`; settled in the `finally` so it
  // closes on the done path AND every error path (mirrors ask.ts).
  const reqId = agentStatus.startRequest(botConfig.name, "extracting_claims", undefined, {
    kind: "factcheck",
    name: runName.length > 60 ? `${runName.slice(0, 57)}…` : runName,
  });
  setConnectorInfo(reqId, botConfig, config.claudeModel);

  const tracer = new Tracer("factcheck", { botName: botConfig.name, platform: "factcheck" });
  const traceId: string | undefined = tracer.traceId;
  const usage: Usage = { inputTokens: 0, outputTokens: 0, numTurns: 0, costUsd: 0 };
  let status: "ok" | "error" = "ok";
  let seenModel: string | undefined;
  // Tracks whether the current `/agents` model label came from the Phase-1
  // extraction Haiku. A later verify/compose model (sonnet) is allowed to
  // overwrite an extraction-only label so the card ends up showing the
  // verification model, not the fast extraction Haiku.
  let modelFromExtraction = false;
  // Preserve the costUsd unknown-vs-zero distinction: CLI/direct-SDK Haiku leave
  // it undefined (⇒ the /agents Recent cost column should dash, not show $0.00),
  // whereas a subscription connector returns an explicit 0.
  let sawCost = false;

  const addUsage = (
    r: { inputTokens?: number; outputTokens?: number; numTurns?: number; costUsd?: number; model?: string },
    phase: "extract" | "verify" | "compose" = "verify",
  ) => {
    usage.inputTokens += r.inputTokens ?? 0;
    usage.outputTokens += r.outputTokens ?? 0;
    usage.numTurns += r.numTurns ?? 0;
    if (typeof r.costUsd === "number") { usage.costUsd += r.costUsd; sawCost = true; }
    if (r.model) {
      const fromExtraction = phase === "extract";
      // Set on first sight; otherwise let a later, different, non-extraction
      // model replace a label that only reflects the extraction Haiku.
      const overwrite = seenModel !== r.model && modelFromExtraction && !fromExtraction;
      if (!seenModel || overwrite) {
        seenModel = r.model;
        modelFromExtraction = fromExtraction;
        agentStatus.setModel(reqId, r.model);
      }
    }
  };

  // Write helper that flips `clientState.gone` on the first failed write (the
  // one-shot keeps producing events after a client abort — stop writing then).
  const safeWrite = (event: string, data: unknown) => {
    if (clientState.gone) return;
    stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => { clientState.gone = true; });
  };

  const runStart = Date.now();
  const deadline = runStart + FACTCHECK_TIMEOUT_MS - COMPOSE_BUDGET_MS;

  try {
    // ── Phase 1: claim extraction (Haiku) ──────────────────────────────────
    // Strip any prior fact-check block ONCE. The article cap applies to the
    // EXTRACTION body only; sel-mode locateExcerpt runs over the FULL stripped
    // body (capping would break excerpt location for tail selections on >12k pages).
    const strippedBody = stripFactcheckBlock(opts.body);
    const sel = (opts.sel ?? "").trim();
    const extractionText = opts.mode === "sel"
      ? sel
      : strippedBody.slice(0, FACTCHECK_ARTICLE_BODY_MAX);

    tracer.start("extract", { mode: opts.mode });
    let extraction: Awaited<ReturnType<typeof callHaikuWithFallback>>;
    try {
      extraction = await callHaikuWithFallback(
        buildClaimExtractionPrompt(extractionText, opts.meta.title, maxClaims),
        {
          source: "factcheck-extract",
          entrypoint: "factcheck",
          cwd: opts.botDir,
          botName: botConfig.name,
          connector: botConfig.connector,
          haikuBackend: botConfig.haikuBackend,
          tracer,
        },
      );
    } catch (err) {
      // End the extract span on the throw path (the outer catch only finishes
      // the trace root) so it pairs on all paths like verify/compose.
      tracer.end("extract", { error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    addUsage(extraction, "extract");
    tracer.end("extract", {
      inputTokens: extraction.inputTokens,
      outputTokens: extraction.outputTokens,
      model: extraction.model,
      // The ACTUAL Haiku backend under a DISTINCT `haikuBackend` attr — NOT
      // `connector`. This extract span is co-resident with the claim/compose
      // spans, which carry the bot's `connector` (claude-sdk). getRecentTraces'
      // walk collapses DISTINCT `connector` values to 'mixed', so stamping the
      // router backend as a second `connector` here would flip the whole factcheck
      // row to connector='mixed'. `haikuBackend` is invisible to that collapse
      // (the walk only reads `connector`/`model`), so the row keeps showing the
      // verify connector while the waterfall label still surfaces the backend
      // (aiSpanLabel falls back to `haikuBackend` when `connector` is absent).
      ...(extraction.backend ? { haikuBackend: extraction.backend } : {}),
    });

    const parsed = parseClaimList(extraction.result ?? "");
    if (!parsed) {
      // Clean app_error, not a crash — the run still finishes (finally settles).
      log.info("Fact check: no claims extracted bot={bot} mode={mode}", {
        bot: botConfig.name,
        mode: opts.mode,
      });
      await stream.writeSSE({
        event: "app_error",
        data: JSON.stringify({
          type: "error",
          message: "Couldn't extract any checkable claims from this page.",
        }),
      });
      return;
    }
    const claims: Claim[] = parsed.slice(0, maxClaims);
    const total = claims.length;

    safeWrite("claims", {
      type: "claims",
      claims: claims.map((c, i) => ({ index: i + 1, title: c.title })),
    });
    agentStatus.updatePhase(reqId, "verifying_claims");

    // sel-mode surrounding excerpt (located over the FULL stripped body).
    const excerpt = opts.mode === "sel" ? locateExcerpt(strippedBody, sel, opts.ctx) : undefined;

    // ── Phase 2: bounded-parallel per-claim verification ───────────────────
    let doneCount = 0;

    // One claim's verification: a tool-enabled one-shot on the web-tools bot,
    // traced under its own indexed span so concurrent verifies don't clobber a
    // shared `claude` label. Returns the verdict block + whether it's a genuine
    // model verdict (a synthetic ❓ on empty/timeout/error is `real:false`).
    const verify = async (i: number): Promise<ClaimVerifyOutcome> => {
      const claim = claims[i]!;
      const index = i + 1;
      const label = `claude:claim-${i}`;
      // Per-claim tool progress — forward tool_start/tool_end (with claimIndex) as
      // `tool` SSE events. Text deltas are NOT forwarded during the fan-out
      // (index-less parallel deltas would interleave into garbage).
      const onProgress = (event: StreamProgressEvent) => {
        if (clientState.gone) return;
        if (event.type === "tool_start") {
          const prog = getToolProgress(event.name, event.input);
          // Full URL alongside the hostname `detail` — the client keeps the first
          // one seen per host to build the Consulting chip's href (hostname stays
          // the dedup key + label). Only forwarded when present.
          const url = rawUrlField(event.input);
          safeWrite("tool", {
            type: "tool",
            state: "start",
            name: event.displayName,
            label: prog?.label ?? event.displayName,
            detail: prog?.detail,
            ...(url ? { url } : {}),
            claimIndex: index,
          });
        } else if (event.type === "tool_end") {
          safeWrite("tool", { type: "tool", state: "end", name: event.displayName, claimIndex: index });
        }
      };

      const { systemPrompt, userPrompt } = buildClaimVerifyPrompt(claim, {
        index,
        total,
        pageTitle: opts.meta.title,
        wikiName: opts.wikiName,
        mode: opts.mode,
        excerpt,
        heading: opts.ctx,
      });

      try {
        // The shared seam owns the `claude:claim-<i>` span (start + end + tool
        // child spans under `label`). These spans are named claude:claim-<i>
        // (never "claude"), so they deliberately fall through the getRecentTraces
        // fast path to the walk aggregate, which sums their tokens + collapses
        // model/connector. Because the seam stamps `requestedModel` at start and
        // `model` only on a resolved end, an errored claim carries NO `model` attr
        // and so can no longer flip the /traces row to `model='mixed'`.
        const claude = await tracedOneShot(tracer, label, userPrompt, config, botConfig, {
          systemPrompt,
          onProgress,
          timeoutMs: FACTCHECK_CLAIM_TIMEOUT_MS,
          startAttrs: { claimIndex: index },
        });
        addUsage(claude);
        const result = (claude.result ?? "").trim();
        return result
          // A genuine model verdict (even a model-chosen ❓ ⇒ `unverifiable`).
          ? { block: result, real: true, outcome: realOutcome(result), confidence: parseConfidence(result) }
          // Empty result — no parseable verdict came back (an `error` outcome).
          : { block: synthBlock(index, total, claim.title, "The verifier returned no verdict for this claim."), real: false, outcome: "error" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The seam already ended the claim span with `{ error }`.
        log.warn("Fact check claim failed bot={bot} claim={index} error={error}", {
          bot: botConfig.name,
          index,
          error: message,
        });
        // Single undistinguished catch (timeout OR failure) — the block text and
        // the outcome both lead with the timeout reading (the common cause under
        // the 90s per-claim budget); no signal here separates a true timeout.
        return { block: synthBlock(index, total, claim.title, "Verification timed out or failed for this claim."), real: false, outcome: "timeout" };
      }
    };

    const outcomes = await runClaimPool({
      total,
      concurrency: FACTCHECK_CLAIM_CONCURRENCY,
      // Launch-gate: stop launching for a gone client or past the deadline
      // (in-flight claims drain on their own timeout; the heartbeat keeps the
      // stream alive). Not-launched claims get a synthetic ❓ "skipped" block.
      shouldSkip: () => clientState.gone || Date.now() > deadline,
      verify,
      onSkip: (i) => ({
        block: synthBlock(i + 1, total, claims[i]!.title, "Skipped — the fact check ran out of time before this claim could be verified."),
        real: false,
        outcome: "skipped",
      }),
      onDone: (i, outcome) => {
        safeWrite("claim_result", {
          type: "claim_result",
          index: i + 1,
          verdict: verdictOf(outcome.block),
          outcome: outcome.outcome,
          ...(typeof outcome.confidence === "number" ? { confidence: outcome.confidence } : {}),
          markdown: outcome.block,
        });
        doneCount++;
        agentStatus.updateProgress(reqId, { done: doneCount, total, currentItem: claims[i]!.title });
      },
    });
    const blocks = outcomes.map((o) => o.block);

    // ── Phase 3: compose (multi-claim only) ────────────────────────────────
    let lede = "";
    if (total > 1) {
      try {
        const composePrompts = buildComposePrompt({
          title: opts.meta.title,
          wikiName: opts.wikiName,
          blocks,
        });
        // Compose deltas DO stream via the index-less `delta` path — nothing else
        // is running, so there's no interleave risk. The client accumulates them
        // as the lede above the blocks.
        const composeProgress = (event: StreamProgressEvent) => {
          if (event.type === "text_delta") safeWrite("delta", { type: "delta", text: event.text });
        };
        // The shared seam owns the `compose` span (connector + requestedModel at
        // start, model/tokens at end, `{ error }` on throw). It's named `compose`
        // (never "claude"), so it too falls through to the walk aggregate alongside
        // the claim spans. Only thinking is disabled (`thinkingMaxTokens: 0`); tools
        // stay available — the compose prompt steers away from tool use, but a stray
        // tool excursion just burns the COMPOSE_BUDGET_MS window and degrades to the
        // neutral header below (we deliberately don't hard-disable tools here).
        const compose = await tracedOneShot(tracer, "compose", composePrompts.userPrompt, config, botConfig, {
          systemPrompt: composePrompts.systemPrompt,
          thinkingMaxTokens: 0,
          timeoutMs: COMPOSE_BUDGET_MS,
          onProgress: composeProgress,
        });
        addUsage(compose, "compose");
        lede = (compose.result ?? "").trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The seam already ended the compose span with `{ error }`.
        log.warn("Fact check compose failed bot={bot} error={error} — degrading to header", {
          bot: botConfig.name,
          error: message,
        });
        // Degrade to a neutral one-line header; never fail the run.
        lede = "Fact-check results:";
      }
    }

    const answer = assembleFactcheckAnswer(lede, blocks);
    // Count ONLY claims that produced a real verify block (skipped/timed-out
    // synthetic ❓ blocks excluded).
    const claimCount = outcomes.filter((o) => o.real).length;

    log.info("Fact check done bot={bot} mode={mode} claims={claims}/{total} tokens={tokens}", {
      bot: botConfig.name,
      mode: opts.mode,
      claims: claimCount,
      total,
      tokens: usage.outputTokens,
    });

    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        type: "done",
        answer,
        cited: [],
        noHits: false,
        lowConfidence: false,
        claimCount,
        baseHash: opts.baseHash,
        mode: opts.mode,
      }),
    });

    // Trailing server-rendered HTML (same pipeline as Ask/Explain). A throw here
    // is swallowed — the streamed plain text stands.
    if (opts.renderAnswerHtml) {
      try {
        const html = opts.renderAnswerHtml(answer);
        await stream.writeSSE({ event: "answer_html", data: JSON.stringify({ html, cited: [] }) });
      } catch (err) {
        log.warn("Fact check answer_html render failed — keeping streamed text: {error}", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    status = "error";
    const message = err instanceof Error ? err.message : String(err);
    tracer.finish("error", { error: message });
    log.error("Fact check failed bot={bot} error={error}", { bot: botConfig.name, error: message });
    await stream.writeSSE({ event: "app_error", data: JSON.stringify({ type: "error", message }) });
  } finally {
    const costUsd = sawCost ? usage.costUsd : undefined;
    if (status === "ok") tracer.finish("ok", { ...usage, costUsd });
    agentStatus.completeRequest(reqId, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      numTurns: usage.numTurns,
      costUsd,
      ...(config.tracingEnabled ? { traceId } : {}),
    });
  }
}

/** The `/agents` run name (+ display label): mode + title / truncated selection. */
function factcheckRunName(opts: FactcheckSseOptions): string {
  if (opts.mode === "sel") {
    const sel = (opts.sel ?? "").trim().replace(/\s+/g, " ");
    const snippet = sel.length > 48 ? `${sel.slice(0, 45)}…` : sel;
    return `Fact check: "${snippet}"`;
  }
  return `Fact check: ${opts.meta.title}`;
}
