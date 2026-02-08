import type { Watcher, WatcherAlert } from "../types.ts";
import { spawnHaiku } from "../scheduler/executor.ts";

export async function checkEmail(watcher: Watcher, cwd?: string): Promise<WatcherAlert[]> {
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

  const { result } = await spawnHaiku(prompt, "watcher-email", "jarvis-watcher", cwd);
  return JSON.parse(extractJsonArray(result));
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

function extractJsonArray(text: string): string {
  // Strip markdown fences first
  const stripped = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();

  // Find the JSON array in the response — Haiku sometimes wraps it in prose
  const start = stripped.indexOf("[");
  const end = stripped.lastIndexOf("]");
  if (start !== -1 && end > start) {
    return stripped.slice(start, end + 1);
  }

  // No array found — assume empty
  return "[]";
}
