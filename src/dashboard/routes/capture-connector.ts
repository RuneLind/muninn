import type { BotConfig, ConnectorType } from "../../bots/config.ts";
import { applyThreadConnector } from "../../chat/thread-connector.ts";
import { getConnector, listConnectors, type Connector } from "../../db/connectors.ts";
import { getLog } from "../../logging.ts";
import { presetsForPickedModel, type CapturePreset } from "../../summaries/presets.ts";
import { isValidUuid } from "./route-utils.ts";

const log = getLog("dashboard", "capture-connector");

/**
 * A capture run on a named connector (a `connectors` row) instead of the
 * summarizer bot's own config.json connector and model. A row in the bot's own
 * model family is applied the way a chat thread applies one
 * (`applyThreadConnector`): each field it sets wins, each it leaves unset falls
 * back to the bot. A row of another family takes only its own model-bound
 * fields and must name a model (see {@link captureConnectorGap}). The bot's
 * persona, prompts and directory are unchanged either way.
 *
 * Only YouTube offers the pick today. The pieces are here rather than in its
 * route so another capture route can take the same `connector_id` field.
 */
export interface CaptureConnectorDeps {
  getConnector(id: string): Promise<Connector | null>;
  listConnectors(): Promise<Connector[]>;
}

export const DEFAULT_CAPTURE_CONNECTOR_DEPS: CaptureConnectorDeps = { getConnector, listConnectors };

export type CaptureConnectorPick =
  | { ok: true; bot: BotConfig; picked: Connector | null }
  | { ok: false; status: 400 | 503; body: { error: string; code: string; connector_id?: unknown } };

/**
 * Which model ids a connector takes. claude-cli and claude-sdk both take
 * Anthropic ids and read the thinking budget and effort the same way;
 * Copilot has its own catalog, and an openai-compat endpoint serves whatever
 * its operator loaded.
 */
type ModelFamily = "anthropic" | "copilot" | "openai-compat";

function modelFamily(type: ConnectorType | undefined): ModelFamily {
  const t = type ?? "claude-cli";
  if (t === "copilot-sdk") return "copilot";
  if (t === "openai-compat") return "openai-compat";
  return "anthropic";
}

/**
 * Why `row` cannot run a capture over `bot`, or null. Only a row of another
 * model family can fall short: it inherits none of the bot's model, endpoint
 * or thinking settings, and an unset model there does NOT mean that
 * connector's default. Every connector falls back to the process-wide
 * `CLAUDE_MODEL` (default "sonnet"), which a local endpoint rejects. So such
 * a row must name its model, and an openai-compat one its base URL.
 */
export function captureConnectorGap(bot: Pick<BotConfig, "connector">, row: Connector): string | null {
  if (modelFamily(bot.connector) === modelFamily(row.connectorType)) return null;
  if (!row.model) {
    return `Connector "${row.name}" names no model, and the summarizer bot's model is for another kind of connector.`;
  }
  if (row.connectorType === "openai-compat" && !row.baseUrl) {
    return `Connector "${row.name}" names no base URL.`;
  }
  return null;
}

/**
 * Resolve a request's `connector_id`. Absent or null is the summarizer bot as
 * configured. Present but not a non-blank string, or naming no row, is 400
 * `bad_connector`: running the default while the reader believes they picked
 * another model is the silent wrong answer the `kind` check refuses too. A
 * failed lookup is 503, since the pick may be valid.
 */
export async function resolveCaptureConnector(
  bot: BotConfig,
  raw: unknown,
  deps: CaptureConnectorDeps = DEFAULT_CAPTURE_CONNECTOR_DEPS,
): Promise<CaptureConnectorPick> {
  if (raw === undefined || raw === null) return { ok: true, bot, picked: null };
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      status: 400,
      body: { error: "Connector must be a non-blank string", code: "bad_connector", connector_id: raw },
    };
  }
  const id = raw.trim();
  const unknown = {
    ok: false as const,
    status: 400 as const,
    body: { error: `Unknown connector: ${id}`, code: "bad_connector", connector_id: raw },
  };
  // The column is a UUID: anything else would be a Postgres cast error, not "no such row".
  if (!isValidUuid(id)) return unknown;
  let row: Connector | null;
  try {
    row = await deps.getConnector(id);
  } catch (err) {
    log.warn("Capture connector lookup failed for {id}: {error}", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 503,
      body: { error: "Could not look up the connector", code: "connector_lookup_failed", connector_id: raw },
    };
  }
  if (!row) return unknown;
  const gap = captureConnectorGap(bot, row);
  if (gap) {
    return { ok: false, status: 400, body: { error: gap, code: "connector_incomplete", connector_id: raw } };
  }
  return { ok: true, bot: applyCaptureConnector(bot, row), picked: row };
}

/**
 * The summarizer bot as it runs on `row`. A row in the bot's own model family
 * takes the chat-thread merge (unset fields fall back to the bot). A row of
 * ANOTHER family takes only its own model, endpoint and thinking settings: the
 * bot's are meant for another catalog, and inheriting them ran
 * `claude --model gpt-5.5` or sent a Claude thinking budget to a local model
 * as `max_tokens`. {@link captureConnectorGap} refuses such a row with no
 * model before it gets here. The timeout is family-neutral and still falls back.
 */
export function applyCaptureConnector(bot: BotConfig, row: Connector): BotConfig {
  const merged = applyThreadConnector(bot, row);
  if (modelFamily(bot.connector) === modelFamily(row.connectorType)) return merged;
  return {
    ...merged,
    model: row.model,
    baseUrl: row.baseUrl,
    thinkingMaxTokens: row.thinkingMaxTokens,
    effort: row.effort,
  };
}

/** The kinds a capture offers on a picked connector; see {@link presetsForPickedModel}. */
export function kindsForPick(kinds: CapturePreset[], picked: Connector | null): CapturePreset[] {
  return picked?.model ? presetsForPickedModel(kinds) : kinds;
}

/** A picker row's text: the row's own name, plus its type when the name does not say it. */
export function captureConnectorLabel(row: Pick<Connector, "name" | "connectorType">): string {
  return row.name.includes(row.connectorType) ? row.name : `${row.name} (${row.connectorType})`;
}

/** The picker's first row: what a capture runs on when nothing is picked. */
export function defaultCaptureConnectorLabel(bot: Pick<BotConfig, "name" | "connector" | "model">): string {
  return `Default: ${bot.name} (${bot.connector ?? "claude-cli"} · ${bot.model ?? "default model"})`;
}

/**
 * Every named connector, or `[]` when the listing fails: a capture still runs
 * on the default, so a DB hiccup costs the reader the picker, not the popup.
 */
export async function listCaptureConnectors(
  deps: CaptureConnectorDeps = DEFAULT_CAPTURE_CONNECTOR_DEPS,
): Promise<Connector[]> {
  try {
    return await deps.listConnectors();
  } catch (err) {
    log.warn("Capture connector listing failed: {error}", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
