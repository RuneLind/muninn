/**
 * What a connector TYPE can express, as data — no connector is constructed and
 * nothing is spawned to answer it.
 *
 * Extracted from `one-shot.ts` (which re-exports both names, so every existing
 * import path is unchanged) for the reason `summary-structure.ts` was extracted
 * from `summarizer-shared.ts`: a caller that needs only the table must not have
 * to import the module that builds every connector. The first such caller is
 * `src/summaries/presets.ts`, which is IO-free by contract and narrows the kinds
 * a bot offers by what its connector can honour — importing `one-shot.ts` there
 * would pull `resolveConnector` and the whole connector graph into the picker.
 *
 * One table, one implementation: a second copy of "which connectors honour a
 * thinking budget" is exactly the drift that made a raised frame budget inert
 * behind a second literal (`src/video/media.ts`).
 */

import type { ConnectorType } from "../bots/config.ts";

export interface ConnectorCapabilities {
  /**
   * Whether the connector can grant read access to directories outside the bot
   * folder. `claude-cli` expresses this via `--add-dir`; `claude-sdk` via the
   * Agent SDK's `additionalDirectories`. The Copilot / OpenAI-compat connectors
   * have no equivalent knob.
   */
  supportsExtraDirs: boolean;
  /**
   * Whether `thinkingMaxTokens` actually means "extended-thinking budget" on
   * this connector. It does NOT mean that everywhere: `openai-compat` reuses the
   * field as the request's **`max_tokens`** (an output-length cap), and
   * `copilot-sdk` ignores it entirely. So a caller that wants to tune *thinking*
   * (e.g. the capture summarizers capping it to kill first-token dead-air) must
   * gate on this — overriding the field on an openai-compat bot would silently
   * clamp how long its answer is allowed to be.
   */
  supportsThinkingBudget: boolean;
  /**
   * Whether the connector exposes built-in web tools (WebFetch / web search) so a
   * one-shot can verify claims against the live web. `claude-cli` and `claude-sdk`
   * both surface WebFetch; the Copilot / OpenAI-compat connectors run only the
   * bot's `.mcp.json` tools and have no built-in web fetch. The wiki fact-check
   * route pre-flights on this and emits a clean `app_error` when it's false
   * (mirrors the `supportsExtraDirs` TikTok pre-flight precedent).
   */
  supportsWebTools: boolean;
}

/**
 * Capabilities of a connector TYPE, with no bot in hand.
 *
 * Used by the one caller that legitimately has no `BotConfig` (the wiki
 * chat-target endpoint flags each named `connectors` row — a DB row carrying a
 * `connectorType`, not a bot — so the reader's connector picker can say "no web
 * search" honestly) and by the capture-kind resolver. Deriving either in a
 * second hardcoded list is exactly the drift this single implementation exists
 * to prevent.
 */
export function capabilitiesForConnectorType(connector: ConnectorType): ConnectorCapabilities {
  const isClaude = connector === "claude-cli" || connector === "claude-sdk";
  return {
    supportsExtraDirs: isClaude,
    supportsThinkingBudget: isClaude,
    supportsWebTools: isClaude,
  };
}
