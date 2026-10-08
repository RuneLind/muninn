/**
 * The answer scanner hook (answer cards D16): `WIKI_ANSWER_SCANNER` names a
 * module, and its `scanAnswer(text)` judges an answer body before it is stored.
 *
 * The module ships from the NAV deploy repo into the pod image; muninn only
 * loads it. The contract, which that repo builds against:
 *
 *   export function scanAnswer(text: string):
 *     Array<{ reason: string }> | Promise<Array<{ reason: string }>>
 *
 * An empty array is clean. Anything else that is not an array of `{reason}`
 * objects — a missing export, a throw, a non-array — is `unavailable`, never
 * clean: the caller fails closed.
 *
 * The module is imported once per path and cached. A failed load is not
 * cached, so a later scan retries it. Failures are logged at most once a
 * minute per kind and path, and a scanner's thrown message is never logged:
 * it may quote the answer, and the pod's log is shared.
 * Dependency-free apart from the logger, so a smoke script can import it with
 * a path argument.
 */
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { getLog } from "../logging.ts";
import type { MuninnProfile } from "../config.ts";

const log = getLog("wiki", "answer-scanner");

export type ScanOutcome =
  | { status: "clean" }
  | { status: "refused"; reasons: string[]; omitted?: number }
  | { status: "unavailable"; error: string };

type ScanFn = (text: string) => unknown;

/** How long one scan may take. A scanner is a regex pass over 8000
 *  characters; past this it is hung, and the POST must not hang with it. */
export const ANSWER_SCAN_TIMEOUT_MS = 5_000;
/** The most reasons a refusal carries, and the longest one (code points): a
 *  scanner's output becomes a response body and a line in the card. */
export const ANSWER_SCAN_REASONS_MAX = 20;
export const ANSWER_SCAN_REASON_CHARS = 300;
/** At most one log line per category (load / throw / shape, per path) per window. */
const LOG_WINDOW_MS = 60_000;

const loaded = new Map<string, Promise<ScanFn>>();
const lastLogged = new Map<string, number>();

type LogKind = "path" | "load" | "throw" | "shape" | "timeout";

/** Constant templates only: LogTape reads `{…}` in a message as a property,
 *  so text interpolated into one loses its braces. */
const TEMPLATES: Record<LogKind, string> = {
  path: "WIKI_ANSWER_SCANNER is not an absolute path: {path}",
  load: "answer scanner {path} failed to load: {error}",
  throw: "answer scanner {path} threw a {errorName}",
  shape: "answer scanner {path} returned something other than a list of reason objects",
  timeout: "answer scanner {path} did not answer within {timeoutMs} ms",
};

function logLimited(kind: LogKind, path: string, now: number, props: Record<string, unknown> = {}): void {
  const key = `${kind}|${path}`;
  const last = lastLogged.get(key);
  if (last !== undefined && now - last < LOG_WINDOW_MS) return;
  lastLogged.set(key, now);
  log.error(TEMPLATES[kind], { path, ...props });
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** A thrown value's class, never its message: the message may quote the answer. */
const errName = (e: unknown) => (e instanceof Error ? e.name : typeof e);

async function loadScanner(modulePath: string): Promise<ScanFn> {
  let pending = loaded.get(modulePath);
  if (!pending) {
    pending = import(pathToFileURL(modulePath).href).then((mod: Record<string, unknown>) => {
      if (typeof mod.scanAnswer !== "function") throw new Error("the module has no scanAnswer export");
      return mod.scanAnswer as ScanFn;
    });
    loaded.set(modulePath, pending);
    // A failed load is forgotten, so the next scan tries again.
    pending.catch(() => loaded.delete(modulePath));
  }
  return pending;
}

const clip = (s: string) => {
  const cps = [...s];
  return cps.length <= ANSWER_SCAN_REASON_CHARS ? s : `${cps.slice(0, ANSWER_SCAN_REASON_CHARS - 1).join("")}…`;
};

/** `[{reason: string}, …]` with no holes, or null. An index loop, since
 *  `every` skips the holes of a sparse array. */
function reasonsOf(result: unknown): string[] | null {
  if (!Array.isArray(result)) return null;
  const out: string[] = [];
  for (let i = 0; i < result.length; i++) {
    const f = result[i] as unknown; // a hole reads undefined: malformed
    if (!f || typeof f !== "object" || typeof (f as { reason?: unknown }).reason !== "string") return null;
    out.push((f as { reason: string }).reason);
  }
  return out;
}

export interface ScanOptions {
  /** Default {@link ANSWER_SCAN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** The log rate limit's clock. Default `Date.now`. */
  now?: () => number;
}

/**
 * Scan one answer body with the module at `modulePath`. A blank or relative
 * path is `unavailable`; deciding whether an unset scanner is acceptable is
 * the caller's (see {@link scannerRequired}). A scan that has not settled
 * within the timeout is `unavailable` too; a SYNCHRONOUS infinite loop in the
 * scanner blocks the event loop and cannot be bounded from inside the process.
 */
export async function scanAnswerText(modulePath: string, text: string, opts: ScanOptions = {}): Promise<ScanOutcome> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? ANSWER_SCAN_TIMEOUT_MS;
  if (!modulePath.trim() || !isAbsolute(modulePath)) {
    logLimited("path", modulePath, now());
    return { status: "unavailable", error: "WIKI_ANSWER_SCANNER is not an absolute path" };
  }
  let scan: ScanFn;
  try {
    scan = await loadScanner(modulePath);
  } catch (e) {
    // A load error is about module code, not answer text: its message is kept.
    logLimited("load", modulePath, now(), { error: errText(e) });
    return { status: "unavailable", error: "the answer scanner could not be loaded" };
  }
  let result: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("timeout");
  try {
    result = await Promise.race([
      Promise.resolve().then(() => scan(text)),
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), timeoutMs);
      }),
    ]);
  } catch (e) {
    logLimited("throw", modulePath, now(), { errorName: errName(e) });
    return { status: "unavailable", error: "the answer scanner failed" };
  } finally {
    clearTimeout(timer);
  }
  if (result === timedOut) {
    logLimited("timeout", modulePath, now(), { timeoutMs });
    return { status: "unavailable", error: "the answer scanner did not answer in time" };
  }
  const reasons = reasonsOf(result);
  if (!reasons) {
    logLimited("shape", modulePath, now());
    return { status: "unavailable", error: "the answer scanner returned an unexpected result" };
  }
  if (reasons.length === 0) return { status: "clean" };
  const omitted = reasons.length - ANSWER_SCAN_REASONS_MAX;
  return {
    status: "refused",
    reasons: reasons.slice(0, ANSWER_SCAN_REASONS_MAX).map(clip),
    ...(omitted > 0 ? { omitted } : {}),
  };
}

/** Does this profile refuse an answer body when no scanner is configured?
 *  `nais` does; `default` scans only when the variable is set. */
export function scannerRequired(profile: MuninnProfile): boolean {
  return profile === "nais";
}

/** Test seam: forget every loaded module and logged error. */
export function __resetAnswerScannerForTest(): void {
  loaded.clear();
  lastLogged.clear();
}
