import { callHaikuWithFallback } from "./haiku-direct.ts";
import { extractJson } from "./json-extract.ts";
import { getLog } from "../logging.ts";

const log = getLog("ai", "knowledge-decomposer");

export interface DecomposeOptions {
  question: string;
  botName: string;
  botDir?: string;
}

export interface DecomposeResult {
  /** 1 entry = passthrough (no decomposition needed). 2–4 entries = fan-out. */
  subQuestions: string[];
  rationale: string;
  /** Wall time of the Haiku call (ms) — useful for tracing. */
  haikuMs: number;
  /** True when the model decided this is a passthrough, false when it fanned out. */
  passthrough: boolean;
}

const MIN_SUB_QUESTIONS = 1;
const MAX_SUB_QUESTIONS = 4;

const DECOMPOSE_PROMPT = `You decompose a single user question into the smallest set of focused sub-questions needed to answer it well.

Rules:
- Return 1 sub-question when the input is a simple lookup (one topic, one fact). This is the cheap path — prefer it.
- Return 2–4 sub-questions only when the input asks for a comparison, has distinct parts ("X and Y"), or chains facts across topics.
- Never return 0 or more than 4. If you would, return 1 with the original question verbatim.
- Each sub-question stands alone: a downstream knowledge-base search must be able to answer it without the others.
- Keep sub-questions tight — they will be sent to a retrieval service, not back to a person.

Respond with ONLY valid JSON (no markdown fences, no commentary):
{"subQuestions": ["..."], "rationale": "short reason for the choice"}

Examples:

Input: "What is BUC 02?"
Output: {"subQuestions": ["What is BUC 02?"], "rationale": "Single lookup."}

Input: "How does A001 differ from A002, and what triggers each?"
Output: {"subQuestions": ["What is A001 and what triggers it?", "What is A002 and what triggers it?", "Concrete differences between A001 and A002"], "rationale": "Comparison plus trigger conditions — three focused queries serve this better than one."}

Question to decompose:
"""
{QUESTION}
"""`;

interface RawResult {
  subQuestions?: unknown;
  rationale?: unknown;
}

export async function decomposeQuestion(opts: DecomposeOptions): Promise<DecomposeResult> {
  const { question, botName, botDir } = opts;
  const prompt = DECOMPOSE_PROMPT.replace("{QUESTION}", question);

  const t0 = performance.now();
  let raw: string;
  try {
    const haiku = await callHaikuWithFallback(prompt, {
      source: "knowledge-decompose",
      entrypoint: "knowledge-decomposer",
      cwd: botDir,
      botName,
    });
    raw = haiku.result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("decompose_haiku_failed botName={botName} error={error} — falling back to passthrough", { botName, error: message });
    return passthrough(question, "haiku call failed", performance.now() - t0);
  }
  const haikuMs = performance.now() - t0;

  let parsed: RawResult;
  try {
    parsed = extractJson<RawResult>(raw);
  } catch {
    log.warn("decompose_parse_failed botName={botName} raw={raw} — falling back to passthrough", { botName, raw: raw.slice(0, 200) });
    return passthrough(question, "could not parse decomposer response", haikuMs);
  }

  return normalize(parsed, question, haikuMs);
}

export function normalize(raw: RawResult, originalQuestion: string, haikuMs: number): DecomposeResult {
  const rationaleRaw = typeof raw.rationale === "string" ? raw.rationale.trim() : "";

  if (!Array.isArray(raw.subQuestions)) {
    return passthrough(originalQuestion, rationaleRaw || "decomposer omitted subQuestions", haikuMs);
  }

  const cleaned: string[] = [];
  for (const item of raw.subQuestions) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    cleaned.push(trimmed);
  }

  if (cleaned.length < MIN_SUB_QUESTIONS) {
    return passthrough(originalQuestion, rationaleRaw || "decomposer returned no usable sub-questions", haikuMs);
  }

  const clamped = cleaned.slice(0, MAX_SUB_QUESTIONS);
  const subQuestions = clamped.length === 1 ? [clamped[0]!] : clamped;

  return {
    subQuestions,
    rationale: rationaleRaw || (subQuestions.length === 1 ? "single sub-question" : `${subQuestions.length} sub-questions`),
    haikuMs,
    passthrough: subQuestions.length === 1,
  };
}

function passthrough(question: string, rationale: string, haikuMs: number): DecomposeResult {
  return {
    subQuestions: [question],
    rationale,
    haikuMs,
    passthrough: true,
  };
}
