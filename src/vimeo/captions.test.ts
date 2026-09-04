/**
 * The halves of `captions.ts` that run with no browser: the host-pinned VTT
 * download, the pure track choice, the harvest's error classification (driven
 * through an injected launcher over a stub DOM) — plus the load-bearing
 * structural fact that this module does not load a browser driver at import.
 */
import { describe, expect, test } from "bun:test";
import {
  chooseTrack,
  deHeadlessUserAgent,
  downloadVtt,
  harvestVimeoCaptions,
  VIMEO_CAPTIONS_HOST,
  VimeoBotBlockedError,
  VimeoBrowserMissingError,
  type VimeoBrowserLauncher,
  VimeoHarvestError,
  VimeoNotPublicError,
  type VimeoCaptionTrack,
  VimeoVttDownloadError,
} from "./captions.ts";

const SIGNED = `https://${VIMEO_CAPTIONS_HOST}/captions/322912661.vtt?expires=1788888888&sig=deadbeef`;

const captionsSource = await Bun.file(`${import.meta.dir}/captions.ts`).text();

function textFetch(
  body: string,
  init: ResponseInit = {},
): { impl: typeof fetch; inits: (RequestInit | undefined)[] } {
  const inits: (RequestInit | undefined)[] = [];
  const impl = (async (_input: RequestInfo | URL, requestInit?: RequestInit) => {
    inits.push(requestInit);
    return new Response(body, init);
  }) as unknown as typeof fetch;
  return { impl, inits };
}

/**
 * A body that delivers one chunk and then goes silent, honouring the abort the
 * way a real `fetch` body does. This is the shape a dribbling server has, and
 * the shape whose abort used to escape as a raw `AbortError`.
 */
function stallingFetch(firstChunk: string): typeof fetch {
  return ((_input: RequestInfo | URL, init?: RequestInit) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(firstChunk));
        init?.signal?.addEventListener("abort", () => controller.error(new Error("The operation was aborted.")));
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }) as unknown as typeof fetch;
}

describe("downloadVtt — the host pin", () => {
  test("downloads from captions.vimeo.com", async () => {
    const { impl } = textFetch("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHei");
    expect(await downloadVtt(SIGNED, { fetchImpl: impl })).toContain("WEBVTT");
  });

  test("refuses any other host", async () => {
    let called = false;
    const impl = (async () => {
      called = true;
      return new Response("WEBVTT");
    }) as unknown as typeof fetch;
    await expect(
      downloadVtt("https://evil.example/captions/1.vtt", { fetchImpl: impl }),
    ).rejects.toThrow(VimeoVttDownloadError);
    await expect(
      downloadVtt("https://captions.vimeo.com.evil.example/captions/1.vtt", { fetchImpl: impl }),
    ).rejects.toThrow(/only captions\.vimeo\.com/);
    // A host ENDING in the pinned one is the mutant a suffix test cannot see:
    // `xcaptions.vimeo.com` is somebody else's subdomain of vimeo.com, and
    // `hostname.endsWith(VIMEO_CAPTIONS_HOST)` accepts it.
    await expect(
      downloadVtt("https://xcaptions.vimeo.com/captions/1.vtt", { fetchImpl: impl }),
    ).rejects.toThrow(/only captions\.vimeo\.com/);
    expect(called).toBe(false);
  });

  test("the pinned host is matched case- and root-dot-insensitively", () => {
    // `URL` lowercases the hostname itself, so the only normalisation left is
    // the trailing root dot — and both spellings ARE the pinned host, so they
    // must not be refused.
    expect(new URL(`https://CAPTIONS.VIMEO.COM/x.vtt`).hostname).toBe(VIMEO_CAPTIONS_HOST);
    expect(new URL(`https://${VIMEO_CAPTIONS_HOST}./x.vtt`).hostname.replace(/\.$/, "")).toBe(
      VIMEO_CAPTIONS_HOST,
    );
  });

  test("refuses http, and refuses a non-URL", async () => {
    const { impl } = textFetch("WEBVTT");
    await expect(downloadVtt(`http://${VIMEO_CAPTIONS_HOST}/captions/1.vtt`, { fetchImpl: impl })).rejects.toThrow(
      /non-https/,
    );
    await expect(downloadVtt("captions.vimeo.com/1.vtt", { fetchImpl: impl })).rejects.toThrow(
      VimeoVttDownloadError,
    );
  });

  test("never follows a redirect — the first hop could leave the pinned host", async () => {
    const { impl, inits } = textFetch("", { status: 302, headers: { location: "https://evil.example/x" } });
    await expect(downloadVtt(SIGNED, { fetchImpl: impl })).rejects.toThrow(/redirect/i);
    expect(inits[0]?.redirect).toBe("error");
  });

  test("a non-2xx is an error", async () => {
    const { impl } = textFetch("gone", { status: 410 });
    await expect(downloadVtt(SIGNED, { fetchImpl: impl })).rejects.toThrow(/HTTP 410/);
  });
});

