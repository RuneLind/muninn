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
  classifyTextLinks,
  pickTextLinks,
  renderTextLinksSection,
  substituteUrls,
  tcoUrlsIn,
  type TextLink,
} from "./text-links.ts";
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

/**
 * Resolve every `t.co` URL in `text` (one hop each, one shared budget), put the
 * targets in its place, and classify the result. An unresolved `t.co` stays in
 * the text and is dropped from the list (`isSkippedHost`).
 */
export async function prepareTextLinks(text: string, deps: TextLinksDeps = {}): Promise<PreparedTextLinks> {
  const tco = tcoUrlsIn(text);
  const targets = new Map<string, string>();
  if (tco.length > 0) {
    const resolve =
      deps.resolveRedirect ?? ((url: string, signal: AbortSignal) => safeResolveRedirect(url, { signal, caller: "text-links" }));
    const budget = new AbortController();
    const budgetMs = deps.tcoBudgetMs ?? SAFE_RESOLVE_TIMEOUT_MS;
    const timer = setTimeout(() => budget.abort(), budgetMs);
    const deadline = new Promise<null>((r) => budget.signal.addEventListener("abort", () => r(null), { once: true }));
    try {
      const queue = [...tco];
      const worker = async () => {
        for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
          if (budget.signal.aborted) return;
          const target = await Promise.race([resolve(url, budget.signal).catch(() => null), deadline]);
          if (target !== null && target !== url) targets.set(url, target);
        }
      };
      await Promise.all(Array.from({ length: Math.min(TCO_CONCURRENCY, tco.length) }, worker));
    } finally {
      clearTimeout(timer);
    }
    if (targets.size < tco.length) {
      log.info("Resolved {resolved} of {found} t.co link(s); the rest stay unexpanded and out of the links list", {
        resolved: targets.size,
        found: tco.length,
      });
    }
  }
  const substituted = substituteUrls(text, targets);
  return { text: substituted, links: classifyTextLinks(substituted), tcoFound: tco.length, tcoResolved: targets.size };
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
