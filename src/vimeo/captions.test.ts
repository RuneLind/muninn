/**
 * The two halves of `captions.ts` that run with no browser: the host-pinned VTT
 * download and the pure track choice — plus the load-bearing structural fact
 * that this module does not statically import a browser driver.
 */
import { describe, expect, test } from "bun:test";
import {
  chooseTrack,
  deHeadlessUserAgent,
  downloadVtt,
  VIMEO_CAPTIONS_HOST,
  VimeoVttDownloadError,
  type VimeoCaptionTrack,
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
    expect(called).toBe(false);
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

  test("among several auto tracks the first (the spoken one) wins", () => {
    expect(chooseTrack([track("no-x-autogen"), track("en-x-autogen")])!.lang).toBe("no-x-autogen");
  });

  test("a track with no harvested URL is unusable and drops out", () => {
    const chosen = chooseTrack([{ lang: "no", label: "Norsk", vttUrl: "" }, track("en-x-autogen")]);
    expect(chosen!.lang).toBe("en-x-autogen");
    expect(chooseTrack([{ lang: "no", label: "Norsk", vttUrl: "" }])).toBeNull();
  });
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

describe("no static browser import", () => {
  // LOAD-BEARING: `src/dashboard/routes.ts` statically imports every route
  // module, so a top-level `import … from "playwright…"` here would pull a
  // browser driver into a `MUNINN_PROFILE=nais` boot, in an image built without
  // one. The dynamic import loads it only when a harvest actually runs.
  test("no import statement names playwright", () => {
    expect(captionsSource).not.toMatch(/^\s*import\s[^\n]*\bfrom\s*["']playwright/m);
    expect(captionsSource).not.toMatch(/\brequire\(\s*["']playwright/);
  });

  test("the dynamic import is the only load site", () => {
    expect(captionsSource).toContain('await import("playwright-core")');
    // `playwright`, not `playwright-core`, ships the browser binaries and a
    // postinstall — the package name itself is part of the decision.
    expect(captionsSource).not.toMatch(/["']playwright["']/);
  });
});
