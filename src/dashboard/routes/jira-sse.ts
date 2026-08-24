/**
 * SSE lifecycle for the Jira composer (`POST /api/jira/draft`) — the server half
 * of PR 2's `/jira` page.
 *
 * **Why the fact-check scaffold and not `streamResearchSSE`.** Research owns the
 * whole retrieve → coverage-gate → cited-synthesis shape and renders its own
 * decline copy; this feature retrieves and cites too, but it DRAFTS on a weak
 * verdict rather than declining, carries the verdict on the payload, and runs its
 * own two post-passes. What it needs from the family is the outer shape —
 * heartbeat, `app_error` masking, abort-guarded writes, terminal `end` — which is
 * exactly `streamFactcheckScaffold`, byte-shared with share, the article
 * fact-check and the claim retry.
 *
 * **Every body check runs in the ROUTE, before this function is called.** Once
 * `streamSSE` commits a 200 a validation failure can only be an `app_error`
 * inside a successful response, indistinguishable from a model failure. The
 * `share-sse.ts` ordering contract, verbatim.
 *
 * **The result lands on the `jira_drafts` row on EVERY terminal path, including a
 * client abort.** `clientState.gone` stops the WRITES, not the work — the
 * one-shot runs to completion and still spends its 120–600 s — so an aborted
 * draft is still generated. That is also why the page POLLS
 * `GET /api/jira/draft/:id` instead of re-attaching: there is nothing to attach
 * to, and a re-POST of identical content would hit the single-flight 409.
 */

import type { Context } from "hono";
import type { Config } from "../../config.ts";
import type { BotConfig } from "../../bots/config.ts";
import type { executeOneShot } from "../../ai/one-shot.ts";
import type { McpServerStatus } from "../../ai/mcp-status.ts";
import { runFencedOneShot } from "../../core/fenced-one-shot.ts";
import { Tracer } from "../../tracing/tracer.ts";
import {
  makeSafeWrite,
  streamFactcheckScaffold,
  type ClientState,
  type SseStream,
} from "./factcheck-sse.ts";
import { buildJiraRetrievalQuestion } from "../../jira/query.ts";
import {
  applyExclusions,
  fetchFullDocuments,
  retrieveForJira,
  sliceForDepth,
  type JiraFullDoc,
} from "../../jira/retrieval.ts";
import { buildJiraSystemPrompt, buildJiraUserPrompt } from "../../jira/prompt.ts";
import { buildDepthFence } from "../../jira/tool-fence.ts";
import { finalizeJiraDraft, JIRA_EMPTY_RESULT_MESSAGE } from "../../jira/finalize.ts";
import { runJiraThreadDraft, type JiraThreadRunOptions } from "./jira-thread-run.ts";
import { effectiveCoverage, type JiraCitation, type JiraDepth, type JiraDonePayload } from "../../jira/wire.ts";
import {
  createJiraDraft,
  failJiraDraft,
  saveJiraDraftRetrieval,
  startJiraDraftRun,
} from "../../db/jira-drafts.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "jira-sse");

/**
 * Budget for one draft generation, per depth.
 *
 * **Measured, not inherited.** Share's `SHARE_TIMEOUT_MS = 120_000` is justified
 * by *"No tools … a single bounded completion"* — a premise `Full` breaks
 * outright, and one that is weaker even at `Ingen` on this path: melosys runs
 * `copilot-sdk`, which starts all five MCP servers per session plus a pre-flight
 * probe REGARDLESS of `excludedTools` (that field filters tool VISIBILITY, not
 * server startup).
 *
 * Measured 2026-08-22 through this route on melosys, on a real 1.5 KB refinement
 * note, curl to curl (condense + retrieval + generation + both post-passes): two
 * cold `Ingen` runs at **21.5 s** and **18.2 s** wall clock, and a `Skisse` run
 * at **55.3 s**. 120 s is ~5.5× the cold `Ingen` and ~2.2× the observed `Skisse`
 * — headroom, not a fit — and the two share a budget because they differ only by
 * a rider and two more citations, which is exactly the spread those numbers show.
 *
 * **Heartbeat arithmetic, stated the way `share-sse.ts` states it.** The scaffold
 * writes a `heartbeat` every 30 s, which is what holds the stream open past the
 * 255 s per-response `idleTimeout`; without it the 120 s budget would already be
 * within one stalled model call of the limit and `Full` could not exist at all.
 * The rule for anyone raising these: the budget may exceed 255 s (it does, at
 * `Full`) only while the gap between CLIENT-VISIBLE writes stays under it, and
 * the only guarantee of that is the 30 s heartbeat. A change that removes or
 * lengthens the heartbeat past 255 s breaks `Full` silently.
 */