/**
 * Settle-or-report, because the property under test is "this call comes back at
 * all". A bare `await` on a never-settling promise IS failed by `bun test`'s
 * per-test timeout (measured on bun 1.3.10: "this test timed out after 300ms",
 * file completes) — but `await expect(<never-settling>).rejects.toThrow()` is
 * NOT: that construct hangs the whole file until it is killed (measured, same
 * version). The natural way to write "the call rejects with the budget error"
 * is exactly that construct, so this helper returns the rejection value, or the
 * string below when the call is still running — either way it comes back.
 */
async function settledWithin(call: Promise<unknown>, ms = 1_000): Promise<unknown> {
  return await Promise.race([
    call.then(
      (value) => value,
      (err) => err,
    ),
    Bun.sleep(ms).then(() => "STILL RUNNING — the call is not bounded by its budget"),
  ]);
}

describe("downloadVtt — the bounds", () => {
  test("refuses a body over the cap (a half VTT is a hole in a transcript)", async () => {
    const { impl } = textFetch("x".repeat(5_000));
    await expect(downloadVtt(SIGNED, { fetchImpl: impl, maxBytes: 1_000 })).rejects.toThrow(
      /exceeds 1000 bytes/,
    );
  });

  test("a body at the cap still downloads", async () => {
    const { impl } = textFetch("y".repeat(1_000));
    expect((await downloadVtt(SIGNED, { fetchImpl: impl, maxBytes: 1_000 })).length).toBe(1_000);
  });

  test("times out, and the abort reaches the request", async () => {
    let aborted = false;
    const impl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    await expect(downloadVtt(SIGNED, { fetchImpl: impl, timeoutMs: 25 })).rejects.toThrow(
      /timed out after 25ms/,
    );
    expect(aborted).toBe(true);
  });

  test("a timeout DURING the body read is still a VimeoVttDownloadError", async () => {
    // Measured against a real dribbling server: the abort fired inside
    // `reader.read()` and escaped as a raw `AbortError`, so every caller's
    // `instanceof VimeoVttDownloadError` handling was bypassed by the one
    // failure this download is most likely to have.
    const promise = downloadVtt(SIGNED, { fetchImpl: stallingFetch("WEBVTT\n\n"), timeoutMs: 30 });
    await expect(promise).rejects.toThrow(VimeoVttDownloadError);
    await expect(promise).rejects.toThrow(/timed out after 30ms/);
  }, 5_000);

  test("a fetchImpl that never answers is bounded by the budget, not by the signal", async () => {
    // The abort bounds a fetch that HONOURS it. `fetchVimeoOembed` additionally
    // RACES the budget for the case that does not — a stub, an e2e fake, a body
    // that ignores the signal — and this download did not, so such a caller hung
    // with a fired timer and nothing listening to it.
    const impl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const outcome = await settledWithin(downloadVtt(SIGNED, { fetchImpl: impl, timeoutMs: 30 }));
    expect(outcome).toBeInstanceOf(VimeoVttDownloadError);
    expect((outcome as Error).message).toMatch(/timed out after 30ms/);
  }, 5_000);

  test("a BODY that ignores the abort is bounded by the budget too", async () => {
    // The headers land, then the stream neither yields nor errors on abort:
    // `reader.read()` simply never settles. The race has to cover the body read
    // as well as the request, or the bound stops at the headers.
    const impl = (() =>
      Promise.resolve(
        new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 }),
      )) as unknown as typeof fetch;
    const outcome = await settledWithin(downloadVtt(SIGNED, { fetchImpl: impl, timeoutMs: 30 }));
    expect(outcome).toBeInstanceOf(VimeoVttDownloadError);
    expect((outcome as Error).message).toMatch(/timed out after 30ms/);
  }, 5_000);

  test("the BODILESS read is inside the budget as well", async () => {
    // The third door into the same hang: `res.body` null takes an
    // `await res.text()` shortcut, and a stub whose `text()` never settles is
    // bounded by neither the cap nor the signal. Built as a bare object rather
    // than a `Response`, because a real bodiless `Response.text()` always
    // resolves — the stub IS the seam this path is reached through.
    const impl = (async () => ({
      status: 200,
      ok: true,
      headers: new Headers(),
      body: null,
      text: () => new Promise<string>(() => {}),
    })) as unknown as typeof fetch;
    const outcome = await settledWithin(downloadVtt(SIGNED, { fetchImpl: impl, timeoutMs: 30 }));
    expect(outcome).toBeInstanceOf(VimeoVttDownloadError);
    expect((outcome as Error).message).toMatch(/timed out after 30ms/);
  }, 5_000);

  test("a bodiless response is not a silently empty transcript", async () => {
    // `res.body` null took an `await res.text()` shortcut whose size check ran
    // AFTER the buffering. A declared length over the cap must be refused before
    // anything is read.
    const impl = (async () =>
      new Response(null, { status: 200, headers: { "content-length": "9999999" } })) as unknown as typeof fetch;
    await expect(downloadVtt(SIGNED, { fetchImpl: impl, maxBytes: 1_000 })).rejects.toThrow(
      VimeoVttDownloadError,
    );
  });

  test("multi-byte text survives the streamed read", async () => {
    const body = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nFørst et par små saksopplysninger.";
    const { impl } = textFetch(body);
    expect(await downloadVtt(SIGNED, { fetchImpl: impl })).toBe(body);
  });
});

