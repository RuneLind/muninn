/**
 * The rules the YouTube Chrome extension's popup runs on, as one pure module.
 *
 * The extension has NO test harness — it is unpackaged JavaScript loaded into a
 * browser, and the only check it has is a human opening the popup. So the parts
 * that can be wrong without looking wrong live here, under `src/`, with a
 * co-located test, and are emitted into `extensions/youtube/capture-rules.js` by
 * `bun run build:extension` (`scripts/build-extension.ts`). The emitted copy is
 * checked in, and the test below re-runs the emitter and compares bytes, so a
 * stale copy fails CI rather than shipping a popup running last month's rules.
 *
 * Three things are genuinely easy to get wrong here, and each is a function:
 *
 *  - **the server payload is untrusted shape.** The popup asks a Muninn whose
 *    URL the reader typed, which may be an older instance with no options
 *    endpoint, a proxy answering HTML, or nothing at all. Every failure has to
 *    land in the SAME place: Standard only, and a sentence saying the options
 *    could not be read. A silent Standard-only picker is the failure this
 *    endpoint exists to remove, so "unreachable" must never be indistinguishable
 *    from "this instance offers one kind".
 *  - **a remembered choice outlives the server that offered it.** `deep` is
 *    remembered in `chrome.storage.sync` and syncs across profiles, so a browser
 *    can carry a kind this instance does not offer (the summarizer bot moved to
 *    a Copilot connector, a per-bot preset was renamed). Restoring it blind
 *    means a 400 on click; it is re-validated against the CURRENT options.
 *  - **the stored value predates the picker.** An install that only ever knew
 *    the Slides tick has `{frames: true|false}` and no `kind` at all. That is
 *    the default, not an error.
 *
 * The visual-detail axis added later runs the same three rules, plus one of its
 * own: a Muninn that does not offer the choice gets no such CONTROL and no such
 * field. Its route would ignore the key rather than refuse it, so a control
 * rendered there is a choice the reader makes and nothing acts on.
 *
 * Pure and import-free by construction: it is bundled for a browser, where
 * nothing from `node:` or from the rest of `src/` exists.
 */

/** One entry of the server's kind picker. */
export interface CaptureKindOption {
  readonly id: string;
  readonly label: string;
}

/** What `GET /api/youtube/options` tells the popup, once validated. */
export interface CaptureOptions {
  readonly kinds: CaptureKindOption[];
  readonly defaultKind: string;
  readonly framesSupported: boolean;
  /**
   * How much of the video a slides capture may SHOW, or null on an instance
   * that does not offer the choice at all (a Muninn from before it existed).
   * Null means the popup renders no such control and sends no such field —
   * which is exactly what that instance would ignore anyway.
   */
  readonly visualDetail: { options: CaptureKindOption[]; defaultDetail: string } | null;
  /**
   * Whether these options came from the server. `false` ⇒ the fallback below,
   * and the popup MUST say so — the reader is looking at one kind because
   * Muninn could not be reached, not because Muninn offers one kind.
   */
  readonly fromServer: boolean;
}

/** The id every instance offers, and the one a client sends for "no pick". */
export const FALLBACK_KIND_ID = "standard";

/** The visual-coverage policy a client sends for "no pick" — and the route's own default. */
export const FALLBACK_VISUAL_DETAIL_ID = "selected";

/**
 * The visual-coverage row the fallback offers: the one policy every instance
 * runs, and nothing else.
 *
 * The `kinds` rule, not the `framesSupported` one, and the difference is what
 * happens to a value the instance does not take. An over-offered Slides tick is
 * REFUSED — the POST pre-flights the connector and answers 503 with a sentence
 * the popup renders. `visual_detail` has no such refusal behind it: the instance
 * that offers no choice is one from BEFORE the field existed, and it ignores the
 * key, so a reader who picked Detailed against an unreachable options endpoint
 * would get a Selected capture with nothing said. Offering only what every
 * instance runs is the same shape as falling back to `standard` alone rather
 * than to a catalog of every shipped preset.
 */
export const FALLBACK_VISUAL_DETAIL_OPTIONS: CaptureKindOption[] = [
  { id: FALLBACK_VISUAL_DETAIL_ID, label: "Selected" },
];

