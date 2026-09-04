/**
 * Harvesting a Vimeo video's caption track — the one mechanism in this vertical
 * that can rot.
 *
 * FOUR cheaper paths were measured and closed on 2026-09-04 (`src/vimeo/CLAUDE.md`
 * has the table). yt-dlp's web client refuses without a login even for public
 * videos; `player.vimeo.com/video/<id>/config` answers a 403 bot page to curl and
 * to an in-page `fetch` alike. What is left is to let the REAL player do the work
 * and harvest what it fetches: load the watch
 * page in a headless Chromium, `play()` it muted, set every text track to
 * `mode = "hidden"`, and read the signed
 * `https://captions.vimeo.com/captions/<id>.vtt?expires=…&sig=…` URL off the
 * request stream. That URL then downloads with a plain cookie-less `fetch`.
 *
 * ⚠️ `playwright-core` is imported ONLY through the dynamic `await import()` in
 * {@link harvestVimeoCaptions}, never at module top. `src/dashboard/routes.ts`
 * statically imports every route module, so a top-level import would pull a
 * browser driver into `MUNINN_PROFILE=nais` boot — a pod built without one. The
 * `typeof import(…)` type aliases below are erased at compile time and load
 * nothing; `captions.test.ts` pins the absence of a static import by reading this
 * file's source.
 *
 * The signed URL expires in ~3.5 h. Download it IMMEDIATELY and persist the VTT,
 * never the URL.
 */
import { getLog } from "../logging.ts";
import { vimeoWatchUrl } from "./url.ts";

const log = getLog("vimeo", "captions");

// Type-only views of playwright-core. `typeof import(…)` inside a type alias is
// erased by the compiler — no module is loaded by these three lines.
type PlaywrightModule = typeof import("playwright-core");
type PwBrowser = Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>;
type PwContext = Awaited<ReturnType<PwBrowser["newContext"]>>;
type PwPage = Awaited<ReturnType<PwContext["newPage"]>>;

/** The ONLY host a caption URL may point at. */
export const VIMEO_CAPTIONS_HOST = "captions.vimeo.com";
/** Whole-operation budget for a harvest, browser launch included. */
export const VIMEO_HARVEST_TIMEOUT_MS = 60_000;
/** A 53-minute talk's VTT is 62 KB. The cap bounds the process, generously. */
export const VIMEO_VTT_MAX_BYTES = 2 * 1024 * 1024;
export const VIMEO_VTT_TIMEOUT_MS = 20_000;

export interface VimeoCaptionTrack {
  readonly lang: string;
  readonly label: string;
  readonly vttUrl: string;
}

export interface VimeoCaptions {
  readonly videoId: string;
  readonly title: string;
  readonly durationSec: number;
  readonly tracks: VimeoCaptionTrack[];
  /**
   * The signed HLS/DASH manifest, if the player asked for one while we watched.
   * Nothing in PR 1 reads it — it is what an audio/Whisper fallback would need,
   * and capturing a URL we are already listening for costs nothing.
   */
  readonly manifestUrl?: string;
}

