import { resolve } from "node:path";
import { getLog } from "../logging.ts";
import {
  type DevRun,
  getDevRunByThreadId,
  getDevRunsByIdPrefix,
  listHandoffs,
  updateHandoffStatus,
  updateDevRun,
  computeRunStatus,
  TERMINAL_RUN_STATUSES,
} from "../db/dev-runs.ts";
import {
  fetchCiConclusion,
  isConfirmedGreen,
  parseGithubRunUrl,
  type CiConclusion,
} from "./ci-conclusion.ts";

const log = getLog("hivemind", "handoff-interpreter");

/**
 * Phase 4 inbound interpreter — turns a peer's handoff reply into dev_run state.
 * Runs OFF the delivery path (fire-and-forget in router.route, after the message
 * is persisted/broadcast), so a parse failure never blocks inbound delivery.
 *
 * Pipeline: parse the `<!-- status/e2e: … run:<id> -->` marker → resolve the
 * dev_run by 8-hex prefix (handling >1 collision) → update the role's handoff on
 * (run_id, peer_name) → recompute + persist dev_run.status. On a green orchestrate
 * verdict it VERIFIES the GitHub CI conclusion before flipping the spec to
 * `verified` — the one assertion humans downstream trust at face value.
 *
 * v1 PARKS at ready_to_verify (build ∧ test done): the dependency gate is reached
 * in the inbound router where there's no active turn, so the orchestrate confirm
 * renders off dev_run.status on the user's next chat turn (auto-fire is v2).
 */

export type HandoffVerdict = "done" | "failed" | "green" | "red";

export interface ParsedMarker {
  verdict: HandoffVerdict;
  /** The 8-hex (give or take) run-id prefix the peer echoed from delegate_task. */
  runIdPrefix: string;
}

// `<!-- status: done run:ab12cd34 -->` (build/test/review) or
// `<!-- e2e: green run:ab12cd34 -->` (orchestrate). Tolerant of whitespace, case,
// and an id slightly off the 8-hex norm (autonomous peers occasionally pad/trim).
const MARKER_RE =
  /<!--\s*(?:status:\s*(done|failed)|e2e:\s*(green|red))\s+run:([0-9a-f]{4,32})\s*-->/gi;

/**
 * Parse the LAST handoff marker in a reply (the final verdict wins if a peer
 * quotes an earlier one). Returns null when there's no marker — the common case
 * for ordinary peer chatter, which the interpreter then ignores.
 */
export function parseHandoffMarker(text: string): ParsedMarker | null {
  let last: RegExpExecArray | null = null;
  MARKER_RE.lastIndex = 0;
  for (let m = MARKER_RE.exec(text); m; m = MARKER_RE.exec(text)) last = m;
  if (!last) return null;
  const verdict = (last[1] ?? last[2])!.toLowerCase() as HandoffVerdict;
  return { verdict, runIdPrefix: last[3]!.toLowerCase() };
}

/** Map a marker verdict to the handoff status enum (`done`/`failed`). green→done,
 *  red→failed — the run-level green/red distinction is recomputed from roles. */
export function verdictToHandoffStatus(v: HandoffVerdict): "done" | "failed" {
  return v === "done" || v === "green" ? "done" : "failed";
}

/**
 * Resolve the dev_run a marker refers to. The 8-hex prefix is only 32 bits, so
 * it can collide; the routed thread (which the router already resolved via the
 * correlation token, then the (bot,peer) fallback) disambiguates:
 *   1. prefix → exactly one run: use it.
 *   2. prefix → several runs: prefer the one whose thread_id is the routed thread
 *      (the token/fallback already picked the right conversation); else the
 *      most-recently-updated OPEN run; else the most-recently-updated overall.
 *   3. prefix → no runs (or no prefix at all): fall back to the routed thread's run.
 */
export async function resolveRun(args: {
  runIdPrefix?: string;
  routedThreadId?: string;
}): Promise<DevRun | null> {
  const { runIdPrefix, routedThreadId } = args;

  if (runIdPrefix) {
    const matches = await getDevRunsByIdPrefix(runIdPrefix);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      if (routedThreadId) {
        const onThread = matches.find((r) => r.threadId === routedThreadId);
        if (onThread) return onThread;
      }
      // matches are ordered most-recently-updated first.
      const open = matches.find((r) => !TERMINAL_RUN_STATUSES.has(r.status));
      const chosen = open ?? matches[0]!;
      log.warn(
        "run:{prefix} matched {n} dev_runs (8-hex collision) — picked {id} ({how})",
        { prefix: runIdPrefix, n: matches.length, id: chosen.id, how: open ? "newest open" : "newest" },
      );
      return chosen;
    }
  }

  // No prefix, or prefix matched nothing: the routed thread is the fallback join
  // (it already encodes the correlation token + (bot,peer) resolution).
  if (routedThreadId) return getDevRunByThreadId(routedThreadId);
  return null;
}