/**
 * What the popup runs on when the options endpoint cannot be read: Standard
 * only, slides available (the POST still pre-flights the connector and answers
 * 503 `frames_unsupported` with a sentence, so hiding the tick here would
 * remove a working control on every instance that DOES support it).
 */
export const FALLBACK_CAPTURE_OPTIONS: CaptureOptions = {
  kinds: [{ id: FALLBACK_KIND_ID, label: "Standard" }],
  defaultKind: FALLBACK_KIND_ID,
  framesSupported: true,
  visualDetail: {
    options: FALLBACK_VISUAL_DETAIL_OPTIONS,
    defaultDetail: FALLBACK_VISUAL_DETAIL_ID,
  },
  fromServer: false,
};

/** The sentence the popup shows when the options could not be read. */
export const OPTIONS_UNREACHABLE_MESSAGE = "Could not reach Muninn options — Standard only.";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * `{id, label}` rows out of an untrusted list, or `[]`.
 *
 * Shared by the kind picker and the visual-detail picker, so a payload that is
 * junk in one place cannot be read leniently in the other. A label that is
 * missing or not a string falls back to the id, which is a usable picker row;
 * an entry with no id is not a row at all and is dropped.
 */
function parseOptionRows(raw: unknown): CaptureKindOption[] {
  if (!Array.isArray(raw)) return [];
  const rows: CaptureKindOption[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, label } = entry as { id?: unknown; label?: unknown };
    if (!isNonEmptyString(id)) continue;
    rows.push({ id, label: isNonEmptyString(label) ? label : id });
  }
  return rows;
}

/**
 * The visual-detail capability, or null.
 *
 * Null on every shape short of a usable one — the field absent (an older
 * Muninn), `supported` explicitly false, or an options list that parsed to
 * nothing — because the popup's answer to all three is the same: render no such
 * control and send no such field, which is what those instances expect.
 */
function parseVisualDetail(raw: unknown): CaptureOptions["visualDetail"] {
  if (typeof raw !== "object" || raw === null) return null;
  const { supported, options, default: fallback } = raw as {
    supported?: unknown;
    options?: unknown;
    default?: unknown;
  };
  if (supported === false) return null;
  const rows = parseOptionRows(options);
  if (rows.length === 0) return null;
  const offered = new Set(rows.map((r) => r.id));
  const defaultDetail =
    isNonEmptyString(fallback) && offered.has(fallback) ? fallback : rows[0]!.id;
  return { options: rows, defaultDetail };
}

/**
 * Validate `GET /api/youtube/options`, or return null.
 *
 * Null means "use {@link FALLBACK_CAPTURE_OPTIONS} and say so". Anything short
 * of a usable list is null: a non-object, a missing or empty `kinds`, or a
 * `kinds` whose entries are not `{id, label}` — a picker rendered from junk is
 * worse than a picker that admits it has nothing.
 *
 * `default_kind` and `frames.supported` are read leniently on purpose: they are
 * a hint and a capability flag, and an instance that omits either is still one
 * whose kind list is good. The default falls back to the first offered kind
 * (the server orders `standard` first) and slides fall back to available, which
 * the POST re-checks anyway.
 */
export function parseCaptureOptions(payload: unknown): CaptureOptions | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = payload as {
    kinds?: unknown;
    default_kind?: unknown;
    frames?: unknown;
    visual_detail?: unknown;
  };
  if (!Array.isArray(raw.kinds)) return null;

  const kinds = parseOptionRows(raw.kinds);
  if (kinds.length === 0) return null;

  const offered = new Set(kinds.map((k) => k.id));
  const defaultKind =
    isNonEmptyString(raw.default_kind) && offered.has(raw.default_kind)
      ? raw.default_kind
      : kinds[0]!.id;

  const frames = raw.frames as { supported?: unknown } | undefined;
  const framesSupported =
    typeof frames === "object" && frames !== null && typeof frames.supported === "boolean"
      ? frames.supported
      : true;

  return {
    kinds,
    defaultKind,
    framesSupported,
    visualDetail: parseVisualDetail(raw.visual_detail),
    fromServer: true,
  };
}

/**
 * The kind to SELECT, given what this browser remembered and what the server
 * offers now.
 *
 * A remembered id the server no longer offers — or one that was never a string,
 * which is what an install from before the picker has — falls back to the
 * server's default. It never throws and never returns an id outside
 * `options.kinds`, so the value the popup submits is always one the route
 * accepts. When the answer differs from what was stored, `restoredKindNote`
 * below is the line that says so.
 */