/** No browser binary (or no `playwright-core`) on this machine. */
export class VimeoBrowserMissingError extends Error {
  constructor(cause: unknown) {
    super(
      "Vimeo caption harvest needs a Chromium: run `bunx playwright install chromium` on this machine. " +
        `Launch failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "VimeoBrowserMissingError";
  }
}

/** Vimeo served its bot-detection "Sorry" page instead of the watch page. */
export class VimeoBotBlockedError extends Error {
  constructor(readonly videoId: string) {
    super(`Vimeo answered its bot-detection page for video ${videoId}`);
    this.name = "VimeoBotBlockedError";
  }
}

/** Private, password-walled or deleted: the page renders no `<video>` at all. */
export class VimeoNotPublicError extends Error {
  constructor(readonly videoId: string) {
    super(`Vimeo video ${videoId} is not publicly playable (no <video> element on the page)`);
    this.name = "VimeoNotPublicError";
  }
}

export class VimeoHarvestError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VimeoHarvestError";
  }
}

export class VimeoVttDownloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VimeoVttDownloadError";
  }
}

export interface HarvestOptions {
  /** Unlisted video's private hash — the watch page 404s without it. */
  hash?: string;
  /** Whole-operation budget (default {@link VIMEO_HARVEST_TIMEOUT_MS}). */
  timeoutMs?: number;
  /**
   * Default true. The escape hatch for the day {@link deHeadlessUserAgent} stops
   * being enough: a HEADED Chromium reaches the real page where a headless one is
   * challenged (measured 2026-09-04, both directions). It needs a display, so it
   * is a laptop lever, not a server one.
   */
  headless?: boolean;
  /** Override the derived user agent entirely. Diagnostics; see below. */
  userAgent?: string;
}

/**
 * Take the `Headless` token out of the browser's OWN user agent.
 *
 * ⚠️ This is the single line the whole harvest currently depends on, and it
 * REVERSES the plan's "no UA override, ever" rule — which came from a curl
 * measurement against the `/config` endpoint, not from a page load. Measured
 * 2026-09-04, four ways, on the real site:
 *
 *   - headless, default UA (`HeadlessChrome/145.0.7632.6`) → Cloudflare's
 *     "Verify to continue" interstitial. No `<video>`, no captions. Same for the
 *     `player.vimeo.com` embed page ("We couldn't verify the security of your
 *     connection") and same under `channel: "chromium"`.
 *   - HEADED, default UA (`Chrome/145.0.0.0`) → the real page, one text track,
 *     the signed caption URL.
 *   - headless with the UA's `Headless` token removed → the real page. Adding
 *     `--disable-blink-features=AutomationControlled` changed nothing either way,
 *     so the UA token is the whole discriminator.
 *
 * It is a DERIVATION, not a fingerprint: the string is read out of the launched
 * binary at runtime and only the automation token is dropped, so the version, the
 * platform and everything else stay honest, and a Chromium upgrade needs no edit
 * here. Nothing is claimed that the browser is not — it IS that Chrome build.
 */
export function deHeadlessUserAgent(userAgent: string): string {
  return userAgent.replace(/HeadlessChrome\//g, "Chrome/");
}

// ── Track choice (pure) ──────────────────────────────────────────────────────

/** `no-x-autogen` → `no`. */
function baseLang(lang: string): string {
  return lang.trim().toLowerCase().replace(/-x-autogen$/, "").split("-")[0] ?? "";
}

function isAuto(lang: string): boolean {
  return /-x-autogen$/i.test(lang.trim());
}

/**
 * Pick the track to transcribe from.
 *
 * 1. A track with no harvested URL is unusable and drops out first.
 * 2. A MANUAL track beats an auto-generated one — auto-captions garble proper
 *    nouns ("JavaBeen" for JavaBin, measured on the fixture's talk).
 * 3. Within the surviving partition, the TALK's own language wins over a
 *    translation. The talk's language is read off an auto-generated track when
 *    there is one: Vimeo generates those from the audio, so their language IS
 *    the spoken language — a fact no manual track carries.
 * 4. Otherwise source order, which is the order the player lists them.
 */
export function chooseTrack(tracks: readonly VimeoCaptionTrack[]): VimeoCaptionTrack | null {
  const usable = tracks.filter((t) => !!t.vttUrl);
  if (usable.length === 0) return null;
  const spoken = usable.find((t) => isAuto(t.lang));
  const talkLang = spoken ? baseLang(spoken.lang) : null;

  const manual = usable.filter((t) => !isAuto(t.lang));
  const pool = manual.length > 0 ? manual : usable;
  if (talkLang) {
    const own = pool.find((t) => baseLang(t.lang) === talkLang);
    if (own) return own;
  }
  return pool[0]!;
}

// ── VTT download ─────────────────────────────────────────────────────────────

export interface DownloadVttOptions {
  /** Test seam — production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Download one signed caption URL.
 *
 * HOST-PINNED: the URL comes out of a page a third party controls, so it is
 * checked against {@link VIMEO_CAPTIONS_HOST} exactly, over https, with
 * `redirect: "error"` — a host pin that follows redirects is not a host pin,
 * since the first hop can be anywhere. Bounded in time AND in bytes, and an
 * over-cap body is REFUSED rather than truncated: half a VTT is a transcript
 * with a silent hole in it, which is worse than no transcript.
 */
export async function downloadVtt(url: string, opts: DownloadVttOptions = {}): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new VimeoVttDownloadError(`Not a URL: ${url}`, { cause: err });
  }
  if (parsed.protocol !== "https:") {
    throw new VimeoVttDownloadError(`Refusing non-https caption URL: ${parsed.protocol}//${parsed.host}`);
  }
  if (parsed.hostname.toLowerCase().replace(/\.$/, "") !== VIMEO_CAPTIONS_HOST) {
    throw new VimeoVttDownloadError(
      `Refusing caption URL on host ${parsed.hostname} (only ${VIMEO_CAPTIONS_HOST} is allowed)`,
    );
  }

  const maxBytes = opts.maxBytes ?? VIMEO_VTT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? VIMEO_VTT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(url, { redirect: "error", signal: controller.signal });
    } catch (err) {
      throw new VimeoVttDownloadError(
        controller.signal.aborted
          ? `Caption download timed out after ${timeoutMs}ms`
          : `Caption download failed (a redirect is refused, not followed): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    if (res.status >= 300 && res.status < 400) {
      controller.abort();
      throw new VimeoVttDownloadError(`Caption URL answered a redirect (${res.status}); refusing to follow it`);
    }
    if (!res.ok) {
      controller.abort();
      throw new VimeoVttDownloadError(`Caption download returned HTTP ${res.status}`);
    }

    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      if (new TextEncoder().encode(text).length > maxBytes) {
        throw new VimeoVttDownloadError(`Caption body exceeds ${maxBytes} bytes`);
      }
      return text;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        // Stopping the READ does not stop the TRANSFER — abort the request that
        // opened the socket (the `safe-fetch.ts` measurement).
        controller.abort();
        throw new VimeoVttDownloadError(`Caption body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(joined);
  } finally {
    clearTimeout(timer);
  }
}

// ── Harvest ──────────────────────────────────────────────────────────────────

/**
 * Load the watch page and harvest the signed caption URLs the player requests.
 *
 * The whole operation, browser launch included, lives inside one budget; every
 * Playwright wait gets what is LEFT of it (never 0 — Playwright reads a 0 timeout
 * as "wait forever"). Chromium is launched per harvest and closed in `finally`:
 * a long-lived browser is a second process to supervise, for a job that runs
 * once per capture.
 */
export async function harvestVimeoCaptions(
  videoId: string,
  opts: HarvestOptions = {},
): Promise<VimeoCaptions> {
  const watchUrl = vimeoWatchUrl({ id: videoId, hash: opts.hash });
  const deadline = Date.now() + (opts.timeoutMs ?? VIMEO_HARVEST_TIMEOUT_MS);

  let chromium: PlaywrightModule["chromium"];
  try {
    ({ chromium } = await import("playwright-core"));
  } catch (err) {
    throw new VimeoBrowserMissingError(err);
  }

  let browser: PwBrowser;
  try {
    browser = await chromium.launch({
      headless: opts.headless ?? true,
      timeout: remaining(deadline),
    });
  } catch (err) {
    throw new VimeoBrowserMissingError(err);
  }

  try {
    const userAgent = opts.userAgent ?? (await derivedUserAgent(browser));
    // One retry on the bot page, with a FRESH context (new fingerprint/storage).
    for (let attempt = 1; attempt <= 2; attempt++) {
      const context = await browser.newContext({ locale: "en-US", userAgent });
      try {
        return await harvestInContext(context, videoId, watchUrl, deadline);
      } catch (err) {
        if (err instanceof VimeoBotBlockedError && attempt === 1) {
          log.warn("Vimeo bot page for {videoId}; retrying once with a fresh context", { videoId });
          continue;
        }
        throw err;
      } finally {
        await context.close().catch(() => {});
      }
    }
    throw new VimeoBotBlockedError(videoId);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function harvestInContext(
  context: PwContext,
  videoId: string,
  watchUrl: string,
  deadline: number,
): Promise<VimeoCaptions> {
  const page = await context.newPage();
  const vttUrls: string[] = [];
  let manifestUrl: string | undefined;
  page.on("request", (req) => {
    const u = req.url();
    if (u.includes("captions.vimeo.com/captions/") && u.includes(".vtt") && !vttUrls.includes(u)) {
      vttUrls.push(u);
    }
    if (!manifestUrl && u.includes("vod-adaptive-ak.vimeocdn.com") && u.includes("/playlist/av/")) {
      manifestUrl = u;
    }
  });

  await page.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: remaining(deadline, 30_000) });
  if (await looksLikeBotPage(page)) throw new VimeoBotBlockedError(videoId);

  try {
    await page.waitForSelector("video", { timeout: remaining(deadline, 20_000) });
  } catch (err) {
    if (await looksLikeBotPage(page)) throw new VimeoBotBlockedError(videoId);
    throw new VimeoNotPublicError(videoId);
  }

  // Text tracks exist only after playback starts — before `play()` the player has
  // not fetched its config. Muted first: muted autoplay is the one kind headless
  // Chromium allows.
  await page.evaluate(() => {
    const v = document.querySelector("video");
    if (!v) return;
    v.muted = true;
    void v.play().catch(() => {});
  });
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return !!v && v.textTracks.length > 0;
      },
      undefined,
      { timeout: remaining(deadline, 25_000) },
    );
  } catch {
    // No tracks is a legitimate answer (spec §5: fall back to audio), not a
    // failure — return the metadata we do have with an empty track list.
    log.info("Vimeo video {videoId} exposed no text tracks", { videoId });
  }

  const meta = await page.evaluate(() => {
    const v = document.querySelector("video");
    // Indexed rather than spread: `TextTrackList` is not iterable in every DOM
    // lib version, and this function is serialized into the page as written.
    const tracks: { lang: string; label: string }[] = [];
    if (v) {
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i];
        if (t) tracks.push({ lang: t.language, label: t.label });
      }
    }
    return {
      durationSec: v && Number.isFinite(v.duration) ? v.duration : 0,
      title: document.title.replace(/ \| Videos & Movies on Vimeo$/, "").replace(/ on Vimeo$/, "").trim(),
      tracks,
    };
  });

  // CORRELATION: the request stream carries URLs, the DOM carries lang/label, and
  // nothing links them. So the tracks are enabled ONE AT A TIME and the first URL
  // that arrives after track i is enabled is track i's — a pairing by causation
  // rather than by "request order happens to match DOM order". A track that
  // produces no new request within its slice (the player may have prefetched it)
  // falls back to positional assignment from whatever is still unclaimed.
  const paired: (string | undefined)[] = new Array(meta.tracks.length).fill(undefined);
  for (let i = 0; i < meta.tracks.length; i++) {
    const before = vttUrls.length;
    await page.evaluate((idx) => {
      const v = document.querySelector("video");
      const track = v?.textTracks[idx];
      if (track) track.mode = "hidden";
    }, i);
    await waitFor(() => vttUrls.length > before, Math.min(10_000, remaining(deadline, 10_000)));
    if (vttUrls.length > before) paired[i] = vttUrls[before];
  }
  const unclaimed = vttUrls.filter((u) => !paired.includes(u));
  for (let i = 0; i < paired.length; i++) {
    if (!paired[i]) paired[i] = unclaimed.shift();
  }

  // Duration is re-read here, at the LAST possible moment: the player is an MSE
  // source and `v.duration` is still NaN when the text tracks first appear
  // (measured — the first read reported 0 for a 56-minute talk). Whichever of the
  // two reads is finite wins; 0 means "the player never said", and the oEmbed
  // duration is the caller's answer then.
  const lateDuration = await page
    .evaluate(() => {
      const v = document.querySelector("video");
      const d = v?.duration;
      v?.pause();
      return typeof d === "number" && Number.isFinite(d) ? d : 0;
    })
    .catch(() => 0);

  const tracks: VimeoCaptionTrack[] = meta.tracks
    .map((t, i) => ({ lang: t.lang, label: t.label, vttUrl: paired[i] ?? "" }))
    .filter((t) => t.vttUrl !== "");
  if (meta.tracks.length > 0 && tracks.length === 0) {
    throw new VimeoHarvestError(
      `Vimeo video ${videoId} listed ${meta.tracks.length} caption track(s) but requested no VTT within the budget`,
    );
  }

  return {
    videoId,
    title: meta.title,
    durationSec: lateDuration || meta.durationSec,
    tracks,
    manifestUrl,
  };
}

