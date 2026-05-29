import { getLog } from "../logging.ts";
import { callHaikuWithFallback } from "../ai/haiku-direct.ts";
import type { HaikuBackend } from "../ai/haiku-direct.ts";
import type { ConnectorType } from "../bots/config.ts";
import type { ReengageContext } from "./devloop-prompts.ts";
import { fillTemplate } from "../utils/fill-template.ts";

const log = getLog("hivemind", "devloop-classifier");

/**
 * Build-vs-test routing for the Phase 6b re-engage (the documented follow-up to
 * the always-build first cut). On a red e2e the run can be re-opened toward
 * either agent: the BUILD agent (the feature code is wrong — the common case) or
 * the TEST agent (the e2e/spec itself is wrong — stale selector, outdated
 * assertion, test data, or a spec that drifted). A small Haiku call on the e2e
 * agent's failure report makes the call. Only consulted when the bot opts into
 * `hivemind.devLoop.reengageClassifier`; every miss/error/ambiguity degrades to
 * "build" so enabling the classifier can only refine, never strand, the verified
 * always-build behaviour.
 */
export type ReengageRole = "build" | "test";

export interface ClassifyOptions {
  botName: string;
  /** Bot dir = cwd for the Haiku call (CLI/Copilot auth + MCP discovery). */
  botDir: string;
  connector?: ConnectorType;
  haikuBackend?: HaikuBackend;
}

/** Injectable Haiku caller (defaults to the real router). Tests pass a stub so
 *  they never hit a live backend. Shape matches `callHaikuWithFallback`. */
export type HaikuCaller = typeof callHaikuWithFallback;

const CLASSIFY_PROMPT = `You are triaging a failed cross-repo end-to-end (e2e) test run in a software dev loop.
Decide whether the failure should be fixed by the BUILD agent or the TEST agent:
- "build" = the FEATURE CODE is wrong or missing — a real application bug the e2e correctly caught.
- "test" = the TEST/SPEC is wrong — a stale selector, an outdated or incorrect assertion, bad test data, a flaky/environment issue, or a spec that drifted from the implemented behaviour. The feature code is fine.

When genuinely unsure, answer "build": re-running the build agent on a test problem only wastes a cycle, but re-running the test agent on a real bug would hide it.

Failed CI run: {CI}

What the e2e agent reported:
{REPORT}

Reply with EXACTLY one lowercase word and nothing else: build or test`;

/**
 * Classify a red e2e as a BUILD problem (feature code) or a TEST problem
 * (spec/test drift). Returns "build" — the safe default — whenever there is no
 * usable failure report, the Haiku call errors, or the verdict is ambiguous.
 */
export async function classifyReengageRole(
  ctx: ReengageContext,
  opts: ClassifyOptions,
  callHaiku: HaikuCaller = callHaikuWithFallback,
): Promise<ReengageRole> {
  const report = ctx.orchestrateMessage?.trim();
  // No signal to classify on → don't burn a Haiku call; default build.
  if (!report) {
    log.debug("reengage classifier: no e2e report for {bot}, defaulting to build", { botName: opts.botName });
    return "build";
  }
  // fillTemplate uses function replacers so `$`-patterns in the raw e2e report
  // ($&, $`, $$ …) are inserted literally instead of mangling the prompt.
  const prompt = fillTemplate(CLASSIFY_PROMPT, {
    CI: ctx.ciUrl ?? "(not reported)",
    REPORT: report,
  });
  try {
    const haiku = await callHaiku(prompt, {
      source: "devloop-reengage-classify",
      entrypoint: "devloop-classifier",
      cwd: opts.botDir,
      botName: opts.botName,
      connector: opts.connector,
      haikuBackend: opts.haikuBackend,
    });
    return parseRole(haiku.result, opts.botName);
  } catch (err) {
    log.warn("reengage classifier failed for {bot}, defaulting to build: {error}", {
      botName: opts.botName, error: err instanceof Error ? err.message : String(err),
    });
    return "build";
  }
}

/**
 * Parse a Haiku verdict into a role. The prompt demands EXACTLY one lowercase
 * word, so we accept only a clean one-word "build"/"test" (tolerating surrounding
 * whitespace/punctuation/quotes). ANYTHING else — prose, a negation like "not a
 * test issue", an empty string — defaults to "build" (the safe route). This is
 * deliberately strict: a tolerant "contains \btest\b" parse would mis-route a
 * negated mention ("this is NOT a test problem") to the test agent, the unsafe
 * direction; routing uncertainty to build only ever wastes a capped cycle.
 */
export function parseRole(raw: string, botName?: string): ReengageRole {
  // Trim, lowercase, then strip leading/trailing non-letters ("test." → "test",
  // "**build**" → "build"); internal non-letters survive, so prose stays multi-token.
  const t = (raw ?? "").trim().toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (t === "test") return "test";
  if (t === "build") return "build";
  log.debug("reengage classifier verdict not a clean build/test answer, defaulting to build: {raw}", {
    botName, raw: (raw ?? "").slice(0, 120),
  });
  return "build";
}