describe("chooseTrack", () => {
  const track = (lang: string, label = lang): VimeoCaptionTrack => ({
    lang,
    label,
    vttUrl: `https://${VIMEO_CAPTIONS_HOST}/captions/${lang}.vtt`,
  });

  test("no tracks", () => {
    expect(chooseTrack([])).toBeNull();
  });

  test("a single auto track is the answer", () => {
    expect(chooseTrack([track("no-x-autogen")])!.lang).toBe("no-x-autogen");
  });

  test("a manual track beats an auto-generated one", () => {
    expect(chooseTrack([track("no-x-autogen"), track("no")])!.lang).toBe("no");
  });

  test("the talk's own language beats an English translation", () => {
    // The auto track is generated from the AUDIO, so its language is the
    // spoken one — that is how a manual `no` is known to be the original.
    const chosen = chooseTrack([track("en"), track("no-x-autogen"), track("no")]);
    expect(chosen!.lang).toBe("no");
  });

  test("with no auto track to name the spoken language, source order wins", () => {
    expect(chooseTrack([track("en"), track("fr")])!.lang).toBe("en");
  });

  test("among several auto tracks, source order — the spoken language is UNKNOWN", () => {
    // Vimeo's auto-TRANSLATIONS carry `-x-autogen` too, so with more than one
    // auto track "the first one is the spoken language" is luck of ordering, not
    // a fact. Nothing is claimed: source order decides, as it does with no auto
    // track at all.
    expect(chooseTrack([track("no-x-autogen"), track("en-x-autogen")])!.lang).toBe("no-x-autogen");
  });

  test("several auto tracks do not let one of them pick the manual track", () => {
    // The first auto track being `en-x-autogen` used to promote the English
    // MANUAL track over the Norwegian one listed first — a translation chosen
    // over the original, on the strength of an ordering that means nothing.
    const chosen = chooseTrack([
      track("no"),
      track("en"),
      track("en-x-autogen"),
      track("no-x-autogen"),
    ]);
    expect(chosen!.lang).toBe("no");
  });

  test("a LONE auto track still names the spoken language", () => {
    expect(chooseTrack([track("en"), track("no-x-autogen"), track("no")])!.lang).toBe("no");
  });

  test("a track with no harvested URL is unusable and drops out", () => {
    const chosen = chooseTrack([{ lang: "no", label: "Norsk", vttUrl: "" }, track("en-x-autogen")]);
    expect(chosen!.lang).toBe("en-x-autogen");
    expect(chooseTrack([{ lang: "no", label: "Norsk", vttUrl: "" }])).toBeNull();
  });
});

// ── The harvest, over a stub DOM ─────────────────────────────────────────────
//
// The page-side functions are handed to `page.evaluate` as closures over
// `document`, so the fake RUNS them against a stub DOM rather than matching on
// their source text: what is under test is what those functions do — which track
// ends up `hidden`, which ends up `disabled` — and a source-text assertion
// cannot see that.

