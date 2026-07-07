import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "email");

// Gmail's `after:` filter is date-only — compute the date in Oslo (where the
// user lives) so a run just after UTC-midnight doesn't query the wrong day.
const OSLO_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const DEFAULT_EMAIL_PROMPT = `For each new unread email, evaluate if it's worth notifying the user.

Worth notifying:
- From real people (not automated marketing/newsletters)
- Urgent or time-sensitive
- Action items or requests
- Security alerts, expiring tokens, important notifications

Not worth notifying:
- Marketing, newsletters, promotional offers
- Social-network noise (LinkedIn connection suggestions, follow recommendations, digests)`;


export async function checkEmail(watcher: Watcher, cwd?: string, botName?: string): Promise<WatcherAlert[]> {
  const config = watcher.config as { filter?: string; prompt?: string; model?: string };
  const query = buildGmailQuery(config.filter, watcher.lastRunAt);

  const userPrompt = config.prompt || DEFAULT_EMAIL_PROMPT;

  const prompt = `You have access to Gmail MCP tools.
Search for unread emails matching: "${query}"

${userPrompt}

CRITICAL:
- "id" MUST be the exact Gmail message ID from the API (e.g. "19abc123def"). Copy it verbatim.
- "sender" MUST be the exact From header value (e.g. "Posten Norge")
- "subject" MUST be the exact email subject line, verbatim — do NOT rephrase or shorten it.

Return ONLY a JSON array (no markdown fences):
[{"id":"msg_id","source":"email","sender":"exact sender","subject":"exact subject","summary":"**Fra:** sender — subject brief","urgency":"high|medium|low"}]
If nothing worth notifying, return: []`;

  const { result } = await spawnHaiku(prompt, { source: "watcher-email", entrypoint: "jarvis-watcher", cwd, botName, model: config.model });
  try {
    return extractJson<WatcherAlert[]>(result);
  } catch {
    log.warn("Failed to parse Haiku response as JSON, skipping. Raw: {raw}", { raw: result.slice(0, 300) });
    return [];
  }
}

export function buildGmailQuery(filter: string | undefined, lastRunAt: number | null): string {
  const parts: string[] = ["is:unread"];
  if (filter) parts.push(filter);
  if (lastRunAt) {
    // en-CA → "YYYY-MM-DD" in Oslo TZ; Gmail's `after:` wants slashes.
    const oslo = OSLO_DATE_FMT.format(new Date(lastRunAt)).replace(/-/g, "/");
    parts.push(`after:${oslo}`);
  }
  return parts.join(" ");
}
