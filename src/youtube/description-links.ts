/**
 * The links in a YouTube description, classified — pure and import-free.
 *
 * A description holds two kinds of link: the sources a video names, and the
 * creator's own promo (funnels, shorteners, social profiles). Measured on the
 * reference description (`Q876SRB_-1M`): 9 URLs, 2 sources, 7 promo. The
 * classifier gives every URL exactly ONE class, first rule wins:
 *
 *   social → creator → source (block) → repo → candidate
 *
 * Promo is decided before block membership, so a source block never promotes
 * a funnel or a profile. A `source` URL reaches the stored `## Links` section
 * by rule, whatever the model picks; a `repo` or `candidate` URL only when the
 * model picks its id; `creator` and `social` URLs are never stored, only counted.
 *
 * The rules were checked against the URL and heading shapes of 30 sampled
 * descriptions before they were coded (plan D17); the shapes that changed the
 * table are listed in the PR that added this file. Every rule has an invented
 * fixture in `description-links.test.ts` — the samples stay out of this repo.
 *
 * Pure: its one import is `normalizeDestinationUrl`, itself pure, which the
 * dedup keys on.
 */

import { normalizeDestinationUrl } from "../summaries/destination-url.ts";

export type DescriptionLinkClass = "social" | "creator" | "source" | "repo" | "candidate";

export interface DescriptionLink {
  readonly url: string;
  readonly cls: DescriptionLinkClass;
  /** 0-based line index in the description. */
  readonly line: number;
  /** The entry's title, from its own line or the line above (never empty). */
  readonly title: string;
  /** A trailing parenthetical split off the title, or "". */
  readonly attribution: string;
  /** The prompt hint for a candidate: `uploader's own site` or `repeated host`. */
  readonly hint?: string;
}

/** Hosts that are never the uploader's own funnel, whatever the uploader is called. */
const CONTENT_HOSTS = new Set([
  "anthropic.com",
  "claude.com",
  "claude.dev",
  "claude.ai",
  "openai.com",
  "github.com",
  "arxiv.org",
  "huggingface.co",
]);

/** Link shorteners: nothing about the target can be read off the URL. */
const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "t.ly",
  "tinyurl.com",
  "buff.ly",
  // D17 survey additions: affiliate and sponsor shorteners seen in the sample.
  "amzn.to",
  "goo.gle",
  "goo.gl",
  "hubs.li",
  "ow.ly",
  "lnkd.in",
  "geni.us",
  "jb.gg",
]);

/** First labels that mark a funnel subdomain on the uploader's own domain. */
const FUNNEL_LABELS = new Set(["c", "go", "link", "l", "join", "get"]);

/** Hosts whose path is a profile when it is ONE segment (plus an optional tab). */
const ONE_SEGMENT_PROFILE_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "threads.net",
  // D17: Threads serves profiles on threads.com now.
  "threads.com",
  // D17: a Twitch channel is a profile page.
  "twitch.tv",
]);

const PROFILE_TABS = new Set(["about", "videos", "featured"]);

/** First path segments that are a post or a feature on a one-segment host, never a profile. */
const NON_PROFILE_FIRST_SEGMENTS = new Set(["watch", "share", "story.php", "permalink.php", "photo.php", "hashtag", "search"]);

/** A LinkedIn `/in/<x>/…` or `/company/<x>/…` tail that is a feed of posts, not the profile. */
const LINKEDIN_POST_TABS = new Set(["posts", "recent-activity", "activity"]);

/** Any URL on these hosts is promo: community, membership and link-in-bio pages. */
const ANY_URL_SOCIAL_HOSTS = new Set([
  "patreon.com",
  "discord.gg",
  "linktr.ee",
  // D17: paid-community platforms, seen only as the creator's own funnels.
  "skool.com",
  "whop.com",
]);

/** The host without `www.` / `m.`, lowercased — what the host rules compare. */
export function bareHost(host: string): string {
  return host.toLowerCase().replace(/^(?:www\d?|m|mobile)\./, "");
}

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter((s) => s !== "");
}