interface FakeTrack {
  language: string;
  label: string;
  mode: string;
}

interface FakePageSpec {
  title?: string;
  heading?: string;
  hasVideo?: boolean;
  tracks?: { lang: string; label: string }[];
  /** The VTT URL enabling track i makes the player request; null = none. */
  urlPerTrack?: (string | null)[];
  /** Burned before `goto` resolves, to exhaust the whole-operation budget. */
  gotoDelayMs?: number;
  /** `goto` burns its own timeout and rejects the way Playwright does. */
  stallGoto?: boolean;
  /** `goto` rejects immediately with this message (a DNS/transport failure). */
  gotoThrows?: string;
  /** `launch` takes this long — spends budget before any navigation. */
  launchDelayMs?: number;
  /**
   * A failing `waitForSelector`/`waitForFunction` BURNS the timeout it was given
   * before rejecting — which is what Playwright's real waits do, and the only
   * way the budget can expire while a wait is in flight rather than before it.
   * (A few ms over, so "the deadline has passed" is deterministic rather than a
   * race with the clock.)
   */
  stallWaits?: boolean;
  /** The probe evaluate throws with this message (a detached frame, say). */
  probeThrows?: string;
  duration?: number;
}

interface FakeHarness {
  launcher: VimeoBrowserLauncher;
  /** Every `mode` assignment, in order: `"<index>:<mode>"`. */
  modeLog: string[];
  /** Watch-page loads. One per harvest ATTEMPT — the retry is the second. (The
   *  throwaway context `derivedUserAgent` opens navigates nowhere.) */
  navigations: number;
}

function fakeHarness(spec: FakePageSpec): FakeHarness {
  const modeLog: string[] = [];
  const requestHandlers: ((req: { url: () => string }) => void)[] = [];
  const trackSpecs = spec.tracks ?? [];
  const tracks: FakeTrack[] = trackSpecs.map((t, i) => {
    let mode = "disabled";
    return {
      language: t.lang,
      label: t.label,
      get mode() {
        return mode;
      },
      set mode(next: string) {
        mode = next;
        modeLog.push(`${i}:${next}`);
        const url = spec.urlPerTrack?.[i];
        if (next === "hidden" && url) for (const h of requestHandlers) h({ url: () => url });
      },
    } as FakeTrack;
  });

  const video = {
    muted: false,
    duration: spec.duration ?? Number.NaN,
    play: () => Promise.resolve(),
    pause: () => {},
    textTracks: Object.assign(tracks, { length: tracks.length }),
  };
  const document = {
    get title() {
      return spec.title ?? "";
    },
    querySelector(selector: string) {
      if (selector === "video") return spec.hasVideo === false ? null : video;
      if (selector === "h1") return spec.heading === undefined ? null : { textContent: spec.heading };
      return null;
    },
  };

  /** Runs a page-side closure with the stub `document` installed. */
  async function runInPage<T>(fn: (arg?: unknown) => T, arg?: unknown): Promise<T> {
    const had = "document" in globalThis;
    const previous = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = document;
    try {
      return fn(arg);
    } finally {
      if (had) (globalThis as { document?: unknown }).document = previous;
      else delete (globalThis as { document?: unknown }).document;
    }
  }

  /** Spend the wait's own timeout before failing, when the spec asks for it. */
  async function burnTimeout(timeout: number | undefined): Promise<void> {
    if (spec.stallWaits) await Bun.sleep((timeout ?? 0) + 5);
  }

  let navigations = 0;
  const page = {
    on(event: string, handler: (req: { url: () => string }) => void) {
      if (event === "request") requestHandlers.push(handler);
    },
    async goto(_url: string, opts?: { timeout?: number }) {
      navigations++;
      if (spec.gotoDelayMs) await Bun.sleep(spec.gotoDelayMs);
      if (spec.stallGoto) {
        await Bun.sleep((opts?.timeout ?? 0) + 5);
        throw new Error(`goto: Timeout ${opts?.timeout}ms exceeded.`);
      }
      if (spec.gotoThrows) throw new Error(spec.gotoThrows);
      return null;
    },
    async evaluate(fn: (arg?: unknown) => unknown, arg?: unknown) {
      const source = String(fn);
      if (source.includes("hasVideo") && spec.probeThrows) throw new Error(spec.probeThrows);
      return await runInPage(fn, arg);
    },
    async waitForSelector(selector: string, options?: { timeout?: number }) {
      if (selector === "video" && spec.hasVideo === false) {
        await burnTimeout(options?.timeout);
        throw new Error("Timeout waiting for selector");
      }
      return {};
    },
    async waitForFunction(fn: () => unknown, _arg?: unknown, options?: { timeout?: number }) {
      const ok = await runInPage(fn as (arg?: unknown) => unknown);
      if (!ok) {
        await burnTimeout(options?.timeout);
        throw new Error("Timeout waiting for function");
      }
      return {};
    },
  };

  const context = {
    async newPage() {
      return page;
    },
    async close() {},
  };
  const browser = {
    async newContext() {
      return context;
    },
    async close() {},
  };

  return {
    launcher: {
      launch: async () => {
        if (spec.launchDelayMs) await Bun.sleep(spec.launchDelayMs);
        return browser;
      },
    } as unknown as VimeoBrowserLauncher,
    modeLog,
    get navigations() {
      return navigations;
    },
  };
}

