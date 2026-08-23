/**
 * The Jira-composer WIRE CONTRACT — the values the routes, PR 2's `/jira` page and
 * the tests must all agree on.
 *
 * Dependency-free on purpose, the `src/share/wire.ts` precedent: PR 2 bundles its
 * dialog/page client for the browser, so anything this module imports is pulled
 * into that bundle. `templates.ts` reaches for `bots/config.ts` types, `prompt.ts`
 * for the citation shape, `verify-keys.ts` for huginn. None of that is needed to
 * state a cap, name a depth or type a payload.
 */

/** Which template shapes the task. Ordered ids — see `templates.ts`. */
export type JiraTemplateId = "bug" | "story" | "task" | "spike";

/**
 * How much technical solution the draft carries. Deliberately an axis of its own
 * rather than four more templates (design call 2): "how much of the how" varies
 * independently of the issue type.
 */
export type JiraDepth = "ingen" | "skisse" | "full";

/** Picker order + labels. Spelled the way the reader picks them, in Norwegian. */
export const JIRA_DEPTHS: readonly { id: JiraDepth; label: string; hint: string }[] = [
  { id: "ingen", label: "Ingen", hint: "Problem, verdi, akseptansekriterier. Ingen filer, ingen klasser." },
  { id: "skisse", label: "Skisse", hint: "3–5 punkter: hvilke tjenester og klasser berøres, hvilken vei endringen går." },
  { id: "full", label: "Full", hint: "fil.kt:linje, rekkefølge, migrering, ett kodeutdrag, risiko." },
];

export function isJiraDepth(value: unknown): value is JiraDepth {
  return value === "ingen" || value === "skisse" || value === "full";
}

/**
 * Cap on the raw material (chars).
 *
 * A pasted Slack thread or a meeting note is the input; 24k is the same budget
 * `SHARE_BODY_MAX` gives a whole wiki page, which is the largest thing this
 * feature has ever been asked to read. Over-cap is a **400, never a truncation**
 * (the `SHARE_PROMPT_OVERRIDE_MAX` rule): a silently shortened note changes what
 * the model was asked without telling anyone, and the reader would read the
 * result as a task written from everything they pasted.
 */
export const JIRA_NOTES_MAX = 24_000;

/**
 * Cap on the whole assembled generation prompt (chars) — the backstop behind
 * `JIRA_NOTES_MAX`, since the citations block is server-grown and the notes cap
 * alone does not bound it. Enforced in `prompt.ts` by trimming the CITATIONS
 * (the recoverable half), never the notes.
 */
export const JIRA_BODY_MAX = 48_000;

/** Cap on the free-text `extra` steer ("fokuser på migreringsrisikoen"). */
export const JIRA_EXTRA_MAX = 2_000;

/**
 * Cap on the reader's edit of the draft at `PUT /api/jira/draft/:id`. Generous —
 * a Full-depth task with a code excerpt is genuinely long — and a hard 400, not a
 * truncation: the stored markdown is the only copy after the paste (design call 3).
 */
export const JIRA_MARKDOWN_MAX = 100_000;

/**
 * Retrieval coverage verdict — `research/answer.ts`'s `Coverage` plus one value
 * of this feature's own, so the browser half never imports the research layer.
 *
 * **`unreachable` is not a coverage verdict about the corpus; it is the absence
 * of one.** Measured on the first real run: huginn was down, every sub-search
 * threw (`research-knowledge.ts` records `resultCount: 0` + `error` for each),
 * `assessCoverage` saw zero hits and returned `no_hits` — and the page told the
 * reader that *"nothing in jira-issues, melosys-confluence-v3 or nav-wiki covered
 * this search"*. The corpus was never asked. The two states lead to opposite
 * actions (rewrite the raw material vs. try again in a minute), so they get
 * different values rather than one sentence hedging both.
 */
export type JiraCoverage = "answer" | "no_hits" | "low_confidence" | "unreachable";

