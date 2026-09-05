/**
 * The media seam (v2 PR 3): from the signed JSON manifest the harvest already
 * records (`VimeoCaptions.manifestUrl`) to a file ffmpeg reads.
 *
 * Vimeo's player fetches `…/v2/playlist/av/primary/prot/…/playlist.json` off
 * `vod-adaptive-ak.vimeocdn.com` — measured 2026-09-05 on a public JavaZone
 * talk: 200 with a bare cookie-less `curl`, 928 KB for 53 minutes, five H.264
 * video representations (240p → 1080p) and two audio (AAC, Opus), each a list of
 * ~6 s segments with `start`/`end`/`size`/`url` and a base64 `init_segment`. A
 * segment's URL is relative to the representation's `base_url`, which is
 * relative to the manifest's `base_url`, which is relative to the manifest's
 * own URL (`../../../../../range/prot/`). Init segment + any run of segments,
 * concatenated in order, is a fragmented MP4 whose timestamps are ABSOLUTE
 * (`ffprobe` reports `start_time=1386.08` on the segment covering 23:06), so a
 * frame extracted from it is stamped with its position in the talk with no
 * arithmetic on our side.
 *
 * Every fetch here goes through `downloadPinned` (`download.ts`) with the
 * `downloadVtt` rules — https, host pinned to {@link VIMEO_MEDIA_HOST},
 * `redirect: "error"`, a byte cap that REFUSES, one budget raced at every read
 * — because these URLs come out of a page a third party controls. What differs
 * from the caption download is only the host, the caps and the noun in the
 * error messages.
 *
 * The signed manifest expires like the VTT (~3.5 h): fetch it in the same job
 * as the harvest and never persist it.
 *
 * The pure half — `parseVimeoManifest`, `chooseRepresentation`,
 * `segmentIndexAt`, `resolveSegmentUrl`, `initSegmentBytes`,
 * `renditionTimeoutFor` — is exercised against the committed fixture
 * `fixtures/manifest-placeholder.json` (a real manifest's SHAPE with every
 * signed path, id and URL replaced by a placeholder and 12 segments per
 * representation kept). The download half is driven through `fetchImpl`.
 */

import { unlink } from "node:fs/promises";
import { getLog } from "../logging.ts";
import { downloadPinned, VimeoDownloadError, VIMEO_MEDIA_HOST } from "./download.ts";

const log = getLog("vimeo", "media");

/** The one host a manifest URL and every segment URL may name (owned by `download.ts`). */
export { VIMEO_MEDIA_HOST };

/**
 * Manifest cap: measured 928 KB for a 53-minute talk (537 segments × 7
 * representations), so the 3 h cap this vertical enforces is ~3.2 MB. 8 MB is
 * headroom over that, not a fitted number.
 */
export const VIMEO_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
export const VIMEO_MANIFEST_TIMEOUT_MS = 20_000;

/**
 * Per-segment cap: the largest segment measured was 1.2 MB (1080p, 6 s, a
 * high-motion opening); a 6 s segment past 16 MB is not a Vimeo rendition.
 */
export const VIMEO_SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
/** Per-segment budget, further bounded by what is left of the whole operation. */
export const VIMEO_SEGMENT_TIMEOUT_MS = 30_000;

/**
 * The most a single `downloadRendition` may write — checked TWICE: on the
 * manifest's DECLARED sizes before the first fetch (so an oversized request is
 * refused at zero cost) and on the bytes actually WRITTEN as they arrive (so a
 * manifest that under-declares cannot walk past it — the declared sizes come
 * from the same third-party page as the URLs). Sized against the
 * whole-rendition callers: the entire 240p video of a 3 h talk is ~176 MB
 * (52 MB measured per 53 min), the entire Opus audio ~137 MB, and 60 sparse
 * 1080p segments ~72 MB.
 */
export const VIMEO_RENDITION_MAX_BYTES = 256 * 1024 * 1024;

/** A refusal about the manifest's SHAPE or a choice it cannot satisfy. */
export class VimeoMediaError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VimeoMediaError";
  }
}

/** A refusal from the download engine, on the media host. */
export class VimeoMediaDownloadError extends VimeoDownloadError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VimeoMediaDownloadError";
  }
}

