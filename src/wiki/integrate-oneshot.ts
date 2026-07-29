/**
 * Observability + tool-fencing seam for the fact-check integrate one-shot.
 *
 * A thin identity wrapper over the shared `runFencedOneShot`
 * (`src/core/fenced-one-shot.ts`), which it shares with the source-page drafter:
 * it mints its own `factcheck-integrate` trace ROOT and a lightweight `/agents`
 * run of the already-registered `factcheck` kind, runs the model call through
 * `tracedOneShot` (which owns the `claude` CHILD span, never the root), and
 * finishes both in try/catch so a throw can't leak an unfinished trace or a run
 * stuck mid-phase. Bare `executeOneShot` is never called from this path.
 *
 * ── The tool fence is load-bearing ───────────────────────────────────────────
 * The proposed edits are delivered as the one-shot's RETURN TEXT, previewed by a
 * human and only then applied under CAS. A model that can reach `Write`/`Edit`
 * can satisfy the prompt by editing the page directly — bypassing the preview,
 * the CAS, the per-wiki queue, the log entry and the commit, all at once. So the
 * bot config is cloned with `FENCED_EXCLUDED_TOOLS` unioned onto its own
 * `excludedTools` (muninn #397's lesson: under `bypassPermissions` an empty
 * `allowedTools` means the FULL surface — only `excludedTools` binds). WebFetch /
 * WebSearch stay available; the prompt steers against using them, since every
 * source the edit list needs is already quoted in the verdict blocks.
 *
 * CAVEAT: the fence does NOT bind on `openai-compat` — that connector ignores
 * `excludedTools` entirely (the same caveat the drafter carries). It also exposes
 * no filesystem tools, so the practical exposure there is nil; the guarantee just
 * isn't enforced by this code.
 */

import type { Config } from "../config.ts";
import type { BotConfig } from "../bots/config.ts";
import type { ClaudeExecResult } from "../ai/executor.ts";
import type { executeOneShot } from "../ai/one-shot.ts";
import { runFencedOneShot } from "../core/fenced-one-shot.ts";
import { Tracer } from "../tracing/tracer.ts";
import { getLog } from "../logging.ts";

const log = getLog("wiki", "integrate");

/** Wall-clock budget for the integrate call — one structured-output turn over a
 *  capped body, with no tool excursions expected. */
export const INTEGRATE_TIMEOUT_MS = 90_000;

export interface IntegrateOneShotOptions {
  /** Page title — the trace subject + `/agents` card name. */
  pageTitle: string;
  wikiName: string;
  prompt: string;
  systemPrompt: string;
  config: Config;
  botConfig: BotConfig;
  /** Test seams — production callers pass neither. */
  oneShot?: typeof executeOneShot;
  tracer?: Tracer;
}

/**
 * Run the integrate model call with a trace root + `/agents` run attached and the
 * file-writing tools fenced off. Fail-soft by construction: the trace is stamped
 * `error`, the run completed, and the error re-thrown so the route's own handling
 * is unchanged.
 */
export async function runIntegrateOneShot(opts: IntegrateOneShotOptions): Promise<ClaudeExecResult> {
  const { pageTitle, wikiName } = opts;
  const name = `Fact-check integrate: ${pageTitle}`;

  return runFencedOneShot({
    traceName: "factcheck-integrate",
    platform: "factcheck",
    kind: "factcheck",
    phase: "calling_claude",
    runName: name.length > 60 ? `${name.slice(0, 57)}…` : name,
    sourcePage: "/wiki",
    source: "factcheck-integrate",
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt,
    config: opts.config,
    botConfig: opts.botConfig,
    timeoutMs: INTEGRATE_TIMEOUT_MS,
    startAttrs: { wiki: wikiName, title: pageTitle },
    onError: (message) =>
      log.warn("Fact-check integrate one-shot failed for {title}: {error}", {
        title: pageTitle,
        error: message,
      }),
    ...(opts.oneShot ? { oneShot: opts.oneShot } : {}),
    ...(opts.tracer ? { tracer: opts.tracer } : {}),
  });
}
