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

/**
 * The one thing a harvest needs from `playwright-core`. It is a TEST SEAM (the
 * `fetchImpl` idiom of this module's other half): production passes nothing and
 * the dynamic `await import("playwright-core")` stays the default, which is what
 * keeps a browser driver out of a `MUNINN_PROFILE=nais` boot.
 */
export interface VimeoBrowserLauncher {
  launch(options: { headless: boolean; timeout: number }): Promise<PwBrowser>;
}

export interface HarvestOptions {
  /** Unlisted video's private hash — the watch page 404s without it. */
  hash?: string;
  /** Test seam — production takes the dynamic import. */
  launcher?: VimeoBrowserLauncher;
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
 *    translation — but only when the talk's language is actually KNOWN. It is
 *    read off an auto-generated track: Vimeo generates those from the audio, so
 *    a lone auto track's language IS the spoken language, a fact no manual track
 *    carries. With SEVERAL auto tracks it is not known at all — Vimeo's
 *    auto-translations carry `-x-autogen` too, so "the first auto track" named
 *    the spoken language only by luck of ordering. This step is then skipped
 *    rather than guessed.
 * 4. Otherwise source order, which is the order the player lists them.
 *
 * ⚠️ Steps 2–4 have NO live coverage: both videos measured on 2026-09-04 had
 * exactly one track, so everything below step 1 is reasoning about Vimeo's
 * model, pinned by unit tests, not by an observed multi-track video.
 */
export function chooseTrack(tracks: readonly VimeoCaptionTrack[]): VimeoCaptionTrack | null {
  const usable = tracks.filter((t) => !!t.vttUrl);
  if (usable.length === 0) return null;
  const auto = usable.filter((t) => isAuto(t.lang));
  const talkLang = auto.length === 1 ? baseLang(auto[0]!.lang) : null;

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
  // `URL.hostname` is already lowercase (WHATWG lowercases it); only the
  // trailing root dot is left to normalise.
  if (parsed.hostname.replace(/\.$/, "") !== VIMEO_CAPTIONS_HOST) {
    throw new VimeoVttDownloadError(
      `Refusing caption URL on host ${parsed.hostname} (only ${VIMEO_CAPTIONS_HOST} is allowed)`,
    );
  }

  const maxBytes = opts.maxBytes ?? VIMEO_VTT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? VIMEO_VTT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  // The FLAG says why, not `signal.aborted`: this function aborts its own
  // controller on an over-cap body too, and that is not a timeout.
  let timedOut = false;
  // The budget as something to RACE, not only as an abort — the same shape
  // `fetchVimeoOembed` uses, and for the same reason: the signal bounds a
  // transport that HONOURS it, while racing bounds the CALLER whatever the
  // transport does. A `fetchImpl` stub, an e2e fake, or a body that ignores its
  // signal left this function awaiting a promise that never settled, with the
  // timer already fired and nobody listening. `.catch` is attached at once so a
  // timer firing when nothing is racing cannot raise an unhandled rejection, and
  // the timer is cleared in the `finally` below.
  let expire: () => void = () => {};
  const budgetExpired = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new VimeoVttDownloadError(`Caption download timed out after ${timeoutMs}ms`));
  });
  budgetExpired.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    expire();
  }, timeoutMs);
  try {
    let res: Response;
    try {
      const fetching = doFetch(url, { redirect: "error", signal: controller.signal });
      fetching.catch(() => {}); // the race's loser is nobody's rejection
      res = await Promise.race([fetching, budgetExpired]);
    } catch (err) {
      // The budget's own rejection is already this module's error, with the
      // right message — re-wrapping it would bury it as a transport failure.
      if (err instanceof VimeoVttDownloadError) throw err;
      // A real `fetch` throws here for two different reasons — the budget, and
      // `redirect: "error"` meeting a 3xx — and naming only the second made a
      // plain timeout read as a redirect refusal. The transport's own message
      // says which; this line no longer guesses.
      throw new VimeoVttDownloadError(
        timedOut
          ? `Caption download timed out after ${timeoutMs}ms`
          : `Caption download failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    // UNREACHABLE against a real `fetch`: with `redirect: "error"` a 3xx throws
    // above and never becomes a Response. It stays for a `fetchImpl` that hands
    // one back anyway — a stub, an e2e fake — so the refusal is the same either
    // way rather than a redirect body being parsed as a transcript.
    if (res.status >= 300 && res.status < 400) {
      controller.abort();
      throw new VimeoVttDownloadError(`Caption URL answered a redirect (${res.status}); refusing to follow it`);
    }
    if (!res.ok) {
      controller.abort();
      throw new VimeoVttDownloadError(`Caption download returned HTTP ${res.status}`);
    }

    // Deliberately NOT `readBounded` (`src/utils/bounded-fetch.ts`), the repo's
    // other body cap: that one cancels its reader on the over-cap path, and a
    // `reader.cancel()` does not close a Bun fetch socket (measured
    // cross-process: 52 GB kept arriving after a read that returned in 8 ms).
    // Only aborting the CONTROLLER stops the transfer, and it has to happen at
    // the moment the cap is crossed — inside this loop.
    const reader = res.body?.getReader();
    if (!reader) {
      // No stream to bound. The declared length is then the only bound there
      // is, so it is checked BEFORE anything is buffered.
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        controller.abort();
        throw new VimeoVttDownloadError(`Caption body declares ${declared} bytes, over the ${maxBytes}-byte cap`);
      }
      const reading = res.text();
      reading.catch(() => {});
      const text = await readInsideBudget(
        Promise.race([reading, budgetExpired]),
        timeoutMs,
        () => timedOut,
      );
      if (new TextEncoder().encode(text).length > maxBytes) {
        throw new VimeoVttDownloadError(`Caption body exceeds ${maxBytes} bytes`);
      }
      return text;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      // Raced, not merely awaited: a stream that neither yields nor errors on
      // abort leaves `reader.read()` pending forever, and the cap below can only
      // fire on bytes that actually arrive.
      const draining = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          received += value.byteLength;
          if (received > maxBytes) {
            // Stopping the READ does not stop the TRANSFER — abort the request
            // that opened the socket (the `safe-fetch.ts` measurement).
            controller.abort();
            throw new VimeoVttDownloadError(`Caption body exceeds ${maxBytes} bytes`);
          }
          chunks.push(value);
        }
      })();
      draining.catch(() => {});
      await Promise.race([draining, budgetExpired]);
    } catch (err) {
      // The budget can expire HERE, mid-body — the likeliest failure this
      // download has, and it used to escape as a raw `AbortError` past every
      // caller's `instanceof VimeoVttDownloadError`.
      if (err instanceof VimeoVttDownloadError) throw err;
      throw new VimeoVttDownloadError(
        timedOut
          ? `Caption download timed out after ${timeoutMs}ms`
          : `Caption body could not be read: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
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

/**
 * The bodiless path's read, classified the same way the streamed one is: a
 * `res.text()` that ends in an abort is this module's error, naming the budget.
 */
async function readInsideBudget(reading: Promise<string>, timeoutMs: number, timedOut: () => boolean): Promise<string> {
  try {
    return await reading;
  } catch (err) {
    // The budget's own rejection arrives here already classified when the read
    // is raced against it; re-wrapping would only re-derive the same message.
    if (err instanceof VimeoVttDownloadError) throw err;
    throw new VimeoVttDownloadError(
      timedOut()
        ? `Caption download timed out after ${timeoutMs}ms`
        : `Caption body could not be read: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
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
  // Validated at the DOOR, because `remaining()` guards `left <= 0` and that is
  // false for NaN: a NaN budget flowed into every Playwright timeout, and
  // Playwright reads a falsy timeout as "wait forever" — the budget silently
  // switched off. `--timeout=abc` on the smoke script is how it arrives.
  const budgetMs = opts.timeoutMs ?? VIMEO_HARVEST_TIMEOUT_MS;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new VimeoHarvestError(
      `Vimeo caption harvest needs a finite budget in ms, got ${budgetMs}`,
    );
  }
  const deadline = Date.now() + budgetMs;

  let launcher: VimeoBrowserLauncher;
  if (opts.launcher) {
    launcher = opts.launcher;
  } else {
    try {
      ({ chromium: launcher } = await import("playwright-core"));
    } catch (err) {
      throw new VimeoBrowserMissingError(err);
    }
  }

  // OUTSIDE the try: an exhausted budget is a `VimeoHarvestError` and must not
  // be caught below and re-told as "install a Chromium" — the operator would go
  // fix a browser that is already installed.
  const launchTimeout = remaining(deadline);
  let browser: PwBrowser;
  try {
    browser = await launcher.launch({ headless: opts.headless ?? true, timeout: launchTimeout });
  } catch (err) {
    if (isBrowserMissing(err)) throw new VimeoBrowserMissingError(err);
    throw new VimeoHarvestError(
      `Vimeo caption harvest could not launch a browser: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  try {
    const userAgent = opts.userAgent ?? (await derivedUserAgent(browser));
    // One retry on the bot page, in a NEW CONTEXT — which is a new cookie jar and
    // new storage, and nothing else: same browser, same binary, same derived user
    // agent, same locale. So it can shake off a per-session challenge cookie and
    // cannot do a thing about the UA gate; that is what `deHeadlessUserAgent`
    // (and, failing it, `headless: false`) is for.
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
    // Unreachable: the loop either returns, retries once, or rethrows. It is
    // here because control-flow analysis cannot see that, and a `return`-less
    // path would otherwise be typed `VimeoCaptions | undefined`.
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

  try {
    await page.goto(watchUrl, { waitUntil: "domcontentloaded", timeout: remaining(deadline, 30_000) });
  } catch (err) {
    // The same states as the two waits below: a navigation cut short by the
    // budget is reported as the budget, naming the ambiguity (the site may also
    // be slow or unreachable — nothing was observed); any other navigation
    // failure is a harvest error carrying Playwright's own message, never a raw
    // TimeoutError with no class (measured: `--timeout=1500` on the live site
    // surfaced `TimeoutError: goto: Timeout 709ms exceeded.` verbatim).
    remaining(deadline, undefined, "before the watch page loaded — the site may also be slow or unreachable; raise the budget to tell the two apart");
    throw new VimeoHarvestError(`Vimeo watch page for ${videoId} failed to load: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if ((await probeChallenge(page)).kind === "bot") throw new VimeoBotBlockedError(videoId);

  // OUTSIDE the try: the catch below means "this page has no <video>", and an
  // exhausted budget computed inside it was reported as a private video.
  const selectorTimeout = remaining(deadline, 20_000);
  try {
    await page.waitForSelector("video", { timeout: selectorTimeout });
  } catch (err) {
    // The wait rejects in one of three states, and only the first two are
    // distinguishable from each other:
    //   1. it got its FULL slice (the cap) and the deadline is still ahead — the
    //      page was observed for the whole window: classify (bot / unknown /
    //      not public) below;
    //   2. the deadline has now passed — which in practice means its slice was
    //      cut short by the budget (`selectorTimeout < cap`), though a wait that
    //      got its full slice and exhausted the budget by a millisecond lands
    //      here too — the observation window was truncated, so "private" and
    //      "slow" are the same evidence: report the budget, and say in the
    //      message that the video may also be private;
    //   3. the wait failed for another reason (page closed) while the deadline
    //      still stands — falls through to `probeChallenge`, which answers
    //      `unknown` and names it. With the deadline passed, state 2 wins and
    //      the closed page is reported as the budget.
    // The code evaluates ONE predicate, "has the deadline passed", not the
    // slice-vs-cap comparison. State 2 is a deliberate choice, not a defect: a
    // budget error naming the ambiguity is honest where a "not public" verdict
    // about a video nobody observed for its window would not be.
    remaining(deadline, undefined, "before a <video> appeared — the page may also be private; raise the budget to tell the two apart");
    const probe = await probeChallenge(page);
    if (probe.kind === "bot") throw new VimeoBotBlockedError(videoId);
    if (probe.kind === "unknown") {
      // No `<video>` AND no readable page: that is not evidence about the video.
      throw new VimeoHarvestError(
        `Vimeo video ${videoId} showed no <video> and the page could not be inspected: ${probe.reason}`,
        { cause: err },
      );
    }
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
  // Outside the try for the same reason as the selector wait above: this catch
  // means "no text tracks", which an exhausted budget is not.
  const tracksTimeout = remaining(deadline, 25_000);
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector("video");
        return !!v && v.textTracks.length > 0;
      },
      undefined,
      { timeout: tracksTimeout },
    );
  } catch {
    // Same three states as the selector wait above, one step down: a full 25 s
    // slice with no tracks IS the answer "no captions" (state 1, spec §5: fall
    // back to audio); a slice cut short by the budget is state 2 — the message
    // says the video may also be caption-less, since the wait never got its
    // window. It has to be asked here — with no tracks to pair, nothing further
    // down calls `remaining()`, so the harvest RESOLVED with an empty track list
    // for a video whose tracks were never waited out.
    remaining(deadline, undefined, "before any text track appeared — the video may also have no captions; raise the budget to tell the two apart");
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
  // nothing links them. So exactly ONE track is enabled at a time and the first
  // URL that arrives after track i is enabled is track i's — a pairing by
  // causation rather than by "request order happens to match DOM order". A track
  // that produces no new request within its slice (the player may have
  // prefetched it) falls back to positional assignment from whatever is still
  // unclaimed.
  //
  // "One at a time" means every OTHER track is put back to `disabled` in the
  // same evaluate. Only ever enabling made it cumulative — from track 2 on,
  // several tracks were live at once, so a URL the player fetched late for track
  // i-1 was credited to track i, silently, as a caption file in the wrong
  // language.
  const paired: (string | undefined)[] = new Array(meta.tracks.length).fill(undefined);
  for (let i = 0; i < meta.tracks.length; i++) {
    const before = vttUrls.length;
    await page.evaluate((idx) => {
      const v = document.querySelector("video");
      if (!v) return;
      for (let j = 0; j < v.textTracks.length; j++) {
        const track = v.textTracks[j];
        if (!track) continue;
        const wanted = j === idx ? "hidden" : "disabled";
        if (track.mode !== wanted) track.mode = wanted;
      }
    }, i);
    await waitFor(() => vttUrls.length > before, remaining(deadline, 10_000));
    if (vttUrls.length > before) paired[i] = vttUrls[before];
  }
  const unclaimed = vttUrls.filter((u) => !paired.includes(u));
  for (let i = 0; i < paired.length; i++) {
    if (!paired[i]) paired[i] = unclaimed.shift();
  }

  // Duration is re-read here, at the LAST possible moment, and on the two talks
  // measured 2026-09-04 it changed NOTHING: the player is an MSE source and
  // `v.duration` was still not a number at either read, so both sweeps printed
  // `player says unknown (MSE, no duration)` and `durationSec === 0`.
  //
  // **oEmbed is the duration source for this vertical.** The late read is kept
  // because it costs one evaluate and a progressive (non-MSE) source would
  // answer it — but 0 here means "the player never said", not "a zero-length
  // video", and no caller may read it as a duration.
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
 * The THREE interstitials Vimeo serves instead of a watch page, all of them
 * measured rather than guessed: the older "Sorry" bot page, and the Cloudflare
 * challenge headless Chromium got on 2026-09-04 — "Verify to continue" on the
 * watch page, "We couldn't verify the security of your connection" on the player
 * embed. (A fourth, "confirm that you're a human", was never measured on Vimeo
 * and is not carried: an unmeasured pattern here can only mislabel a real page.)
 *
 * Matched on the `h1`, which is where they differ from a real page — and a page
 * with a `<video>` is never one of these whatever its wording.
 */
const CHALLENGE_HEADINGS = [/^sorry\b/i, /verify to continue/i, /couldn.{0,3}t verify the security/i];

/**
 * The same three against `document.title`, anchored WHOLE. The title is a much
 * weaker signal than the heading: a prefix match read the real video "Sorry, Not
 * Sorry on Vimeo" as a bot page. The 403 page's title is the word "Sorry" and
 * nothing else.
 */
const CHALLENGE_TITLES = [
  /^sorry[.!]?$/i,
  /^verify to continue$/i,
  /^(we )?couldn.{0,3}t verify the security of your connection[.!]?$/i,
];

/**
 * What the page LOOKS like, with "could not tell" kept distinct from "not a
 * challenge". Swallowing the evaluate failure into `false` meant a page that
 * could not be read at all was reported as a private video — a claim about the
 * video, made from a probe that never ran.
 */
type ChallengeProbe = { kind: "bot" } | { kind: "clean" } | { kind: "unknown"; reason: string };

async function probeChallenge(page: PwPage): Promise<ChallengeProbe> {
  let probe: { title: string; heading: string; hasVideo: boolean };
  try {
    probe = await page.evaluate(() => ({
      title: document.title || "",
      heading: document.querySelector("h1")?.textContent?.trim() ?? "",
      hasVideo: !!document.querySelector("video"),
    }));
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  if (probe.hasVideo) return { kind: "clean" };
  const title = probe.title.trim();
  const bot =
    CHALLENGE_TITLES.some((re) => re.test(title)) || CHALLENGE_HEADINGS.some((re) => re.test(probe.heading));
  return bot ? { kind: "bot" } : { kind: "clean" };
}

/**
 * Playwright's own wording when the browser binary is not installed — the ONLY
 * failure that earns {@link VimeoBrowserMissingError}, whose message tells the
 * operator to run `bunx playwright install chromium`. A sandbox refusal, an OOM
 * or a closed target sent them to fix a browser they already had.
 */
function isBrowserMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist/i.test(message) || /browserType\.launch: Executable/i.test(message);
}

/**
 * What is LEFT of the whole-operation budget, capped at this step's own ceiling.
 * Throws rather than returning 0 — Playwright reads `timeout: 0` as "no timeout",
 * so an exhausted budget would turn into an unbounded wait.
 */
function remaining(deadline: number, cap?: number, ambiguity?: string): number {
  const left = deadline - Date.now();
  if (left <= 0) {
    throw new VimeoHarvestError(
      "Vimeo caption harvest exceeded its whole-operation budget" + (ambiguity ? ` ${ambiguity}` : ""),
    );
  }
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
