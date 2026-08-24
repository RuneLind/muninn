/**
 * Which bot drafts a Jira task.
 *
 * **Not `resolveResearchBot`.** Its "first non-opus bot" default would hand the
 * draft to jarvis, whose collections are the AI/tech shelf — producing a
 * confident, well-written task grounded in the wrong corpus, which is worse than
 * a refusal because it looks right.
 *
 * **Not `resolveSummarizerBot` either**, for the same reason: it falls back to
 * the first discovered bot.
 *
 * So this resolver has NO fallback. `JIRA_BOT` (env) names a bot, defaulting to
 * `melosys` — the bot whose `.mcp.json` binds the three collections this feature
 * retrieves over. If that bot is not discovered, every route 503s with a message
 * naming what is missing. A wrong-corpus draft is not a degrade path.
 *
 * **Env-only in v1**, deliberately outside the `role_overrides` DB mechanism that
 * `SUMMARIZER_BOT`/`RESEARCH_BOT`/`HAIKU_BACKEND` use from `/models`: there is
 * nothing to hot-swap between. It does get a row in the repo `CLAUDE.md`
 * configuration table, like every other env knob.
 */

import { discoverAllBots, type BotConfig } from "../bots/config.ts";

/** The bot the composer runs on when `JIRA_BOT` is unset. */
export const DEFAULT_JIRA_BOT = "melosys";

/** The name currently in effect (trimmed, lowercased). */
export function jiraBotName(): string {
  return (process.env.JIRA_BOT?.trim() || DEFAULT_JIRA_BOT).toLowerCase();
}

/** Resolve the composer's bot by NAME. `undefined` ⇒ the caller 503s. */
export function resolveJiraBot(bots: BotConfig[]): BotConfig | undefined {
  const wanted = jiraBotName();
  return bots.find((b) => b.name.toLowerCase() === wanted);
}

/**
 * The composer's bot over the LIVE discovery — the ONE resolver every surface
 * calls.
 *
 * The chat page used to answer `GET /chat/bots`'s `jiraBot` from the bot list
 * captured at process start, while every `/api/jira/*` route resolved over
 * `discoverAllBots()`. Two sources for one answer, and the chat's whole reason
 * for asking the server is that a second copy of the name is what makes the
 * «Lag Jira-sak» control appear on a thread the route then refuses — a second
 * copy of the *lookup* is the same defect one layer down. The startup list is
 * token-gated (`discoverBots`), so a `JIRA_BOT` whose folder carries no Telegram
 * token resolved for the routes and not for the page.
 */
export function resolveJiraBotLive(): BotConfig | undefined {
  return resolveJiraBot(discoverAllBots());
}

/** The 503 body's message — one spelling, shared by the two routes that need the
 *  pinned bot (templates and from-thread); the archive reads render botless. */
export function jiraBotMissingMessage(): string {
  return (
    `Jira-komponisten er festet til boten "${jiraBotName()}", som ikke er oppdaget i denne instansen. ` +
    `Sett JIRA_BOT til en bot som har melosys-samlingene (jira-issues, melosys-confluence-v3, nav-wiki).`
  );
}
