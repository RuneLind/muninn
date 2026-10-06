/**
 * The one write path for a stored capture summary.
 *
 * huginn's ingest takes no document id: it rewrites the whole file from the
 * request body, keys the path on `<category>/<sanitized title>.md`, and forks a
 * `Title (2).md` sibling when the incoming `url` is empty or differs from the
 * stored one. So "save this body back over that document" is a small protocol,
 * and every route that writes a summary — re-run today, the fact-check append
 * and apply routes next — goes through the three pieces here:
 *
 * - {@link preflightSummarySave}: the fork refusals, run BEFORE any model spend
 *   (`no_url` and `no_category` 400, `title_not_round_trippable` 409).
 * - {@link SummarySaveClaims}: one writer per `(sourceId, docId)` at a time, a
 *   token with a budget fixed at claim time. The caller claims around its own
 *   read → model → write; anyone else is `409 in_flight`. A claim that lapsed
 *   still saves when no claim was taken on the key since it lapsed, and is
 *   pinned for the length of its POST.
 * - {@link saveSummaryBody}: builds the ingest body (every stored frontmatter
 *   field the vertical's ingest model accepts, re-sent), posts it BLOCKING, and
 *   reports what huginn wrote — `empty_summary` before any POST, `write_failed`
 *   when the request never reached huginn or it answered 4xx, `write_unknown`
 *   when it may have written (a 5xx, a timeout, a 2xx with no usable
 *   `file_path`), `forked` when the path it wrote is not the document's.
 */

import { getLog } from "../logging.ts";
import type { SimilarArticle } from "./job-store.ts";
import { postSummaryIngest, type SummaryIngest } from "./summarizer-shared.ts";
import { sanitizeFilenameLikeHuginn } from "./huginn-filename.ts";
import {
  decodeFrontmatterScalar,
  parseCaptureFrontmatter,
  splitTranscript,
  transcriptIsWindowed,
} from "./transcript-split.ts";
import {
  appendTranscriptSection,
  TRANSCRIPT_MAX_BYTES,
  TRANSCRIPT_TRUNCATION_NOTE,
  type CappedTranscript,
} from "./transcript-appendix.ts";

const log = getLog("summaries", "save");

// ---------------------------------------------------------------------------
// The save descriptor
// ---------------------------------------------------------------------------

/** What a write needs to know about one summary source's huginn ingest. */
export interface SummarySaveDescriptor {
  /** The `/summaries` source id. */
  readonly id: string;
  /** huginn's ingest path for this source. */
  readonly ingestPath: string;
  /** The frontmatter keys the source's ingest model accepts, `date`/`url`
   *  included — the RE-SEND list. A key left off is ERASED by a save. */
  readonly frontmatterFields: readonly string[];
  /**
   * Does the source's huginn ingest model carry a `tags` list?
   *
   * huginn REBUILDS the frontmatter `tags` line on every ingest as
   * `category.split("/") + req.tags`, deduped (`build_summary_tags`), so a tag
   * added by hand is erased by an ingest that does not re-send it. Where the
   * model accepts the field the save re-sends the stored list minus the
   * category parts ({@link extraTagsFromStored}).
   *
   * `false` for YouTube: `YouTubeIngestRequest` has no `tags` field, and
   * pydantic's `extra='ignore'` would drop the key silently. A hand-added tag on
   * a YouTube document is lost on every ingest; that is huginn's.
   */
  readonly acceptsTags: boolean;
  /** Where the transcript rides: appended to the summary string under
   *  `## Transcript`, or its own `transcript_markdown` field (Vimeo). */
  readonly transcriptCarrier: "summary" | "field";
}

/**
 * One descriptor per summary source. The re-run table extends four of these;
 * `article` and `anthropic` have a descriptor without being re-runnable (they
 * store no transcript).
 *
 * `x-article` covers both shapes on that shelf: a pasted X post (no transcript)
 * and an X video capture (a flat transcript in the summary string) — one
 * collection, one ingest model.
 *
 * Exported for tests (the parity and ingest-path pins); callers use
 * {@link requireSaveDescriptor}.
 */
