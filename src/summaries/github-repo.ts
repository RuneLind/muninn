/**
 * A GitHub repo link's detail line: description, language, license and stars
 * with the date they were read (plan muninn-summary-links, D7).
 *
 * One `GET https://api.github.com/repos/<owner>/<repo>` per repo, all of a
 * capture's repos under ONE 5 s budget. Authenticated when
 * `MUNINN_GITHUB_TOKEN` is set, anonymous otherwise (60 requests an hour per
 * address). A muninn-scoped name, so a broad personal `GITHUB_TOKEN` in a
 * developer's shell is never picked up silently. Any failure — a 404, a rate
 * limit, a timeout, an unreadable body — gives `null`, and the caller writes
 * the plain link line.
 *
 * The parts are joined with `, `: the section renderer replaces ` · ` inside a
 * detail with `, ` anyway (`links-section.ts`), since ` · ` separates the
 * provenance.
 */

import { getLog } from "../logging.ts";
import type { LinkLine } from "./links-section.ts";

const log = getLog("summaries", "github-repo");

export const GITHUB_REPO_TIMEOUT_MS = 5_000;
const API_BASE = "https://api.github.com";

/** First path segments on github.com that are not an owner. */
const NOT_OWNERS = new Set([
  "about", "apps", "collections", "customer-stories", "enterprise", "events", "explore", "features",
  "issues", "login", "marketplace", "new", "notifications", "orgs", "pricing", "pulls", "search",
  "security", "settings", "site", "sponsors", "topics", "trending",
]);

/** `{owner, repo}` for a github.com repo URL (any page inside the repo), or null. */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^(?:www\.)?github\.com$/i.test(parsed.hostname)) return null;
  const [owner, rawRepo] = parsed.pathname.split("/").filter((s) => s !== "");
  if (!owner || !rawRepo || NOT_OWNERS.has(owner.toLowerCase())) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  const name = /^[A-Za-z0-9_.-]+$/;
  return name.test(owner) && name.test(repo) && repo !== "." && repo !== ".." ? { owner, repo } : null;
}

/** `2134` → `2.1k`, `1_200_000` → `1.2M`. */
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

interface RepoJson {
  description?: unknown;
  language?: unknown;
  license?: { spdx_id?: unknown; name?: unknown } | null;
  stargazers_count?: unknown;
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

/** Looks a repo URL up: its detail line, or `null` (not a repo, or any failure). */
export type RepoLineLookup = (url: string, signal: AbortSignal) => Promise<string | null>;

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
    const ref = githubRepoOf(url);
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
        log.info("GitHub repo lookup for {repo}: status {status} — plain link line", {
          repo: `${ref.owner}/${ref.repo}`,
          status: res.status,
          authenticated: token !== "",
        });
        return null;
      }
      const json = (await res.json()) as RepoJson;
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

/**
 * The lines with a repo detail where the lookup gave one: every `📦` line on
 * github.com, looked up in parallel under ONE {@link GITHUB_REPO_TIMEOUT_MS}
 * budget. An existing detail (a description's attribution) is kept in front.
 * A failed lookup leaves its line exactly as it was.
 */
export async function withRepoDetails(
  lines: readonly LinkLine[],
  lookup: RepoLineLookup | undefined,
  timeoutMs: number = GITHUB_REPO_TIMEOUT_MS,
): Promise<LinkLine[]> {
  if (lookup === undefined || !lines.some((l) => githubRepoOf(l.url) !== null)) return [...lines];
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), timeoutMs);
  try {
    const deadline = new Promise<null>((resolve) => budget.signal.addEventListener("abort", () => resolve(null), { once: true }));
    return await Promise.all(
      lines.map(async (line) => {
        if (githubRepoOf(line.url) === null) return line;
        const detail = await Promise.race([lookup(line.url, budget.signal).catch(() => null), deadline]);
        if (detail === null || detail === "") return line;
        return { ...line, icon: "📦", detail: line.detail === "" ? detail : `${line.detail}, ${detail}` };
      }),
    );
  } finally {
    clearTimeout(timer);
  }
}
