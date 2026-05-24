import { resolve } from "node:path";

/**
 * Server-side mirror of the research-card client's handoff-path + orchestrate-
 * prompt builders, for the v2 auto-orchestrate code-triggered turn (Phase 6a) —
 * the inbound interpreter has no browser to build them. The manual path still
 * runs the client copy in `src/chat/views/components/research-card.ts`.
 *
 * KEEP IN SYNC with `research-card.ts` (`handoffPaths`, `buildOrchestratePrompt`):
 * both must produce the same instruction so an auto-fired verify behaves
 * identically to the user-clicked one.
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