export const JIRA_TIMEOUT_MS_BY_DEPTH: Record<JiraDepth, number> = {
  ingen: 120_000,
  skisse: 120_000,
  // `Full` opens files through the code/yggdrasil MCP servers — a tool loop, not
  // a bounded completion, so share's "no tools" premise does not apply at all.
  // Measured on the same note, same day: **118.4 s** end to end, of which the
  // model call was 89.7 s across 10 real `yggdrasil-*` tool calls (list_repos,
  // search ×5, read_source ×3, symbol_context). 600 s is ~5× that — room for a
  // deeper investigation on a bigger note, and far enough from the observed
  // figure that it is a ceiling rather than a target.
  full: 600_000,
};

/**
 * Slack added to the single-flight slot's expiry on top of the budget.
 *
 * Same reason as share's `SHARE_SLOT_SLACK_MS` — the one-shot's budget starts
 * AFTER the slot is taken — but this route has far more work outside that budget
 * than share does, and the first cut inherited share's 60 s without doing the
 * arithmetic. Every step below is bounded by a constant, and the sum is what the
 * slack has to cover:
 *
 *   · the Haiku condense (`query.ts`)          ≤ **60 s** (`HAIKU_TIMEOUT_MS`)
 *   · the `Full` full-document pull            ≤ **8 s** (`JIRA_FULL_DOC_TIMEOUT_MS`)
 *   · the `jira-issues` key-index listing      ≤ **15 s** (`verify-keys.ts`)
 *   = **83 s** of bounded non-model work, plus the retrieval fan-out (up to four
 *   huginn searches, each with huginn's own timeout) and the row writes.
 *
 * At 60 s the slot could expire while its holder was still condensing, and a
 * second click then started a duplicate generation — the exact failure the slot
 * exists to prevent. 180 s covers the 83 s of constants with room for the
 * retrieval fan-out; it is a ceiling on a WEDGE, so over-sizing costs only a
 * later retry after a crash, while under-sizing costs a double spend.
 */
export const JIRA_SLOT_SLACK_MS = 180_000;

interface JiraFlight {
  startedAt: number;
  expiresAt: number;
}

/**
 * Single-flight registry, keyed on a content hash.
 *
 * Share keys its slot on a stable page identity; free-text notes have none. The
 * key is a hash of `notes + template + depth + excludeDocIds` — **and the
 * exclusion set has to be in it**, or a toggle-and-regenerate while the first
 * draft is still streaming hashes identically and gets the 409, which is exactly
 * the path PR 2's toggle acceptance exercises.
 *
 * `expiresAt` on the value is what stops a process killed mid-stream from wedging
 * a note forever; it is evaluated lazily on the next hit — no sweeper, no timer.
 */
const jiraFlights = new Map<string, JiraFlight>();

/**
 * The content hash.
 *
 * **`draftId` is part of it, and the notes handed in are the RESOLVED ones.** The
 * first cut hashed the request BODY's notes, which on a regenerate are empty — so
 * every regenerate of every draft at the same template/depth/exclusion set hashed
 * IDENTICALLY, and a regenerate of draft B got a 409 about a draft the reader had
 * never opened. Sync, since `Bun.CryptoHasher` needs no await.
 */
export interface JiraFlightKeyInput {
  /** The RESOLVED notes (the row’s on a regenerate), never the request body’s. */
  notes: string;
  template: string;
  depth: JiraDepth;
  /**
   * The reader’s free-text steer. **In the key**, because it reaches the prompt:
   * without it a reader who typed «fokuser på migreringsrisikoen» and clicked
   * Generer på nytt was told «et likt utkast» about a draft that is not alike at
   * all — and `extra` is one of the two things a regenerate exists to let them
   * change.
   */
  extra: string;
  excludeDocIds: string[];
  draftId: string;
}

/**
 * The 409 sentence for the thread slot — ONE spelling.
 *
 * There is now exactly ONE holder of a {@link threadFlightKey} slot, `POST
 * …/from-thread` — a re-run is another click on that same route. The sentence is
 * still declared apart from the notes path's («…et utkast for dette
 * råmaterialet»), which names raw material this draft does not have and a piece
 * of work this path never runs.
 */
