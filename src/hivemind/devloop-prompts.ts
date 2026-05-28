import { resolve } from "node:path";
import { parseGithubRunUrl } from "./ci-conclusion.ts";
import type { DevRunHandoff } from "../db/dev-runs.ts";

/**
 * Server-side mirror of the research-card client's handoff-path + orchestrate-
 * prompt builders, for the v2 auto-orchestrate code-triggered turn (Phase 6a) —
 * the inbound interpreter has no browser to build them. The manual path still
 * runs the client copy in `src/chat/views/components/research-card.ts`.
 *
 * KEEP IN SYNC with `research-card.ts` (`handoffPaths`, `buildOrchestratePrompt`):
 * both must produce the same instruction so an auto-fired verify behaves
 * identically to the user-clicked one.
 *
 * The re-engage prompt (Phase 6b) has NO client mirror — re-engage is autonomous
 * only (no manual button), so it lives server-side alone.
 */

/** The two handoff artifact paths for a run, derived deterministically from the
 *  bot dir + user + issue key — identical to the client's `handoffPaths()`. */
export function handoffPathsFor(
  botDir: string,
  userId: string,
  issueKey: string,
): { planPath: string; specPath: string } {
  return {
    planPath: resolve(botDir, "reports", userId, `${issueKey}.md`),
    specPath: resolve(botDir, "specs", userId, `${issueKey}.md`),
  };
}

/** Instruction handed to the bot to fan the cross-repo e2e out to an orchestrate
 *  peer via `delegate_task`. Mirrors the client's `buildOrchestratePrompt`
 *  (which ignores its `planPath` arg — only the spec path is referenced). */
export function buildOrchestratePrompt(specPath: string): string {
  return 'Build and test are both done for this dev run — now run the cross-repo e2e to verify it ("when everything is green, everything is good").\n\n' +
    'Use the hivemind list_peers tool (scope: "machine") to find the agent that can run the orchestrate-e2e-flow skill (the melosys-e2e-tests agent, or a dedicated orchestrator).\n' +
    'AVAILABILITY GUARD: if no such peer is online, do NOT proceed — tell me which agent to start.\n\n' +
    'When ready, use the delegate_task tool (NOT send_to_peer), role: "orchestrate", to hand it the cross-repo e2e' +
    (specPath ? ' for the spec at ' + specPath : '') + ': instruct it to run the full e2e end to end (local + CI) and report back the GitHub Actions run URL so the result can be verified. ' +
    'Then report back here what you sent and to whom.';
}

/** The failure context extracted from a red run's handoffs, fed into the
 *  re-engage prompt (Phase 6b). */
export interface ReengageContext {
  /** The failed GitHub Actions run URL, reconstructed from the orchestrate
   *  handoff's reply (the CI conclusion that came back not-green). */
  ciUrl?: string;
  /** The orchestrate peer's reply text (what the e2e agent reported), trimmed. */
  orchestrateMessage?: string;
  /** peer_name of the build handoff to prefer re-delegating to (same branch). */
  buildPeer?: string;
  /** peer_name of the test handoff to prefer re-delegating to, when the classifier
   *  routes a red to the TEST agent (spec/test drift) instead of build. */
  testPeer?: string;
}

/**
 * Extract the re-engage failure context from a red run's handoff rows. Pulls the
 * orchestrate peer's last reply (carrying the CI URL the green gate rejected) and
 * the build peer to re-engage. Called BEFORE the orchestrate handoff is cleared,
 * so the CI URL is preserved into the prompt even though the row is then deleted.
 */
export function buildReengageContext(handoffs: DevRunHandoff[]): ReengageContext {
  const orchMessage = handoffs
    .filter((h) => h.role === "orchestrate")
    .map((h) => h.lastMessage)
    .find((m): m is string => !!m);
  const parsed = orchMessage ? parseGithubRunUrl(orchMessage) : null;
  // The MOST RECENT build peer — handoffs are created_at ASC, and a re-engaged run
  // may have several build rows (delegate_task always inserts). The latest is the
  // peer that did the work the failed e2e ran against, so prefer it for the fix.
  const buildPeer = handoffs.filter((h) => h.role === "build").at(-1)?.peerName;
  // Same "most recent" rule for the test peer — used when the classifier routes
  // the red to the TEST agent (spec/test drift) rather than build.
  const testPeer = handoffs.filter((h) => h.role === "test").at(-1)?.peerName;
  return {
    ciUrl: parsed ? `https://github.com/${parsed.repo}/actions/runs/${parsed.runId}` : undefined,
    orchestrateMessage: orchMessage?.trim().slice(0, 1500),
    buildPeer,
    testPeer,
  };
}

