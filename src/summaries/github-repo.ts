/**
 * A GitHub repo link's detail line: description, language, license and stars
 * with the date they were read (plan muninn-summary-links, D7).
 *
 * One `GET https://api.github.com/repos/<owner>/<repo>` per repo (owner and
 * name compared case-insensitively), at most 4 at once, all of a capture's
 * repos under ONE 5 s budget, and only for a repo root or its default-branch
 * tree: a pull request, an issue or a file keeps its own plain line.
 * Authenticated when `MUNINN_GITHUB_TOKEN` is set, anonymous otherwise (60
 * requests an hour per address). A muninn-scoped name, so a broad personal
 * `GITHUB_TOKEN` in a developer's shell is never picked up silently. Any
 * failure — a 404, a timeout, an unreadable body — gives `null`, and the
 * caller writes the plain link line; a rate-limit answer (429, or 403 with
 * `x-ratelimit-remaining: 0`) also stops the lookups still queued.
 *
 * The parts are joined with `, `: the section renderer replaces ` · ` inside a
 * detail with `, ` anyway (`links-section.ts`), since ` · ` separates the
 * provenance. An existing attribution is set apart with ` – `.
 */

import { getLog } from "../logging.ts";
import { githubRepoOf } from "../youtube/description-links.ts";
import type { LinkLine } from "./links-section.ts";

export { githubRepoOf };

const log = getLog("summaries", "github-repo");

export const GITHUB_REPO_TIMEOUT_MS = 5_000;
/** How many repo lookups run at once. */
export const GITHUB_REPO_CONCURRENCY = 4;
const API_BASE = "https://api.github.com";

/**
 * The repo a URL gets a repo LINE for: the repo root, or `/tree/<branch>` with
 * nothing after it (the lookup then checks `<branch>` is the default branch).
 * Any deeper page — a pull request, an issue, a file, a subdirectory — gets
 * none: its line stays its own. `null` for those and for non-repo URLs.
 */
export function repoLineRef(url: string): { owner: string; repo: string; branch?: string } | null {
  const ref = githubRepoOf(url);
  if (ref === null) return null;
  const segs = new URL(url).pathname.split("/").filter((s) => s !== "");
  if (segs.length === 2) return ref;
  if (segs.length === 4 && segs[2] === "tree") return { ...ref, branch: decodeURIComponent(segs[3]!) };
  return null;
}

/** `2134` → `2.1k`, `1_200_000` → `1.2M`; a count that rounds to 1000 of a unit reads as the next unit. */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  for (const [size, suffix] of [[1e3, "k"], [1e6, "M"]] as const) {
    // Rounded to one decimal first: 999_950 is 1000.0k, so it reads as 1M.
    const rounded = Math.round(n / (size / 10)) / 10;
    if (rounded < 1000) return `${rounded.toFixed(1).replace(/\.0$/, "")}${suffix}`;
  }
  return `${(Math.round(n / 1e8) / 10).toFixed(1).replace(/\.0$/, "")}B`;
}

interface RepoJson {
  description?: unknown;
  language?: unknown;
  license?: { spdx_id?: unknown; name?: unknown } | null;
  stargazers_count?: unknown;
  default_branch?: unknown;
}

/** The detail text for one repo's API answer, read on `day` (`YYYY-MM-DD`). */
export function repoDetail(json: RepoJson, day: string): string {
  const parts: string[] = [];
  if (typeof json.description === "string" && json.description.trim() !== "") parts.push(json.description.trim());
  if (typeof json.language === "string" && json.language !== "") parts.push(json.language);
  const spdx = json.license?.spdx_id;
  if (typeof spdx === "string" && spdx !== "" && spdx !== "NOASSERTION") parts.push(spdx);
  else if (typeof json.license?.name === "string" && json.license.name !== "") parts.push(json.license.name);
  if (typeof json.stargazers_count === "number" && Number.isFinite(json.stargazers_count)) {
    parts.push(`★ ${formatStars(json.stargazers_count)} on ${day}`);
  }
  return parts.join(", ");
}

/** A lookup's answer when GitHub said the rate limit is spent: the caller stops looking up. */
export const REPO_RATE_LIMITED = { rateLimited: true } as const;

/**
 * Looks a repo URL up: its detail line, `null` (not a repo-line URL, or any
 * failure), or {@link REPO_RATE_LIMITED}.
 */