export const JIRA_THREAD_FLIGHT_MESSAGE =
  "Det skrives allerede en sak fra denne samtalen — vent til den er ferdig.";

/**
 * The single-flight key for the thread path: the thread, and nothing else.
 *
 * `jiraFlightKey` hashes everything that changes the OUTPUT, which is the right
 * rule for a one-shot over stored hits — two different drafts are two different
 * pieces of work and may run at once. A thread turn is not that: it is a message
 * in a conversation, and two of them in one thread interleave (measured: two
 * `Lag Jira-sak` user lines 17 ms apart, then two replies) whatever template or
 * depth each asked for. Keying on the thread makes the second caller wait, which
 * is what the 409 already tells them.
 *
 * Domain-separated from `jiraFlightKey`'s input, so a thread id can never collide
 * with a content hash.
 */
export function threadFlightKey(threadId: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(["jira-thread", threadId].join("\0"));
  return h.digest("hex");
}

export function jiraFlightKey(input: JiraFlightKeyInput): string {
  const h = new Bun.CryptoHasher("sha256");
  // NUL-separated and with the exclusion set SORTED, so the same toggle state
  // reached by clicking rows in a different order is the same slot.
  h.update(
    [
      input.draftId,
      input.notes,
      input.template,
      input.depth,
      input.extra,
      [...input.excludeDocIds].sort().join(","),
    ].join("\u0000"),
  );
  return h.digest("hex");
}

export type JiraAcquisition =
  | { ok: true; release: () => void }
  | { ok: false; expiresAtMs: number };

/** Claim the slot for `key`, treating an EXPIRED holder as free. `release` is
 *  identity-checked, so a late release from a run whose entry already expired and
 *  was re-taken cannot free the newer holder's slot. */
export function acquireJiraFlight(
  key: string,
  depth: JiraDepth,
  now: number = Date.now(),
): JiraAcquisition {
  const held = jiraFlights.get(key);
  if (held && held.expiresAt > now) return { ok: false, expiresAtMs: held.expiresAt };
  const entry: JiraFlight = {
    startedAt: now,
    expiresAt: now + JIRA_TIMEOUT_MS_BY_DEPTH[depth] + JIRA_SLOT_SLACK_MS,
  };
  jiraFlights.set(key, entry);
  return {
    ok: true,
    release: () => {
      if (jiraFlights.get(key) === entry) jiraFlights.delete(key);
    },
  };
}

/** Test-only: drop every in-flight entry. */
export function __resetJiraFlightsForTest(): void {
  jiraFlights.clear();
}

export interface JiraSseOptions {
  config: Config;
  /** The pinned bot (`JIRA_BOT`). `null` ⇒ the scaffold emits the no-bot error. */
  botConfig: BotConfig | null;
  /** Route-computed preflight error; when set, emitted as an `app_error`. */
  preflightError?: string | null;
  /** The resolved template's instruction body. */
  instruction: string;
  template: string;
  depth: JiraDepth;
  notes: string;
  extra: string;
  /**
   * REGENERATE: the stored citation set to reuse. When present, NO retrieval
   * runs — this is the whole point of storing the hit set (design call 1).
   */
  storedCitations?: JiraCitation[];
  /** Regenerate: the draft row to write into, and its stored retrieval question. */
  existingDraftId?: string;
  storedRetrievalQuestion?: string;
  /** Regenerate: the row's IMMUTABLE retrieval verdict — what retrieval found,
   *  never the last run's derived one. Also the marker that retrieval landed. */
  storedCoverage?: JiraDonePayload["coverage"];
  /** The exclusion set the stored markdown was generated under — restored if this run fails. */
  storedExcludeDocIds?: string[];
  excludeDocIds: string[];
  /** Live MCP probe result — the same one the `Full` pre-flight ran. */
  mcpServers: McpServerStatus[];
  /**
   * REGENERATE ON A THREAD-SOURCED DRAFT: run another turn in the thread instead
   * of a one-shot over stored hits.
   *
   * It rides `JiraSseOptions` rather than getting its own route so the page's
   * stream contract does not fork — a regenerate is a regenerate, and the client
   * sends the same POST whichever way the draft was born. `runJiraDraft` diverts
   * on this field before it touches retrieval.
   */
  threadRun?: JiraThreadRunOptions;
  /** Fired on every terminal path — the route releases its single-flight slot. */
  onSettled?: () => void;
  /** Test seams — production callers pass none. */
  oneShot?: typeof executeOneShot;
  retrieve?: Parameters<typeof retrieveForJira>[0]["retrieve"];
  buildQuestion?: typeof buildJiraRetrievalQuestion;
  fetchFullDocs?: typeof fetchFullDocuments;
}

