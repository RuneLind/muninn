/**
 * The network half of a text capture's links: `t.co` targets before the model
 * call, repo lines after it. The pure half is `text-links.ts`; both text
 * verticals (`src/x-article/summarizer.ts`, `src/article/summarizer.ts`) call
 * these two functions and nothing else.
 */

import { getLog } from "../logging.ts";
import { SAFE_RESOLVE_TIMEOUT_MS, safeResolveRedirect } from "./safe-fetch.ts";
import { githubRepoLookup, withRepoDetails, type RepoLineLookup } from "./github-repo.ts";
import {
  TEXT_LINKS_MAX,
  classifyTextLinks,
  pickTextLinks,
  redirectUrlsIn,
  renderTextLinksSection,
  substituteUrls,
  type TextLink,
} from "./text-links.ts";
import { isShortenerHost } from "../youtube/description-links.ts";
import type { LinksPick } from "./links-section.ts";

const log = getLog("summaries", "text-links");

/** How many `t.co` lookups run at once inside the shared budget. */
const TCO_CONCURRENCY = 5;

export interface TextLinksDeps {
  /** One redirect hop under a shared signal; default `safeResolveRedirect`. */
  readonly resolveRedirect?: (url: string, signal: AbortSignal) => Promise<string | null>;
  /** The repo-line lookup; default the GitHub API (`MUNINN_GITHUB_TOKEN` optional). */
  readonly repoLine?: RepoLineLookup;
  /** The budget every `t.co` link of one text shares; default 10 s. */
  readonly tcoBudgetMs?: number;
}

export interface PreparedTextLinks {
  /** The text the model reads: every resolved `t.co` URL spelled as its target. */
  readonly text: string;
  /** The numbered candidates, from that text. */
  readonly links: TextLink[];
  /** `t.co` URLs found, and how many resolved. */
  readonly tcoFound: number;
  readonly tcoResolved: number;
}

/** Runs `resolve` over `urls`, {@link TCO_CONCURRENCY} at a time, until the budget aborts. */
async function resolveAll(
  urls: readonly string[],
  resolve: (url: string, signal: AbortSignal) => Promise<string | null>,
  budget: AbortSignal,
  deadline: Promise<null>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const queue = [...urls];
  const worker = async () => {
    for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
      if (budget.aborted) return;
      const target = await Promise.race([resolve(url, budget).catch(() => null), deadline]);
      if (target !== null && target !== url) out.set(url, target);
    }
  };
  await Promise.all(Array.from({ length: Math.min(TCO_CONCURRENCY, urls.length) }, worker));
  return out;
}

function isShortenerUrl(url: string): boolean {
  try {
    return isShortenerHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Resolve the redirects in `text` and classify the result, under ONE shared
 * budget and at most {@link TEXT_LINKS_MAX} lookups in all:
 *
 * 1. every `t.co` URL and every known-shortener URL (`isShortenerHost`), one
 *    hop each, the first {@link TEXT_LINKS_MAX} in order of first appearance;
 * 2. a `t.co` whose target is on a known shortener (`lnkd.in`, `bit.ly`…) gets
 *    ONE more hop, in text order, while lookups are left.
 *
 * The targets replace the URLs in one pass over the text. An unresolved `t.co`
 * stays in the text and is dropped from the list (`isSkippedHost`); an
 * unresolved shortener stays as a candidate. `ownUrl` is the capture's own
 * address, never listed.
 */
export async function prepareTextLinks(text: string, deps: TextLinksDeps = {}, ownUrl?: string): Promise<PreparedTextLinks> {
  const found = redirectUrlsIn(text);
  const isTco = (u: string) => new URL(u).hostname.toLowerCase() === "t.co";
  const tcoFound = found.filter(isTco).length;
  const targets = new Map<string, string>();
  if (found.length > 0) {
    const resolve =
      deps.resolveRedirect ?? ((url: string, signal: AbortSignal) => safeResolveRedirect(url, { signal, caller: "text-links" }));
    const budget = new AbortController();
    const budgetMs = deps.tcoBudgetMs ?? SAFE_RESOLVE_TIMEOUT_MS;
    const timer = setTimeout(() => budget.abort(), budgetMs);
    const deadline = new Promise<null>((r) => budget.signal.addEventListener("abort", () => r(null), { once: true }));
    try {
      const first = found.slice(0, TEXT_LINKS_MAX);
      const firstHop = await resolveAll(first, resolve, budget.signal, deadline);
      for (const url of first) {
        const target = firstHop.get(url);
        if (target !== undefined) targets.set(url, target);
      }
      const left = TEXT_LINKS_MAX - first.length;
      const middles = [
        ...new Set(first.filter((u) => isTco(u) && targets.has(u) && isShortenerUrl(targets.get(u)!)).map((u) => targets.get(u)!)),
      ].slice(0, Math.max(0, left));
      if (middles.length > 0 && !budget.signal.aborted) {
        const secondHop = await resolveAll(middles, resolve, budget.signal, deadline);
        for (const url of first) {
          const final = isTco(url) && targets.has(url) ? secondHop.get(targets.get(url)!) : undefined;
          if (final !== undefined) targets.set(url, final);
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (found.length > targets.size) {
      log.info("Resolved {resolved} of {found} redirect link(s); the rest stay as written", {
        resolved: targets.size,
        found: found.length,
      });
    }
  }
  const tcoResolved = [...targets.keys()].filter(isTco).length;
  const substituted = substituteUrls(text, targets);
  return { text: substituted, links: classifyTextLinks(substituted, ownUrl), tcoFound, tcoResolved };
}

export interface FinishedTextLinks {
  readonly section: string | null;
  readonly picked: number;
  readonly unknownIds: number[];
}

/** The `## Links` section for the model's pick, repo lines included. */
export async function finishTextLinks(
  links: readonly TextLink[],
  pick: LinksPick,
  deps: TextLinksDeps = {},
): Promise<FinishedTextLinks> {
  const { lines, unknownIds } = pickTextLinks(links, pick);
  const detailed = await withRepoDetails(lines, deps.repoLine ?? githubRepoLookup());
  return { section: renderTextLinksSection(detailed), picked: lines.length, unknownIds };
}

/** The summary span's link attributes: candidates listed, `t.co` links found and resolved. */
export function linkTraceAttrs(prepared: PreparedTextLinks): Record<string, string> {
  return {
    linkCandidates: String(prepared.links.length),
    tcoFound: String(prepared.tcoFound),
    tcoResolved: String(prepared.tcoResolved),
  };
}
