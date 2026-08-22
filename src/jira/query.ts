/**
 * Notes → ONE bounded retrieval question.
 *
 * **Why this module exists at all.** `researchKnowledge` runs `decomposeQuestion`,
 * a Haiku prompt tuned on *"What is BUC 02?"*-shaped input whose documented
 * failure mode is PASSTHROUGH of the original string — straight into a `?q=` URL
 * parameter (`buildSearchPath` in `research-knowledge.ts`). A 10 KB pasted Slack
 * thread cannot go in raw: it would be passed through as one enormous query
 * string, and huginn would embed a meeting transcript as if it were a question.
 *
 * **Why ONE question, not a list.** `ResearchKnowledgeOptions` accepts a single
 * `question: string` and has no seam for caller-supplied sub-questions, and
 * `decomposeQuestion` already fans out to up to four. Emitting a list would mean
 * either re-joining it for the decomposer to re-split (a second Haiku call, with
 * the passthrough hazard still live) or adding a bypass parameter to
 * `src/ai/research-knowledge.ts`, which this PR does not touch. So: one rich
 * multi-part question, handed to the decomposer that already knows how to split.
 *
 * `buildRetrievalQuestion` in `research/answer.ts` is a SHAPE reference only — it
 * is deterministic string interpolation over prior turns, not a model call.
 *
 * Fail-soft by construction: a Haiku failure, an empty answer or a model that
 * echoes the notes back all degrade to the deterministic
 * {@link fallbackRetrievalQuestion}, so retrieval always runs on something bounded.
 */

import { callHaikuWithFallback, type HaikuBackend } from "../ai/haiku-direct.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { Tracer } from "../tracing/index.ts";
import { getLog } from "../logging.ts";

const log = getLog("jira", "query");

/**
 * Hard cap on the emitted question (chars).
 *
 * It becomes a `?q=` URL parameter on up to four huginn searches, and it is an
 * EMBEDDING input — past a couple of hundred characters a semantic query stops
 * being a query and starts being a document. 400 leaves room for a genuinely
 * multi-part question ("Hvordan beregnes trygdeavgift ved årsavregning, og
 * hvilke tjenester berøres av …") without approaching either limit.
 *
 * `JIRA_BODY_MAX` bounds the GENERATION prompt; it does not bound this.
 */
export const JIRA_QUERY_MAX = 400;

/** Chars of the raw notes handed to the condenser. The condensing call is a cheap
 *  Haiku one and does not need the whole thread to name what it is about. */
export const JIRA_QUERY_NOTES_MAX = 8_000;

export interface BuildJiraQueryOptions {
  notes: string;
  botName: string;
  connector?: ConnectorType;
  haikuBackend?: HaikuBackend;
  /** Threaded into the Haiku router so the `haiku_usage` row ties back to the
   *  draft's trace — NULL without it (the `knowledge-decompose` precedent). */
  tracer?: Tracer;
  /** Test seam — production callers omit it. */
  haiku?: typeof callHaikuWithFallback;
}

export interface JiraQueryResult {
  question: string;
  /** True when the Haiku call failed/was unusable and the fallback was used. */
  degraded: boolean;
  haikuMs: number;
}

/**
 * The condenser prompt. Asks for ONE question and nothing else — no JSON, no
 * preamble — because the parse is `trim()` and anything else is noise we would
 * have to strip. The instruction to keep domain nouns verbatim is load-bearing:
 * the corpus is Norwegian NAV/Melosys vocabulary (lovvalg, trygdeavtale, BUC/SED)
 * and a translated or paraphrased query retrieves nothing.
 */