/**
 * The three reader-facing coverage sentences.
 *
 * They live in the WIRE module rather than beside `assessCoverage` in
 * `retrieval.ts` for exactly the reason this module exists: `/jira`'s page
 * bundle renders them, and `retrieval.ts` reaches for `researchKnowledge` /
 * `fetchKnowledgeApi` / the logger, so importing them from the browser half
 * would drag the whole research layer into the bundle. `retrieval.ts` imports
 * these two, so there is still ONE spelling of each.
 *
 * Deliberately NOT `coverageMessage` from `answer.ts`: its `NO_HITS_MESSAGE`
 * names the Anthropic firehose and the Claude/YouTube/X shelves (none of which
 * this feature searches) and its `LOW_CONFIDENCE_MESSAGE` says *"I'd rather not
 * synthesize an answer that isn't well-grounded"* — the opposite of what this
 * does. An ungrounded draft is still useful raw material, so it still drafts; it
 * just never presents the result as grounded.
 */
export const JIRA_NO_HITS_MESSAGE =
  "Ingenting i jira-issues, melosys-confluence-v3 eller nav-wiki dekket dette søket, " +
  "så utkastet er skrevet utelukkende fra råmaterialet ditt. Det er ingen referanser å kontrollere — " +
  "les nøye før du oppretter saken.";

export const JIRA_LOW_CONFIDENCE_MESSAGE =
  "De nærmeste treffene dekket ikke dette temaet med sikkerhet, så utkastet er svakt forankret. " +
  "Kildene er listet opp likevel — vurder dem selv, eller skriv om råmaterialet mot det som faktisk er indeksert.";

/**
 * The third state, which the SERVER cannot spell.
 *
 * `jiraCoverageMessage` takes only the derived verdict, and a derived `no_hits`
 * has two completely different causes: the corpus covered nothing, or the reader
 * switched every retrieved source off. Telling someone who just unticked 24 rows
 * that "nothing in jira-issues covered this search" is a lie about the corpus.
 * The page distinguishes them by comparing the derived `coverage` against the
 * stored `retrievalCoverage`, which is why both ride the payload.
 */
/**
 * The retrieval that never happened.
 *
 * Deliberately says the API was unavailable and NOT that the corpus is empty —
 * see {@link JiraCoverage}. It also tells the reader what to do, because unlike
 * the other three states this one is transient: the same notes, retried later,
 * produce a grounded draft.
 */
export const JIRA_UNREACHABLE_MESSAGE =
  "Kunnskaps-API-et var utilgjengelig — ingen kilder ble hentet. Utkastet er skrevet utelukkende " +
  "fra råmaterialet ditt. Prøv igjen senere.";

export const JIRA_ALL_EXCLUDED_MESSAGE =
  "Alle kilder er slått av — utkastet er uten grunnlag. Retrieval fant treff, " +
  "men ingen av dem er med i denne genereringen. Slå på minst én kilde og generer på nytt " +
  "hvis saken skal være forankret.";

/**
 * The verdict for ONE generation, from the immutable retrieval verdict plus how
 * many sources that run actually kept.
 *
 * **The two are different questions and only one of them is storable.** What
 * retrieval found is a fact about the draft session — it is written once, by
 * `saveJiraDraftRetrieval`, and never again. What a given RUN was grounded in is
 * a function of the reader's exclusion set at that moment, which changes on every
 * regenerate. Writing the second back over the first is what made the composer
 * latch: one regenerate with every source toggled off stored `no_hits`, the next
 * regenerate read that back as "what retrieval found", and the draft stayed
 * `no_hits` with 21 live citations and a full `## Referanser` underneath it.
 *
 * So: the row keeps the retrieval verdict, and both the `done` payload and
 * `GET /api/jira/draft/:id` report THIS. Deriving costs nothing — the row already
 * stores the wide citation set and the run's exclusion set — and it cannot drift,
 * which two columns could.
 *
 * `null` (a legacy row, or one whose retrieval never landed) reads as `answer`,
 * the same default the regenerate path has always applied.
 */