/** A launcher that fails the way `chromium.launch` fails. */
function failingLauncher(message: string): VimeoBrowserLauncher {
  return {
    launch: async () => {
      throw new Error(message);
    },
  } as unknown as VimeoBrowserLauncher;
}

const CAPTION_URL = (lang: string) => `https://${VIMEO_CAPTIONS_HOST}/captions/${lang}.vtt?sig=abc`;

describe("harvestVimeoCaptions — what a failure is ALLOWED to be called", () => {
  test("a missing browser binary is the only VimeoBrowserMissingError", async () => {
    // Playwright's own wording, verbatim from a machine with no `bunx playwright
    // install chromium`: that message is the one that earns the remedy in
    // VimeoBrowserMissingError's text.
    await expect(
      harvestVimeoCaptions("123", {
        launcher: failingLauncher(
          "browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app",
        ),
      }),
    ).rejects.toThrow(VimeoBrowserMissingError);
  });

  test("any OTHER launch failure is a harvest error, not 'install chromium'", async () => {
    // A sandbox refusal, an OOM, a budget exhaustion: telling the operator to
    // install a browser they already have sends the diagnosis the wrong way.
    const promise = harvestVimeoCaptions("123", {
      launcher: failingLauncher("Target page, context or browser has been closed"),
    });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.not.toThrow(VimeoBrowserMissingError);
  });

  test("an exhausted budget is a harvest error, not 'not publicly playable'", async () => {
    // The budget check sat INSIDE the try whose catch means "no <video> on the
    // page", so a slow page was reported as a private video.
    const harness = fakeHarness({ hasVideo: true, gotoDelayMs: 60, tracks: [] });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher, timeoutMs: 40 });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.not.toThrow(VimeoNotPublicError);
    // Spent before any wait STARTED: the page was never observed, so there is no
    // "may also be private" to say — that clause belongs to a wait cut short.
    await expect(promise).rejects.not.toThrow(/may also be private/);
  }, 5_000);

  test("a budget that expires DURING the <video> wait is still a harvest error", async () => {
    // Hoisting `remaining()` out of the try covers only a budget already spent
    // when the wait STARTS. The likelier case is the one the wait itself causes:
    // `waitForSelector` gets what is left of the budget, burns it, and rejects —
    // and that rejection is indistinguishable from "this page has no <video>".
    // Classified on the shape of the error alone it read as VimeoNotPublicError,
    // i.e. a claim about the video made by a clock.
    const harness = fakeHarness({ hasVideo: false, stallWaits: true, title: "Whatever on Vimeo" });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher, timeoutMs: 60 });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.not.toThrow(VimeoNotPublicError);
    // A wait cut short by the budget observed the page for less than its window,
    // so the budget error must SAY the video may also be private — otherwise the
    // operator reads "raise the timeout" about a video that never had a <video>.
    await expect(promise).rejects.toThrow(/may also be private/);
  }, 5_000);

  test("a budget that expires DURING the navigation is the budget, not a raw Playwright error", async () => {
    // Measured live with `--timeout=1500`: `TimeoutError: goto: Timeout 709ms
    // exceeded.` reached the operator verbatim — no class, no budget wording.
    const harness = fakeHarness({ hasVideo: true, tracks: [], stallGoto: true });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher, timeoutMs: 60 });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.toThrow(/may also be slow or unreachable/);
  }, 5_000);

  test("a navigation that fails with budget to spare is a harvest error carrying Playwright's message", async () => {
    // The non-budget half of the goto catch: a DNS or transport failure must
    // come back classified AND with the underlying reason, never the ambiguity
    // clause (nothing about the budget is true here).
    const harness = fakeHarness({ hasVideo: true, tracks: [], gotoThrows: "net::ERR_NAME_NOT_RESOLVED" });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher, timeoutMs: 60_000 });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.toThrow(/net::ERR_NAME_NOT_RESOLVED/);
    await expect(promise).rejects.not.toThrow(/slow or unreachable/);
  }, 5_000);

  test("a budget already spent by launch is reported WITHOUT the navigation clause", async () => {
    // `remaining()` for goto is computed outside its try: computed inside, a
    // budget gone before navigation was rethrown with "the site may also be
    // slow" about a page that was never requested.
    const harness = fakeHarness({ hasVideo: true, tracks: [], launchDelayMs: 60 });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher, timeoutMs: 40 });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.not.toThrow(/slow or unreachable/);
    expect(harness.navigations).toBe(0);
  }, 5_000);

  test("a budget that expires DURING the text-track wait is not 'no tracks'", async () => {
    // Same shape one step down: that catch means "this video has no captions",
    // which an exhausted budget is not — and with no tracks to pair, nothing
    // downstream calls `remaining()` again, so the harvest RESOLVED, reporting an
    // empty track list for a video whose tracks were never waited out.
    const harness = fakeHarness({ hasVideo: true, tracks: [], stallWaits: true });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher, timeoutMs: 60 });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.toThrow(/may also have no captions/);
  }, 5_000);

  test("a non-finite budget is refused at the door", async () => {
    // `remaining()` guards `left <= 0`, which is FALSE for NaN — so NaN flowed
    // into every Playwright timeout, and Playwright reads a falsy timeout as
    // "wait forever". `--timeout=abc` on the smoke script is how it arrives.
    for (const timeoutMs of [Number.NaN, 0, -1, Number.POSITIVE_INFINITY]) {
      const harness = fakeHarness({ hasVideo: true, tracks: [] });
      await expect(harvestVimeoCaptions("123", { launcher: harness.launcher, timeoutMs })).rejects.toThrow(
        VimeoHarvestError,
      );
    }
  });

  test("a page with no <video> and no challenge heading is not public", async () => {
    const harness = fakeHarness({ hasVideo: false, title: "Private video on Vimeo" });
    await expect(harvestVimeoCaptions("123", { launcher: harness.launcher })).rejects.toThrow(
      VimeoNotPublicError,
    );
  });

  test("a video TITLED 'Sorry, …' is not a bot page", async () => {
    // `/^sorry\b/i` against `document.title` reported a real video as
    // bot-blocked. The 403 page's title is the word and nothing else.
    const harness = fakeHarness({ hasVideo: false, title: "Sorry, Not Sorry on Vimeo" });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher });
    await expect(promise).rejects.toThrow(VimeoNotPublicError);
    await expect(promise).rejects.not.toThrow(VimeoBotBlockedError);
  });

  test("the measured interstitials ARE bot pages, and are retried once", async () => {
    for (const spec of [
      { title: "Sorry" },
      { heading: "Verify to continue" },
      { heading: "We couldn't verify the security of your connection" },
    ]) {
      const harness = fakeHarness({ hasVideo: false, ...spec });
      await expect(harvestVimeoCaptions("123", { launcher: harness.launcher })).rejects.toThrow(
        VimeoBotBlockedError,
      );
      expect(harness.navigations).toBe(2);
    }
  });

  test("a page that cannot be inspected is not reported as a private video", async () => {
    // `.catch(() => null)` on the probe meant "not a bot page", which with no
    // <video> became "not publicly playable" — a claim about the video made from
    // an evaluate that never ran.
    const harness = fakeHarness({ hasVideo: false, probeThrows: "Execution context was destroyed" });
    const promise = harvestVimeoCaptions("123", { launcher: harness.launcher });
    await expect(promise).rejects.toThrow(VimeoHarvestError);
    await expect(promise).rejects.toThrow(/Execution context was destroyed/);
  });
});