export function buildQueryPrompt(notes: string): string {
  return `Nedenfor står råmateriale fra en refinement — et møtereferat, en Slack-tråd eller løse notater.

Skriv ETT søkespørsmål som henter fram den bakgrunnen man trenger for å skrive en god Jira-sak av dette: tidligere saker om samme tema, dokumentasjonen for det som endres, og de sentrale domenebegrepene.

Krav:
- Nøyaktig ett spørsmål, på norsk, høyst ${JIRA_QUERY_MAX} tegn.
- Behold domeneord, tjenestenavn, klassenavn og saksnumre ORDRETT slik de står i råmaterialet.
- Spørsmålet skal dekke flere sider av saken i én setning — det brytes automatisk opp i delspørsmål etterpå.
- Svar med spørsmålet alene. Ingen innledning, ingen anførselstegn, ingen forklaring.

RÅMATERIALE:
"""
${notes}
"""`;
}

/**
 * Deterministic fallback: the first ~400 characters of the notes, whitespace
 * collapsed.
 *
 * Not a great question — but it is BOUNDED, which is the property that matters:
 * the failure this module exists to prevent is a 10 KB URL parameter, and this
 * cannot produce one. Exported so the tests can assert the degrade path lands
 * here rather than on the raw notes.
 */
export function fallbackRetrievalQuestion(notes: string): string {
  const flat = notes.replace(/\s+/g, " ").trim();
  return flat.length <= JIRA_QUERY_MAX ? flat : `${flat.slice(0, JIRA_QUERY_MAX - 1)}…`;
}

/**
 * Strip the shapes a model reaches for even when told not to: surrounding
 * quotes, a leading "Spørsmål:" label, a markdown bullet. Then clamp.
 *
 * The clamp is a hard slice rather than a rejection: an over-long question is
 * still a usable query, and rejecting it would drop us to the (worse) fallback.
 */
export function normalizeRetrievalQuestion(raw: string): string {
  let q = raw.trim();
  // Only the FIRST line — a model that adds a rationale puts it on line 2+.
  q = q.split(/\r?\n/, 1)[0]!.trim();
  q = q.replace(/^[-*+]\s+/, "");
  q = q.replace(/^(?:spørsmål|question|søk|query)\s*:\s*/i, "");
  q = q.replace(/^["'«»]+/, "").replace(/["'«»]+$/, "");
  q = q.replace(/\s+/g, " ").trim();
  return q.length <= JIRA_QUERY_MAX ? q : `${q.slice(0, JIRA_QUERY_MAX - 1)}…`;
}

/** Condense the notes into one bounded retrieval question. Never throws. */
export async function buildJiraRetrievalQuestion(
  opts: BuildJiraQueryOptions,
): Promise<JiraQueryResult> {
  const notes = opts.notes.length > JIRA_QUERY_NOTES_MAX
    ? opts.notes.slice(0, JIRA_QUERY_NOTES_MAX)
    : opts.notes;
  const fallback = fallbackRetrievalQuestion(opts.notes);
  const haiku = opts.haiku ?? callHaikuWithFallback;
  const t0 = performance.now();

  let raw: string;
  try {
    const res = await haiku(buildQueryPrompt(notes), {
      source: "jira-query",
      entrypoint: "jira-composer",
      botName: opts.botName,
      ...(opts.connector ? { connector: opts.connector } : {}),
      ...(opts.haikuBackend ? { haikuBackend: opts.haikuBackend } : {}),
      ...(opts.tracer ? { tracer: opts.tracer } : {}),
    });
    raw = res.result;
  } catch (err) {
    log.warn("jira_query_haiku_failed bot={bot} error={error} — falling back to a clipped note", {
      bot: opts.botName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { question: fallback, degraded: true, haikuMs: performance.now() - t0 };
  }

  const haikuMs = performance.now() - t0;
  const question = normalizeRetrievalQuestion(raw);
  // An empty answer, or one that is just the notes echoed back (the decomposer's
  // own passthrough failure, one layer up), is not a condensation.
  if (!question || question.length > JIRA_QUERY_MAX) {
    log.warn("jira_query_unusable bot={bot} len={len} — falling back", { bot: opts.botName, len: question.length });
    return { question: fallback, degraded: true, haikuMs };
  }
  return { question, degraded: false, haikuMs };
}
