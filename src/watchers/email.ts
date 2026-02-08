import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku } from "../scheduler/executor.ts";

export async function checkEmail(watcher: Watcher): Promise<WatcherAlert[]> {
  const config = watcher.config as { filter?: string };
  const query = buildGmailQuery(config.filter, watcher.lastRunAt);

  const prompt = `You have access to Gmail MCP tools.
Search for unread emails matching: "${query}"
Skip these already-notified message IDs: ${JSON.stringify(watcher.lastNotifiedIds)}

For each new unread email, evaluate if it's worth notifying the user. Important emails:
- From real people (not automated marketing/newsletters)
- Urgent or time-sensitive
- Action items or requests
- Security alerts, expiring tokens, important notifications

Return ONLY a JSON array (no markdown fences):
[{"id":"msg_id","source":"email","summary":"<b>From:</b> sender — subject line brief","urgency":"high|medium|low"}]
If nothing worth notifying, return: []`;

  const { result } = await spawnHaiku(prompt, "watcher-email", "jarvis-watcher");
  return JSON.parse(stripMarkdownFences(result));
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

function stripMarkdownFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
}