export interface VimeoSegment {
  /** Absolute position in the talk, seconds. */
  readonly start: number;
  readonly end: number;
  /** Declared byte size, from the manifest. */
  readonly size: number;
  /** Relative to the representation's `baseUrl`. */
  readonly url: string;
}

export interface VimeoRepresentation {
  readonly id: string;
  readonly kind: "video" | "audio";
  readonly mimeType: string;
  /** `avc1.64001F`, `mp4a.40.2`, `opus`, … */
  readonly codecs: string;
  readonly bitrate: number;
  readonly avgBitrate: number;
  readonly durationSec: number;
  /** Video only. */
  readonly width?: number;
  readonly height?: number;
  /** Relative to the manifest's `baseUrl`; usually `""`. */
  readonly baseUrl: string;
  /** Base64 — the codec configuration every fMP4 written from this rep opens with. */
  readonly initSegment: string;
  /** In manifest order, which is start order. */
  readonly segments: readonly VimeoSegment[];
}

export interface VimeoManifest {
  readonly clipId: string;
  /** Relative to the manifest's own URL. */
  readonly baseUrl: string;
  readonly video: readonly VimeoRepresentation[];
  readonly audio: readonly VimeoRepresentation[];
}

// ── Parse ────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(rec: Record<string, unknown>, key: string, where: string): number {
  const v = rec[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new VimeoMediaError(`Manifest ${where}: "${key}" is not a finite number`);
  }
  return v;
}

/**
 * A size or a position: finite AND non-negative. A negative declared `size`
 * would let one segment cancel another in the declared-total cap (300 MB and
 * −300 MB sum to 0), and a negative `start` has no meaning in a talk.
 */
function nonneg(rec: Record<string, unknown>, key: string, where: string): number {
  const v = num(rec, key, where);
  if (v < 0) throw new VimeoMediaError(`Manifest ${where}: "${key}" is not a non-negative number`);
  return v;
}

function str(rec: Record<string, unknown>, key: string, where: string, allowEmpty = false): string {
  const v = rec[key];
  if (typeof v !== "string" || (!allowEmpty && v.length === 0)) {
    throw new VimeoMediaError(`Manifest ${where}: "${key}" is not a${allowEmpty ? "" : " non-empty"} string`);
  }
  return v;
}

function parseRepresentation(raw: unknown, kind: "video" | "audio", i: number): VimeoRepresentation {
  const where = `${kind}[${i}]`;
  if (!isRecord(raw)) throw new VimeoMediaError(`Manifest ${where}: not an object`);
  const rawSegments = raw.segments;
  if (!Array.isArray(rawSegments)) throw new VimeoMediaError(`Manifest ${where}: "segments" is not an array`);
  const segments: VimeoSegment[] = rawSegments.map((s, j) => {
    const sw = `${where}.segments[${j}]`;
    if (!isRecord(s)) throw new VimeoMediaError(`Manifest ${sw}: not an object`);
    const start = nonneg(s, "start", sw);
    const end = nonneg(s, "end", sw);
    if (end < start) throw new VimeoMediaError(`Manifest ${sw}: end ${end} before start ${start}`);
    return { start, end, size: nonneg(s, "size", sw), url: str(s, "url", sw) };
  });
  for (let j = 1; j < segments.length; j++) {
    if (segments[j]!.start < segments[j - 1]!.start) {
      throw new VimeoMediaError(`Manifest ${where}: segments are not in start order at [${j}]`);
    }
  }
  return {
    id: str(raw, "id", where),
    kind,
    mimeType: str(raw, "mime_type", where),
    codecs: str(raw, "codecs", where),
    bitrate: num(raw, "bitrate", where),
    avgBitrate: num(raw, "avg_bitrate", where),
    durationSec: num(raw, "duration", where),
    ...(kind === "video" ? { width: num(raw, "width", where), height: num(raw, "height", where) } : {}),
    baseUrl: str(raw, "base_url", where, true),
    initSegment: str(raw, "init_segment", where),
    segments,
  };
}

/**
 * Validate the manifest's shape. Strict on what this module READS, indifferent
 * to everything else (`index_segment`, `avg_id`, `framerate`, …): a manifest
 * that grows a key keeps parsing, one that drops a load-bearing key fails HERE
 * with the path named, not inside a URL resolution three calls later.
 */