export function pickKind(stored: unknown, options: CaptureOptions): string {
  if (isNonEmptyString(stored) && options.kinds.some((k) => k.id === stored.trim())) {
    return stored.trim();
  }
  return options.defaultKind;
}

/**
 * The one line the popup shows when {@link pickKind} did NOT restore what this
 * browser remembered — or null when there is nothing to say.
 *
 * Without it the fallback is silent: a browser carrying `deep` on an instance
 * that no longer offers it renders `standard`, the reader clicks Summarize and
 * gets a capture in a kind they did not pick, with the picker showing the kind
 * that ran and no trace of the one that did not.
 *
 * Two cases are deliberately silent. An install with no stored kind is the
 * DEFAULT, not a fallback — there was no choice to lose. And under the
 * unreachable fallback ({@link FALLBACK_CAPTURE_OPTIONS}) the popup already
 * shows {@link OPTIONS_UNREACHABLE_MESSAGE}, which is the true explanation:
 * this instance is not known to have dropped anything.
 */
export function restoredKindNote(
  stored: unknown,
  picked: string,
  options: CaptureOptions,
): string | null {
  if (!options.fromServer) return null;
  if (!isNonEmptyString(stored)) return null;
  const wanted = stored.trim();
  if (wanted === picked) return null;
  const label = options.kinds.find((k) => k.id === picked)?.label ?? picked;
  return `“${wanted}” is not offered here — using ${label}.`;
}

/**
 * The Slides tick's state, given what this browser remembered and whether the
 * instance can read frames at all.
 *
 * `true` only for an explicit stored `true` on an instance that supports them:
 * a remembered tick must not survive onto a summarizer bot whose connector
 * cannot read files, where the POST would 503 on every click.
 */
export function pickFrames(stored: unknown, options: CaptureOptions): boolean {
  return options.framesSupported && stored === true;
}

/**
 * The visual-detail value to SELECT — or null on an instance that does not
 * offer the choice, which is also the signal to send no such field.
 *
 * The {@link pickKind} rule on the other axis: a remembered value the server no
 * longer offers falls back to the server's default rather than being submitted
 * blind, so the value the popup shows is always one the route accepts. Unlike
 * the kind, a fallback here needs no note — the two policies are fixed by the
 * server's code, so "no longer offered" is not a state a real instance reaches.
 */
export function pickVisualDetail(stored: unknown, options: CaptureOptions): string | null {
  const capability = options.visualDetail;
  if (!capability) return null;
  if (isNonEmptyString(stored) && capability.options.some((o) => o.id === stored.trim())) {
    return stored.trim();
  }
  return capability.defaultDetail;
}

/**
 * The body the background worker POSTs to `/api/youtube/summarize`.
 *
 * Built here rather than in the worker so the three coercions the route cares
 * about are pinned by a test: `frames` is always a real boolean (anything else
 * is 400 `bad_frames`), `kind` is always a non-empty string (an unknown one
 * is 400 `bad_kind`, and `undefined` would be dropped by `JSON.stringify` —
 * which the route reads as "not picked", i.e. Standard, silently), and
 * `visual_detail` is either a non-empty string or ABSENT.
 *
 * Absent is the load-bearing half of that last one: the route refuses a present
 * key holding anything it does not offer — including a blank string, which is a
 * picker that failed to fill — while an absent key is the documented default.
 * So a popup with nothing to send omits the key rather than sending `""`.
 */
export function buildSummarizeBody(input: {
  title?: unknown;
  url: string;
  videoId: string;
  kind?: unknown;
  frames?: unknown;
  visualDetail?: unknown;
}): {
  title: string;
  url: string;
  video_id: string;
  kind: string;
  frames: boolean;
  visual_detail?: string;
} {
  return {
    title: typeof input.title === "string" ? input.title : "",
    url: input.url,
    video_id: input.videoId,
    kind: isNonEmptyString(input.kind) ? input.kind.trim() : FALLBACK_KIND_ID,
    frames: input.frames === true,
    ...(isNonEmptyString(input.visualDetail)
      ? { visual_detail: input.visualDetail.trim() }
      : {}),
  };
}