describe("harvestVimeoCaptions — track/URL correlation", () => {
  test("tracks are enabled ONE at a time: the previous one is disabled again", async () => {
    // Enabling was cumulative, so from track 2 on, several tracks were `hidden`
    // at once and a late URL belonging to track i-1 was assigned to track i —
    // silently, as a caption file in the wrong language.
    const harness = fakeHarness({
      hasVideo: true,
      tracks: [
        { lang: "no-x-autogen", label: "Norsk" },
        { lang: "en", label: "English" },
      ],
      urlPerTrack: [CAPTION_URL("no"), CAPTION_URL("en")],
    });
    const result = await harvestVimeoCaptions("123", { launcher: harness.launcher });
    expect(result.tracks.map((t) => `${t.lang}=${t.vttUrl}`)).toEqual([
      `no-x-autogen=${CAPTION_URL("no")}`,
      `en=${CAPTION_URL("en")}`,
    ]);
    // Track 0 is hidden, then put back to disabled before track 1 is hidden.
    expect(harness.modeLog).toEqual(["0:hidden", "0:disabled", "1:hidden"]);
  }, 10_000);
});

describe("deHeadlessUserAgent", () => {
  // The single line the harvest depends on: Vimeo's Cloudflare gate challenges
  // the `HeadlessChrome` token and nothing else about the browser (measured four
  // ways, 2026-09-04 — see the function's own comment).
  const HEADLESS =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/145.0.7632.6 Safari/537.36";

  test("drops the automation token and NOTHING else", () => {
    expect(deHeadlessUserAgent(HEADLESS)).toBe(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.7632.6 Safari/537.36",
    );
  });

  test("the version is the real one — it is derived, not a fingerprint", () => {
    expect(deHeadlessUserAgent(HEADLESS)).toContain("145.0.7632.6");
    expect(deHeadlessUserAgent(HEADLESS)).not.toContain("Headless");
  });

  test("a headed UA passes through untouched", () => {
    const headed =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
    expect(deHeadlessUserAgent(headed)).toBe(headed);
  });
});

