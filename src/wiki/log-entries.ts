/**
 * The `log.md` entry parser: `## [YYYY-MM-DD] kind | title` headers and the
 * body under each. Moved here from `digest.ts` (a features module, which
 * re-exports it) so wiki-core callers such as the mentions builder read log
 * entries the way the What's new digest does without an upward import.
 */

/** One parsed `## [date] kind | title` log entry with its body. */
export interface LogEntry {
  /** ISO date from the header, `YYYY-MM-DD`. */
  date: string;
  /** The `kind` token (e.g. `note`, `ingest`) — empty when the header omits it. */
  kind: string;
  title: string;
  /** Free-markdown body under the header, trimmed (may be empty). */
  body: string;
  /** 1-based line of the header in `log.md`. Set by {@link parseLogEntries}. */
  line?: number;
}

export const ENTRY_HEADER_RE = /^##\s+\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/;

/**
 * Split raw `log.md` text into entries. Everything before the first
 * `## [date]` header (the file's intro) is ignored. A header's remainder is
 * `kind | title`; when the `|` is absent the whole remainder is the title and
 * kind is empty. Entries are returned in file order — which differs by wiki
 * (mimir appends oldest-first, bot wikis prepend newest-first), so downstream
 * `digest.ts` `selectRecentEntries` sorts by date rather than trusting file order.
 */
export function parseLogEntries(logText: string): LogEntry[] {
  const lines = logText.split("\n");
  const entries: LogEntry[] = [];
  let current: { date: string; kind: string; title: string; body: string[]; line: number } | null = null;

  const flush = () => {
    if (current) {
      entries.push({
        date: current.date,
        kind: current.kind,
        title: current.title,
        body: current.body.join("\n").trim(),
        line: current.line,
      });
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(ENTRY_HEADER_RE);
    if (m) {
      flush();
      const remainder = m[2]!.trim();
      const pipe = remainder.indexOf("|");
      const kind = pipe === -1 ? "" : remainder.slice(0, pipe).trim();
      const title = (pipe === -1 ? remainder : remainder.slice(pipe + 1)).trim();
      current = { date: m[1]!, kind, title, body: [], line: i + 1 };
    } else if (current) {
      current.body.push(line);
    }
  }
  flush();
  return entries;
}
