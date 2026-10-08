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
 * cached, so a later scan retries it, and is logged once per distinct error.
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
  | { status: "refused"; reasons: string[] }
  | { status: "unavailable"; error: string };

type ScanFn = (text: string) => unknown;

const loaded = new Map<string, Promise<ScanFn>>();
/** Distinct load/scan errors already logged. Bounded: a scanner whose error
 *  text varies per call must not grow it without limit. */
const logged = new Set<string>();
const LOGGED_MAX = 64;

function logOnce(key: string, message: string): void {
  if (logged.has(key)) return;
  if (logged.size >= LOGGED_MAX) return;
  logged.add(key);
  log.error(message);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

/**
 * Scan one answer body with the module at `modulePath`. A blank or relative
 * path is `unavailable`; deciding whether an unset scanner is acceptable is
 * the caller's (see {@link scannerRequired}).
 */
export async function scanAnswerText(modulePath: string, text: string): Promise<ScanOutcome> {
  if (!modulePath.trim() || !isAbsolute(modulePath)) {
    logOnce(`path:${modulePath}`, `WIKI_ANSWER_SCANNER is not an absolute path: "${modulePath}"`);
    return { status: "unavailable", error: "WIKI_ANSWER_SCANNER is not an absolute path" };
  }
  let scan: ScanFn;
  try {
    scan = await loadScanner(modulePath);
  } catch (e) {
    logOnce(`load:${modulePath}:${errText(e)}`, `answer scanner ${modulePath} failed to load: ${errText(e)}`);
    return { status: "unavailable", error: "the answer scanner could not be loaded" };
  }
  let result: unknown;
  try {
    result = await scan(text);
  } catch (e) {
    logOnce(`throw:${modulePath}:${errText(e)}`, `answer scanner ${modulePath} threw: ${errText(e)}`);
    return { status: "unavailable", error: "the answer scanner failed" };
  }
  if (!Array.isArray(result) || !result.every((f) => f && typeof f === "object" && typeof f.reason === "string")) {
    logOnce(`shape:${modulePath}`, `answer scanner ${modulePath} returned something other than [{reason}]`);
    return { status: "unavailable", error: "the answer scanner returned an unexpected result" };
  }
  if (result.length === 0) return { status: "clean" };
  return { status: "refused", reasons: result.map((f: { reason: string }) => f.reason) };
}

/** Does this profile refuse an answer body when no scanner is configured?
 *  `nais` does; `default` scans only when the variable is set. */
export function scannerRequired(profile: MuninnProfile): boolean {
  return profile === "nais";
}

/** Test seam: forget every loaded module and logged error. */
export function __resetAnswerScannerForTest(): void {
  loaded.clear();
  logged.clear();
}
