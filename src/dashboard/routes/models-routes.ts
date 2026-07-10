import type { Hono } from "hono";
import { renderModelsPage } from "../views/models-page.ts";
import {
  assembleModelsOverview,
  DEFAULT_MODELS_OVERVIEW_DEPS,
  type ModelsOverviewDeps,
} from "../models-overview.ts";
import { discoverAllBots } from "../../bots/config.ts";
import { writeBotConfigField } from "../../bots/config-edit.ts";
import { connectorCapabilities } from "../../ai/one-shot.ts";
import {
  clearRoleOverride,
  isRoleKey,
  setRoleOverride,
  type RoleKey,
} from "../../db/role-overrides.ts";
import { activityLog } from "../../observability/activity-log.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "models");

/**
 * `/models` page + JSON API. `GET /api/models/overview` is the read-only
 * assembly (PR 2). PR 5 adds editing:
 *   - `POST /api/models/bot-config` writes a per-bot config.json field in place
 *     (applies on restart — the git-synced source of truth).
 *   - `POST /api/models/role` sets/clears a DB-backed role override
 *     (SUMMARIZER_BOT / RESEARCH_BOT / HAIKU_BACKEND) — HOT, beats env at the
 *     next resolution with no restart.
 * Every edit is activity-logged. `deps` stays injectable for the overview test.
 */
export function registerModelsRoutes(
  app: Hono,
  deps: ModelsOverviewDeps = DEFAULT_MODELS_OVERVIEW_DEPS,
): void {
  app.get("/models", async (c) => {
    return c.html(await renderModelsPage());
  });

  app.get("/api/models/overview", async (c) => {
    const bot = c.req.query("bot") || "jarvis";
    const overview = await assembleModelsOverview(bot, deps);
    return c.json(overview);
  });

  // ---- Per-bot config.json field edit (applies on restart) ----------------
  app.post("/api/models/bot-config", async (c) => {
    let body: { bot?: unknown; field?: unknown; value?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const bot = typeof body.bot === "string" ? body.bot : "";
    const field = typeof body.field === "string" ? body.field : "";
    // `value: null` clears the field (revert to default). Any other type is
    // passed through to writeBotConfigField's validation.
    const value = body.value === undefined ? null : body.value;
    if (!bot || !field) {
      return c.json({ ok: false, error: "bot and field are required" }, 400);
    }

    let result: { path: string; cleared: boolean };
    try {
      result = writeBotConfigField(bot, field, value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: message }, 400);
    }

    // Warn (don't block) if the summarizer's connector loses TikTok frame support.
    let warning: string | undefined;
    if (field === "connector" && !result.cleared) {
      const bots = discoverAllBots();
      const target = bots.find((b) => b.name === bot);
      if (target && !connectorCapabilities(target).supportsExtraDirs) {
        warning = `Connector "${String(value)}" lacks extra-dirs support — if ${bot} is the summarizer, TikTok frame-reading will 503.`;
      }
    }

    activityLog.push("system", `Models: set ${bot} ${field} = ${result.cleared ? "(cleared)" : JSON.stringify(value)}`, {
      botName: bot,
      metadata: { source: "models-page", field, value, cleared: result.cleared },
    });
    log.info("Edited {bot} config.json field {field}", { botName: bot, bot, field });

    return c.json({
      ok: true,
      cleared: result.cleared,
      message: "Saved to config.json — applies on restart.",
      ...(warning ? { warning } : {}),
    });
  });

  // ---- Role override (hot: beats env at next resolution) ------------------
  app.post("/api/models/role", async (c) => {
    let body: { role?: unknown; value?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const role = typeof body.role === "string" ? body.role : "";
    if (!isRoleKey(role)) {
      return c.json({ ok: false, error: `unknown role "${role}"` }, 400);
    }
    const roleKey: RoleKey = role;
    const rawValue = typeof body.value === "string" ? body.value.trim() : "";

    // Empty value ⇒ clear the override (revert to env/default).
    if (rawValue.length === 0) {
      await clearRoleOverride(roleKey);
      activityLog.push("system", `Models: cleared ${roleKey} override`, {
        metadata: { source: "models-page", role: roleKey, cleared: true },
      });
      return c.json({ ok: true, cleared: true, message: `Cleared ${roleKey} override — reverted to env/default.` });
    }

    let canonicalValue = rawValue;
    let warning: string | undefined;

    if (roleKey === "HAIKU_BACKEND") {
      const valid = ["cli", "anthropic", "copilot"];
      const v = rawValue.toLowerCase();
      if (!valid.includes(v)) {
        return c.json({ ok: false, error: `unknown HAIKU_BACKEND "${rawValue}" — valid values: ${valid.join(", ")}` }, 400);
      }
      canonicalValue = v;
    } else {
      // SUMMARIZER_BOT / RESEARCH_BOT — must name a discovered bot (mirrors PR 2's
      // "env only wins when it matched a real bot"). Store the canonical name.
      const bots = discoverAllBots();
      const match = bots.find((b) => b.name.toLowerCase() === rawValue.toLowerCase());
      if (!match) {
        return c.json({ ok: false, error: `no bot named "${rawValue}" — cannot set ${roleKey} override` }, 400);
      }
      canonicalValue = match.name;
      if (roleKey === "SUMMARIZER_BOT" && !connectorCapabilities(match).supportsExtraDirs) {
        warning = `${match.name}'s connector "${match.connector ?? "claude-cli"}" lacks extra-dirs support — TikTok frame-reading will 503.`;
      }
    }

    await setRoleOverride(roleKey, canonicalValue);
    activityLog.push("system", `Models: set ${roleKey} override = ${canonicalValue}`, {
      metadata: { source: "models-page", role: roleKey, value: canonicalValue },
    });
    log.info("Set {role} override = {value} (hot)", { role: roleKey, value: canonicalValue });

    return c.json({
      ok: true,
      value: canonicalValue,
      message: `Set ${roleKey} = ${canonicalValue} — takes effect immediately.`,
      ...(warning ? { warning } : {}),
    });
  });
}
