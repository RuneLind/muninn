import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  VIMEO_MEDIA_HOST,
  VIMEO_RENDITION_MAX_BYTES,
  VimeoMediaDownloadError,
  VimeoMediaError,
  chooseRepresentation,
  downloadRendition,
  fetchVimeoManifest,
  initSegmentBytes,
  parseVimeoManifest,
  renditionTimeoutFor,
  resolveSegmentUrl,
  segmentIndexAt,
  segmentIndicesFor,
  type VimeoManifest,
} from "./media.ts";

const FIXTURE_PATH = new URL("./fixtures/manifest-placeholder.json", import.meta.url).pathname;
const FIXTURE_RAW = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

/** The shape a live manifest URL has; the signed parts are placeholders. */
const MANIFEST_URL =
  `https://${VIMEO_MEDIA_HOST}/exp=0~acl=placeholder~hmac=placeholder/00000000-0000-4000-8000-000000000000/psid=placeholder/v2/playlist/av/primary/prot/placeholder/playlist.json?omit=av1-hevc&pathsig=placeholder`;

function fixture(): VimeoManifest {
  return parseVimeoManifest(FIXTURE_RAW);
}

/** A `fetch` stub answering every URL with `body`, recording what was asked. */
function bytesFetch(body: (url: string) => Uint8Array<ArrayBuffer>, status = 200) {
  const urls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    return new Response(body(url), { status, headers: { "content-type": "video/mp4" } });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe("parseVimeoManifest — the committed fixture", () => {
  test("is a real manifest's shape: 5 video + 2 audio representations, 12 segments each", () => {
    const m = fixture();
    expect(m.video.map((r) => r.height)).toEqual([1080, 720, 540, 360, 240]);
    expect(m.audio.map((r) => r.codecs)).toEqual(["mp4a.40.2", "opus"]);
    for (const r of [...m.video, ...m.audio]) {
      expect(r.segments.length).toBe(12);
      expect(r.segments[0]!.start).toBe(0);
      expect(r.durationSec).toBeCloseTo(r.segments[11]!.end);
    }
    expect(m.baseUrl).toBe("../../../../../range/prot/");
  });

  test("carries no live signed path, id or URL", () => {
    const text = readFileSync(FIXTURE_PATH, "utf8");
    expect(text).not.toMatch(/pathsig=[0-9a-f]{8}~/);
    expect(text).not.toMatch(/exp=\d{10}/);
    expect(text).not.toMatch(/hmac=/);
    expect(text).not.toMatch(/psid=[0-9a-f]{20,}/);
    // Every representation id is a named placeholder, never a live UUID.
    for (const r of [...FIXTURE_RAW.video, ...FIXTURE_RAW.audio]) {
      expect(r.id).toMatch(/^rep-(video-\d+p|audio-(opus|aac))$/);
    }
  });

  test("ignores keys it does not read and refuses a missing load-bearing one, naming the path", () => {
    const grown = structuredClone(FIXTURE_RAW);
    grown.video[0].brand_new_key = { anything: true };
    grown.extra = 1;
    expect(parseVimeoManifest(grown).video[0]!.height).toBe(1080);

    const noSegments = structuredClone(FIXTURE_RAW);
    delete noSegments.video[1].segments;
    expect(() => parseVimeoManifest(noSegments)).toThrow(/video\[1\]: "segments"/);

    const badStart = structuredClone(FIXTURE_RAW);
    badStart.audio[0].segments[3].start = "3";
    expect(() => parseVimeoManifest(badStart)).toThrow(/audio\[0\]\.segments\[3\]: "start"/);

    const outOfOrder = structuredClone(FIXTURE_RAW);
    outOfOrder.video[0].segments[5].start = 0;
    expect(() => parseVimeoManifest(outOfOrder)).toThrow(/not in start order at \[5\]/);

    expect(() => parseVimeoManifest(null)).toThrow(VimeoMediaError);
    expect(() => parseVimeoManifest([])).toThrow(/not a JSON object/);
    expect(() => parseVimeoManifest({ clip_id: "x", base_url: "", video: [] })).toThrow(/"audio"/);
  });

  test("an empty rep base_url is legal, an empty id is not", () => {
    expect(fixture().video[0]!.baseUrl).toBe("");
    const blankId = structuredClone(FIXTURE_RAW);
    blankId.video[0].id = "";
    expect(() => parseVimeoManifest(blankId)).toThrow(/video\[0\]: "id" is not a non-empty string/);
  });
});

describe("chooseRepresentation", () => {
  test("video: the SMALLEST rendition at least the target height", () => {
    const m = fixture();
    expect(chooseRepresentation(m, { kind: "video", height: 720 })?.height).toBe(720);
    expect(chooseRepresentation(m, { kind: "video", height: 700 })?.height).toBe(720);
    expect(chooseRepresentation(m, { kind: "video", height: 721 })?.height).toBe(1080);
    expect(chooseRepresentation(m, { kind: "video", height: 100 })?.height).toBe(240);
  });

  test("video: the tallest available when none reaches the target", () => {
    expect(chooseRepresentation(fixture(), { kind: "video", height: 4000 })?.height).toBe(1080);
  });

  test("audio: the requested codec family, else the cheapest", () => {
    const m = fixture();
    expect(chooseRepresentation(m, { kind: "audio", codec: "opus" })?.codecs).toBe("opus");
    expect(chooseRepresentation(m, { kind: "audio", codec: "aac" })?.codecs).toBe("mp4a.40.2");
    // Opus is the cheaper of the two (101 vs 194 kbps), so "no preference" is Opus here.
    expect(chooseRepresentation(m, { kind: "audio" })?.codecs).toBe("opus");
    const noOpus: VimeoManifest = { ...m, audio: m.audio.filter((r) => r.codecs !== "opus") };
    expect(chooseRepresentation(noOpus, { kind: "audio", codec: "opus" })?.codecs).toBe("mp4a.40.2");
  });

  test("a representation with no segments is never chosen; nothing of the kind is null", () => {
    const m = fixture();
    const hollow720: VimeoManifest = {
      ...m,
      video: m.video.map((r) => (r.height === 720 ? { ...r, segments: [] } : r)),
    };
    expect(chooseRepresentation(hollow720, { kind: "video", height: 720 })?.height).toBe(1080);
    expect(chooseRepresentation({ ...m, audio: [] }, { kind: "audio" })).toBeNull();
    expect(chooseRepresentation({ ...m, video: [] }, { kind: "video", height: 720 })).toBeNull();
  });

  test("does not mutate the manifest's arrays", () => {
    const m = fixture();
    const before = m.video.map((r) => r.id);
    chooseRepresentation(m, { kind: "video", height: 100 });
    chooseRepresentation(m, { kind: "video", height: 4000 });
    expect(m.video.map((r) => r.id)).toEqual(before);
  });
});

describe("segmentIndexAt / segmentIndicesFor", () => {
  const rep = () => fixture().video[1]!; // 720p, 12 × ~6.08 s

  test("start ≤ t < end names the segment; boundaries belong to the later one", () => {
    const r = rep();
    expect(segmentIndexAt(r, 0)).toBe(0);
    expect(segmentIndexAt(r, 6.0)).toBe(0);
    expect(segmentIndexAt(r, r.segments[1]!.start)).toBe(1);
    expect(segmentIndexAt(r, 40)).toBe(6);
    expect(r.segments[6]!.start).toBeLessThanOrEqual(40);
    expect(r.segments[6]!.end).toBeGreaterThan(40);
  });

  test("clamps: before the first ⇒ 0, at or past the last end ⇒ the last", () => {
    const r = rep();
    expect(segmentIndexAt(r, -5)).toBe(0);
    expect(segmentIndexAt(r, Number.NaN)).toBe(0);
    expect(segmentIndexAt(r, r.durationSec)).toBe(11);
    expect(segmentIndexAt(r, 99_999)).toBe(11);
  });

  test("no segments is a refusal, not index 0", () => {
    expect(() => segmentIndexAt({ ...rep(), segments: [] }, 3)).toThrow(VimeoMediaError);
  });

  test("indices for a time list are sorted and de-duplicated", () => {
    expect(segmentIndicesFor(rep(), [50, 1, 2, 40, 50.5])).toEqual([0, 6, 8]);
  });
});

describe("resolveSegmentUrl", () => {
  test("resolves rep.baseUrl + segment.url against the manifest's base against the manifest URL", () => {
    const m = fixture();
    const rep = m.video[1]!;
    const url = new URL(resolveSegmentUrl(MANIFEST_URL, m, rep, rep.segments[3]!));
    expect(url.hostname).toBe(VIMEO_MEDIA_HOST);
    // `../../../../../range/prot/` climbs five directories from
    // `/…/v2/playlist/av/primary/prot/placeholder/` — placeholder, prot,
    // primary, av, playlist — to `/…/v2/`, then `range/prot/` + the segment's own path.
    expect(url.pathname).toBe(
      "/exp=0~acl=placeholder~hmac=placeholder/00000000-0000-4000-8000-000000000000/psid=placeholder/v2/range/prot/placeholder/avf/rep-video-720p.mp4",
    );
    expect(url.search).toBe("?pathsig=placeholder&range=3");
  });

  test("a manifest whose base points off-host resolves there — and the download refuses it", async () => {
    const m: VimeoManifest = { ...fixture(), baseUrl: "https://evil.example/range/" };
    const rep = m.video[1]!;
    expect(new URL(resolveSegmentUrl(MANIFEST_URL, m, rep, rep.segments[0]!)).hostname).toBe("evil.example");
    const { impl, urls } = bytesFetch(() => new Uint8Array(new ArrayBuffer(16)));
    const out = join(mkdtempSync(join(tmpdir(), "vimeo-media-")), "x.mp4");
    await expect(downloadRendition(MANIFEST_URL, m, rep, [0], out, { fetchImpl: impl })).rejects.toThrow(
      /only vod-adaptive-ak\.vimeocdn\.com/,
    );
    expect(urls).toEqual([]); // refused before any request
    expect(existsSync(out)).toBe(false);
  });
});

describe("initSegmentBytes", () => {
  test("decodes to an fMP4 header (ftyp)", () => {
    const bytes = initSegmentBytes(fixture().video[1]!);
    expect(bytes.byteLength).toBeGreaterThan(8);
    expect(new TextDecoder().decode(bytes.subarray(4, 8))).toBe("ftyp");
  });

  test("refuses a decode too short to be a box", () => {
    expect(() => initSegmentBytes({ ...fixture().video[1]!, initSegment: "AAAA" })).toThrow(/decodes to 3 bytes/);
  });
});

describe("renditionTimeoutFor", () => {
  test("30 s fixed + 1.5 s per segment, never below the fixed part", () => {
    expect(renditionTimeoutFor(0)).toBe(30_000);
    expect(renditionTimeoutFor(1)).toBe(31_500);
    expect(renditionTimeoutFor(60)).toBe(120_000);
    expect(renditionTimeoutFor(-3)).toBe(30_000);
  });
});

describe("fetchVimeoManifest", () => {
  test("host-pinned, then parsed", async () => {
    const { impl, urls } = bytesFetch(() => new TextEncoder().encode(JSON.stringify(FIXTURE_RAW)) as Uint8Array<ArrayBuffer>);
    const m = await fetchVimeoManifest(MANIFEST_URL, { fetchImpl: impl });
    expect(m.video.length).toBe(5);
    expect(urls).toEqual([MANIFEST_URL]);

    await expect(
      fetchVimeoManifest("https://captions.vimeo.com/v2/playlist.json", { fetchImpl: impl }),
    ).rejects.toThrow(VimeoMediaDownloadError);
    await expect(
      fetchVimeoManifest(MANIFEST_URL.replace("https:", "http:"), { fetchImpl: impl }),
    ).rejects.toThrow(/non-https manifest URL/);
  });

  test("an over-cap manifest is refused, not truncated into a parse error", async () => {
    const { impl } = bytesFetch(() => new Uint8Array(new ArrayBuffer(5_000)));
    const outcome = await fetchVimeoManifest(MANIFEST_URL, { fetchImpl: impl, maxBytes: 1_000 }).catch((e) => e);
    expect(outcome).toBeInstanceOf(VimeoMediaDownloadError);
    expect((outcome as Error).message).toMatch(/Manifest body exceeds 1000 bytes/);
  });

  test("a non-JSON body is a VimeoMediaError", async () => {
    const { impl } = bytesFetch(() => new TextEncoder().encode("#EXTM3U") as Uint8Array<ArrayBuffer>);
    await expect(fetchVimeoManifest(MANIFEST_URL, { fetchImpl: impl })).rejects.toThrow(/not JSON/);
  });
});

describe("downloadRendition", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "vimeo-media-"));

  /** Each segment's fake body is its `range=` value repeated, so file order is checkable. */
  function segmentBody(url: string): Uint8Array<ArrayBuffer> {
    const n = Number(new URL(url).searchParams.get("range"));
    return new Uint8Array(new ArrayBuffer(4)).fill(n);
  }

  test("writes init + the requested segments in INDEX order, sparse indices allowed", async () => {
    const m = fixture();
    const rep = m.video[1]!;
    const { impl, urls } = bytesFetch(segmentBody);
    const out = join(dir(), "sparse.mp4");
    const result = await downloadRendition(MANIFEST_URL, m, rep, [9, 2, 2, 5], out, { fetchImpl: impl });

    const init = initSegmentBytes(rep);
    const file = new Uint8Array(readFileSync(out));
    expect([...file.subarray(0, init.byteLength)]).toEqual([...init]);
    expect([...file.subarray(init.byteLength)]).toEqual([2, 2, 2, 2, 5, 5, 5, 5, 9, 9, 9, 9]);
    expect(result.bytes).toBe(init.byteLength + 12);
    expect(result.segments.map((s) => s.index)).toEqual([2, 5, 9]);
    expect(result.segments[0]!.start).toBe(rep.segments[2]!.start);
    expect(urls.map((u) => new URL(u).searchParams.get("range"))).toEqual(["2", "5", "9"]);
    for (const u of urls) expect(new URL(u).hostname).toBe(VIMEO_MEDIA_HOST);
  });

  test("an index outside the representation is refused before anything is fetched", async () => {
    const m = fixture();
    const { impl, urls } = bytesFetch(segmentBody);
    const out = join(dir(), "oob.mp4");
    await expect(downloadRendition(MANIFEST_URL, m, m.video[1]!, [12], out, { fetchImpl: impl })).rejects.toThrow(
      /outside 0\.\.11/,
    );
    await expect(downloadRendition(MANIFEST_URL, m, m.video[1]!, [], out, { fetchImpl: impl })).rejects.toThrow(
      /No segments requested/,
    );
    expect(urls).toEqual([]);
    expect(existsSync(out)).toBe(false);
  });

  test("the DECLARED total is checked against the cap before the first fetch", async () => {
    const m = fixture();
    const rep = m.video[0]!; // 1080p: the biggest declared sizes
    const { impl, urls } = bytesFetch(segmentBody);
    const out = join(dir(), "big.mp4");
    const declared = rep.segments[0]!.size + rep.segments[1]!.size;
    await expect(
      downloadRendition(MANIFEST_URL, m, rep, [0, 1], out, { fetchImpl: impl, maxTotalBytes: declared - 1 }),
    ).rejects.toThrow(/Refusing to download \d+ declared bytes/);
    expect(urls).toEqual([]);
    // Exactly at the cap is allowed.
    await downloadRendition(MANIFEST_URL, m, rep, [0, 1], out, { fetchImpl: impl, maxTotalBytes: declared });
    expect(urls.length).toBe(2);
    expect(VIMEO_RENDITION_MAX_BYTES).toBeGreaterThan(declared);
  });

  test("a failing segment removes the partial file and rethrows the engine's error", async () => {
    const m = fixture();
    const rep = m.video[1]!;
    let calls = 0;
    const impl = (async (input: string | URL | Request) => {
      calls++;
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (calls === 2) return new Response("gone", { status: 410 });
      return new Response(segmentBody(url), { status: 200 });
    }) as unknown as typeof fetch;
    const out = join(dir(), "partial.mp4");
    const outcome = await downloadRendition(MANIFEST_URL, m, rep, [0, 1, 2], out, { fetchImpl: impl }).catch((e) => e);
    expect(outcome).toBeInstanceOf(VimeoMediaDownloadError);
    expect((outcome as Error).message).toMatch(/Segment download returned HTTP 410/);
    expect(existsSync(out)).toBe(false);
    expect(calls).toBe(2); // stopped at the failure, did not fetch segment 2
  });

  test("an over-cap segment is refused by the per-segment cap", async () => {
    const m = fixture();
    const rep = m.video[1]!;
    const { impl } = bytesFetch(() => new Uint8Array(new ArrayBuffer(2_000)));
    const out = join(dir(), "fat.mp4");
    const outcome = await downloadRendition(MANIFEST_URL, m, rep, [0], out, {
      fetchImpl: impl,
      maxSegmentBytes: 1_000,
    }).catch((e) => e);
    expect(outcome).toBeInstanceOf(VimeoMediaDownloadError);
    expect((outcome as Error).message).toMatch(/Segment body exceeds 1000 bytes/);
    expect(existsSync(out)).toBe(false);
  });

  test("the whole-operation budget binds across segments, not only inside one", async () => {
    const m = fixture();
    const rep = m.video[1]!;
    // Each fetch is fast; the budget is spent between them.
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      await new Promise((r) => setTimeout(r, 15));
      return new Response(segmentBody(url), { status: 200 });
    }) as unknown as typeof fetch;
    const out = join(dir(), "slow.mp4");
    const outcome = await downloadRendition(MANIFEST_URL, m, rep, [0, 1, 2, 3, 4, 5], out, {
      fetchImpl: impl,
      timeoutMs: 20,
    }).catch((e) => e);
    expect(outcome).toBeInstanceOf(VimeoMediaDownloadError);
    // The WHOLE operation's budget is named, not the sliver the last segment
    // was handed — "Segment download timed out after 2ms" is true and useless.
    expect((outcome as Error).message).toMatch(/Rendition download timed out after 20ms \(\d\/6 segments\)/);
    expect(existsSync(out)).toBe(false);
  });
});