/** What the interpreter did with one inbound reply — for logging + tests. */
export interface InterpretResult {
  /** A handoff marker was found in the reply. */
  matched: boolean;
  runId?: string;
  /** Roles whose handoff rows were updated (the (run_id, peer_name) join). */
  rolesUpdated?: string[];
  /** dev_run.status after recompute, persisted. */
  runStatus?: string;
  /** Spec frontmatter flipped to `verified` (CI-confirmed green). */
  verified?: boolean;
  /** The CI conclusion fetched when a green verdict arrived (null if unfetchable). */
  ci?: CiConclusion | null;
  note?: string;
}

export interface InterpretDeps {
  /** Resolve a bot's directory so the spec path (relative) can be made absolute
   *  for the verified-flip. Missing → flip skipped (status still persists). */
  getBotDir?: (botName: string) => string | undefined;
  /** Injection seams for tests. Default to the real CI fetch + file flip.
   *  `fetchCi` receives the reply text containing the CI URL (the URL is parsed
   *  out of it), matching `fetchCiConclusion`'s contract. */
  fetchCi?: (replyTextWithCiUrl: string) => Promise<CiConclusion | null>;
  flipSpec?: (absSpecPath: string) => Promise<boolean>;
}

/**
 * Interpret one peer reply. Returns immediately (matched:false) when there's no
 * marker — most inbound peer messages. Side effects: handoff status update,
 * dev_run.status persist, and (CI-confirmed) the spec verified-flip.
 */
export async function interpretHandoffReply(args: {
  botName: string;
  peerName: string;
  text: string;
  routedThreadId?: string;
  deps?: InterpretDeps;
}): Promise<InterpretResult> {
  const marker = parseHandoffMarker(args.text);
  if (!marker) return { matched: false };

  const run = await resolveRun({ runIdPrefix: marker.runIdPrefix, routedThreadId: args.routedThreadId });
  if (!run) {
    log.warn("Handoff marker run:{prefix} from {peer} resolved no dev_run — ignoring", {
      botName: args.botName, peer: args.peerName, prefix: marker.runIdPrefix,
    });
    return { matched: true, note: "no dev_run for marker" };
  }

  // The run is finished — a late, duplicate, or flapping marker (e.g. a retry that
  // reports `failed` after a green) must NOT reopen it. Without this, a stray reply
  // could clobber a terminal green back to red. (Re-engaging a red run is v2.)
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    log.debug("Handoff reply for already-terminal run {run} ({status}) — ignoring", {
      botName: args.botName, run: run.id, status: run.status,
    });
    return { matched: true, runId: run.id, runStatus: run.status, note: "run already terminal" };
  }

  const handoffStatus = verdictToHandoffStatus(marker.verdict);
  const updated = await updateHandoffStatus({
    runId: run.id,
    peerName: args.peerName,
    status: handoffStatus,
    lastMessage: args.text.slice(0, 2000),
  });
  if (updated === 0) {
    log.warn(
      "Handoff reply for run {run} from peer_name '{peer}' matched no handoff row " +
        "((run_id, peer_name) join missed — peer_name drift?). Run won't roll up.",
      { botName: args.botName, run: run.id, peer: args.peerName },
    );
    return { matched: true, runId: run.id, note: "no handoff row for (run, peer_name)" };
  }

  // Which roles did we just close? (One peer usually has one role per run.)
  const handoffs = await listHandoffs(run.id);
  const rolesUpdated = handoffs.filter((h) => h.peerName === args.peerName).map((h) => h.role);

  let runStatus = await computeRunStatus(run.id);
  let verified = false;
  let ci: CiConclusion | null | undefined;

  // Green gate — verify, don't trust. Trigger on the run REACHING green (build ∧
  // test ∧ orchestrate all done), NOT on this reply's verdict: handoffs arrive in
  // any order, so the reply that tips the run to green is often a plain
  // `status: done` from build/test landing AFTER the orchestrate `e2e: green`.
  // Gating on `verdict === "green"` would let that later reply persist a terminal
  // green with no CI check. The CI URL comes from this reply or, if it's not the
  // orchestrate one, the orchestrate handoff's stored reply (last_message).
  if (runStatus === "green") {
    const fetchCi = args.deps?.fetchCi ?? fetchCiConclusion;
    const orchTexts = handoffs.filter((h) => h.role === "orchestrate").map((h) => h.lastMessage);
    const ciText = [args.text, ...orchTexts].find((t): t is string => !!t && !!parseGithubRunUrl(t));
    if (!ciText) {
      runStatus = "verifying";
      log.warn("Run {run} reached green but no CI URL in any orchestrate reply — not flipping", {
        botName: args.botName, run: run.id,
      });
    } else {
      ci = await fetchCi(ciText);
      if (isConfirmedGreen(ci)) {
        verified = await flipRunSpec(run, args.botName, args.deps);
        // green ⟹ spec verified. If the verified artifact couldn't be written,
        // stay `verifying` (re-send can complete it) rather than claim a green
        // the spec file doesn't reflect.
        runStatus = verified ? "green" : "verifying";
        if (!verified) {
          log.warn("CI confirmed green for run {run} but the spec flip failed — staying 'verifying'", {
            botName: args.botName, run: run.id,
          });
        }
      } else {
        runStatus = "verifying";
        log.warn("CI not confirmed-green for run {run} (status={s}, conclusion={c}) — not flipping spec", {
          botName: args.botName, run: run.id, s: ci?.status ?? "?", c: ci?.conclusion ?? "?",
        });
      }
    }
  }

  await updateDevRun(run.id, { status: runStatus });
  log.info("Handoff reply from {peer}: run {run} roles={roles} → {status}{verified}", {
    botName: args.botName, peer: args.peerName, run: run.id,
    roles: rolesUpdated.join(","), status: runStatus, verified: verified ? " (spec verified)" : "",
  });

  return { matched: true, runId: run.id, rolesUpdated, runStatus, verified, ci };
}