export type RepoLineLookup = (url: string, signal: AbortSignal) => Promise<string | null | typeof REPO_RATE_LIMITED>;

export interface GitHubRepoLookupOptions {
  /** Default: `process.env.MUNINN_GITHUB_TOKEN`, read at call time. */
  token?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam: the day the stars were read. */
  today?: () => string;
  apiBase?: string;
}

export function githubRepoLookup(options: GitHubRepoLookupOptions = {}): RepoLineLookup {
  const doFetch = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? API_BASE;
  return async (url, signal) => {
    const ref = repoLineRef(url);
    if (ref === null) return null;
    const token = (options.token ?? process.env.MUNINN_GITHUB_TOKEN ?? "").trim();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "muninn",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token !== "") headers.Authorization = `Bearer ${token}`;
    try {
      const res = await doFetch(`${apiBase}/repos/${ref.owner}/${ref.repo}`, { headers, signal });
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        const rateLimited = res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
        log.info("GitHub repo lookup for {repo}: status {status} — plain link line", {
          repo: `${ref.owner}/${ref.repo}`,
          status: res.status,
          rateLimited,
          authenticated: token !== "",
        });
        return rateLimited ? REPO_RATE_LIMITED : null;
      }
      const json = (await res.json()) as RepoJson;
      // `/tree/<branch>` is the repo's front page only on its default branch.
      if (ref.branch !== undefined && json.default_branch !== ref.branch) return null;
      const day = options.today?.() ?? new Date().toISOString().slice(0, 10);
      const detail = repoDetail(json, day);
      return detail === "" ? null : detail;
    } catch (err) {
      log.info("GitHub repo lookup for {repo} failed: {error} — plain link line", {
        repo: `${ref.owner}/${ref.repo}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}

/** One lookup per repo, whatever the case of its owner and name. */
function repoKey(url: string): string | null {
  const ref = repoLineRef(url);
  if (ref === null) return null;
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}${ref.branch !== undefined ? `@${ref.branch}` : ""}`;
}

/**
 * The lines with a repo detail where the lookup gave one: every line whose URL
 * is a repo root or its default-branch tree (`repoLineRef`), one lookup per
 * repo, at most {@link GITHUB_REPO_CONCURRENCY} at once, all under ONE
 * {@link GITHUB_REPO_TIMEOUT_MS} budget. After a rate-limit answer the rest are
 * not looked up. A line that already has a detail (a description's
 * attribution) keeps it in front, separated by ` – `. A failed lookup, or a
 * deeper page in a repo, leaves its line exactly as it was.
 */
export async function withRepoDetails(
  lines: readonly LinkLine[],
  lookup: RepoLineLookup | undefined,
  timeoutMs: number = GITHUB_REPO_TIMEOUT_MS,
): Promise<LinkLine[]> {
  const keys = lines.map((l) => repoKey(l.url));
  if (lookup === undefined || keys.every((k) => k === null)) return [...lines];
  const firstUrl = new Map<string, string>();
  keys.forEach((k, i) => {
    if (k !== null && !firstUrl.has(k)) firstUrl.set(k, lines[i]!.url);
  });
  const details = new Map<string, string>();
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), timeoutMs);
  try {
    const deadline = new Promise<null>((resolve) => budget.signal.addEventListener("abort", () => resolve(null), { once: true }));
    const queue = [...firstUrl.keys()];
    let rateLimited = false;
    const worker = async () => {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        if (rateLimited || budget.signal.aborted) return;
        const answer = await Promise.race([lookup(firstUrl.get(key)!, budget.signal).catch(() => null), deadline]);
        if (typeof answer === "object" && answer !== null && answer.rateLimited) {
          if (!rateLimited) {
            rateLimited = true;
            log.warn("GitHub rate limit reached: {skipped} remaining repo lookup(s) skipped, their lines stay plain", {
              skipped: queue.length,
            });
          }
          return;
        }
        if (typeof answer === "string" && answer !== "") details.set(key, answer);
      }
    };
    await Promise.all(Array.from({ length: Math.min(GITHUB_REPO_CONCURRENCY, queue.length) }, worker));
  } finally {
    clearTimeout(timer);
  }
  return lines.map((line, i) => {
    const detail = keys[i] === null ? undefined : details.get(keys[i]!);
    if (detail === undefined) return line;
    return { ...line, icon: "📦", detail: line.detail === "" ? detail : `${line.detail} – ${detail}` };
  });
}
