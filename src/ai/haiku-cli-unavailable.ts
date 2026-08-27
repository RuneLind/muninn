/**
 * The Claude CLI, refused on a profile that ships without it.
 *
 * `spawnHaiku` IS the Claude CLI subprocess, and the `nais` image is built
 * `--build-arg WITH_CLI=false`. A spawn there is an ENOENT — or, worse, a
 * `claude` on PATH with no credential, which sits there until
 * `HAIKU_TIMEOUT_MS` on every extractor call. Both shapes read as "the
 * assistant is slow" rather than "this pod has no model credential".
 *
 * ONE door: the refusal lives in `spawnHaiku` itself, so it covers the Haiku
 * ROUTER's fallback, a bot that ASKS for the CLI backend, and the direct callers
 * the router never sees (`src/watchers/{email,x,anthropic}.ts`).
 *
 * Its own module because both ends need it — `src/scheduler/executor.ts` throws
 * it and `src/ai/haiku-direct.ts` re-exports it — and importing one from the
 * other would be a cycle.
 */
import { resolveServingProfile } from "../config.ts";

/**
 * Why a call reached the CLI, when the caller knows. The Haiku router fills it
 * in with the backend it actually tried and the failure that sent it here — the
 * operator question the refusal has to answer is WHICH credential is missing
 * (`gh auth login` for Copilot, `ANTHROPIC_API_KEY` for the direct SDK), and a
 * bare "no CLI" would send them looking at the image instead.
 */
export interface HaikuCliFallback {
  readonly backend: string;
  readonly reason: string;
  readonly cause?: unknown;
}

export class HaikuCliUnavailableError extends Error {
  constructor(
    readonly backend: string,
    readonly botName: string,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      `Haiku backend "${backend}" is unavailable for ${botName} and this profile (MUNINN_PROFILE=nais) ` +
      `has no Claude CLI to fall back to: ${reason}`,
      options,
    );
    this.name = "HaikuCliUnavailableError";
  }
}

/** The profile is read at CALL time, like `isWikiReadonly()`: this sits below
 *  the config layer and a snapshot could only disagree with what the process
 *  actually is. */
export function assertHaikuCliAvailable(botName: string, fallback?: HaikuCliFallback): void {
  if (resolveServingProfile() !== "nais") return;
  throw new HaikuCliUnavailableError(
    fallback?.backend ?? "cli",
    botName,
    fallback?.reason ??
      "the resolved backend IS the Claude CLI (a bot's connector/haikuBackend, HAIKU_BACKEND, or a direct watcher call)",
    { cause: fallback?.cause },
  );
}