describe("no browser driver is loaded by importing this module", () => {
  // LOAD-BEARING: `src/dashboard/routes.ts` statically imports every route
  // module, so anything that loads a browser driver at MODULE level here pulls
  // one into a `MUNINN_PROFILE=nais` boot, in an image built without one.
  //
  // The old version of this test was a line-anchored regex over the source, and
  // it was VACUOUS against the two regressions that would actually happen: a
  // module-scope `const pw = await import("playwright-core")` (top-level await,
  // no `import` statement at all) and a bare side-effect `import
  // "playwright-core";` (no `from` clause) both passed it. So the property is
  // checked two ways, neither of them a line-shaped regex.

  test("the module PARSES with no static playwright import", () => {
    // Bun's own parser, not a regex: it sees a multi-line `import x\n from
    // "playwright"` and a side-effect `import "playwright-core";` alike, and it
    // reports the dynamic import as a different KIND.
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(captionsSource);
    const playwright = imports.filter((i) => i.path.startsWith("playwright"));
    expect(playwright.map((i) => `${i.kind} ${i.path}`)).toEqual(["dynamic-import playwright-core"]);
  });

  test("IMPORTING the module does not load a browser driver", async () => {
    // The property itself, executed: a child process that refuses to load any
    // `playwright*` module, then imports this one. A module-scope `await
    // import(...)` — which no import-statement check can see — fails here.
    const child = Bun.spawnSync([
      process.execPath,
      "-e",
      `import { plugin } from "bun";
       plugin({
         name: "no-playwright",
         setup(build) {
           build.onLoad({ filter: /playwright/ }, () => {
             throw new Error("LOADED_A_BROWSER_DRIVER");
           });
         },
       });
       await import(${JSON.stringify(`${import.meta.dir}/captions.ts`)});
       console.log("CLEAN");`,
    ]);
    const output = `${child.stdout.toString()}${child.stderr.toString()}`;
    expect(output).not.toContain("LOADED_A_BROWSER_DRIVER");
    expect(output).toContain("CLEAN");
    expect(child.exitCode).toBe(0);
  }, 30_000);

  test("the load site is a dynamic import of playwright-CORE", () => {
    expect(captionsSource).toContain('await import("playwright-core")');
    // `playwright`, not `playwright-core`, ships the browser binaries and a
    // postinstall — the package name itself is part of the decision.
    expect(captionsSource).not.toMatch(/["']playwright["']/);
  });
});
