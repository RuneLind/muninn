/**
 * Backfill publication dates onto jarvis wiki SOURCE pages so the Atlas timeline
 * can bucket them by their true `pubDate` (the `Source: …, YYYY-MM-DD` line the
 * reader parses via `extractPubDate`, regex `/^Source:.*?(\d{4}-\d{2}-\d{2})/m`).
 *
 * Of ~607 source pages only ~207 carry a parseable `Source:` line today. This
 * one-shot raises that coverage from CAPTURE-TIME metadata that already exists —
 * it NEVER invents a date:
 *
 *   A. In-page `Date: YYYY-MM-DD` line (~66 pages). The publication date is
 *      already in the file, just in a `URL:`/`Date:` block the Atlas can't parse.
 *      We fold that block into one canonical `Source: <platform>, <date> — <url>`
 *      line — a pure format normalization, the date is the page's own.
 *
 *   B. YouTube upload date keyed by video id (~252 url-only pages). The
 *      youtube-transcripts store (`~/source/private/youtube-transcripts/**.md`)
 *      carries each video's frontmatter `date:` + `url:`. We match a wiki page's
 *      YouTube url to its transcript by video id and insert a `Source: YouTube,
 *      <date> — <url>` line after the H1. High confidence — it's the same
 *      capture the Chrome extension recorded at ingest time.
 *
 * Pages with a bare `url:` and no in-page date and no transcript match (X posts,
 * misc web) are LEFT ALONE — the Atlas already falls back to `created:`/mtime for
 * them, and we do not fabricate a publication date from capture time.
 *
 * Safety: every planned edit is applied to an in-memory copy and re-verified —
 * `extractPubDate(next)` must equal the intended date AND the page must end with
 * exactly one `^Source:` line — before it is written. A page that fails
 * verification is skipped, never half-edited. Idempotent: a page that already has
 * a parseable `Source:` line is counted `already-dated` and skipped, so re-running
 * is a no-op.
 *
 * Usage:
 *   bun scripts/backfill-wiki-pubdates.ts                 # DRY-RUN (default) — prints the plan
 *   bun scripts/backfill-wiki-pubdates.ts --apply         # write the edits to disk
 *   bun scripts/backfill-wiki-pubdates.ts --limit 20      # cap planned edits (dry-run inspection)
 *   bun scripts/backfill-wiki-pubdates.ts --wiki-dir <abs>
 *   bun scripts/backfill-wiki-pubdates.ts --transcripts-dir <abs>
 *   bun scripts/backfill-wiki-pubdates.ts --apply --commit    # write + git-commit + reindex
 *   bun scripts/backfill-wiki-pubdates.ts --apply --no-commit # write, never commit
 *
 * Wiki-writing convention (ALL future wiki-writing scripts must follow this):
 * a script that mutates wiki pages MUST route its commit through
 * `commitWikiChange` (`src/wiki/commit.ts`) — never a bare `git add`/`commit` —
 * so it stages ONLY the paths it wrote, commits on the default branch, and pushes
 * asynchronously, matching the gardener/fact-check writers. It then fires the
 * huginn reindex for the touched collections so search picks the edits up. With
 * `--apply`, this commit+reindex is ON by default WHEN THE REPO WAS CLEAN at
 * script start (so a script run in a dirty working tree stays hands-off); pass
 * `--commit` to force it on a dirty repo, `--no-commit` to suppress it entirely.
 *
 * Env: WIKI_DIR (wiki root override), YT_TRANSCRIPTS_DIR (transcripts override),
 * KNOWLEDGE_API_URL (huginn base for the reindex, default http://localhost:8321).
 * Defaults: jarvis wiki (`../huginn/huginn-jarvis/data/wiki`) and
 * `~/source/private/youtube-transcripts`.
 */
import path from "node:path";
import os from "node:os";
import { Glob } from "bun";
import {
  parseFrontmatter,
  stripFrontmatter,
  extractPubDate,
} from "../src/wiki/store.ts";
import { commitWikiChange } from "../src/wiki/commit.ts";
import { fetchKnowledgeApi } from "../src/ai/knowledge-api-client.ts";

// ── args / config ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const flagVal = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const limit = Number(flagVal("--limit") ?? "0") || 0;
const commitFlag = args.includes("--commit");
const noCommitFlag = args.includes("--no-commit");
const KNOWLEDGE_API_URL = process.env.KNOWLEDGE_API_URL ?? "http://localhost:8321";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WIKI_ROOT = path.resolve(
  flagVal("--wiki-dir") ?? process.env.WIKI_DIR ?? path.join(REPO_ROOT, "../huginn/huginn-jarvis/data/wiki"),
);
const TRANSCRIPTS_ROOT = path.resolve(
  flagVal("--transcripts-dir") ??
    process.env.YT_TRANSCRIPTS_DIR ??
    path.join(os.homedir(), "source/private/youtube-transcripts"),
);

