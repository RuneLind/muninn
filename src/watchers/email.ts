import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku } from "../scheduler/executor.ts";
import { extractJson } from "../ai/json-extract.ts";
import { getLog } from "../logging.ts";

const log = getLog("watchers", "email");

export async function checkEmail(watcher: Watcher, cwd?: string, botName?: string): Promise<WatcherAlert[]> {
  const config = watcher.config as { filter?: string };
  const query = buildGmailQuery(config.filter, watcher.lastRunAt);

  const prompt = `You have access to Gmail MCP tools.
Search for unread emails matching: "${query}"

For each new unread email, evaluate if it's worth notifying the user. Important emails:
- From real people (not automated marketing/newsletters)
- Urgent or time-sensitive
- Action items or requests
- Security alerts, expiring tokens, important notifications

CRITICAL:
- "id" MUST be the exact Gmail message ID from the API (e.g. "19abc123def"). Copy it verbatim.
- "sender" MUST be the exact From header value (e.g. "Posten Norge")
- "subject" MUST be the exact email subject line, verbatim — do NOT rephrase or shorten it.

Return ONLY a JSON array (no markdown fences):
[{"id":"msg_id","source":"email","sender":"exact sender","subject":"exact subject","summary":"<b>Fra:</b> sender — subject brief","urgency":"high|medium|low"}]
If nothing worth notifying, return: []`;

  const { result } = await spawnHaiku(prompt, "watcher-email", "jarvis-watcher", cwd, botName);
  try {
    return extractJson<WatcherAlert[]>(result);
  } catch {
    log.warn("Failed to parse Haiku response as JSON, skipping. Raw: {raw}", { raw: result.slice(0, 300) });
    return [];
  }
}

function buildGmailQuery(filter: string | undefined, lastRunAt: number | null): string {
  const parts: string[] = ["is:unread"];
  if (filter) parts.push(filter);
  if (lastRunAt) {
    const date = new Date(lastRunAt);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const dd = String(date.getDate()).padStart(2, "0");
    parts.push(`after:${yyyy}/${mm}/${dd}`);
  }
  return parts.join(" ");
}
