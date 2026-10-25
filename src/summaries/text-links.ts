/**
 * The links in a TEXT capture (an X article, a pasted article) — pure.
 *
 * The rule set differs from the YouTube description's (`description-links.ts`):
 * a text has no source block and no creator promo, so there is NO by-rule
 * placement. Social profiles and X self-links (`isSkippedHost`: x.com,
 * twitter.com and an unresolved `t.co`) are dropped; every other `http(s)`
 * URL is a candidate the model picks from, deduplicated by `linkKey` (first
 * occurrence wins), capped at {@link TEXT_LINKS_MAX}. A line's title is the
 * markdown link's text, else `host/path`; its provenance reads `from text`.
 *
 * A `t.co` href is replaced by its resolved target BEFORE this runs, in the
 * text the model reads and therefore in the numbered list
 * (`text-links-run.ts`).
 */

import { isSkippedHost } from "./doc-links.ts";
import { renderLinksSection, type LinkLine, type LinksPick } from "./links-section.ts";
import { extractLineUrls, hostAndPath, isRepoUrl, isSocialUrl, linkKey } from "../youtube/description-links.ts";

/** At most this many candidates reach the prompt. */
export const TEXT_LINKS_MAX = 40;

export interface TextLink {
  /** 1-based, the number the model picks by. */
  readonly id: number;
  readonly url: string;
  readonly title: string;
  readonly cls: "repo" | "candidate";
}

const TITLE_MAX = 200;
const URLISH_RE = /^(?:https?:\/\/)?(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?(?:…|\.\.\.)?$/i;

function titleFor(url: string, linkText: string | undefined): string {
  const text = (linkText ?? "").replace(/\s+/g, " ").trim();
  if (text === "" || URLISH_RE.test(text)) return hostAndPath(url).slice(0, TITLE_MAX);
  return text.slice(0, TITLE_MAX);
}

/**
 * Every candidate URL in `text`, numbered 1..n in order of first appearance,
 * at most {@link TEXT_LINKS_MAX}. Code is not special-cased: a URL in a code
 * block is a URL the text carries.
 */
export function classifyTextLinks(text: string): TextLink[] {
  const seen = new Set<string>();
  const out: TextLink[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const found of extractLineUrls(line)) {
      if (out.length >= TEXT_LINKS_MAX) return out;
      let parsed: URL;
      try {
        parsed = new URL(found.url);
      } catch {
        continue;
      }
      if (isSkippedHost(parsed.hostname) || isSocialUrl(parsed)) continue;
      const key = linkKey(found.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: out.length + 1,
        url: found.url,
        title: titleFor(found.url, found.linkText),
        cls: isRepoUrl(parsed) ? "repo" : "candidate",
      });
    }
  }
  return out;
}

/** The distinct `t.co` URLs in `text`, in order — what the run resolves. */
export function tcoUrlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    for (const { url } of extractLineUrls(line)) {
      try {
        if (new URL(url).hostname.toLowerCase() === "t.co") out.add(url);
      } catch {
        // not a URL
      }
    }
  }
  return [...out];
}

/** `text` with each resolved URL spelled as its target, wherever it occurs. */
export function substituteUrls(text: string, targets: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of targets) {
    // Not followed by a path character, so `https://t.co/ab` never rewrites
    // inside `https://t.co/abc`.
    const re = new RegExp(`${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w/-])`, "g");
    out = out.replace(re, () => to);
  }
  return out;
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
