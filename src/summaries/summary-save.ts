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
 *   token with a budget timer. The caller claims around its own read → model →
 *   write; anyone else is `409 in_flight`.
 * - {@link saveSummaryBody}: builds the ingest body (every stored frontmatter
 *   field the vertical's ingest model accepts, re-sent), posts it BLOCKING, and
 *   reports what huginn wrote — `write_failed` on a failed POST, `forked` when
 *   the path it wrote is not the document's.
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
   * The whitespace {@link body} lost at its end. A transcript-less save puts it
   * back, so an unchanged save is byte-identical on disk; with a transcript the
   * appendix owns the separator and this is unused.
   */
  readonly bodyTrailingWhitespace: string;
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
    bodyTrailingWhitespace: split.body.slice(body.length),
    transcript: transcript === "" ? null : transcript,
    windowed: transcript !== null && transcriptIsWindowed(transcript),
    truncated: transcript !== null && transcript.includes(TRANSCRIPT_TRUNCATION_NOTE),
  };
}

/**
 * The document's display title, from the FILE NAME: no capture vertical writes
 * a `title:` key, and a title read back out of the path posts back to the same
 * path when it passes {@link titleRoundTripRefusal}.
 */
export function titleFromDocId(docId: string): string {
  const base = docId.split("/").pop() ?? docId;
  return base.replace(/\.md$/i, "") || docId;
}

/** The category the document is filed under — its own directory. `null` for an
 *  id with no directory part. */
export function categoryFromDocId(docId: string): string | null {
  const at = docId.lastIndexOf("/");
  return at <= 0 ? null : docId.slice(0, at);
}

/**
 * Why a title read out of a doc id does NOT always post back to the same path:
 * the exact fixed-point test over huginn's own file-name rule (ported, with a
 * cross-language fixture test in `huginn-filename.test.ts`). A different name
 * is a SECOND DOCUMENT. Returns the reason, or `null` when the title
 * round-trips.
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
 * `build_summary_tags` dedupes.
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
 * Each claim carries a budget timer, because "the writer settles" is a
 * connector's promise and not this module's: a model call that never settles
 * would pin the document for the life of the process. The expiry warns and
 * frees the key for OTHER writers; it does not cancel the claim. A claim that
 * lapsed may still write ({@link pinForWrite}) as long as nobody else took the
 * key in the meantime — a run that outlived the budget inside its own timeouts
 * keeps its summary. The claim is a TOKEN, so a stalled writer that settles
 * after someone else claimed releases nothing and writes nothing.
 *
 * Module-level ({@link summarySaveClaims}) so every write route shares one; a
 * class so a test can hold its own.
 */
