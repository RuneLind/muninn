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
  classifyTextLinksCounted,
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
  /** Distinct candidates past the {@link TEXT_LINKS_MAX} cap, left out of `links`. */
  readonly linksTruncated: number;
  /** `t.co` URLs found, and how many resolved. */
  readonly tcoFound: number;
  readonly tcoResolved: number;
}

function isTcoUrl(url: string): boolean {
  return new URL(url).hostname.toLowerCase() === "t.co";
}

/**
 * The final target of every URL in `first` that resolved, in `first`'s order.
 * One pool of {@link TCO_CONCURRENCY} lookups, one budget, and every URL looked
 * up at most once (a shortener both bare in the text and a `t.co` target shares
 * one lookup). A `t.co` that lands on a known shortener chains its second hop
 * the moment its own first hop answers, so a hanging link starves no other.
 *
 * Second hops share what the cap leaves (`TEXT_LINKS_MAX - first.length`), in
 * text order, so the map does not depend on which answer came first. A `t.co`
 * claims a lookup at once when one is left even if every earlier `t.co` still
 * unanswered claims one too; otherwise it waits for those earlier claims. Only
 * a cap that tight makes a link wait on a slower one.
 */
async function resolveRedirects(
  first: readonly string[],
  resolve: (url: string, signal: AbortSignal) => Promise<string | null>,
  budget: AbortSignal,
  deadline: Promise<null>,
): Promise<Map<string, string>> {
  let free = TCO_CONCURRENCY;
  const waiting: Array<() => void> = [];
  const acquire = (): Promise<void> => {
    if (free > 0) {
      free--;
      return Promise.resolve();
    }
    return new Promise((r) => waiting.push(r));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else free++;
  };
  // Past the budget a queued lookup runs only to see the abort and answer null.
  budget.addEventListener("abort", () => waiting.splice(0).forEach((w) => w()), { once: true });

  const memo = new Map<string, Promise<string | null>>();
  const lookup = (url: string): Promise<string | null> => {
    let answer = memo.get(url);
    if (answer === undefined) {
      answer = (async () => {
        await acquire();
        try {
          if (budget.aborted) return null;
          const target = await Promise.race([resolve(url, budget).catch(() => null), deadline]);
          return target !== null && target !== url ? target : null;
        } finally {
          release();
        }
      })();
      memo.set(url, answer);
    }
    return answer;
  };

  const firstHops = first.map(lookup);
  const left = TEXT_LINKS_MAX - first.length;
  let claimed = 0;
  const decided: Promise<void>[] = [];
  const isDecided: boolean[] = [];
  const finals = new Map<string, Promise<string | null>>();
  for (const url of first.filter(isTcoUrl)) {
    const p = decided.length;
    let resolveDecided!: () => void;
    decided.push(new Promise<void>((r) => (resolveDecided = r)));
    isDecided.push(false);
    const decide = () => {
      isDecided[p] = true;
      resolveDecided();
    };
    finals.set(
      url,
      (async () => {
        try {
          const target = await lookup(url);
          if (target === null || !isShortenerUrl(target)) return target;
          for (;;) {
            if (memo.has(target)) break;
            const pending = decided.slice(0, p).filter((_, j) => !isDecided[j]);
            if (pending.length === 0 || claimed + pending.length < left) break;
            await Promise.race(pending);
          }
          if (!memo.has(target)) {
            if (claimed >= left) return target;
            claimed++;
            lookup(target);
          }
          decide();
          return (await memo.get(target)!) ?? target;
        } finally {
          decide();
        }
      })(),
    );
  }

  const out = new Map<string, string>();
  const answers = await Promise.all(first.map((url, i) => finals.get(url) ?? firstHops[i]!));
  first.forEach((url, i) => {
    const target = answers[i];
    if (target !== null && target !== undefined && target !== url) out.set(url, target);
  });
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
 *    ONE more hop, chained on its own first hop, while lookups are left
 *    (`resolveRedirects`). A URL is looked up once, whichever way it is reached.
 *
 * The targets replace the URLs in one pass over the text. An unresolved `t.co`
 * stays in the text and is dropped from the list (`isSkippedHost`); an
 * unresolved shortener stays as a candidate. `ownUrl` is the capture's own
 * address, never listed.
 */
export async function prepareTextLinks(text: string, deps: TextLinksDeps = {}, ownUrl?: string): Promise<PreparedTextLinks> {
  const found = redirectUrlsIn(text);
  const tcoFound = found.filter(isTcoUrl).length;
  let targets = new Map<string, string>();
  if (found.length > 0) {
    const resolve =
      deps.resolveRedirect ?? ((url: string, signal: AbortSignal) => safeResolveRedirect(url, { signal, caller: "text-links" }));
    const budget = new AbortController();
    const budgetMs = deps.tcoBudgetMs ?? SAFE_RESOLVE_TIMEOUT_MS;
    const timer = setTimeout(() => budget.abort(), budgetMs);
    const deadline = new Promise<null>((r) => budget.signal.addEventListener("abort", () => r(null), { once: true }));
    try {
      targets = await resolveRedirects(found.slice(0, TEXT_LINKS_MAX), resolve, budget.signal, deadline);
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
  const tcoResolved = [...targets.keys()].filter(isTcoUrl).length;
  const substituted = substituteUrls(text, targets);
  const { links, truncated } = classifyTextLinksCounted(substituted, ownUrl);
  return { text: substituted, links, linksTruncated: truncated, tcoFound, tcoResolved };
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

/** The summary span's link attributes: candidates listed and cut by the cap, `t.co` links found and resolved. */
export function linkTraceAttrs(prepared: PreparedTextLinks): Record<string, string> {
  return {
    linkCandidates: String(prepared.links.length),
    linkCandidatesTruncated: String(prepared.linksTruncated),
    tcoFound: String(prepared.tcoFound),
    tcoResolved: String(prepared.tcoResolved),
  };
}