export function parseVimeoManifest(raw: unknown): VimeoManifest {
  if (!isRecord(raw)) throw new VimeoMediaError("Manifest: not a JSON object");
  const video = raw.video;
  const audio = raw.audio;
  if (!Array.isArray(video)) throw new VimeoMediaError('Manifest: "video" is not an array');
  if (!Array.isArray(audio)) throw new VimeoMediaError('Manifest: "audio" is not an array');
  return {
    clipId: str(raw, "clip_id", "root"),
    baseUrl: str(raw, "base_url", "root", true),
    video: video.map((r, i) => parseRepresentation(r, "video", i)),
    audio: audio.map((r, i) => parseRepresentation(r, "audio", i)),
  };
}

// ── Choose ───────────────────────────────────────────────────────────────────

export type RepresentationNeed =
  | {
      kind: "video";
      /** The smallest rendition at least this tall; the tallest one when none is. */
      height: number;
    }
  | {
      kind: "audio";
      /** Preferred codec family; falls back to the cheapest rendition when absent. */
      codec?: "opus" | "aac";
    };

function matchesCodec(rep: VimeoRepresentation, codec: "opus" | "aac"): boolean {
  return codec === "opus" ? rep.codecs === "opus" : rep.codecs.startsWith("mp4a");
}

/**
 * Pick the representation for a need. Pure.
 *
 * Video: the SMALLEST rendition at least `height` tall — a frame the model reads
 * gains nothing from pixels above what it is scaled to, and every 6 s segment
 * at 1080p is ~1.6× the bytes of 720p (measured 592 KB vs 371 KB) — falling
 * back to the tallest available when none reaches the target. Audio: the
 * requested codec family when present (the Whisper path wants Opus: 101 kbps
 * against AAC's 194, same speech), otherwise the lowest average bitrate.
 * Representations with no segments are never chosen. `null` when the manifest
 * has nothing of that kind.
 */
export function chooseRepresentation(
  manifest: VimeoManifest,
  need: RepresentationNeed,
): VimeoRepresentation | null {
  const pool = (need.kind === "video" ? manifest.video : manifest.audio).filter((r) => r.segments.length > 0);
  if (pool.length === 0) return null;
  if (need.kind === "video") {
    const tallEnough = pool.filter((r) => (r.height ?? 0) >= need.height);
    const byHeight = (a: VimeoRepresentation, b: VimeoRepresentation) => (a.height ?? 0) - (b.height ?? 0);
    if (tallEnough.length > 0) return tallEnough.sort(byHeight)[0]!;
    return pool.sort(byHeight)[pool.length - 1]!;
  }
  const byBitrate = (a: VimeoRepresentation, b: VimeoRepresentation) => a.avgBitrate - b.avgBitrate;
  if (need.codec) {
    const matching = pool.filter((r) => matchesCodec(r, need.codec!));
    if (matching.length > 0) return matching.sort(byBitrate)[0]!;
  }
  return pool.sort(byBitrate)[0]!;
}

/**
 * The index of the segment covering `tSec` (start ≤ t < end). Before the
 * first segment ⇒ 0; at or past the last one's end ⇒ the last index — a
 * timestamp the cadence rounds to the talk's very end still names a segment.
 * Throws on a representation with no segments.
 */
export function segmentIndexAt(rep: VimeoRepresentation, tSec: number): number {
  const n = rep.segments.length;
  if (n === 0) throw new VimeoMediaError(`Representation ${rep.id} has no segments`);
  if (!Number.isFinite(tSec) || tSec <= 0) return 0;
  // Segments are in start order (the parser checks), so the first one whose
  // end is past t is the one covering it.
  for (let i = 0; i < n; i++) {
    if (tSec < rep.segments[i]!.end) return i;
  }
  return n - 1;
}

/** Sorted, de-duplicated segment indices covering every time in `timesSec`. */
export function segmentIndicesFor(rep: VimeoRepresentation, timesSec: readonly number[]): number[] {
  const set = new Set<number>();
  for (const t of timesSec) set.add(segmentIndexAt(rep, t));
  return [...set].sort((a, b) => a - b);
}

/**
 * The absolute URL of one segment, RESOLVED in three steps like a DASH client:
 * the manifest's `baseUrl` against the manifest URL, the representation's
 * `baseUrl` against that, the segment's `url` against that. Each step is a
 * URL resolution, never a string concatenation — `"abc" + "def.mp4"` is not
 * `abc/def.mp4`, and a base with no trailing slash is a file reference the
 * next step replaces. Every live representation carries `base_url: ""`
 * (measured 2026-09-05), which resolves to its parent unchanged, so the day
 * Vimeo populates the field is the day this rule matters. Returned as a
 * string so `downloadPinned` re-parses and re-judges it; nothing here decides
 * whether the host is allowed.
 */