// ── helpers ──────────────────────────────────────────────────────────────────
const ISO = /(\d{4}-\d{2}-\d{2})/;
const DATE_LINE_RE = /^Date:\s*(\d{4}-\d{2}-\d{2})\s*$/m;
const SOURCE_LINE_COUNT_RE = /^Source:/gm;

/** True when the git repo containing `dir` has NO uncommitted changes at all
 *  (`git status --porcelain` empty). Used to decide whether `--commit` is on by
 *  default. A non-repo / git failure reads as "not clean" (conservative). */
async function repoCleanAtStart(dir: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, "status", "--porcelain"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    return code === 0 && out.length === 0;
  } catch {
    return false;
  }
}

/** The huginn collection a wiki-relative path reindexes into (mirrors
 *  `reindexCollectionFor` in src/gardener/apply.ts): life/** → wiki-life, else wiki. */
function collectionForPath(rel: string): "wiki" | "wiki-life" {
  return rel.startsWith("life/") ? "wiki-life" : "wiki";
}

/** Extract a YouTube video id from a watch/short/embed url; undefined otherwise. */
function youtubeId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) ??
    url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/) ??
    url.match(/youtube\.com\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : undefined;
}

/** Human platform label for a source url — matches the canonical dated pages. */
function platformFor(url: string | undefined): string {
  if (!url) return "Web";
  if (/youtube\.com|youtu\.be/.test(url)) return "YouTube";
  if (/(\/\/|\.)x\.com|twitter\.com/.test(url)) return "X";
  if (/substack\.com/.test(url)) return "Substack";
  return "Web";
}

/** Build a video-id → upload-date (YYYY-MM-DD) map from the transcripts store. */
async function buildYoutubeDateIndex(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let files = 0;
  try {
    const glob = new Glob("**/*.md");
    for await (const rel of glob.scan({ cwd: root, dot: false })) {
      if (rel.split("/").some((s) => s.startsWith("."))) continue;
      let text: string;
      try {
        text = await Bun.file(path.join(root, rel)).text();
      } catch {
        continue;
      }
      const fm = parseFrontmatter(text);
      const url = typeof fm.url === "string" ? fm.url : "";
      const date = typeof fm.date === "string" ? fm.date : "";
      const id = youtubeId(url);
      const iso = date.match(ISO)?.[1];
      if (id && iso && !map.has(id)) map.set(id, iso);
      files++;
    }
  } catch (err) {
    console.warn(`! transcripts dir unreadable at ${root}: ${err instanceof Error ? err.message : err}`);
  }
  console.log(`youtube-transcripts: scanned ${files} files → ${map.size} dated video ids\n`);
  return map;
}

interface Plan {
  relPath: string;
  name: string;
  date: string;
  reason: "in-page-date" | "youtube-transcript";
  before: string; // one-line before-context for the dry-run
  next: string; // full new content
}

/**
 * Case A — a page carrying a body `Date: YYYY-MM-DD` line. Fold the adjacent
 * `URL:`/`Date:` metadata block into one canonical `Source:` line in place.
 */
function planFromDateLine(content: string, fmUrl: string | undefined): Omit<Plan, "relPath" | "name" | "reason"> | null {
  const dm = content.match(DATE_LINE_RE);
  if (!dm) return null;
  const date = dm[1]!;
  const lines = content.split("\n");
  const di = lines.findIndex((l) => /^Date:\s*\d{4}-\d{2}-\d{2}\s*$/.test(l));
  if (di === -1) return null;

  // If a `Source:` line already sits directly above (optionally with a `URL:`
  // line between) — a dateless attribution like `Source: research doc …` — fold
  // the date INTO that existing line rather than adding a second Source line, and
  // drop the now-redundant `Date:` line. (No `.*?`-parseable date on it yet, or
  // the page would have been counted already-dated.)
  const above = lines[di - 1];
  const above2 = lines[di - 2];
  if (above && /^Source:\s*\S/.test(above)) {
    const merged = `${above.replace(/[\s,]+$/, "")}, ${date}`;
    const before = `${above} / ${lines[di]}`;
    const next = [...lines.slice(0, di - 1), merged, ...lines.slice(di + 1)].join("\n");
    return { date, before, next };
  }
  if (above && above2 && /^URL:\s*\S+/i.test(above) && /^Source:\s*\S/.test(above2)) {
    const merged = `${above2.replace(/[\s,]+$/, "")}, ${date}`;
    const before = `${above2} / ${above} / ${lines[di]}`;
    // keep the URL: line, drop the Date: line, date-stamp the Source: line
    const next = [...lines.slice(0, di - 2), merged, above, ...lines.slice(di + 1)].join("\n");
    return { date, before, next };
  }

  // Otherwise fold an adjacent `URL:`/`Date:` block into one canonical Source line.
  let start = di;
  let url = fmUrl ?? "";
  const prev = lines[di - 1];
  if (prev && /^URL:\s*\S+/i.test(prev)) {
    start = di - 1;
    url = prev.replace(/^URL:\s*/i, "").trim();
  }
  const sourceLine = url
    ? `Source: ${platformFor(url)}, ${date} — ${url}`
    : `Source: ${platformFor(url)}, ${date}`;
  const before = lines.slice(start, di + 1).join(" / ");
  const next = [...lines.slice(0, start), sourceLine, ...lines.slice(di + 1)].join("\n");
  return { date, before, next };
}

