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
 */

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
    if (segs.length === 1) return true;
    return segs.length === 2 && PROFILE_TABS.has(segs[1]!.toLowerCase());
  }
  if (host === "linkedin.com") {
    return (segs[0] === "in" || segs[0] === "company") && segs.length >= 2 && segs.length <= 3;
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

/** The uploader name, and each part of a `Name | Topic` / `Name - Brand` name, as host-label keys. */
export function uploaderKeys(uploader: string): string[] {
  const norm = (s: string) => s.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]/g, "");
  const keys = new Set<string>();
  const whole = norm(uploader);
  if (whole.length >= 3) keys.add(whole);
  for (const part of uploader.split(/\s[|\-–—·]\s|\|/)) {
    const k = norm(part);
    if (k.length >= 3) keys.add(k);
  }
  return [...keys];
}

function hostMatchesUploader(host: string, keys: readonly string[]): boolean {
  if (keys.length === 0) return false;
  const labels = host.split(".").slice(0, -1);
  return labels.some((label) => keys.some((k) => label === k || (k.length >= 5 && label.includes(k))));
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
const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "'", '"', "”", "’", "»", "*"]);

/**
 * The URL out of one raw match: trailing `.,;:!?` (and closing quotes) stripped,
 * and a closing `)` stripped only when it is unbalanced, so `Foo_(bar)` keeps
 * its own parentheses and `(see https://a.b/c)` loses the prose one.
 */
export function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === undefined) return url;
    if (TRAILING_PUNCT.has(last)) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ")") {
      const open = (url.match(/\(/g) ?? []).length;
      const close = (url.match(/\)/g) ?? []).length;
      if (close > open) {
        url = url.slice(0, -1);
        continue;
      }
    }
    if (last === "]" && !url.includes("[")) {
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

/** Every URL on one line, with its offset — in order. */
export function extractLineUrls(line: string): Array<{ url: string; index: number }> {
  const out: Array<{ url: string; index: number }> = [];
  for (const m of line.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length > "https://".length) out.push({ url, index: m.index });
  }
  return out;
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

/** Words that start a source block. Neither a bare *links* nor *resources* does. */
const SOURCE_HEADING_RE = /\b(?:mentioned|references|sources|further reading|papers|links in this video)\b/i;

function isSourceHeadingText(text: string): boolean {
  return SOURCE_HEADING_RE.test(text);
}

function nextNonBlank(lines: readonly string[], from: number): number {
  for (let j = from; j < lines.length; j++) if (lines[j]!.trim() !== "") return j;
  return -1;
}

/** A line of nothing but rule characters (`━━━`, `___`, `===`, `---`). */
function isSeparatorLine(line: string): boolean {
  const t = line.trim();
  return t.length >= 3 && !/[\p{L}\p{N}]/u.test(t);
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
  const colon = line.trim().endsWith(":");
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

/** The shape of the entry that starts at line `j` (a non-blank line). */
function entryShapeAt(lines: readonly string[], j: number): EntryShape | null {
  const line = lines[j]!;
  if (BULLET_RE.test(line)) return "bullet";
  if (NUMBER_RE.test(line)) return "number";
  if (BARE_URL_LINE_RE.test(line)) return "bare";
  if (!hasUrl(line)) return j + 1 < lines.length && hasUrl(lines[j + 1]!) ? "title-over-url" : null;
  return "inline";
}

/**
 * The 0-based line indexes inside source blocks.
 *
 * A block starts at a source heading. Blank lines before its first URL line are
 * skipped. After that it ends at the next heading line, at a separator line, or
 * at a blank line — unless the blank separates two entries written the same
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
    if (line.trim() === "") {
      if (firstShape === null) continue;
      const j = nextNonBlank(lines, i + 1);
      const next = j < 0 ? null : entryShapeAt(lines, j);
      if (next === null || next === "inline" || next !== firstShape) open = false;
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
/** Labels that say "a link follows" and nothing about what it is (D17: «Links:» over a URL). */
const GENERIC_LABEL_RE = /^(?:links?|resources?|sources?|references?|website|web|site|here|link below|check it out)$/i;

function cleanTitle(text: string): string {
  return text.replace(LEAD_JUNK_RE, "").replace(TRAIL_JUNK_RE, "").replace(/\s+/g, " ").trim();
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

function titleFor(lines: readonly string[], i: number, url: string, index: number): { title: string; attribution: string } {
  const line = lines[i]!;
  const before = line.slice(0, index).replace(URL_RE, " ");
  let title = cleanTitle(before);
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

/** Which class wins when one URL appears twice: a source anywhere makes it a source. */
const CLASS_RANK: Record<DescriptionLinkClass, number> = { source: 0, repo: 1, candidate: 2, creator: 3, social: 4 };

/**
 * Every `http(s)` URL in `description`, each with exactly one class, in the
 * order of first appearance, deduplicated by URL.
 */
export function classifyDescriptionLinks(description: string, uploader: string): DescriptionLink[] {
  const lines = description.split(/\r?\n/);
  const block = sourceBlockLines(lines);
  const keys = uploaderKeys(uploader);
  const byUrl = new Map<string, { link: DescriptionLink; host: string }>();
  for (let i = 0; i < lines.length; i++) {
    for (const { url, index } of extractLineUrls(lines[i]!)) {
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
      } else if (block.has(i)) cls = "source";
      else if (isRepoUrl(parsed)) cls = "repo";
      else cls = "candidate";
      const { title, attribution } = titleFor(lines, i, url, index);
      const link: DescriptionLink = { url, cls, line: i, title, attribution, ...(hint ? { hint } : {}) };
      const seen = byUrl.get(url);
      if (!seen) byUrl.set(url, { link, host });
      else if (CLASS_RANK[cls] < CLASS_RANK[seen.link.cls]) {
        byUrl.set(url, { link: { ...link, line: seen.link.line, title: seen.link.title, attribution: seen.link.attribution }, host });
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
  const promo = new Set(links.filter((l) => isPromoClass(l.cls)).map((l) => l.url));
  const kept: string[] = [];
  for (const line of description.split(/\r?\n/)) {
    const urls = extractLineUrls(line);
    const promoHere = urls.filter((u) => promo.has(u.url));
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
