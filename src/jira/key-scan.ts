/**
 * The Jira-key SCANNER over prose — split out of `verify-keys.ts` so a caller
 * that only needs "which key-shaped tokens does this text carry" (the wiki
 * store's tracker inference, `src/wiki/trackers/jira.ts`) does not import the
 * huginn client and its TTL cache with it. `verify-keys.ts` re-exports both
 * names, so its callers are unchanged.
 */

import { JIRA_KEY_SOURCE } from "./retrieval.ts";
import { maskFencedCode } from "./markdown-scan.ts";

/**
 * What a bare `[A-Z][A-Z0-9]+-\d+` matches that is NOT a Jira key.
 *
 * Without this the pass flags `UTF-8`, `ISO-8601`, `SHA-256` and `RFC-2119` in
 * every second technical task and the reader learns to ignore the red rows —
 * which is the only way this mechanism actually fails. The list carries THIS
 * corpus's own vocabulary, not just generic tech: `BUC-02` is the obvious one in
 * a knowledge base whose MCP description literally advertises "BUC/SED types",
 * and `SED-01`-shaped references appear beside it.
 *
 * Bounded by design — a growing denylist is a growing hole, so anything that
 * turns out to need adding should be weighed against just letting the row render
 * amber with a `resolved: false`.
 */
export const JIRA_KEY_DENYLIST = new Set([
  "UTF", "ISO", "SHA", "RFC", "HTTP", "HTTPS", "AES", "RSA", "TLS", "SSL",
  "BUC", "SED", "EU", "EF", "EØS", "ISO8601", "UTF8", "SHA256", "MD", "CVE",
]);

/**
 * The key shape, built from the SHARED {@link JIRA_KEY_SOURCE}.
 *
 * It used to be a second, hand-written regex that disagreed with
 * `jiraKeyFromDocId` on both ends (prefix length and digit count), so a key the
 * scanner accepted could be absent from an index built by the other — a red
 * "fabricated" row for a real issue. Anchored on a word boundary so `xMELOSYS-1`
 * does not match.
 */
const KEY_RE = new RegExp(`\\b(${JIRA_KEY_SOURCE})\\b`, "g");

/** Every candidate key in the markdown, fenced code excluded, in first-seen order. */
export function extractJiraKeys(markdown: string): string[] {
  const masked = maskFencedCode(markdown);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of masked.matchAll(KEY_RE)) {
    const key = m[1]!;
    // The prefix can hold no `-` by construction, so this is the whole of it.
    if (JIRA_KEY_DENYLIST.has(key.slice(0, key.indexOf("-")))) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}