/**
 * Case B — a url-only page. Insert a canonical `Source:` line as its own
 * paragraph directly after the H1 title, leaving the prose untouched.
 */
function planInsertSource(content: string, url: string, date: string): Omit<Plan, "relPath" | "name" | "reason"> | null {
  const lines = content.split("\n");
  const hi = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (hi === -1) return null;
  const sourceLine = `Source: ${platformFor(url)}, ${date} — ${url}`;
  // Rebuild: …H1, blank, Source, blank, <rest with leading blanks trimmed>.
  const rest = lines.slice(hi + 1);
  while (rest.length && rest[0]!.trim() === "") rest.shift();
  const next = [...lines.slice(0, hi + 1), "", sourceLine, "", ...rest].join("\n");
  const before = lines[hi]!;
  return { date, before, next };
}

// ── main ─────────────────────────────────────────────────────────────────────
console.log(`wiki root:        ${WIKI_ROOT}`);
console.log(`transcripts root: ${TRANSCRIPTS_ROOT}`);
console.log(`mode:             ${apply ? "APPLY (writing)" : "DRY-RUN (default)"}${limit ? `  limit=${limit}` : ""}\n`);

const ytDates = await buildYoutubeDateIndex(TRANSCRIPTS_ROOT);

// Scan wiki source pages. A "source" page lives under sources/ or life/*/sources/
// (mirrors the store's folder→type fallback) — we read frontmatter to be sure.
const glob = new Glob("**/*.{md,mdx}");
const relPaths: string[] = [];
for await (const rel of glob.scan({ cwd: WIKI_ROOT, dot: false })) {
  if (rel.split("/").some((s) => s.startsWith(".") || s === "node_modules")) continue;
  relPaths.push(rel);
}
relPaths.sort();

const plans: Plan[] = [];
const counts = {
  alreadyDated: 0,
  planInPageDate: 0,
  planYoutube: 0,
  skipXPost: 0,
  skipNoMatch: 0,
  skipNoUrl: 0,
  skipVerifyFail: 0,
  notSource: 0,
};

