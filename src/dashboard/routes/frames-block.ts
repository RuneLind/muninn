import { capabilitiesForConnectorType } from "../../ai/connector-capabilities.ts";
import { restrictedCliBlocker } from "../../ai/tool-surface.ts";
import type { ConnectorType } from "../../bots/config.ts";

/**
 * Why a summarizer bot cannot run a slide-frame pass (`{ read: [framesDir] }`),
 * as the refusal code the capture routes answer with, or null when it can.
 *
 * - `frames_unsupported`: the connector cannot run a `{ read }` surface at all.
 *   The remedy is another connector.
 * - `cli_too_old`: the connector is claude-cli and the installed CLI predates
 *   `--restricted`. The bot already runs claude-cli, so the remedy is an upgrade.
 *
 * The Slides offers (`/summaries`' tick, `GET /api/youtube/options`) read this,
 * so they withhold Slides exactly where the POSTs would refuse them.
 */
export type FramesBlockCode = "frames_unsupported" | "cli_too_old";

export async function framesBlock(bot: { connector?: ConnectorType }): Promise<FramesBlockCode | null> {
  const connector = bot.connector ?? "claude-cli";
  if (!capabilitiesForConnectorType(connector).supportsExtraDirs) return "frames_unsupported";
  return (await restrictedCliBlocker(connector, "read")) === null ? null : "cli_too_old";
}