/** Rule 1: a profile, home, community or channel page on a social host. */
export function isSocialUrl(url: URL): boolean {
  const host = bareHost(url.hostname);
  const segs = pathSegments(url);
  for (const h of ANY_URL_SOCIAL_HOSTS) if (hostIs(host, h)) return true;
  if (host === "discord.com" && segs[0] === "invite") return true;
  if (ONE_SEGMENT_PROFILE_HOSTS.has(host)) {
    if (segs.length === 0) return false;
    if (host === "tiktok.com" && !segs[0]!.startsWith("@")) return false;
    if (NON_PROFILE_FIRST_SEGMENTS.has(segs[0]!.toLowerCase())) return false;
    if (segs.length === 1) return true;
    return segs.length === 2 && PROFILE_TABS.has(segs[1]!.toLowerCase());
  }
  if (host === "linkedin.com") {
    if (segs[0] !== "in" && segs[0] !== "company") return false;
    return segs.length === 2 || (segs.length === 3 && !LINKEDIN_POST_TABS.has(segs[2]!.toLowerCase()));
  }
  // D17: a Substack profile (`substack.com/@user`).
  if (host === "substack.com") return segs.length === 1 && segs[0]!.startsWith("@");
  // D17: a podcast's show page is its home, not an episode.
  if (host === "open.spotify.com") return segs[0] === "show";
  if (host === "youtube.com") {
    const first = segs[0] ?? "";
    return first.startsWith("@") || first === "channel" || first === "c" || first === "user" || first === "playlist";
  }
  return false;
}

/** Name parts too generic to be the uploader's domain (`Pat - Podcast` must not claim `podcasts.apple.com`). */
const GENERIC_NAME_PARTS = new Set(["podcast", "podcasts", "official", "clips", "channel", "tv", "news", "show", "ai", "tech", "media", "studio"]);

export interface UploaderKeys {
  /** The whole name, normalized; matched inside a host label when ≥5 chars, exactly otherwise. */
  readonly whole: string | null;
  /** Each part of a `Name | Topic` / `Name - Brand` name; matched against a whole host label only. */
  readonly parts: string[];
}

/** The uploader name as host-label keys. Keys under 3 chars are dropped. */
export function uploaderKeys(uploader: string): UploaderKeys {
  const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const w = norm(uploader);
  const whole = w.length >= 3 ? w : null;
  const parts = new Set<string>();
  for (const part of uploader.split(/\s[|\-–—·]\s|\|/)) {
    const k = norm(part);
    if (k.length >= 3 && k !== whole && !GENERIC_NAME_PARTS.has(k)) parts.add(k);
  }
  return { whole, parts: [...parts] };
}

function hostMatchesUploader(host: string, keys: UploaderKeys): boolean {
  const labels = host.split(".").slice(0, -1);
  const { whole, parts } = keys;
  return labels.some(
    (label) => parts.includes(label) || (whole !== null && (label === whole || (whole.length >= 5 && label.includes(whole)))),
  );
}

function isContentHost(host: string): boolean {
  for (const h of CONTENT_HOSTS) if (hostIs(host, h)) return true;
  return false;
}

/** Rule 4: a code or paper host. */
function isRepoUrl(url: URL): boolean {
  const host = bareHost(url.hostname);
  if (host === "github.com") return pathSegments(url).length >= 2;
  return host === "gist.github.com" || hostIs(host, "huggingface.co") || hostIs(host, "arxiv.org");
}

// --- URL extraction --------------------------------------------------------

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "'", '"', "”", "’", "»", "*", "。", "，", "、", "！", "？", "：", "；"]);
/** Closers stripped only when unbalanced, with their openers. */
const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "）": "（", "」": "「", "』": "『", "】": "【", "〉": "〈", "》": "《" };
/** Trailing emoji (with skin tones, joiners, VS16): a pointer after a URL, never part of it. */
const TRAILING_EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u200d\ufe0f\u20e3]+$/u;

