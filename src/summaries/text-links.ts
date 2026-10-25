/**
 * The links in a TEXT capture (an X article, a pasted article) — pure.
 *
 * The rule set differs from the YouTube description's (`description-links.ts`):
 * a text has no source block and no creator promo, so there is NO by-rule
 * placement. Social profiles (a YouTube playlist is content here, not promo),
 * X self-links (`isSkippedHost`: x.com, twitter.com and an unresolved `t.co`),
 * X's media hosts (`*.twimg.com`) and the capture's own URL are dropped; every
 * other `http(s)` URL is a candidate the model picks from, deduplicated by
 * `linkKey` (first occurrence wins), capped at {@link TEXT_LINKS_MAX}. A line's
 * title is the markdown link's text; for a bare URL, the words before it on
 * its line when they end in ` — `, `: ` or ` - `; else `host/path`, plus the
 * query when the path has at most one segment. Its provenance reads `from text`.
 *
 * A `t.co` href (and a known shortener's) is replaced by its resolved target
 * BEFORE this runs, in the text the model reads and therefore in the numbered
 * list (`text-links-run.ts`).
 */

import { isSkippedHost } from "./doc-links.ts";
import { renderLinksSection, type LinkLine, type LinksPick } from "./links-section.ts";
import {
  bareHost,
  extractLineUrls,
  hostAndPath,
  isRepoUrl,
  isShortenerHost,
  isSocialUrl,
  leadInTitle,
  linkKey,
} from "../youtube/description-links.ts";

/** At most this many candidates reach the prompt, and at most this many redirect lookups run per text. */
export const TEXT_LINKS_MAX = 40;

export interface TextLink {
  /** 1-based, the number the model picks by. */
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly cls: "repo" | "candidate";
}

const TITLE_MAX = 200;
/** The most of a query a fallback title carries. */
const TITLE_QUERY_MAX = 60;
const URLISH_RE = /^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?(?:…|\.\.\.)?$/i;

/**
 * `host/path`, plus the query when the path alone does not tell links apart
 * (at most one segment: `youtube.com/watch?v=abc`), tracking parameters dropped.
 */
function fallbackTitle(url: string): string {
  const base = hostAndPath(url);
  try {
    const u = new URL(url);
    if (u.pathname.split("/").filter((s) => s !== "").length > 1) return base.slice(0, TITLE_MAX);
    for (const k of [...u.searchParams.keys()]) {
      if (/^(?:utm_.*|si|ref|fbclid|gclid)$/i.test(k)) u.searchParams.delete(k);
    }
    const query = u.searchParams.toString();
    return (query === "" ? base : `${base}?${query.slice(0, TITLE_QUERY_MAX)}`).slice(0, TITLE_MAX);
  } catch {
    return base.slice(0, TITLE_MAX);
  }
}

function titleFor(url: string, linkText: string | undefined, before: string): string {
  if (linkText === undefined) {
    const lead = leadInTitle(before);
    return lead === "" ? fallbackTitle(url) : lead;
  }
  const text = linkText.replace(/\s+/g, " ").trim();
  if (text === "" || URLISH_RE.test(text)) return fallbackTitle(url);
  return text.slice(0, TITLE_MAX);
}

/** X's media hosts (`pbs.twimg.com`, `video.twimg.com`): the post's own pictures, never a link it cites. */
function isXMediaHost(hostname: string): boolean {
  const h = bareHost(hostname);
  return h === "twimg.com" || h.endsWith(".twimg.com");
}

/**
 * The description rule's social check, minus YouTube playlists: in a
 * description a playlist is the creator's promo, in an article's resource list
 * it is content. Channels and profiles stay social.
 */
function isSocialInText(url: URL): boolean {
  if (bareHost(url.hostname) === "youtube.com" && url.pathname.split("/")[1] === "playlist") return false;
  return isSocialUrl(url);
}

/**
 * Every candidate URL in `text`, numbered 1..n in order of first appearance,
 * at most {@link TEXT_LINKS_MAX}. Code is not special-cased: a URL in a code
 * block is a URL the text carries. `ownUrl` is the capture's own address; a
 * link to it (same `linkKey`) is not listed.
 */
export function classifyTextLinks(text: string, ownUrl?: string): TextLink[] {
  return classifyTextLinksCounted(text, ownUrl).links;
}

/**
 * {@link classifyTextLinks}, plus `truncated`: how many distinct candidates the
 * cap left out. The cap counts candidates, so dropped social and X links never
 * use it up.
 */