/** Flip the run's domain spec frontmatter to `status: verified`, resolving the
 *  bot dir for the relative spec_path. Returns false (with a warn) if the dir is
 *  unknown, the spec_path is unset, or the file write no-ops — the caller then
 *  keeps the run at `verifying` rather than claiming an unwritten green. */
async function flipRunSpec(run: DevRun, botName: string, deps?: InterpretDeps): Promise<boolean> {
  if (!run.specPath) {
    log.warn("Run {run} confirmed green but has no spec_path to flip", { botName, run: run.id });
    return false;
  }
  const botDir = deps?.getBotDir?.(botName);
  if (!botDir) {
    log.warn("Run {run} confirmed green but bot dir for {botName} is unknown — spec not flipped", {
      botName, run: run.id,
    });
    return false;
  }
  const abs = resolve(botDir, run.specPath);
  const flip = deps?.flipSpec ?? flipSpecToVerified;
  return flip(abs);
}

/** Rewrite the `status:` line inside the LEADING YAML frontmatter block to a new
 *  value. Only the first `---…---` block is touched (a `status:` in the body is
 *  left alone), mirroring the client's checkSpecStatus parse. Replaces the WHOLE
 *  value (not just `\w+`) so hyphenated/quoted values like `in-progress` or
 *  `"approved"` aren't garbled, and tolerates CRLF line endings. Returns the
 *  content unchanged if there's no frontmatter status line. Pure — for tests. */
export function setFrontmatterStatus(content: string, status: string): string {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return content;
  const block = fm[1]!;
  if (!/(?:^|\n)status:[ \t]*\S/.test(block)) return content;
  // Replace the whole value up to end-of-line, preserving the line ending.
  const newBlock = block.replace(/((?:^|\n)status:[ \t]*)[^\r\n]*/, (_m, prefix: string) => `${prefix}${status}`);
  return content.replace(fm[0], () => `---\n${newBlock}\n---`);
}

/** Read a domain spec file, flip its frontmatter `status:` to `verified`, write
 *  it back. Returns false if the file is missing or has no frontmatter status. */
export async function flipSpecToVerified(absSpecPath: string): Promise<boolean> {
  const file = Bun.file(absSpecPath);
  if (!(await file.exists())) {
    log.warn("Spec file not found for verified-flip: {path}", { path: absSpecPath });
    return false;
  }
  const content = await file.text();
  const flipped = setFrontmatterStatus(content, "verified");
  if (flipped === content) {
    log.warn("Spec at {path} had no frontmatter status to flip", { path: absSpecPath });
    return false;
  }
  await Bun.write(absSpecPath, flipped);
  log.info("Flipped spec to verified: {path}", { path: absSpecPath });
  return true;
}