export function resolveSegmentUrl(
  manifestUrl: string,
  manifest: VimeoManifest,
  rep: VimeoRepresentation,
  segment: VimeoSegment,
): string {
  const manifestBase = new URL(manifest.baseUrl, manifestUrl);
  const repBase = new URL(rep.baseUrl, manifestBase);
  return new URL(segment.url, repBase).toString();
}

/** The representation's init segment, decoded — the bytes every written file opens with. */
export function initSegmentBytes(rep: VimeoRepresentation): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(rep.initSegment, "base64"));
  } catch (err) {
    throw new VimeoMediaError(`Representation ${rep.id}: init_segment is not base64`, { cause: err });
  }
  // A real init segment opens with an `ftyp` box; 8 bytes is the box header
  // alone. Anything shorter is not one, whatever base64 it decoded from.
  if (bytes.byteLength < 8) {
    throw new VimeoMediaError(`Representation ${rep.id}: init_segment decodes to ${bytes.byteLength} bytes`);
  }
  return bytes;
}

/**
 * Whole-operation budget for a rendition download of `segmentCount` segments:
 * 30 s of fixed slack plus 1.5 s per segment. A 6 s 1080p segment (≤1.2 MB)
 * takes well under a second on an ordinary connection; the per-segment term is
 * for the many-small-fetches shape (537 Opus segments for a 53 min talk), where
 * round trips, not bytes, are the clock.
 */
export function renditionTimeoutFor(segmentCount: number): number {
  return 30_000 + 1_500 * Math.max(0, segmentCount);
}

// ── Fetch ────────────────────────────────────────────────────────────────────