function count(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/**
 * The URL out of one raw match: trailing `.,;:!?` (and closing quotes,
 * full-width punctuation and emoji) stripped, and a closing `)` (or `]`, `）`,
 * `」`…) stripped only when it is unbalanced, so `Foo_(bar)` keeps its own
 * parentheses and `(see https://a.b/c)` loses the prose one.
 */
export function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const emoji = TRAILING_EMOJI_RE.exec(url);
    if (emoji) {
      url = url.slice(0, emoji.index);
      continue;
    }
    const last = url.at(-1);
    if (last === undefined) return url;
    if (TRAILING_PUNCT.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    const opener = CLOSERS[last];
    if (opener !== undefined && count(url, last) > count(url, opener)) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** `[text](https://…` — a markdown link; the href is trimmed like any URL. */
const MD_LINK_RE = /\[([^\[\]\n]*)\]\((https?:\/\/[^\s<>"'`]+)/g;

export interface LineUrl {
  readonly url: string;
  readonly index: number;
  /** A markdown link's text, when the URL is the href of `[text](url)`. */
  readonly linkText?: string;
}

/** Every URL on one line, with its offset — in order. A markdown link counts once, as its href. */
export function extractLineUrls(line: string): LineUrl[] {
  const out: LineUrl[] = [];
  const spans: Array<[number, number]> = [];
  for (const m of line.matchAll(MD_LINK_RE)) {
    const url = trimUrl(m[2]!);
    if (url.length <= "https://".length) continue;
    const hrefAt = m.index + m[0].length - m[2]!.length;
    spans.push([m.index, hrefAt + url.length]);
    out.push({ url, index: hrefAt, linkText: m[1]! });
  }
  for (const m of line.matchAll(URL_RE)) {
    if (spans.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const url = trimUrl(m[0]);
    if (url.length > "https://".length) out.push({ url, index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** The dedup key: the normalized destination, else the URL itself. */
export function linkKey(url: string): string {
  return normalizeDestinationUrl(url) ?? url;
}

function hasUrl(line: string): boolean {
  return /https?:\/\//.test(line);
}

// --- headings and source blocks --------------------------------------------

/** The line's words: emoji and punctuation stripped, whitespace collapsed. */
function headingText(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Words that start a source block. Neither a bare *links* nor *resources* does.
 * The singular *source* skips *open source* and *source code*.
 */
const SOURCE_HEADING_RE =
  /\b(?:mentioned|references?|sources|(?<!open[\s-])source(?!\s+code)|further reading|papers?|links in this video)\b/i;

function isSourceHeadingText(text: string): boolean {
  return SOURCE_HEADING_RE.test(text);
}

/** Down-pointing emoji and arrows: «the links are below», nothing more. */
const POINTER_CHARS = "👇⬇↓⤵🔽⏬";
const POINTER_ONLY_RE = new RegExp(`^[${POINTER_CHARS}\\u{1F3FB}-\\u{1F3FF}\\ufe0f\\s]+$`, "u");
const TRAILING_POINTER_RE = new RegExp(`[${POINTER_CHARS}][\\u{1F3FB}-\\u{1F3FF}\\ufe0f\\s]*$`, "u");

/** A blank line, or a line of nothing but pointer emoji (`👇👇👇`), which reads as one. */
function isBlankish(line: string): boolean {
  const t = line.trim();
  return t === "" || POINTER_ONLY_RE.test(t);
}

function nextNonBlank(lines: readonly string[], from: number): number {
  for (let j = from; j < lines.length; j++) if (!isBlankish(lines[j]!)) return j;
  return -1;
}

/** A line of nothing but rule characters (`━━━`, `___`, `===`, `---`, `▬▬▬`) — not dots, not emoji. */
const SEPARATOR_RE = /^[\u2500-\u257f\u25ac\u23af_=\-*~—–‐‒―]{3,}$/u;

function isSeparatorLine(line: string): boolean {
  return SEPARATOR_RE.test(line.replace(/\s+/g, ""));
}

/**
 * A heading line: no URL, at most 60 characters once emoji and punctuation are
 * stripped, and either all caps or ending with `:`. A `:` line is a heading
 * only when the next non-blank line has no URL — otherwise it is the title line
 * of a two-line entry — UNLESS its words name a source block (D17: «Today's
 * Sources :» sits directly over its first URL).
 */
export function isHeadingLine(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  if (hasUrl(line)) return false;
  const text = headingText(line);
  if (text === "" || text.length > 60 || !/\p{L}/u.test(text)) return false;
  // Trailing decoration first: «Sources: 👇» ends with `:`, and a trailing
  // pointer (`👇`) says the same thing a `:` does.
  const trimmed = line.trim();
  const colon = TRAILING_POINTER_RE.test(trimmed) || trimmed.replace(TRAIL_DECOR_RE, "").endsWith(":");
  const allCaps = text === text.toUpperCase() && /\p{Lu}/u.test(text);
  if (colon) {
    const j = nextNonBlank(lines, i + 1);
    const nextHasUrl = j >= 0 && hasUrl(lines[j]!);
    if (!nextHasUrl) return true;
    return isSourceHeadingText(text);
  }
  return allCaps;
}

/** Whether line `i` starts a source block. */
function startsSourceBlock(lines: readonly string[], i: number): boolean {
  return isHeadingLine(lines, i) && isSourceHeadingText(headingText(lines[i]!));
}

const BULLET_RE = /^\s*[•\-*·▪►‣◦]\s*/;
const NUMBER_RE = /^\s*\d+[.)]\s+/;
const BARE_URL_LINE_RE = /^\s*https?:\/\/\S+\s*$/;

/** How one block entry is written — what a blank line must be followed by to continue the block. */
type EntryShape = "bullet" | "number" | "bare" | "title-over-url" | "inline";

/**
 * The shape of the entry that starts at line `j` (a non-blank line). A bullet or
 * numbered title line directly over a line that leads with its URL is a
 * title-over-URL entry: the marker is decoration, the shape is the two lines.
 */
function entryShapeAt(lines: readonly string[], j: number): EntryShape | null {
  const line = lines[j]!;
  const below = j + 1 < lines.length ? lines[j + 1]! : "";
  if (
    (BULLET_RE.test(line) || NUMBER_RE.test(line)) &&
    !hasUrl(line) &&
    urlLeadsLine(below) &&
    !BULLET_RE.test(below) &&
    !NUMBER_RE.test(below)
  ) {
    return "title-over-url";
  }
  if (BULLET_RE.test(line)) return "bullet";
  if (NUMBER_RE.test(line)) return "number";
  if (BARE_URL_LINE_RE.test(line)) return "bare";
  if (!hasUrl(line)) return j + 1 < lines.length && hasUrl(lines[j + 1]!) ? "title-over-url" : null;
  return "inline";
}

/** Whether line `i` leads with its first URL: nothing but decoration (or a bare label) before it. */
function urlLeadsLine(line: string): boolean {
  const m = /https?:\/\//.exec(line);
  if (!m) return false;
  const before = cleanTitle(line.slice(0, m.index));
  return before === "" || GENERIC_LABEL_RE.test(before);
}

/**
 * Whether a URL-less line keeps an open block open: a bullet or numbered entry,
 * or the title line of a two-line entry (the next line leads with its URL).
 * Any other non-blank line is prose, and prose ends the block.
 */
function continuesBlock(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  if (BULLET_RE.test(line) || NUMBER_RE.test(line)) return true;
  return i + 1 < lines.length && urlLeadsLine(lines[i + 1]!);
}

/**
 * The 0-based line indexes inside source blocks.
 *
 * A block starts at a source heading. Blank lines before its first URL line are
 * skipped. It ends at the next heading line, at a separator line, at a prose
 * line — a non-blank line with no URL that is neither a bullet, a number nor
 * the title line over a URL; this holds before the block's first URL too — or
 * at a blank line, unless the blank separates two entries written the same
 * way: the next non-blank line starts an entry of the SAME shape as the block's
 * first entry (bullet, number, bare URL line, or a title line over its URL).
 * One-line `Title: URL` entries never continue across a blank line. (D17: the
 * reviewed table continued on ANY bullet, number or URL line, so a sponsor
 * line one blank line under a source block became a source.)
 */
export function sourceBlockLines(lines: readonly string[]): Set<number> {
  const inBlock = new Set<number>();
  let open = false;
  let firstShape: EntryShape | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isHeadingLine(lines, i)) {
      open = startsSourceBlock(lines, i);
      firstShape = null;
      continue;
    }
    if (!open) continue;
    if (isSeparatorLine(line)) {
      open = false;
      continue;
    }
    if (isBlankish(line)) {
      if (firstShape === null) continue;
      const j = nextNonBlank(lines, i + 1);
      const next = j < 0 ? null : entryShapeAt(lines, j);
      if (next === null || next === "inline" || next !== firstShape) open = false;
      continue;
    }
    if (!hasUrl(line) && !continuesBlock(lines, i)) {
      open = false;
      continue;
    }
    if (firstShape === null && hasUrl(line)) {
      const prev = i > 0 ? lines[i - 1]! : "";
      const shape = entryShapeAt(lines, i);
      firstShape =
        shape === "bare" && prev.trim() !== "" && !hasUrl(prev) && !isHeadingLine(lines, i - 1) ? "title-over-url" : shape;
    }
    inBlock.add(i);
  }
  return inBlock;
}

// --- titles ----------------------------------------------------------------

/** Emoji, arrows, bullets and their joiners — what decorates an entry, never its words. */
const DECOR = "\\s\\p{Extended_Pictographic}\\u{1F1E6}-\\u{1F1FF}\\u{1F3FB}-\\u{1F3FF}\\u200d\\ufe0f\\u20e3•\\-*·▪►‣◦→➡⇒⟶>»|=–—";
const LEAD_JUNK_RE = new RegExp(`^[${DECOR}]+`, "u");
const TRAIL_JUNK_RE = new RegExp(`[${DECOR}:,]+$`, "u");
/** Trailing decoration, but not a `:` — what comes off before the heading's colon test. */
const TRAIL_DECOR_RE = new RegExp(`[${DECOR}↓⤵]+$`, "u");
/** Labels that say "a link follows" and nothing about what it is (D17: «Links:» over a URL). */
const GENERIC_LABEL_RE = /^(?:links?|resources?|sources?|references?|website|web|site|here|link below|check it out)$/i;

const LEAD_NUMBER_RE = /^\d+[.)](?:\s+|$)/;

function cleanTitle(text: string): string {
  return text
    .replace(LEAD_JUNK_RE, "")
    .replace(LEAD_NUMBER_RE, "")
    .replace(TRAIL_JUNK_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A title written as `"Title" (` before its URL: the open paren and the quotes go. */
function unwrapTitle(title: string): string {
  const t = title.replace(/\s*[(（]$/, "").trim();
  const m = /^["“'‘«](.+)["”'’»]$/.exec(t);
  return m ? m[1]!.trim() : t;
}

function splitAttribution(title: string): { title: string; attribution: string } {
  const m = /^(.*\S)\s*\(([^()]+)\)$/.exec(title);
  if (!m) return { title, attribution: "" };
  return { title: m[1]!.trim(), attribution: m[2]!.trim() };
}

/** `host/path`, the fallback title. */
export function hostAndPath(url: string): string {
  try {
    const u = new URL(url);
    return `${bareHost(u.hostname)}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url;
  }
}

const TITLE_MAX = 200;

function titleFor(lines: readonly string[], i: number, found: LineUrl): { title: string; attribution: string } {
  const { url, index, linkText } = found;
  const line = lines[i]!;
  const linked = linkText === undefined ? "" : cleanTitle(linkText.replace(URL_RE, " "));
  const before = line
    .slice(0, linkText === undefined ? index : line.lastIndexOf("[", index))
    .replace(MD_LINK_RE, " ")
    .replace(URL_RE, " ");
  // A generic link text («My [Website](…)») joins the words before it.
  let title =
    linked !== "" && !GENERIC_LABEL_RE.test(linked) ? linked : unwrapTitle(cleanTitle(linked === "" ? before : `${before} ${linked}`));
  if (title === "" || GENERIC_LABEL_RE.test(title)) {
    const prev = i > 0 ? lines[i - 1]! : "";
    const prevTitle = cleanTitle(prev);
    title =
      prev.trim() !== "" && !hasUrl(prev) && !isHeadingLine(lines, i - 1) && prevTitle !== "" && !GENERIC_LABEL_RE.test(prevTitle)
        ? prevTitle
        : "";
  }
  const split = title === "" ? { title: hostAndPath(url), attribution: "" } : splitAttribution(title);
  return { title: split.title.slice(0, TITLE_MAX), attribution: split.attribution.slice(0, TITLE_MAX) };
}

// --- the classifier --------------------------------------------------------

/**
 * Words that mark an entry as promo whatever block it sits in: a sponsor, a
 * discount, an affiliate link, or the creator's own channels. Kept tight — a
 * cue demotes a block entry to `candidate` (the model can still pick it), it
 * never drops one.
 */
const PROMO_CUE_RE =
  /\b(?:sponsor(?:ed|s)?|discount|deal|promo|coupon|use code|affiliate|follow me|subscribe|join my|my course|newsletter)\b|\d+\s*% off\b/i;

/** Whether the entry around the URL on line `i` — its own line, and its title line above when the URL leads its line — carries a promo cue. */
function entryHasPromoCue(lines: readonly string[], i: number): boolean {
  const own = lines[i]!.replace(URL_RE, " ");
  const title = i > 0 && urlLeadsLine(lines[i]!) && !hasUrl(lines[i - 1]!) ? lines[i - 1]! : "";
  return PROMO_CUE_RE.test(own) || PROMO_CUE_RE.test(title);
}

/** Which class wins when one URL appears twice: a source anywhere makes it a source. */
const CLASS_RANK: Record<DescriptionLinkClass, number> = { source: 0, repo: 1, candidate: 2, creator: 3, social: 4 };

/**
 * Every `http(s)` URL in `description`, each with exactly one class, in the
 * order of first appearance, deduplicated by normalized URL (`linkKey`) —
 * the first occurrence's spelling is kept.
 */
export function classifyDescriptionLinks(description: string, uploader: string): DescriptionLink[] {
  const lines = description.split(/\r?\n/);
  const block = sourceBlockLines(lines);
  const keys = uploaderKeys(uploader);
  const byUrl = new Map<string, { link: DescriptionLink; host: string }>();
  for (let i = 0; i < lines.length; i++) {
    for (const found of extractLineUrls(lines[i]!)) {
      const { url } = found;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        continue;
      }
      const host = bareHost(parsed.hostname);
      let cls: DescriptionLinkClass;
      let hint: string | undefined;
      if (isSocialUrl(parsed)) cls = "social";
      else if (SHORTENER_HOSTS.has(host)) cls = "creator";
      else if (!isContentHost(host) && hostMatchesUploader(host, keys)) {
        if (FUNNEL_LABELS.has(parsed.hostname.toLowerCase().split(".")[0]!)) cls = "creator";
        else {
          cls = "candidate";
          hint = "uploader's own site";
        }
      } else if (block.has(i) && !entryHasPromoCue(lines, i)) cls = "source";
      else if (isRepoUrl(parsed)) cls = "repo";
      else cls = "candidate";
      const { title, attribution } = titleFor(lines, i, found);
      const link: DescriptionLink = { url, cls, line: i, title, attribution, ...(hint ? { hint } : {}) };
      const key = linkKey(url);
      const seen = byUrl.get(key);
      if (!seen) byUrl.set(key, { link, host });
      else if (CLASS_RANK[cls] < CLASS_RANK[seen.link.cls]) {
        // The first occurrence's URL, line and title; the better class.
        const first = seen.link;
        byUrl.set(key, { link: { ...link, url: first.url, line: first.line, title: first.title, attribution: first.attribution }, host: seen.host });
      }
    }
  }
  const all = [...byUrl.values()];
  const hostCount = new Map<string, number>();
  for (const { host } of all) hostCount.set(host, (hostCount.get(host) ?? 0) + 1);
  return all.map(({ link, host }) =>
    link.cls === "candidate" && link.hint === undefined && (hostCount.get(host) ?? 0) >= 2
      ? { ...link, hint: "repeated host" }
      : link,
  );
}

/** Whether a class is promo — never stored, only counted. */
export function isPromoClass(cls: DescriptionLinkClass): boolean {
  return cls === "creator" || cls === "social";
}

/** The source, repo and candidate links, numbered 1..n — the list the model picks from. */
export function linkCandidates(links: readonly DescriptionLink[]): Array<DescriptionLink & { id: number }> {
  return links.filter((l) => !isPromoClass(l.cls)).map((l, i) => ({ ...l, id: i + 1 }));
}

/** The description cap the prompt carries (D11). */
export const DESCRIPTION_PROMPT_MAX_CHARS = 5_000;
export const DESCRIPTION_TRUNCATION_NOTE = "[description truncated]";

/**
 * The description the prompt carries: creator and social links removed (a line
 * left with nothing but its promo URL is dropped whole), blank runs collapsed,
 * and capped at {@link DESCRIPTION_PROMPT_MAX_CHARS} at a line boundary (D11).
 */
export function descriptionForPrompt(description: string, links: readonly DescriptionLink[]): string {
  const promo = new Set(links.filter((l) => isPromoClass(l.cls)).map((l) => linkKey(l.url)));
  const kept: string[] = [];
  for (const line of description.split(/\r?\n/)) {
    const urls = extractLineUrls(line);
    const promoHere = urls.filter((u) => promo.has(linkKey(u.url)));
    if (promoHere.length === 0) {
      kept.push(line);
      continue;
    }
    if (promoHere.length === urls.length) continue;
    let stripped = line;
    for (const u of promoHere) stripped = stripped.split(u.url).join("");
    kept.push(stripped.replace(/\s+([,;])/g, "$1").replace(/[ \t]+$/, ""));
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= DESCRIPTION_PROMPT_MAX_CHARS) return text;
  const room = DESCRIPTION_PROMPT_MAX_CHARS - DESCRIPTION_TRUNCATION_NOTE.length - 1;
  const cut = text.slice(0, room);
  const at = cut.lastIndexOf("\n");
  return `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()}\n${DESCRIPTION_TRUNCATION_NOTE}`;
}