export const SUMMARY_SAVE_DESCRIPTORS: readonly SummarySaveDescriptor[] = [
  {
    id: "youtube",
    ingestPath: "/api/youtube/ingest",
    // `author`/`upload_date`/`duration_sec` since huginn #139.
    frontmatterFields: ["date", "url", "summary_kind", "author", "upload_date", "duration_sec"],
    acceptsTags: false,
    transcriptCarrier: "summary",
  },
  {
    id: "vimeo",
    ingestPath: "/api/vimeo/ingest",
    // `vimeo_video_id` is DERIVED by huginn from the url and is no request
    // field; pydantic would drop it silently, so it is not re-sent.
    frontmatterFields: [
      "date",
      "url",
      "caption_lang",
      "caption_kind",
      "summary_kind",
      "summary_lang",
      "author",
      "upload_date",
      "speaker",
      "thumbnail_url",
      "duration_sec",
    ],
    acceptsTags: true,
    transcriptCarrier: "field",
  },
  {
    id: "tiktok",
    ingestPath: "/api/tiktok/ingest",
    frontmatterFields: ["date", "url", "author"],
    acceptsTags: true,
    transcriptCarrier: "summary",
  },
  {
    id: "x-article",
    ingestPath: "/api/x-articles/ingest",
    frontmatterFields: ["date", "url", "author"],
    acceptsTags: true,
    transcriptCarrier: "summary",
  },
  {
    id: "anthropic",
    ingestPath: "/api/anthropic-summaries/ingest",
    // `AnthropicSummaryIngestRequest` has no `author`.
    frontmatterFields: ["date", "url"],
    acceptsTags: true,
    transcriptCarrier: "summary",
  },
  {
    id: "article",
    ingestPath: "/api/articles/ingest",
    frontmatterFields: ["date", "url", "author"],
    acceptsTags: true,
    transcriptCarrier: "summary",
  },
];

function saveDescriptorFor(sourceId: string): SummarySaveDescriptor | undefined {
  return SUMMARY_SAVE_DESCRIPTORS.find((d) => d.id === sourceId);
}

/** The descriptor for an id the caller knows exists — a typo is a load-time
 *  throw rather than a vertical with no save path. */
export function requireSaveDescriptor(sourceId: string): SummarySaveDescriptor {
  const d = saveDescriptorFor(sourceId);
  if (!d) throw new Error(`No summary save descriptor for source "${sourceId}"`);
  return d;
}

// ---------------------------------------------------------------------------
// Reading the stored document
// ---------------------------------------------------------------------------

/** What the raw file says, once split. */
export interface StoredCapture {
  /** The frontmatter DECODED — what a caller reads when it needs a value. */
  readonly frontmatter: Record<string, string>;
  /**
   * The same keys with their RAW on-disk text, which is what the ingest body is
   * built from. Decoding twice is a wrong answer: huginn writes a quoted
   * `caption_lang: "2026"` and a bare `duration_sec: 3180`, and re-decoding the
   * unquoted `2026` turns a string field into a number its model refuses.
   */
  readonly frontmatterRaw: Record<string, string>;
  /** The summary WITHOUT the transcript appendix, trailing whitespace trimmed. */
  readonly body: string;
  /**
   * Everything in the file after {@link body}, when {@link transcript} is null:
   * the trailing whitespace, plus an EMPTY `## Transcript` heading when the
   * document has one. A transcript-less save puts it back, so an unchanged save
   * is byte-identical on disk; with a transcript the appendix owns the file's
   * end and this is unused.
   */
  readonly bodyTail: string;
  /** The appendix's text, trimmed — `null` when the document has none. */
  readonly transcript: string | null;
  readonly windowed: boolean;
  /** The stored appendix ends on the shared truncation note. */
  readonly truncated: boolean;
}

/**
 * Split one raw capture file.
 *
 * The transcript is TRIMMED, because `appendTranscriptSection` (and huginn's
 * Vimeo `body_suffix`) add their own separator and trailing newline —
 * re-appending an untrimmed appendix grows the file by a blank line per pass.
 */