/** Instruction handed to the bot to re-engage the BUILD agent after a red e2e
 *  (Phase 6b). The default route — most reds are feature bugs. When the optional
 *  Haiku classifier (`reengageClassifier`) instead judges the red to be spec/test
 *  drift, `testReengagePrompt` routes to the test agent. Mirrors the orchestrate
 *  prompt's shape (recommend → delegate_task → report back). */
export function buildReengagePrompt(ctx: ReengageContext): string {
  // Only fired on an orchestrate red (a failed cross-repo e2e), so the lead is
  // always e2e-centric. The CI URL may still be absent if the peer didn't report
  // it on the red — degrade to the run-level statement then.
  return 'The cross-repo e2e for this dev run came back RED — the acceptance criteria are NOT yet met, so the work needs another pass.\n\n' +
    (ctx.ciUrl ? 'Failed CI run: ' + ctx.ciUrl + '\n' : '') +
    (ctx.orchestrateMessage ? 'What the e2e agent reported:\n' + ctx.orchestrateMessage + '\n\n' : '\n') +
    'FIRST: read the failure above and decide WHICH REPO owns the failing code. The original run had this build peer: ' + (ctx.buildPeer ? ctx.buildPeer + ' (its cwd-basename is its repo).' : 'unknown (look at the prior handoff rows).') + ' If the original work spanned multiple repos, pick the peer whose repo matches the failure — DO NOT assume it is the most-recent peer. ' +
    'Then re-engage that BUILD agent: use the delegate_task tool (NOT send_to_peer), role: "build". Hand it the failure context above plus the workplan/spec, and ask it to diagnose the e2e failure, implement the fix, and report back done. ' +
    'PREFER the same build peer that did the original implementation for that repo so the fix lands on the same branch. ' +
    'Delegate to ONE peer per turn. If the fix legitimately spans repos, delegate to the most-likely-owner first — the loop will catch the next red and re-engage the next repo if needed. Do NOT fan out to multiple peers in one turn (a non-replying peer wedges the rollup until the 6h stale-handoff sweep). Each delegate_task call must target ONE repo; never delegate work in repo X to a peer in repo Y. ' +
    'AVAILABILITY GUARD: if NO peer in the matching repo is online, reply here with the missing repo name so I know which agent to start — do NOT substitute a peer from a different repo as a workaround. (The run will park building; that is the intended trade-off.) ' +
    'Then report back here what you sent and to whom.';
}

/** Instruction handed to the bot to re-engage the TEST agent after a red e2e the
 *  classifier judged to be spec/test drift (Phase 6b classifier follow-up) — the
 *  feature code is fine; the e2e itself is wrong (stale selector, outdated
 *  assertion, test data, or a spec that drifted from the implemented behaviour).
 *  Mirrors `buildReengagePrompt`'s shape but routes role: "test". */
export function testReengagePrompt(ctx: ReengageContext): string {
  return 'The cross-repo e2e for this dev run came back RED, but the failure looks like TEST/SPEC drift rather than a feature-code bug — the e2e itself (selector, assertion, test data, or a spec that no longer matches the implemented behaviour) is most likely what needs fixing.\n\n' +
    (ctx.ciUrl ? 'Failed CI run: ' + ctx.ciUrl + '\n' : '') +
    (ctx.orchestrateMessage ? 'What the e2e agent reported:\n' + ctx.orchestrateMessage + '\n\n' : '\n') +
    'Re-engage the TEST agent' + (ctx.testPeer ? ' (' + ctx.testPeer + ')' : '') +
    ' to fix it: use the delegate_task tool (NOT send_to_peer), role: "test". Hand it the failure context above plus the domain spec, and ask it to diagnose the e2e failure, correct the test/spec (re-run `spec-from-analysis` so the binding refreshes against the approved domain spec WITHOUT clobbering valid technical binding), re-run, and report back done. ' +
    'PREFER the same test peer that authored the e2e so the fix lands on the same branch. ' +
    'If on diagnosis it turns out to be a genuine feature-code bug after all, say so and recommend re-engaging the build agent instead. ' +
    'AVAILABILITY GUARD: if it is offline, pick another online test agent (or tell me which to start). ' +
    'Then report back here what you sent and to whom.';
}