export function effectiveCoverage(
  retrievalCoverage: JiraCoverage | null | undefined,
  retainedCount: number,
): JiraCoverage {
  // `unreachable` PASSES THROUGH the zero-retained branch. An unreachable
  // retrieval has nothing to retain by construction, so the branch below would
  // otherwise convert every one of them back into the `no_hits` claim about the
  // corpus that this value exists to stop being made.
  if (retrievalCoverage === "unreachable") return "unreachable";
  if (retainedCount === 0) return "no_hits";
  return retrievalCoverage ?? "answer";
}

/** One retrieved source, as the toggle column renders it and the prompt cites it. */
export interface JiraCitation {
  /** 1-based, renumbered after `excludeDocIds` (see the regenerate contract). */
  n: number;
  collection: string;
  docId: string;
  title: string;
  url?: string;
  /** Corpus badge — "Jira" / "Confluence" / "NAV-wiki" (see `COLLECTION_META`). */
  badge: string;
  relevance: number;
  snippet?: string;
  /** The Jira key when this doc IS an issue (`<KEY>_<slug>.md`), else absent. */
  key?: string;
}

/**
 * Verdict on one Jira key found in the generated markdown. THREE states, not two
 * — a prefix allow-list would silently drop the worst case (a fabricated key from
 * a project retrieval never surfaced), and unioning the notes' keys into
 * `verified` would bless a key mistyped in a meeting note.
 */
export type JiraKeyState =
  /** The key is in the retrieved set — the draft is grounded in that issue. */
  | "verified"
  /** Present in the notes only. Amber: the reader wrote it, retrieval never saw it. */
  | "notes"
  /** Neither retrieved nor in the notes. Red — the fabricated-key case. */
  | "unknown";

export interface JiraKeyVerdict {
  key: string;
  state: JiraKeyState;
  /**
   * Whether the key resolves to a real document in `jira-issues`.
   *
   * This is the "real verdict" behind the amber state, and it is a SEPARATE axis
   * from `state` on purpose: `state` answers "is the draft grounded in it",
   * `resolved` answers "does it exist". A notes-only key that resolves is a real
   * issue the retrieval simply missed; one that does not is a typo in the meeting
   * note. `undefined` ⇒ the lookup was unavailable (huginn down), never `false` —
   * a degraded lookup must not read as a fabrication verdict.
   */
  resolved?: boolean;
  /** The `[KEY](url)` target when resolved. */
  url?: string;
}

/** A construct the generated markdown carries that the Jira paste does NOT convert
 *  (PR 0, measured). Flagged, never silently rewritten — the `verify-keys` shape. */
export type JiraMarkdownFlagKind = "html" | "wiki-markup" | "task-list" | "emoji-shortcode";

export interface JiraMarkdownFlag {
  kind: JiraMarkdownFlagKind;
  /** 1-based line number in the generated markdown. */
  line: number;
  /** The offending fragment, clipped. */
  sample: string;
}

/** The SSE `done` payload. */
export interface JiraDonePayload {
  draftId: string;
  markdown: string;
  citations: JiraCitation[];
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  /**
   * The coverage VERDICT, deliberately not a `weakCoverage` boolean: at
   * `low_confidence` the draft is grounded-but-weak, at `no_hits` there is no
   * `## Referanser` section at all. The two states differ and the page renders
   * them differently.
   */
  coverage: JiraCoverage;
  /**
   * What RETRIEVAL found, before this run's exclusions — the same field the view
   * carries, so a stream-driven client can tell "the corpus had nothing" from
   * "the reader toggled everything off" without a second GET. `null` only when
   * retrieval never landed.
   */
  retrievalCoverage: JiraCoverage | null;
  /** The condensed retrieval question — shown so the reader can see what was searched. */
  retrievalQuestion: string;
}

/** Status of a stored draft, as `GET /api/jira/draft/:id` reports it. */
export type JiraDraftStatus = "generating" | "ready" | "failed";

/**
 * Where a draft came from.
 *
 * `notes` — the reader pasted raw material and the server retrieved for it.
 * `thread` — the draft is a TURN in a chat thread: the conversation already
 * retrieved (through the `research_knowledge` MCP tool), already argued with the
 * answer, and the draft turn inherits all of it as ordinary history. The two
 * differ in every later operation, which is why it is stored rather than inferred
 * from `thread_id` being set: a regenerate on a `thread` draft is another thread
 * turn, and its hit set comes from `research_citations`, not from a retrieval.
 */