export function readStoredCapture(raw: string): StoredCapture {
  const fm = parseCaptureFrontmatter(raw);
  const frontmatter: Record<string, string> = {};
  for (const [key, value] of Object.entries(fm.byKey)) {
    frontmatter[key] = String(decodeFrontmatterScalar(value));
  }
  const split = splitTranscript(fm.body);
  const transcript = split.transcript === null ? null : split.transcript.trim();
  const body = split.body.trimEnd();
  return {
    frontmatter,
    frontmatterRaw: { ...fm.byKey },
    body,
    // `split.body` is a prefix of `fm.body`, so this is the raw text after the
    // trimmed body — an empty appendix's heading included.
    bodyTail: fm.body.slice(body.length),
    transcript: transcript === "" ? null : transcript,
    windowed: transcript !== null && transcriptIsWindowed(transcript),
    truncated: transcript !== null && transcript.includes(TRANSCRIPT_TRUNCATION_NOTE),
  };
}

/**
 * The document's display title, from the FILE NAME: no capture vertical writes
 * a `title:` key, and a title read back out of the path posts back to the same
 * path when it passes {@link titleRoundTripRefusal}. Exported for tests.
 */
export function titleFromDocId(docId: string): string {
  const base = docId.split("/").pop() ?? docId;
  return base.replace(/\.md$/i, "") || docId;
}

/** The category the document is filed under — its own directory. `null` for an
 *  id with no directory part. Exported for tests. */
export function categoryFromDocId(docId: string): string | null {
  const at = docId.lastIndexOf("/");
  return at <= 0 ? null : docId.slice(0, at);
}

/**
 * Why a title read out of a doc id does NOT always post back to the same path:
 * the exact fixed-point test over huginn's own file-name rule (ported, with a
 * cross-language fixture test in `huginn-filename.test.ts`). A different name
 * is a SECOND DOCUMENT. Returns the reason, or `null` when the title
 * round-trips. Exported for tests.
 */
export function titleRoundTripRefusal(title: string): string | null {
  const sanitized = sanitizeFilenameLikeHuginn(title);
  if (sanitized === title) return null;
  return (
    "This document's file name is not what huginn's own file-name rule would produce — a re-ingest " +
    `would file it as "${sanitized}", a second document instead of a replacement.`
  );
}

/**
 * The tags to RE-SEND: the stored `tags` line minus the parts huginn rebuilds
 * from the category. Preserves the tag SET, not the line's bytes: a hand-edited
 * line converges to huginn's category-first, deduped shape on the first save
 * and is a fixed point from then on. Subtracted by VALUE, since
 * `build_summary_tags` dedupes. Exported for tests.
 */