/**
 * The launched binary's own user agent, minus the automation token. Read from a
 * throwaway context because a context's UA is fixed at creation — there is no
 * "what would you have sent" without asking a page. A failure here is not fatal:
 * `undefined` means "use the browser's default", which is what the code did
 * before the Cloudflare gate appeared.
 */
async function derivedUserAgent(browser: PwBrowser): Promise<string | undefined> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const ua = await page.evaluate(() => navigator.userAgent);
    return deHeadlessUserAgent(ua);
  } catch (err) {
    log.warn("Could not read the browser's default user agent: {err}", { err });
    return undefined;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * The interstitials Vimeo serves instead of a watch page, all of them measured
 * rather than guessed: the older "Sorry" bot page, and the Cloudflare challenge
 * that headless Chromium got on 2026-09-04 — "Verify to continue" on the watch
 * page, "We couldn't verify the security of your connection" on the player embed.
 * Matched on the HEADING, which is where they differ from a real page; a page
 * with a `<video>` is never one of these whatever its wording.
 */
const CHALLENGE_HEADINGS = [
  /^sorry\b/i,
  /verify to continue/i,
  /couldn.{0,3}t verify the security/i,
  /confirm that you.{0,3}re a human/i,
];

async function looksLikeBotPage(page: PwPage): Promise<boolean> {
  const probe = await page
    .evaluate(() => ({
      title: document.title || "",
      heading: document.querySelector("h1")?.textContent?.trim() ?? "",
      hasVideo: !!document.querySelector("video"),
    }))
    .catch(() => null);
  if (!probe || probe.hasVideo) return false;
  return CHALLENGE_HEADINGS.some((re) => re.test(probe.title.trim()) || re.test(probe.heading));
}

/**
 * What is LEFT of the whole-operation budget, capped at this step's own ceiling.
 * Throws rather than returning 0 — Playwright reads `timeout: 0` as "no timeout",
 * so an exhausted budget would turn into an unbounded wait.
 */
function remaining(deadline: number, cap?: number): number {
  const left = deadline - Date.now();
  if (left <= 0) throw new VimeoHarvestError("Vimeo caption harvest exceeded its whole-operation budget");
  return cap ? Math.min(cap, left) : left;
}

/** Poll a predicate. Resolves early when it holds; never throws on timeout —
 *  every caller treats "did not happen" as data. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + Math.max(0, timeoutMs);
  while (!predicate() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