export type JiraDraftSource = "notes" | "thread";

export function isJiraDraftSource(value: unknown): value is JiraDraftSource {
  return value === "notes" || value === "thread";
}

/** `GET /api/jira/draft/:id`. `markdown` is null while `generating`. */
export interface JiraDraftView {
  draftId: string;
  status: JiraDraftStatus;
  /**
   * The template id as stored — a plain string, NOT {@link JiraTemplateId}.
   *
   * The shipped four are not the closed set: a bot's `jiraTemplate.<id>.md` adds
   * ids the union cannot know, so typing this as the union bought a cast at the
   * db boundary and a type that lies about the rows it describes.
   */
  template: string;
  depth: JiraDepth;
  notes: string;
  extra: string;
  markdown: string | null;
  /** The WIDE stored hit set — every row PR 2's toggle column renders. */
  citations: JiraCitation[];
  /**
   * The doc ids the reader toggled OFF, as the last generation used them.
   *
   * Stored so the view is self-consistent: without it a poll answered with 24
   * citations beside markdown that cites 23, and `PUT` re-verified against the
   * wide set — flipping an excluded key back to `verified` on save.
   */
  excludeDocIds: string[];
  keyVerdicts: JiraKeyVerdict[];
  markdownFlags: JiraMarkdownFlag[];
  /**
   * What RETRIEVAL found — the stored column, written once and never overwritten.
   * `null` while a draft is still generating (or on a draft whose retrieval died).
   */
  retrievalCoverage: JiraCoverage | null;
  /**
   * The verdict for the draft as it currently stands: {@link effectiveCoverage}
   * of the retrieval verdict and the citations left after `excludeDocIds`. This
   * is the one the page renders; the row does not store it (see the function).
   */
  coverage: JiraCoverage | null;
  retrievalQuestion: string;
  error: string | null;
  /** `notes` (pasted raw material) | `thread` (a turn in a chat thread). */
  source: JiraDraftSource;
  /** The chat thread the draft turn runs in. Null on a notes-sourced draft. */
  threadId: string | null;
  /**
   * That thread's name, resolved at READ time rather than stored — a thread can
   * be renamed, and a copy on this row would then name a thread that no longer
   * exists under that title. Null when there is no thread, or when the thread row
   * is gone (there is deliberately no FK).
   */
  threadName: string | null;
  /**
   * The assistant message whose text this draft's `markdown` was taken from.
   *
   * Re-pointed by every regenerate, since a regenerate is another turn in the
   * same thread. Null on a notes-sourced draft.
   */
  messageId: string | null;
  createdAt: number;
  updatedAt: number;
}

// ── Request-body validation ──────────────────────────────────────────────────

/** The validated draft-request body. */
export interface ParsedJiraDraftBody {
  notes: string;
  template: string;
  depth: JiraDepth;
  extra: string;
  /** Regenerate: reuse this draft's stored hit set. Empty ⇒ a fresh retrieval. */
  draftId: string;
  /** Doc ids the reader toggled OFF. Only meaningful with `draftId`. */
  excludeDocIds: string[];
}

export type JiraBodyResult =
  | { ok: true; body: ParsedJiraDraftBody }
  | { ok: false; error: string };

/**
 * The wire fields, named the way the `/jira` page names them.
 *
 * **These messages are reader-facing.** The route returns the validator's string
 * verbatim in its 400 body and the page renders it verbatim in its status line,
 * so an English `extra is longer than 2000 characters` landed under a Norwegian
 * form whose own field is labelled «Ekstra instruks». The whole surface is
 * Norwegian; so is this.
 */
const FIELD_LABELS: Record<string, string> = {
  notes: "Råmaterialet",
  template: "Malen",
  depth: "Teknisk dybde",
  extra: "Ekstra instruks",
  draftId: "Utkast-id-en",
};