export interface FetchManifestOptions {
  /** Test seam — production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Download the signed manifest (host-pinned, capped) and parse it. */
export async function fetchVimeoManifest(
  manifestUrl: string,
  opts: FetchManifestOptions = {},
): Promise<VimeoManifest> {
  const bytes = await downloadPinned(manifestUrl, {
    host: VIMEO_MEDIA_HOST,
    maxBytes: opts.maxBytes ?? VIMEO_MANIFEST_MAX_BYTES,
    timeoutMs: opts.timeoutMs ?? VIMEO_MANIFEST_TIMEOUT_MS,
    what: "Manifest",
    error: VimeoMediaDownloadError,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new VimeoMediaError("Manifest is not JSON", { cause: err });
  }
  return parseVimeoManifest(json);
}

export interface DownloadRenditionOptions {
  /** Test seam — production uses the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Whole-operation budget; default {@link renditionTimeoutFor} of the count. */
  timeoutMs?: number;
  /** Per-segment cap; default {@link VIMEO_SEGMENT_MAX_BYTES}. */
  maxSegmentBytes?: number;
  /** Cap on the DECLARED total; default {@link VIMEO_RENDITION_MAX_BYTES}. */
  maxTotalBytes?: number;
}

export interface RenditionFile {
  readonly path: string;
  /** Bytes written, init segment included. */
  readonly bytes: number;
  /** The segments written, in file order. */
  readonly segments: readonly { index: number; start: number; end: number }[];
}

/**
 * Write init segment + the named segments (in index order) to `outPath` as ONE
 * fragmented MP4 that ffmpeg reads directly.
 *
 * Indices need not be contiguous: a sparse set (one segment per cadence tick)
 * is a valid fMP4 with gaps, whose frames still carry absolute timestamps; a
 * contiguous run is a playable rendition. Every segment is fetched under the
 * pinned-host rules with `min(VIMEO_SEGMENT_TIMEOUT_MS, what is left of the
 * budget)`; `maxTotalBytes` is checked on the DECLARED total before the first
 * fetch (an oversized request is refused at zero cost) AND on the bytes
 * written as they arrive (a manifest that under-declares cannot walk past
 * it); a segment shorter than it declared is refused. Fetches are sequential
 * — one socket to the CDN, bytes appended in order, no reassembly. On any
 * failure the partial file is removed and the error rethrown: a truncated
 * fMP4 is a file ffmpeg reads to the cut and reports success on.
 */
export async function downloadRendition(
  manifestUrl: string,
  manifest: VimeoManifest,
  rep: VimeoRepresentation,
  indices: readonly number[],
  outPath: string,
  opts: DownloadRenditionOptions = {},
): Promise<RenditionFile> {
  const ordered = [...new Set(indices)].sort((a, b) => a - b);
  if (ordered.length === 0) throw new VimeoMediaError("No segments requested");
  for (const i of ordered) {
    if (!Number.isInteger(i) || i < 0 || i >= rep.segments.length) {
      throw new VimeoMediaError(`Segment index ${i} is outside 0..${rep.segments.length - 1} of ${rep.id}`);
    }
  }
  const maxTotal = opts.maxTotalBytes ?? VIMEO_RENDITION_MAX_BYTES;
  const declared = ordered.reduce((sum, i) => sum + rep.segments[i]!.size, 0);
  if (declared > maxTotal) {
    throw new VimeoMediaError(
      `Refusing to download ${declared} declared bytes of ${rep.id} (cap ${maxTotal})`,
    );
  }

  const init = initSegmentBytes(rep);
  const timeoutMs = opts.timeoutMs ?? renditionTimeoutFor(ordered.length);
  const deadline = Date.now() + timeoutMs;
  const maxSegmentBytes = opts.maxSegmentBytes ?? VIMEO_SEGMENT_MAX_BYTES;

  const sink = Bun.file(outPath).writer();
  let written = 0;
  const segmentsWritten: { index: number; start: number; end: number }[] = [];
  try {
    sink.write(init);
    written += init.byteLength;
    for (const i of ordered) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new VimeoMediaDownloadError(
          `Rendition download timed out after ${timeoutMs}ms (${segmentsWritten.length}/${ordered.length} segments)`,
        );
      }
      const seg = rep.segments[i]!;
      let bytes: Uint8Array;
      try {
        bytes = await downloadPinned(resolveSegmentUrl(manifestUrl, manifest, rep, seg), {
          host: VIMEO_MEDIA_HOST,
          maxBytes: maxSegmentBytes,
          timeoutMs: Math.min(VIMEO_SEGMENT_TIMEOUT_MS, remaining),
          what: "Segment",
          error: VimeoMediaDownloadError,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        });
      } catch (err) {
        // A segment handed the LAST sliver of the budget fails with "Segment
        // download timed out after 2ms" — true, and the wrong clock. When the
        // whole operation's deadline has passed, that is what is reported.
        if (err instanceof VimeoDownloadError && Date.now() >= deadline) {
          throw new VimeoMediaDownloadError(
            `Rendition download timed out after ${timeoutMs}ms (${segmentsWritten.length}/${ordered.length} segments)`,
            { cause: err },
          );
        }
        throw err;
      }
      // The manifest's declared size is exact (measured to the byte on the
      // live talk), so a SHORTER body is a truncated segment — the one thing
      // the engine's cap cannot see, since the cap bounds "too much", not "too
      // little" — and a truncated fMP4 is a file ffmpeg reads to the cut and
      // reports success on. A LONGER body is bounded by the per-segment cap
      // and by the written total below.
      if (bytes.byteLength < seg.size) {
        throw new VimeoMediaError(
          `Refusing ${rep.id} segment ${i}: arrived with ${bytes.byteLength} bytes, declared ${seg.size}`,
        );
      }
      if (written + bytes.byteLength > maxTotal) {
        throw new VimeoMediaError(
          `Refusing ${rep.id}: wrote ${written + bytes.byteLength} bytes, over the ${maxTotal}-byte cap (declared ${declared})`,
        );
      }
      sink.write(bytes);
      written += bytes.byteLength;
      segmentsWritten.push({ index: i, start: seg.start, end: seg.end });
    }
    await sink.end();
  } catch (err) {
    try {
      await sink.end();
    } catch {
      // the write side is already failing; the unlink below is what matters
    }
    await unlink(outPath).catch(() => {});
    throw err;
  }
  log.info("Wrote {segments} segment(s) of {rep} ({bytes} bytes) to {path}", {
    segments: segmentsWritten.length,
    rep: rep.id,
    bytes: written,
    path: outPath,
  });
  return { path: outPath, bytes: written, segments: segmentsWritten };
}