/** Run the SSE lifecycle for one draft. Never throws; always emits a terminal `end`. */
export function streamJiraSSE(c: Context, opts: JiraSseOptions): Response {
  return streamFactcheckScaffold(c, {
    botConfig: opts.botConfig,
    preflightError: opts.preflightError,
    noBotMessage: "Ingen bot er konfigurert til å skrive Jira-saker.",
    run: (stream, botConfig, clientState) => runJiraDraft(stream, opts, botConfig, clientState),
    ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
  });
}

/**
 * Run a draft with NO client attached — the `POST /api/jira/draft/start` path.
 *
 * Same function, same order, same writes: the stream is a stub and `gone` is set
 * from the outset, so every `safeWrite` is the no-op it already becomes the
 * moment a real client aborts. That is deliberate rather than a second
 * generation path — the whole reason the result lands on the row is that an
 * aborted draft still completes, and a detached start is just that case chosen
 * up front. Never rejects: the runner reports its own failures onto the row.
 */
export async function runJiraDraftDetached(
  opts: JiraSseOptions,
  botConfig: BotConfig,
): Promise<void> {
  const stubStream: SseStream = { writeSSE: async () => {} };
  try {
    await runJiraDraft(stubStream, opts, botConfig, { gone: true });
  } finally {
    opts.onSettled?.();
  }
}