export class SummarySaveClaims {
  private readonly held = new Map<
    string,
    { token: symbol; budgetMs: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  /** Claims whose timer fired before anyone released them, with their budget:
   *  still the caller's to write with, if the key is free. */
  private readonly lapsed = new WeakMap<SummarySaveClaim, number>();

  /** `JSON.stringify` over the pair: injective with no separator guess. */
  private key(sourceId: string, docId: string): string {
    return JSON.stringify([sourceId, docId]);
  }

  private arm(key: string, claim: SummarySaveClaim, budgetMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      if (this.held.get(key)?.token !== claim.token) return;
      this.held.delete(key);
      this.lapsed.set(claim, budgetMs);
      log.warn("The save claim on {docId} ({sourceId}) was not released within {budgetMs} ms — releasing it", {
        docId: claim.docId,
        sourceId: claim.sourceId,
        budgetMs,
      });
    }, budgetMs);
    // A background bookkeeping timer must not hold the process open.
    timer.unref?.();
    return timer;
  }

  isHeld(sourceId: string, docId: string): boolean {
    return this.held.has(this.key(sourceId, docId));
  }

  /** Claim the document for `budgetMs`, or `null` when someone holds it. */
  claim(sourceId: string, docId: string, budgetMs: number): SummarySaveClaim | null {
    const key = this.key(sourceId, docId);
    if (this.held.has(key)) return null;
    const claim: SummarySaveClaim = { sourceId, docId, token: Symbol(key), registry: this };
    this.held.set(key, { token: claim.token, budgetMs, timer: this.arm(key, claim, budgetMs) });
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
   * `true` when this claim holds the key now — still its own, or RE-TAKEN after
   * it lapsed with nobody else on it. `false` when another writer holds the key,
   * or the caller already released this claim. Pair with {@link unpinAfterWrite}.
   */
  pinForWrite(claim: SummarySaveClaim): boolean {
    const key = this.key(claim.sourceId, claim.docId);
    const held = this.held.get(key);
    if (held) {
      if (held.token !== claim.token) return false;
      if (held.timer) clearTimeout(held.timer);
      held.timer = null;
      return true;
    }
    const budgetMs = this.lapsed.get(claim);
    if (budgetMs === undefined) return false;
    this.lapsed.delete(claim);
    this.held.set(key, { token: claim.token, budgetMs, timer: null });
    log.info("The save claim on {docId} ({sourceId}) had lapsed with no other writer — re-taken for the write", {
      docId: claim.docId,
      sourceId: claim.sourceId,
    });
    return true;
  }

  /** End a {@link pinForWrite}: re-arm the budget timer, so a caller that never
   *  releases still frees the key. A no-op when the claim no longer holds it. */
  unpinAfterWrite(claim: SummarySaveClaim): void {
    const key = this.key(claim.sourceId, claim.docId);
    const held = this.held.get(key);
    if (!held || held.token !== claim.token || held.timer) return;
    held.timer = this.arm(key, claim, held.budgetMs);
  }

  /** Release a claim; a no-op when it expired and someone else holds the key. */
  release(claim: SummarySaveClaim): void {
    this.lapsed.delete(claim);
    const key = this.key(claim.sourceId, claim.docId);
    const held = this.held.get(key);
    if (!held || held.token !== claim.token) return;
    if (held.timer) clearTimeout(held.timer);
    this.held.delete(key);
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
      code: SummarySaveRefusalCode | "empty_summary" | "in_flight" | "write_failed" | "forked";
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
}

/**
 * The ingest body: every frontmatter field the source accepts, re-sent from its
 * RAW on-disk text, `title`/`category` pinned to the stored path, the stored
 * tags (minus the category parts) where the model takes them, and the
 * transcript appended only when the document has one.
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
    // No appendix to own the file's end, so the stored trailing whitespace goes
    // back — an unchanged save stays byte-identical.
    body.summary = input.summary.trimEnd() + stored.bodyTrailingWhitespace;
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
 * Write a summary body back over its stored document.
 *
 * Requires a HELD claim (it never claims a second time); runs the preflight
 * again, so a caller that skipped it cannot fork; posts blocking; and treats
 * any path other than `docId` as `forked` — huginn wrote a sibling and the
 * stored document is unchanged.
 */
export async function saveSummaryBody(input: SaveSummaryBodyInput): Promise<SummarySaveResult> {
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
        docId: input.docId,
        maxBytes: TRANSCRIPT_MAX_BYTES,
        transcriptBytes: appended.inputBytes,
        keptBytes: appended.keptBytes,
      },
    );
  }

  // Pinned for the POST: the claim can neither lapse mid-ingest nor be lost to
  // a second writer that would then be overwritten by this one.
  if (!claim.registry.pinForWrite(claim)) {
    return {
      ok: false,
      status: 409,
      code: "in_flight",
      error: claim.registry.isHeld(claim.sourceId, claim.docId)
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
  if (!res.ok) {
    log.warn("Saving {docId} failed: {error}", { docId: input.docId, error: res.error });
    return { ok: false, status: 502, code: "write_failed", error: res.error };
  }
  const filePath = typeof res.data.file_path === "string" ? res.data.file_path : "";
  if (!filePath) {
    return {
      ok: false,
      status: 502,
      code: "write_failed",
      error: "huginn answered the ingest without a file_path, so whether the document was written is unknown.",
    };
  }
  if (filePath !== input.docId) {
    log.warn("Saving {docId} wrote {written} instead — the stored document was not overwritten", {
      docId: input.docId,
      written: filePath,
    });
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
  const similar = Array.isArray(res.data.similar) ? (res.data.similar as SimilarArticle[]) : [];
  return { ok: true, filePath, similar, appended };
}