export function extraTagsFromStored(rawTags: string | undefined, category: string): string[] {
  if (rawTags === undefined) return [];
  const stored = String(decodeFrontmatterScalar(rawTags))
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  const fromCategory = new Set(category.split("/"));
  const out: string[] = [];
  for (const tag of stored) {
    if (fromCategory.has(tag) || out.includes(tag)) continue;
    out.push(tag);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type SummarySaveRefusalCode = "no_url" | "no_category" | "title_not_round_trippable";

export type SummarySavePreflight =
  | { ok: true; title: string; category: string; url: string }
  | { ok: false; status: 400 | 409; code: SummarySaveRefusalCode; error: string };

/** An absolute http(s) URL — the one shape huginn's overwrite check can match.
 *  Module-private: `src/gardener/draft.ts` and `wiki-gardener-sources.ts` each
 *  export an `isHttpUrl` with different input rules. */
function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The fork refusals, before any model spend. Each one is a document a save
 * would DUPLICATE rather than replace:
 *
 * - `no_url` (400): huginn forks a sibling whenever the incoming url is empty,
 *   and a value that is not an http(s) URL is refused too — one stored article
 *   sibling carries pasted article text in `url` (5,421 characters decoded,
 *   5,485 raw on disk), close to huginn's 6,144-character cap on the WHOLE
 *   frontmatter block.
 * - `no_category` (400): the id has no directory, so there is no category to
 *   re-file it under.
 * - `title_not_round_trippable` (409): see {@link titleRoundTripRefusal}.
 */
export function preflightSummarySave(stored: StoredCapture, docId: string): SummarySavePreflight {
  const url = stored.frontmatter.url ?? "";
  if (!url || !isAbsoluteHttpUrl(url)) {
    return {
      ok: false,
      status: 400,
      code: "no_url",
      error: url
        ? "The stored document's url is not an http(s) URL, so a re-ingest would fork a second file."
        : "The stored document carries no url, so a re-ingest would fork a second file.",
    };
  }
  const category = categoryFromDocId(docId);
  if (!category) {
    return { ok: false, status: 400, code: "no_category", error: "The stored document is not filed under a category." };
  }
  const title = titleFromDocId(docId);
  const titleRefusal = titleRoundTripRefusal(title);
  if (titleRefusal) {
    return { ok: false, status: 409, code: "title_not_round_trippable", error: titleRefusal };
  }
  return { ok: true, title, category, url };
}

// ---------------------------------------------------------------------------
// The per-document claim
// ---------------------------------------------------------------------------

/** A held claim on one document. It carries the registry that issued it, so a
 *  save checks the claim against THAT registry and never against a default. */
export interface SummarySaveClaim {
  readonly sourceId: string;
  readonly docId: string;
  readonly token: symbol;
  readonly registry: SummarySaveClaims;
}

/**
 * One writer per `(sourceId, docId)`.
 *
 * Two concurrent writers race one FILE: huginn rewrites the whole document
 * from the request body, so the loser's write is simply gone. A writer claims
 * around its own read → model → write; a second claimant gets `null`
 * (the route's `409 in_flight`).
 *
 * Each claim carries a budget, its deadline fixed when it is claimed, because
 * "the writer settles" is a connector's promise and not this module's: a model
 * call that never settles would pin the document for the life of the process.
 * The expiry warns and frees the key for OTHER writers; it does not cancel the
 * claim. A lapsed claim may still write ({@link pinForWrite}) only when no
 * other claim was taken on the key since it lapsed — a run that outlived the
 * budget inside its own timeouts keeps its summary, while a run whose read
 * predates someone else's whole claim → write → release is refused, since its
 * body would overwrite the newer write. The claim is a TOKEN, so a stalled
 * writer that settles after someone else claimed releases nothing and writes
 * nothing.
 *
 * Module-level ({@link summarySaveClaims}) so every write route shares one; a
 * class so a test can hold its own.
 */
export class SummarySaveClaims {
  private readonly held = new Map<
    string,
    {
      token: symbol;
      /** This claim's {@link claim} generation. */
      generation: number;
      budgetMs: number;
      /** `Date.now()` past which the claim lapses. Never moved by a write. */
      deadline: number;
      timer: ReturnType<typeof setTimeout> | null;
      /** A POST is in flight on this claim ({@link pinForWrite}). */
      writing: boolean;
    }
  >();
  /** Per key, the generation of the newest successful {@link claim}: one
   *  number per key at most, deleted when the holder releases. */
  private readonly latestGeneration = new Map<string, number>();
  private nextGeneration = 1;
  /** The claims that lapsed before anyone released them, with what a
   *  re-take needs. */
  private readonly lapsed = new WeakMap<SummarySaveClaim, { generation: number; budgetMs: number; deadline: number }>();

  /** `JSON.stringify` over the pair: injective with no separator guess. */
  private key(sourceId: string, docId: string): string {
    return JSON.stringify([sourceId, docId]);
  }

  /** Free the key for other writers; the claim may still re-take it. */
  private lapse(key: string, claim: SummarySaveClaim): void {
    const held = this.held.get(key);
    if (!held || held.token !== claim.token) return;
    const { generation, budgetMs, deadline } = held;
    this.held.delete(key);
    this.lapsed.set(claim, { generation, budgetMs, deadline });
    log.warn("The save claim on {docId} ({sourceId}) was not released within {budgetMs} ms — releasing it", {
      docId: claim.docId,
      sourceId: claim.sourceId,
      budgetMs,
    });
  }

  /** Arm the timer for what is LEFT of the budget; lapse now when none is. */
  private arm(key: string, claim: SummarySaveClaim): void {
    const held = this.held.get(key);
    if (!held || held.token !== claim.token) return;
    const remaining = held.deadline - Date.now();
    if (remaining <= 0) {
      this.lapse(key, claim);
      return;
    }
    // `lapse` checks the token; the timer is armed only from `claim` and from
    // the end of a pinned write, both with no timer running.
    const timer = setTimeout(() => this.lapse(key, claim), remaining);
    // A background bookkeeping timer must not hold the process open.
    timer.unref?.();
    held.timer = timer;
  }

  isHeld(sourceId: string, docId: string): boolean {
    return this.held.has(this.key(sourceId, docId));
  }

  /** Claim the document for `budgetMs`, or `null` when someone holds it. */
  claim(sourceId: string, docId: string, budgetMs: number): SummarySaveClaim | null {
    const key = this.key(sourceId, docId);
    if (this.held.has(key)) return null;
    const claim: SummarySaveClaim = { sourceId, docId, token: Symbol(key), registry: this };
    const generation = this.nextGeneration++;
    this.latestGeneration.set(key, generation);
    this.held.set(key, {
      token: claim.token,
      generation,
      budgetMs,
      deadline: Date.now() + budgetMs,
      timer: null,
      writing: false,
    });
    this.arm(key, claim);
    return claim;
  }

  /** Is this claim still the current holder? */
  holds(claim: SummarySaveClaim): boolean {
    return this.held.get(this.key(claim.sourceId, claim.docId))?.token === claim.token;
  }

  /**
   * Hold the key for the length of a write: the budget timer is suspended, so
   * the claim cannot lapse while the POST is in flight and a second writer
   * cannot claim and be overwritten by it.
   *
   * `"pinned"` when this claim holds the key now — still its own, or RE-TAKEN
   * after it lapsed with no claim taken on the key since. `"writing"` when this
   * claim already has a POST in flight (a second concurrent save on one claim
   * is refused, not queued). `"taken"` when another writer holds the key or
   * claimed it after this one lapsed, `"released"` when the caller already
   * released this claim. Pair a `"pinned"` with {@link unpinAfterWrite}.
   */
  pinForWrite(claim: SummarySaveClaim): "pinned" | "writing" | "taken" | "released" {
    const key = this.key(claim.sourceId, claim.docId);
    const held = this.held.get(key);
    if (held) {
      if (held.token !== claim.token) return "taken";
      if (held.writing) return "writing";
      if (held.timer) clearTimeout(held.timer);
      held.timer = null;
      held.writing = true;
      return "pinned";
    }
    const lapsed = this.lapsed.get(claim);
    if (lapsed === undefined) return "released";
    if (this.latestGeneration.get(key) !== lapsed.generation) {
      // Someone claimed the key after this one lapsed; whatever they wrote is
      // newer than the read this claim's body was built from.
      this.lapsed.delete(claim);
      return "taken";
    }
    this.lapsed.delete(claim);
    this.held.set(key, { token: claim.token, ...lapsed, timer: null, writing: true });
    log.info("The save claim on {docId} ({sourceId}) had lapsed with no other writer — re-taken for the write", {
      docId: claim.docId,
      sourceId: claim.sourceId,
    });
    return "pinned";
  }

  /** End a {@link pinForWrite}: re-arm the timer for what is left of the
   *  budget (a claim past its deadline lapses here), so a caller that never
   *  releases still frees the key. A no-op unless this claim is writing. */
  unpinAfterWrite(claim: SummarySaveClaim): void {
    const key = this.key(claim.sourceId, claim.docId);
    const held = this.held.get(key);
    if (!held || held.token !== claim.token || !held.writing) return;
    held.writing = false;
    this.arm(key, claim);
  }

  /** Release a claim; a no-op when it expired and someone else holds the key. */
  release(claim: SummarySaveClaim): void {
    this.lapsed.delete(claim);
    const key = this.key(claim.sourceId, claim.docId);
    const held = this.held.get(key);
    if (!held || held.token !== claim.token) return;
    if (held.timer) clearTimeout(held.timer);
    this.held.delete(key);
    this.latestGeneration.delete(key);
  }

  /** Drop every claim and its timer. Tests only. */
  clear(): void {
    for (const { timer } of this.held.values()) if (timer) clearTimeout(timer);
    this.held.clear();
  }
}

/** The process-wide registry every write route claims from. */
export const summarySaveClaims = new SummarySaveClaims();

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

export type SummarySaveResult =
  | { ok: true; filePath: string; similar: SimilarArticle[]; appended: CappedTranscript | null }
  | {
      ok: false;
      status: 400 | 409 | 502;
      code: SummarySaveRefusalCode | "empty_summary" | "in_flight" | "write_failed" | "write_unknown" | "forked";
      error: string;
      /** `forked` only: the sibling huginn wrote, for the delete action. */
      siblingDocId?: string;
    };

export interface SaveSummaryBodyInput {
  readonly descriptor: SummarySaveDescriptor;
  readonly stored: StoredCapture;
  readonly docId: string;
  /** The new summary, WITHOUT a transcript appendix. */
  readonly summary: string;
  /** Re-run's new kind. Absent ⇒ the stored `summary_kind` is re-sent as it
   *  is, or omitted when the document has none. */
  readonly summaryKind?: string;
  /** A claim the caller holds on `(descriptor.id, docId)`, checked against the
   *  registry that issued it. */
  readonly claim: SummarySaveClaim;
  readonly knowledgeApiUrl: string;
  readonly ingest?: SummaryIngest;
  /** Extra properties on the save's log lines, e.g. `{ jobId }`. */
  readonly logContext?: Readonly<Record<string, unknown>>;
}

/**
 * The ingest body: every frontmatter field the source accepts, re-sent from its
 * RAW on-disk text, `title`/`category` pinned to the stored path, the stored
 * tags (minus the category parts) where the model takes them, and the
 * transcript appended only when the document has one. Exported for tests;
 * callers save through {@link saveSummaryBody}.
 */
export function buildSummarySaveBody(input: {
  descriptor: SummarySaveDescriptor;
  stored: StoredCapture;
  title: string;
  category: string;
  summary: string;
  summaryKind?: string;
}): { body: Record<string, unknown>; appended: CappedTranscript | null } {
  const { descriptor, stored } = input;
  const body: Record<string, unknown> = { title: input.title, category: input.category };
  for (const key of descriptor.frontmatterFields) {
    const raw = stored.frontmatterRaw[key];
    if (raw === undefined) continue;
    // Decoded from the RAW text, so a bare `duration_sec: 3180` is a number
    // again rather than a string huginn would re-render as `"3180"`.
    body[key] = decodeFrontmatterScalar(raw);
  }
  if (input.summaryKind !== undefined) body.summary_kind = input.summaryKind;
  if (descriptor.acceptsTags) {
    const tags = extraTagsFromStored(stored.frontmatterRaw.tags, input.category);
    if (tags.length > 0) body.tags = tags;
  }
  let appended: CappedTranscript | null = null;
  if (stored.transcript === null) {
    // No appendix to own the file's end, so the stored tail goes back — an
    // unchanged save stays byte-identical.
    body.summary = input.summary.trimEnd() + stored.bodyTail;
  } else if (descriptor.transcriptCarrier === "summary") {
    // `windowed` picks the capper, and the wrong one is destructive: a flat
    // transcript has no `### [HH:MM:SS]` buckets to cut on. Derived from the
    // stored text itself (`transcriptIsWindowed`).
    appended = appendTranscriptSection(input.summary, stored.transcript, undefined, stored.windowed);
    body.summary = appended.text;
  } else {
    body.summary = input.summary;
    body.transcript_markdown = stored.transcript;
  }
  return { body, appended };
}

/**
 * Is the path huginn wrote the stored document? huginn always answers a
 * lower-case `.md`, so the suffix compares case-insensitively; the stem
 * compares exactly, since a case change there is a different title.
 */
function sameDocId(written: string, docId: string): boolean {
  const stem = (id: string): string | null => (/\.md$/i.test(id) ? id.slice(0, -3) : null);
  const a = stem(written);
  return a !== null && a === stem(docId);
}

/**
 * Write a summary body back over its stored document.
 *
 * Requires a claim the caller took (it never claims a second time); runs the
 * preflight again, so a caller that skipped it cannot fork; posts blocking; and
 * treats any path other than `docId` as `forked` — huginn wrote a sibling and
 * the stored document is unchanged. Every result that is not a write warns
 * exactly once, here, so a caller does not warn again.
 */
export async function saveSummaryBody(input: SaveSummaryBodyInput): Promise<SummarySaveResult> {
  const result = await saveOnce(input);
  if (!result.ok) {
    log.warn("Saving {docId} did not write ({code}): {error}", {
      ...input.logContext,
      docId: input.docId,
      code: result.code,
      error: result.error,
      ...(result.siblingDocId !== undefined ? { siblingDocId: result.siblingDocId } : {}),
    });
  }
  return result;
}

async function saveOnce(input: SaveSummaryBodyInput): Promise<SummarySaveResult> {
  const { claim } = input;
  if (claim.sourceId !== input.descriptor.id || claim.docId !== input.docId) {
    return {
      ok: false,
      status: 409,
      code: "in_flight",
      error: "This write's claim is on a different document. Nothing was saved.",
    };
  }
  const pre = preflightSummarySave(input.stored, input.docId);
  if (!pre.ok) return pre;
  // huginn's YouTube ingest reads an empty `summary` as "summarize it
  // yourself" — it fetches the transcript, runs its own model and overwrites
  // the document — so a blank body is never posted, on any source.
  if (input.summary.trim() === "") {
    return {
      ok: false,
      status: 400,
      code: "empty_summary",
      error: "The new summary is empty, so nothing was saved and the stored document is unchanged.",
    };
  }

  const { body, appended } = buildSummarySaveBody({
    descriptor: input.descriptor,
    stored: input.stored,
    title: pre.title,
    category: pre.category,
    summary: input.summary,
    ...(input.summaryKind !== undefined ? { summaryKind: input.summaryKind } : {}),
  });
  if (appended?.truncated) {
    // Past this bound the end of the talk never reaches the document, and
    // nothing outside the file says so.
    log.warn(
      "Saving {docId}: transcript truncated at the {maxBytes}-byte bound " +
        "({transcriptBytes} bytes in, {keptBytes} kept) — the document ends mid-talk",
      {
        ...input.logContext,
        docId: input.docId,
        maxBytes: TRANSCRIPT_MAX_BYTES,
        transcriptBytes: appended.inputBytes,
        keptBytes: appended.keptBytes,
      },
    );
  }

  // Pinned for the POST: the claim can neither lapse mid-ingest nor be lost to
  // a second writer that would then be overwritten by this one.
  const pin = claim.registry.pinForWrite(claim);
  if (pin !== "pinned") {
    return {
      ok: false,
      status: 409,
      code: "in_flight",
      error:
        pin === "writing"
          ? "A save on this claim is already in flight. Nothing was saved."
          : pin === "taken"
            ? "Another write took this document after this one's claim lapsed. Nothing was saved."
            : "This write's claim was already released. Nothing was saved.",
    };
  }
  let res: Awaited<ReturnType<SummaryIngest>>;
  try {
    res = await (input.ingest ?? postSummaryIngest)({
      knowledgeApiUrl: input.knowledgeApiUrl,
      ingestPath: input.descriptor.ingestPath,
      body,
    });
  } finally {
    claim.registry.unpinAfterWrite(claim);
  }
  const RELOAD = "The document may have been written anyway — Reload it before retrying.";
  if (!res.ok) {
    if (res.mayHaveWritten) {
      return { ok: false, status: 502, code: "write_unknown", error: `${res.error}. ${RELOAD}` };
    }
    return { ok: false, status: 502, code: "write_failed", error: res.error };
  }
  const data = (typeof res.data === "object" && res.data !== null ? res.data : {}) as {
    file_path?: unknown;
    similar?: unknown;
  };
  const filePath = typeof data.file_path === "string" ? data.file_path : "";
  if (!filePath) {
    // The request landed (a 2xx), so the write may well have too.
    return {
      ok: false,
      status: 502,
      code: "write_unknown",
      error: `huginn answered the ingest ${res.status} without a file_path. ${RELOAD}`,
    };
  }
  if (!sameDocId(filePath, input.docId)) {
    return {
      ok: false,
      status: 409,
      code: "forked",
      error:
        `huginn wrote a second document, "${filePath}", instead of replacing this one. ` +
        "Delete that copy from the summaries panel; this document is unchanged.",
      siblingDocId: filePath,
    };
  }
  const similar = Array.isArray(data.similar) ? (data.similar as SimilarArticle[]) : [];
  return { ok: true, filePath, similar, appended };
}