export function classifyTextLinksCounted(text: string, ownUrl?: string): { links: TextLink[]; truncated: number } {
  const seen = new Set<string>();
  if (ownUrl !== undefined && ownUrl.trim() !== "") seen.add(linkKey(ownUrl.trim()));
  const out: TextLink[] = [];
  let truncated = 0;
  for (const line of text.split(/\r?\n/)) {
    let prevEnd = 0;
    for (const found of extractLineUrls(line)) {
      const before = line.slice(prevEnd, found.index).replace(/^\)/, "");
      prevEnd = found.index + found.url.length;
      let parsed: URL;
      try {
        parsed = new URL(found.url);
      } catch {
        continue;
      }
      if (isSkippedHost(parsed.hostname) || isXMediaHost(parsed.hostname) || isSocialInText(parsed)) continue;
      const key = linkKey(found.url);
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= TEXT_LINKS_MAX) {
        truncated++;
        continue;
      }
      out.push({
        id: out.length + 1,
        url: found.url,
        title: titleFor(found.url, found.linkText, before),
        cls: isRepoUrl(parsed) ? "repo" : "candidate",
      });
    }
  }
  return { links: out, truncated };
}

/** The distinct `t.co` URLs in `text`, in order — what the run resolves first. */
export function tcoUrlsIn(text: string): string[] {
  return redirectUrlsIn(text).filter((u) => new URL(u).hostname.toLowerCase() === "t.co");
}

/**
 * The distinct URLs in `text` that the run may resolve, in order of first
 * appearance: `t.co` and the known shorteners (`isShortenerHost`).
 */
export function redirectUrlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    for (const { url } of extractLineUrls(line)) {
      try {
        const host = new URL(url).hostname.toLowerCase();
        if (host === "t.co" || isShortenerHost(host)) out.add(url);
      } catch {
        // not a URL
      }
    }
  }
  return [...out];
}

/**
 * `text` with each resolved URL spelled as its target, in ONE pass over the
 * original text: a target that itself carries a mapped URL
 * (`…?u=https://t.co/b`) is never rewritten again.
 */
export function substituteUrls(text: string, targets: ReadonlyMap<string, string>): string {
  if (targets.size === 0) return text;
  // Longest first, and not followed by a path character, so `https://t.co/ab`
  // never rewrites inside `https://t.co/abc`.
  const alternatives = [...targets.keys()]
    .sort((a, b) => b.length - a.length)
    .map((from) => from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`(?:${alternatives.join("|")})(?![\\w/-])`, "g");
  return text.replace(re, (match) => targets.get(match) ?? match);
}

/**
 * The `LINKS:` envelope step for a text capture, placed between CATEGORY and
 * SUMMARY like YouTube's (`LINKS_STEP_TEXT`, `src/youtube/prompt.ts`).
 */
export const TEXT_LINKS_STEP_TEXT =
  'Then add one line "LINKS: <ids>" naming the numbered links under "## Links in the text" in the user message ' +
  "that the article discusses or cites (for example LINKS: 1, 3), or LINKS: none. Muninn appends the links section " +
  "to the summary itself, so do not write a links section and do not copy those URLs into the summary.";

/** The envelope slot entry the text verticals pass when the list is non-empty. */
export const TEXT_LINKS_STEP = { id: "links-step", label: "LINKS: step", text: TEXT_LINKS_STEP_TEXT } as const;

/** The numbered list appended to the user prompt, or "" with no candidate. */
export function textLinksPromptSection(links: readonly TextLink[]): string {
  if (links.length === 0) return "";
  return (
    "\n\n## Links in the text\n\n" +
    links.map((l) => `${l.id}. ${l.title} — ${l.url}${l.cls === "repo" ? " [code or paper]" : ""}`).join("\n")
  );
}

export interface PickedTextLinks {
  /** The lines the pick names, in list order — before any repo detail. */
  readonly lines: LinkLine[];
  /** Ids the model named that the list does not have — dropped. */
  readonly unknownIds: number[];
}

/** The section lines for the model's pick: a candidate goes in only when its id was picked. */
export function pickTextLinks(links: readonly TextLink[], pick: LinksPick): PickedTextLinks {
  const asked = Array.isArray(pick) ? pick : [];
  const ids = new Set(links.map((l) => l.id));
  const chosen = new Set(asked.filter((id) => ids.has(id)));
  return {
    lines: links
      .filter((l) => chosen.has(l.id))
      .map((l) => ({ icon: l.cls === "repo" ? "📦" : "📄", title: l.title, url: l.url, detail: "", provenance: "from text" })),
    unknownIds: asked.filter((id) => !ids.has(id)),
  };
}

/** The rendered section for these lines, or `null` when none qualified. */
export function renderTextLinksSection(lines: readonly LinkLine[]): string | null {
  return renderLinksSection({ lines: [...lines], omitted: 0 });
}