/**
 * Validate one draft POST body.
 *
 * Lives in the dependency-free wire module for the `parseShareRequestBody`
 * reason: BOTH entry points run it — the SSE `POST /api/jira/draft` and the
 * plain-JSON `POST /api/jira/draft/start` the extension calls — and two copies of
 * a validation contract is two copies to drift. The error copy IS the contract
 * (the route tests pin these strings), so a caller hitting one endpoint must not
 * be told something different from a caller hitting the other.
 *
 * Returns an error rather than a `Response` so it stays dependency-free and each
 * route keeps ownership of its status code. The ORDERING rule both routes hold:
 * this runs BEFORE anything resolution-dependent, and long before `streamSSE`
 * commits a 200 — after that a validation failure can only be an `app_error` no
 * client can tell from a model failure.
 *
 * The TEMPLATE id is deliberately not validated here: the valid set is a function
 * of the resolved bot's `jiraTemplate.<id>.md` overrides, which this module
 * cannot see. It is checked in the route, still pre-commit.
 */
export function parseJiraDraftBody(body: Record<string, unknown>): JiraBodyResult {
  for (const field of ["notes", "template", "depth", "extra", "draftId"]) {
    const v = body[field];
    if (v !== undefined && typeof v !== "string") {
      return { ok: false, error: `${FIELD_LABELS[field] ?? field} må være en tekststreng.` };
    }
  }

  const draftId = typeof body.draftId === "string" ? body.draftId.trim() : "";
  const notes = typeof body.notes === "string" ? body.notes : "";
  // A regenerate reuses the stored notes, so an absent `notes` is legal there and
  // only there. Requiring them on both paths would force the extension/page to
  // echo a 10 KB Slack thread back on every toggle click.
  if (!draftId && !notes.trim()) return { ok: false, error: "Råmaterialet mangler." };
  // ...and NEW notes on a regenerate are refused rather than silently honoured.
  // The stored hit set was retrieved for the OLD raw material and is deliberately
  // not re-retrieved (design call 1), so drafting different notes against it
  // answers a question nobody asked and leaves `retrieval_question` describing a
  // search that no longer matches the row. Changing the notes means a new draft.
  if (draftId && notes.trim()) {
    return {
      ok: false,
      error:
        "Råmaterialet kan ikke endres når du genererer på nytt — treffene ble hentet for den " +
        "opprinnelige teksten. Start et nytt utkast i stedet.",
    };
  }
  if (notes.length > JIRA_NOTES_MAX) {
    return { ok: false, error: `Råmaterialet er ${notes.length} tegn — grensen er ${JIRA_NOTES_MAX}.` };
  }

  const template = typeof body.template === "string" ? body.template.trim() : "";
  if (!template) return { ok: false, error: "Ingen mal er valgt." };

  if (!isJiraDepth(body.depth)) {
    return {
      ok: false,
      error: `Teknisk dybde må være en av: ${JIRA_DEPTHS.map((d) => d.id).join(", ")}.`,
    };
  }

  const extra = typeof body.extra === "string" ? body.extra : "";
  if (extra.length > JIRA_EXTRA_MAX) {
    return { ok: false, error: `Ekstra instruks er ${extra.length} tegn — grensen er ${JIRA_EXTRA_MAX}.` };
  }

  const rawExclude = body.excludeDocIds;
  if (rawExclude !== undefined) {
    if (!Array.isArray(rawExclude) || rawExclude.some((v) => typeof v !== "string")) {
      return { ok: false, error: "Avslåtte kilder må være en liste med dokument-id-er." };
    }
  }
  const excludeDocIds = Array.isArray(rawExclude) ? (rawExclude as string[]).map((s) => s.trim()).filter(Boolean) : [];
  // An exclusion set with no draft to apply it to is a client bug, not a
  // no-op: the reader toggled rows off against a hit set the server is about to
  // discard, and the draft would silently come back citing every one of them.
  if (!draftId && excludeDocIds.length > 0) {
    return {
      ok: false,
      error: "Kilder kan ikke slås av uten et utkast — det finnes ingen lagret trefliste å utelate fra.",
    };
  }

  return { ok: true, body: { notes, template, depth: body.depth, extra, draftId, excludeDocIds } };
}