async function runJiraDraft(
  stream: SseStream,
  opts: JiraSseOptions,
  botConfig: BotConfig,
  clientState: ClientState,
): Promise<void> {
  const safeWrite = makeSafeWrite(stream, clientState);

  // A thread-sourced draft regenerates by running ANOTHER TURN in the thread —
  // never by re-running the one-shot over the stored hits. Diverted here, before
  // any retrieval decision, because none of the retrieval machinery below applies:
  // that draft's hit set comes from the conversation's own `research_knowledge`
  // calls, and its context is the conversation.
  if (opts.threadRun) {
    return runJiraThreadDraft(opts.threadRun, safeWrite);
  }
  /**
   * Is there a STORED HIT SET to reuse?
   *
   * The test is "did retrieval land", not "is there a draft row". `citations`
   * defaults to `'[]'` in the column, so `!!opts.storedCitations` was TRUE for a
   * draft that died before `saveJiraDraftRetrieval` ever ran — and that draft was
   * then condemned to regenerate from an empty hit set, forced to `no_hits`,
   * forever, with no way back short of retyping the notes. `storedCoverage` is
   * the marker that distinguishes them: it is written in the same statement as
   * the citations, so it is non-null exactly when retrieval finished — including
   * the legitimate case of a retrieval that finished with zero hits, which must
   * NOT be re-run.
   *
   * **`unreachable` is the one non-null verdict that means retrieval did NOT
   * land** — it is, by its own definition, the absence of a verdict about the
   * corpus (`src/jira/wire.ts`). Counting it as landed reused the empty hit set
   * on every later regenerate, so the page said *«Prøv igjen senere»* and the one
   * button that could try again never re-retrieved. It is the same latch the
   * `'[]'`-is-truthy bug above created, arrived at from the other side.
   */
  const retrievalLanded = !!opts.storedCitations
    && opts.storedCoverage !== "unreachable"
    && (opts.storedCoverage != null || opts.storedCitations.length > 0);
  const regenerate = !!opts.existingDraftId && retrievalLanded;
  let draftId = opts.existingDraftId ?? "";

  try {
    // The row exists BEFORE any expensive work, so `GET /api/jira/draft/:id` can
    // answer `generating` and an abort has somewhere to land its result.
    if (!draftId) {
      draftId = await createJiraDraft({
        botName: botConfig.name,
        template: opts.template,
        depth: opts.depth,
        notes: opts.notes,
        extra: opts.extra,
      });
    } else {
      // An EXISTING row goes back into flight before anything expensive starts.
      // Without this the row stayed `ready` with the previous markdown for the
      // whole run, so the page's poller — which starts the moment `/draft/start`
      // returns `generating` — read `ready` on its first tick and rendered the
      // OLD task as the new one. Also lands this run's exclusion set.
      await startJiraDraftRun(draftId, opts.excludeDocIds);
    }
    // Emitted FIRST so a client that aborts a second later still knows which row
    // to poll. PR 3's popup reads the plain-JSON `/draft/start` instead, but the
    // page needs the id before the draft exists either way.
    safeWrite("draft", { draftId });

    // One trace root for the whole draft; the fenced one-shot attaches its own
    // `claude` child under it, and the query-condense Haiku row ties back to it.
    const tracer = new Tracer("jira:draft", { botName: botConfig.name, platform: "jira" });

    let citations: JiraCitation[];
    let coverage: JiraDonePayload["coverage"];
    let retrievalCoverage: JiraDonePayload["retrievalCoverage"];
    let retrievalQuestion: string;

    if (regenerate) {
      // NO second retrieval, deliberately: a fresh Haiku decomposition per click
      // would be nondeterministic, so the hits could differ from the rows the
      // reader was toggling. Renumber AFTER the exclusion so the `[n]` markers
      // and `## Referanser` do not cite gaps.
      citations = applyExclusions(opts.storedCitations!, opts.excludeDocIds);
      retrievalQuestion = opts.storedRetrievalQuestion ?? "";
      // A regenerate that excluded everything has no grounding left, whatever
      // retrieval found — but that is a fact about THIS RUN, and it is NOT written
      // back to the row. `startJiraDraftRun` has already landed this run's
      // exclusion set, so the poll derives the same verdict from the same two
      // inputs. Storing it instead is what latched a draft to `no_hits` forever:
      // the next regenerate read the derived value back as the retrieval verdict.
      retrievalCoverage = opts.storedCoverage ?? null;
      coverage = effectiveCoverage(retrievalCoverage, citations.length);
      safeWrite("phase", { phase: "regenerating", citations: citations.length });
    } else {
      safeWrite("phase", { phase: "condensing" });
      const q = await buildQuestion(opts)({
        notes: opts.notes,
        botName: botConfig.name,
        ...(botConfig.connector ? { connector: botConfig.connector } : {}),
        ...(botConfig.haikuBackend ? { haikuBackend: botConfig.haikuBackend } : {}),
        tracer,
      });
      retrievalQuestion = q.question;
      safeWrite("phase", { phase: "retrieving", question: q.question });

      const retrieved = await retrieveForJira({
        question: q.question,
        botConfig,
        knowledgeApiUrl: opts.config.knowledgeApiUrl,
        // `tracer.context` (traceId + the ROOT span id), so the retrieval's own
        // `research_knowledge` root hangs under this draft's root rather than
        // starting a second, orphaned trace.
        traceContext: tracer.context,
        ...(opts.retrieve ? { retrieve: opts.retrieve } : {}),
      });
      // Persist the WIDE set and the RETRIEVAL verdict, then apply the exclusion
      // for this generation. A first draft normally excludes nothing, but the
      // field is honoured either way so `/draft/start` + an immediate toggle
      // behaves like a regenerate — including in the verdict, which is why the
      // payload carries the derived one and the row carries what retrieval found.
      await saveJiraDraftRetrieval(draftId, retrieved.citations, retrieved.coverage, q.question);
      citations = applyExclusions(retrieved.citations, opts.excludeDocIds);
      retrievalCoverage = retrieved.coverage;
      coverage = effectiveCoverage(retrievalCoverage, citations.length);
      safeWrite("citations", { citations, coverage });
    }

    // Depth only ever narrows what reaches the PROMPT — the stored set (and PR 2's
    // toggle column) keeps its full width, which is why it does not resize when
    // the reader changes the dial.
    const promptCitations = sliceForDepth(citations, opts.depth);

    let fullDocs: JiraFullDoc[] = [];
    if (opts.depth === "full" && promptCitations.length > 0) {
      fullDocs = await (opts.fetchFullDocs ?? fetchFullDocuments)(
        promptCitations,
        opts.config.knowledgeApiUrl,
      );
    }

    const built = buildJiraUserPrompt({
      instruction: opts.instruction,
      depth: opts.depth,
      extra: opts.extra,
      citations: promptCitations,
      ...(fullDocs.length ? { fullDocs } : {}),
      notes: opts.notes,
    });
    if (built.trimmed) {
      log.info("jira prompt trimmed to fit JIRA_BODY_MAX bot={bot} used={used} of={of}", {
        bot: botConfig.name,
        used: built.citationsUsed,
        of: promptCitations.length,
      });
    }

    safeWrite("phase", { phase: "writing" });
    const result = await runFencedOneShot({
      traceName: "jira:draft",
      platform: "jira",
      kind: "capture",
      phase: "calling_claude",
      runName: `Jira ${opts.template} · ${opts.depth}`,
      sourcePage: "/jira",
      source: "jira-composer",
      prompt: built.prompt,
      systemPrompt: buildJiraSystemPrompt(),
      config: opts.config,
      botConfig: {
        ...botConfig,
        // The per-depth fence, in the CONNECTOR's dialect — `runFencedOneShot`
        // unions `FENCED_EXCLUDED_TOOLS` on top, so this is additive. See
        // `src/jira/tool-fence.ts` for why an allow-list ships inert here and why
        // the `Full` list is derived from the live probe rather than hardcoded.
        excludedTools: [
          ...new Set([
            ...(botConfig.excludedTools ?? []),
            ...buildDepthFence(opts.depth, botConfig.connector, opts.mcpServers),
          ]),
        ],
      },
      timeoutMs: JIRA_TIMEOUT_MS_BY_DEPTH[opts.depth],
      tracer,
      onProgress: (event) => {
        if (event.type === "text_delta") safeWrite("delta", { type: "delta", text: event.text });
      },
      ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
    });

    // Strip → `[n]` repair → `## Referanser` → both post-passes → land the row,
    // all in `src/jira/finalize.ts`: the thread-sourced draft runs the identical
    // tail, and every step in it is a defect this feature has shipped once.
    const finalized = await finalizeJiraDraft({
      draftId,
      raw: result.result ?? "",
      promptCitations,
      citationsUsed: built.citationsUsed,
      citations,
      notes: opts.notes,
      knowledgeApiUrl: opts.config.knowledgeApiUrl,
    });
    if (!finalized) {
      // An empty result is a FAILED generation, not an empty task. The row is
      // already marked failed; this path owns telling the attached client.
      log.warn("Jira draft returned nothing bot={bot} draft={draft}", { bot: botConfig.name, draft: draftId });
      safeWrite("app_error", { type: "error", message: JIRA_EMPTY_RESULT_MESSAGE });
      return;
    }
    const { markdown, keyVerdicts, markdownFlags } = finalized;

    log.info("Jira draft done bot={bot} draft={draft} depth={depth} chars={chars} cites={cites} unknownKeys={unknown}", {
      bot: botConfig.name,
      draft: draftId,
      depth: opts.depth,
      chars: markdown.length,
      cites: citations.length,
      unknown: keyVerdicts.filter((v) => v.state === "unknown").length,
    });

    const payload: JiraDonePayload = {
      draftId,
      markdown,
      citations,
      keyVerdicts,
      markdownFlags,
      coverage,
      retrievalCoverage,
      retrievalQuestion,
    };
    safeWrite("done", payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("Jira draft failed bot={bot} draft={draft} error={error}", {
      bot: botConfig.name,
      draft: draftId,
      error: message,
    });
    // The row is the record even on failure — PR 2 polls it and PR 3 opens it —
    // and it is read back through a CORS-OPEN `GET /api/jira/draft/:id`, so what
    // lands on it is a GENERIC sentence and the raw exception goes to the log
    // above. A connector timeout carries a stack-shaped string with local paths
    // and internal host:port pairs; the person who can act on that is reading the
    // logs, not the draft. The STREAM still carries the detail: it is the answer
    // to this caller's own POST, on a route with no CORS headers at all.
    if (draftId) {
      // A regenerate that fails must not leave THIS run's exclusion set beside the
      // PREVIOUS run's markdown: the view derives `coverage` from the exclusions,
      // so an all-excluded run that timed out read as `no_hits` over a task with
      // a full `## Referanser`. Restoring the set the stored markdown was written
      // under keeps the row self-consistent; a first draft has nothing to restore.
      await failJiraDraft(
        draftId,
        "Utkastet kunne ikke skrives ferdig. Se muninn-loggen for detaljer, og prøv igjen.",
        regenerate ? opts.storedExcludeDocIds : undefined,
      ).catch(() => {});
    }
    safeWrite("app_error", { type: "error", message: `Kunne ikke skrive saken: ${message}` });
  }
}

function buildQuestion(opts: JiraSseOptions): typeof buildJiraRetrievalQuestion {
  return opts.buildQuestion ?? buildJiraRetrievalQuestion;
}
