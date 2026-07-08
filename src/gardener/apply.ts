/**
 * Apply stage — muninn's FIRST write path into the knowledge wiki.
 *
 * On approve, the review gate calls `applyWikiProposal` with the bot's `wikiDir`
 * and injected filesystem/reindex seams (real ones in the route, fakes in tests).
 * It re-checks path confinement (defense in depth), verifies the target hasn't
 * drifted since drafting, writes the draft, prepends a reverse-chron `log.md`
 * entry, refreshes the read cache, and best-effort triggers a huginn reindex.
 *
 * Filesystem writes are the point — but nothing here touches the DB. The route
 * owns the status CAS (approved → applied | stale | error) based on the returned
 * outcome, keeping this stage unit-testable with temp dirs alone.
 */

import path from "node:path";
import type { WikiProposal } from "../db/wiki-proposals.ts";
import { isPathConfined } from "./draft.ts";
import { parseFrontmatter } from "../wiki/store.ts";
import { getLog } from "../logging.ts";

const log = getLog("gardener", "apply");

const OSLO_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Oslo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export type ApplyOutcome =
  | { outcome: "applied"; writtenPath: string }
  | { outcome: "stale"; reason: string }
  | { outcome: "error"; reason: string };

export interface ApplyDeps {
  /** Absolute wiki root (the bot's `wikiDir`) — the path-confinement anchor. */
  wikiDir: string;
  now: () => number;
  /** Read a file's text, or null when it doesn't exist / is unreadable. */
  readFile: (absPath: string) => Promise<string | null>;
  writeFile: (absPath: string, content: string) => Promise<void>;
  fileExists: (absPath: string) => Promise<boolean>;
  /** Refresh the wiki-store TTL cache for this root (getWikiIndex refresh). */
  refreshIndex: () => Promise<void>;
  /** Best-effort huginn reindex for a collection; must never throw. */
  reindex: (collection: string) => Promise<void>;
}

/** The huginn collection a target path reindexes into: life/** → wiki-life, else wiki. */
export function reindexCollectionFor(targetPath: string): "wiki" | "wiki-life" {
  return targetPath.startsWith("life/") ? "wiki-life" : "wiki";
}

/** Title for the log.md entry — the draft's frontmatter title, falling back to topicKey. */
function draftTitle(proposal: WikiProposal): string {
  const fm = parseFrontmatter(proposal.draft);
  const title = Array.isArray(fm.title) ? fm.title[0] : fm.title;
  return (title && title.trim()) || proposal.topicKey;
}

/**
 * Insert a new entry into a reverse-chron `log.md` — AFTER the `# Activity Log`
 * header, BEFORE the first `## [` entry (the wiki's newest-first convention; a
 * literal prepend above the H1 would be wrong). Creates the file with the header
 * when it doesn't exist yet.
 */
export function insertLogEntry(existing: string | null, entry: string): string {
  const header = "# Activity Log";
  const block = entry.replace(/\n+$/, "");

  if (!existing || !existing.trim()) {
    return `${header}\n\n${block}\n`;
  }

  let text = existing;
  if (!/^#\s+Activity Log/m.test(text)) {
    text = `${header}\n\n${text}`;
  }

  const lines = text.split("\n");
  const firstEntryIdx = lines.findIndex((l) => /^##\s+\[/.test(l));

  if (firstEntryIdx === -1) {
    const trimmed = text.replace(/\n+$/, "");
    return `${trimmed}\n\n${block}\n`;
  }

  const before = lines.slice(0, firstEntryIdx);
  if (before.length && before[before.length - 1]!.trim() !== "") before.push("");
  const after = lines.slice(firstEntryIdx);
  return [...before, block, "", ...after].join("\n");
}

/** Ensure the written page body ends in exactly one trailing newline. */
function withTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

/**
 * Apply one approved proposal: confinement → staleness → write → log.md → cache
 * refresh → best-effort reindex. Returns the outcome; the caller flips the DB
 * status accordingly. Never throws for a recoverable condition — a stale target
 * or a confinement failure is a normal outcome, not an exception.
 */
export async function applyWikiProposal(proposal: WikiProposal, deps: ApplyDeps): Promise<ApplyOutcome> {
  const domain: "ai" | "life" = proposal.targetPath.startsWith("life/") ? "life" : "ai";

  // 1. Path confinement (defense in depth — the shape-gate ran this at persist
  //    time, but a hand-edited row must not escape wikiDir on apply).
  const confined = isPathConfined({
    targetPath: proposal.targetPath,
    wikiDir: deps.wikiDir,
    domain,
    kind: proposal.kind,
    existingRelPath: proposal.mode === "update" ? proposal.targetPath : undefined,
  });
  if (!confined) {
    return { outcome: "error", reason: `path confinement failed for "${proposal.targetPath}"` };
  }

  const absTarget = path.join(deps.wikiDir, proposal.targetPath);

  // 2. Staleness — the target must be exactly as it was at draft time.
  if (proposal.mode === "update") {
    const current = await deps.readFile(absTarget);
    if (current === null) {
      return { outcome: "stale", reason: "target file no longer exists" };
    }
    if (!proposal.baseHash || sha256(current) !== proposal.baseHash) {
      return { outcome: "stale", reason: "target file changed since drafting" };
    }
  } else {
    if (await deps.fileExists(absTarget)) {
      return { outcome: "stale", reason: "target path already exists" };
    }
  }

  // 3. Write the draft.
  try {
    await deps.writeFile(absTarget, withTrailingNewline(proposal.draft));
  } catch (err) {
    return { outcome: "error", reason: `write failed: ${errMsg(err)}` };
  }

  // 4. log.md entry (reverse-chron). A log-write hiccup must not undo the page
  //    write — the page is the source of truth — so it degrades to a warning.
  try {
    const logPath = path.join(deps.wikiDir, "log.md");
    const existingLog = await deps.readFile(logPath);
    const entry = `## [${OSLO_DATE_FMT.format(new Date(deps.now()))}] ${proposal.mode} | ${draftTitle(proposal)}\n- via wiki-gardener, ${proposal.sourceDocs.length} sources`;
    await deps.writeFile(logPath, insertLogEntry(existingLog, entry));
  } catch (err) {
    log.warn("Wiki-gardener apply: log.md update failed for {path}: {error}", {
      path: proposal.targetPath,
      error: errMsg(err),
    });
  }

  // 5. Refresh the read cache so /wiki and the next target-resolve see the write.
  try {
    await deps.refreshIndex();
  } catch (err) {
    log.warn("Wiki-gardener apply: cache refresh failed: {error}", { error: errMsg(err) });
  }

  // 6. Best-effort huginn reindex (non-blocking failure — `reindex` swallows).
  const collection = reindexCollectionFor(proposal.targetPath);
  await deps.reindex(collection);

  return { outcome: "applied", writtenPath: proposal.targetPath };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