for (const rel of relPaths) {
  let content: string;
  try {
    content = await Bun.file(path.join(WIKI_ROOT, rel)).text();
  } catch {
    continue;
  }
  const fm = parseFrontmatter(content);
  const folder = rel.replace(/^life\//, "").split("/")[0] ?? "";
  const isSource = fm.type === "source" || (fm.type === undefined && folder === "sources");
  if (!isSource) {
    counts.notSource++;
    continue;
  }
  if (extractPubDate(content)) {
    counts.alreadyDated++;
    continue;
  }
  const body = stripFrontmatter(content);
  const fmUrl = typeof fm.url === "string" ? fm.url : undefined;

  let plan: (Omit<Plan, "relPath" | "name" | "reason"> & { reason: Plan["reason"] }) | null = null;

  // Case A: in-page Date line (date already in the file).
  if (DATE_LINE_RE.test(body)) {
    const p = planFromDateLine(content, fmUrl);
    if (p) plan = { ...p, reason: "in-page-date" };
  }

  // Case B: url-only → YouTube transcript upload date.
  if (!plan) {
    const bodyUrl = body.match(/^URL:\s*(\S+)/im)?.[1];
    const url = fmUrl ?? bodyUrl ?? body.match(/https?:\/\/\S+/)?.[0];
    const id = youtubeId(url);
    if (!url) {
      counts.skipNoUrl++;
      continue;
    }
    if (!id) {
      // Non-YouTube url with no in-page date — we have no confident pub date.
      if (/(\/\/|\.)x\.com|twitter\.com/.test(url)) counts.skipXPost++;
      else counts.skipNoMatch++;
      continue;
    }
    const date = ytDates.get(id);
    if (!date) {
      counts.skipNoMatch++;
      continue;
    }
    const p = planInsertSource(content, url, date);
    if (p) plan = { ...p, reason: "youtube-transcript" };
  }

  if (!plan) {
    counts.skipNoMatch++;
    continue;
  }

  // Verify before trusting the edit.
  const parsed = extractPubDate(plan.next);
  const sourceLines = plan.next.match(SOURCE_LINE_COUNT_RE)?.length ?? 0;
  if (parsed !== plan.date || sourceLines !== 1) {
    counts.skipVerifyFail++;
    console.warn(`! verify-fail ${rel}: parsed=${parsed} want=${plan.date} sourceLines=${sourceLines}`);
    continue;
  }

  plans.push({ relPath: rel, name: path.basename(rel).replace(/\.mdx?$/i, ""), ...plan });
  if (plan.reason === "in-page-date") counts.planInPageDate++;
  else counts.planYoutube++;
}

// Apply the limit (dry-run inspection aid) after planning so counts stay honest.
const toApply = limit > 0 ? plans.slice(0, limit) : plans;

// ── report ───────────────────────────────────────────────────────────────────
console.log(`Planned edits (${plans.length}${limit ? `, applying ${toApply.length}` : ""}):\n`);
for (const p of toApply) {
  console.log(`  [${p.reason === "in-page-date" ? "date-line" : "yt-upload "}] ${p.date}  ${p.relPath}`);
}

// Decide commit+reindex BEFORE writing so a clean-repo check reflects the
// pre-write state, not the tree we're about to dirty.
const repoWasClean = apply ? await repoCleanAtStart(WIKI_ROOT) : false;
const shouldCommit = apply && !noCommitFlag && (commitFlag || repoWasClean);

if (apply) {
  let written = 0;
  const writtenRelPaths: string[] = [];
  for (const p of toApply) {
    await Bun.write(path.join(WIKI_ROOT, p.relPath), p.next);
    writtenRelPaths.push(p.relPath);
    written++;
  }
  console.log(`\n✓ wrote ${written} files.`);

  if (shouldCommit && writtenRelPaths.length > 0) {
    const message = `[script:backfill-wiki-pubdates] update: ${writtenRelPaths.length} pages`;
    // Await the async push settle so this short-lived script doesn't exit before
    // the commit's push lands (the helper awaits only the local commit itself).
    await new Promise<void>((resolve) => {
      commitWikiChange(WIKI_ROOT, writtenRelPaths, message, { onPushSettled: resolve }).catch(() =>
        resolve(),
      );
    });
    console.log(`✓ committed ${writtenRelPaths.length} pages (${message}).`);

    // Fire the huginn reindex for every touched collection.
    const collections = new Set(writtenRelPaths.map(collectionForPath));
    for (const collection of collections) {
      try {
        await fetchKnowledgeApi(
          KNOWLEDGE_API_URL,
          `/api/collections/${encodeURIComponent(collection)}/update`,
          { method: "POST", timeoutMs: 10_000 },
        );
        console.log(`✓ reindex triggered for "${collection}".`);
      } catch (err) {
        console.warn(`! reindex for "${collection}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  } else if (apply && !noCommitFlag && !repoWasClean && !commitFlag) {
    console.log(`(repo not clean at start — skipping commit; pass --commit to force)`);
  }
} else {
  console.log(`\n(dry-run — no files written; pass --apply to write)`);
}

console.log(`\n── summary ──`);
console.log(`  already dated (parseable Source: line): ${counts.alreadyDated}`);
console.log(`  PLAN in-page Date line → Source:        ${counts.planInPageDate}`);
console.log(`  PLAN YouTube transcript upload date:    ${counts.planYoutube}`);
console.log(`  skip — X post, no confident date:       ${counts.skipXPost}`);
console.log(`  skip — url but no transcript match:     ${counts.skipNoMatch}`);
console.log(`  skip — no url at all:                   ${counts.skipNoUrl}`);
console.log(`  skip — failed edit verification:        ${counts.skipVerifyFail}`);
const totalPlan = counts.planInPageDate + counts.planYoutube;
console.log(`\n  → would raise dated sources by ${totalPlan} (from ${counts.alreadyDated} to ${counts.alreadyDated + totalPlan}).`);
