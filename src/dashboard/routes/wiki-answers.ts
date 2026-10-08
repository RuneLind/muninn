/**
 * The `wiki-answers` route group: answers to a `<Question>` card on a wiki page
 * (answer cards PR 2).
 *
 *   GET  /api/wiki/answers?wiki=&relPath=[&versions=1]
 *   POST /api/wiki/answers  {wiki, relPath, questionId, choice?, body, answerId?, baseVersion?}
 *   GET  /api/wiki/answers/export?wiki=&relPath=[&again=1]   (admin; PR 4)
 *   GET  /api/wiki/answers/export?wiki=&orphans=1           (admin; PR 4)
 *   POST /api/wiki/answers/export/confirm  {wiki, relPath, rows: [[answerId, version], …]}  (admin; PR 4)
 *   POST /api/wiki/answers/export/confirm  {wiki, orphans: true, rows}        (admin; the orphan copy)
 *   POST /api/wiki/answers/redact  {answerId}                                (admin; PR 5)
 *
 * Its own group so `MUNINN_PROFILE=nais` keeps it (D14) while it drops `wiki`.
 * Both routes resolve the page through the read slice's own ladder
 * (`resolveScopedPage`), so on the pod they serve read-only roots only. With
 * auth on, role `user` reaches GET and POST `/api/wiki/answers` on the nais
 * profile only (`WIKI_READ_SLICE_METHOD_ENTRIES` in `src/auth/zones.ts`); the
 * export, its confirm and the redact stay admin. A POST body is scanned by
 * `WIKI_ANSWER_SCANNER` before it is stored (`src/wiki/answer-scanner.ts`),
 * and nais refuses a body when no scanner can run.
 *
 * The POST re-reads the page and parses it with the renderer's own parser
 * (`parseQuestionPage`), so a card the reader shows open is exactly a question
 * this route accepts. The author comes from the session, never from the body
 * (D9): with auth off it is `WIKI_ANSWER_OWNER`, and an unset owner refuses the
 * write. An edit (`answerId`) is a new version, accepted only from the author,
 * and names the version it was made from (`baseVersion`): it is stored as
 * exactly `baseVersion + 1`, so an edit from a stale base — a second tab, a
 * lost race — is a 409, never a silent overwrite.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { resolveServingProfile, resolveWikiAnswerConfig, wikiTakesAnswers, type Config } from "../../config.ts";
import { servesWikiReadSliceOnly } from "../route-groups.ts";
import { resolveReadRequest, resolveScopedPage } from "./wiki-read-scope.ts";
import { requireJsonRequest } from "./json-request.ts";
import { isValidUuid } from "./route-utils.ts";
import { getWikiIndex, parseFrontmatter, readWikiPage, stripFrontmatter, type WikiIndex } from "../../wiki/store.ts";
import { answerStamp, formatAnswerExport, formatOrphanExport, type ExportAnswer } from "../../wiki/answer-export.ts";
import { parseBlocks } from "../../format/markdown-ast.ts";
import {
  authorGroupsOf,
  codePointLength,
  isAskedAuthor,
  parseQuestionPage,
  parseQuestionTarget,
  parseQuestionsTo,
  QUESTION_ANSWER_MAX,
  QUESTION_NOT_SURE,
  resolveQuestionTargets,
  type AnswerGroups,
  type QuestionTarget,
} from "../../format/question.ts";
import { sha256 } from "../../gardener/util.ts";
import { sessionIdentity, sessionRole } from "../../auth/guard.ts";
import { decideZone } from "../../auth/zones.ts";
import type { AuthRole } from "../../auth/role.ts";
import {
  getLatestWikiAnswerVersion,
  insertWikiAnswerVersion,
  listLastExportedWikiAnswers,
  listLatestWikiAnswers,
  listWikiAnswerLocations,
  listWikiAnswerVersions,
  markWikiAnswersExported,
  markWikiOrphanAnswersExported,
  redactWikiAnswer,
  WikiAnswerRedacted,
  WikiAnswerGone,
  WikiAnswerVersionConflict,
  type LatestWikiAnswer,
  type WikiAnswerLocation,
  type WikiAnswerAuthor,
  type WikiAnswerVersion,
} from "../../db/wiki-answers.ts";
import { scanAnswerText, scannerRequired } from "../../wiki/answer-scanner.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki-answers");

/** The answer routes' path. */
export const WIKI_ANSWERS_PATH = "/api/wiki/answers";
/** The export block (PR 4): admin only, marks nothing. */
export const WIKI_ANSWERS_EXPORT_PATH = "/api/wiki/answers/export";
/** Marks an export as copied (PR 4): admin only. */
export const WIKI_ANSWERS_EXPORT_CONFIRM_PATH = "/api/wiki/answers/export/confirm";
/** Redacts an answer (PR 5): admin only. */
export const WIKI_ANSWERS_REDACT_PATH = "/api/wiki/answers/redact";
/** The most `(answerId, version)` rows one confirm takes. */
export const EXPORT_CONFIRM_MAX_ROWS = 500;
/** The largest request body the answer POSTs read. Measured 2026-10-08: the
 *  body cap is 8000 code points, and an ASCII-escaping encoder (Python's
 *  `json.dumps` default) writes an astral one as a 12-byte surrogate pair, so
 *  the largest valid body is 96,002 bytes of JSON and a whole edit POST around
 *  it 96,161; 500 confirm rows are 26,054. wiki, relPath, questionId and choice
 *  have no cap of their own (each must name a real one), so the limit leaves
 *  ~35 KB above the measured answer for them. */
export const WIKI_ANSWER_BODY_LIMIT = 128 * 1024;

/** Refuses a body over {@link WIKI_ANSWER_BODY_LIMIT} with 413 before it is
 *  parsed: role `user` reaches the answer POST on the pod. */
export const answerBodyLimit = bodyLimit({
  maxSize: WIKI_ANSWER_BODY_LIMIT,
  onError: (c) => c.json({ error: "request body too large", code: "too_large" }, 413),
});

/**
 * May this viewer read AND post answers? The zone model's own decision for
 * both methods, so `/api/wiki/page` never tells a client the cards take
 * answers when every request it would make answers 403 — and so a later zone
 * change (answer cards PR 5) flips the page flag with it. With auth off
 * (`role` undefined) every zone admits it.
 */
export function viewerMayUseAnswers(role: AuthRole | null | undefined, wikiReadSlice: boolean): boolean {
  return (["GET", "POST"] as const).every(
    (method) => decideZone({ method, path: WIKI_ANSWERS_PATH, role, wikiReadSlice }).allowed,
  );
}

/** The store, injectable so the route's rules are testable without a database. */
export interface WikiAnswerStore {
  insert: typeof insertWikiAnswerVersion;
  getLatest: typeof getLatestWikiAnswerVersion;
  listLatest: typeof listLatestWikiAnswers;
  listVersions: typeof listWikiAnswerVersions;
  /** Absent ⇒ {@link redactWikiAnswer}. */
  redact?: typeof redactWikiAnswer;
}

const defaultStore: WikiAnswerStore = {
  insert: insertWikiAnswerVersion,
  getLatest: getLatestWikiAnswerVersion,
  listLatest: listLatestWikiAnswers,
  listVersions: listWikiAnswerVersions,
};

/** The export's store (PR 4), a seam of its own so PR 2's store stays as it was. */
export interface WikiAnswerExportStore {
  listLatest: typeof listLatestWikiAnswers;
  listLastExported: typeof listLastExportedWikiAnswers;
  listLocations: typeof listWikiAnswerLocations;
  markExported: typeof markWikiAnswersExported;
  markOrphansExported: typeof markWikiOrphanAnswersExported;
}

const defaultExportStore: WikiAnswerExportStore = {
  listLatest: listLatestWikiAnswers,
  listLastExported: listLastExportedWikiAnswers,
  listLocations: listWikiAnswerLocations,
  markExported: markWikiAnswersExported,
  markOrphansExported: markWikiOrphanAnswersExported,
};

/** One orphaned answer: its page no longer resolves, or its question is gone
 *  from the page and the DecisionLog item is not closed (O4). Enough to copy it
 *  by hand. No `asked`: the question that named who was asked is gone. */
export interface OrphanAnswer {
  answerId: string;
  relPath: string;
  questionId: string;
  authorName: string;
  version: number;
  createdAt: number;
  /** `createdAt` as the export block prints it (`08.10.2026 09:14`, Oslo). */
  time: string;
  choice: string | null;
  body: string;
  reason: "page_gone" | "question_gone";
}

/**
 * The wiki's orphaned answers (O4): only answers whose latest version is
 * unexported and not redacted (see {@link listWikiAnswerLocations}). Each
 * distinct relPath that has such answers is resolved and parsed ONCE. An
 * answer to a question whose item is closed is never an orphan: the
 * `<Question>` normally stays after the close, and an item closed in the
 * DecisionLog settles the question even if the block went. A page that
 * resolves but cannot be read is skipped, not counted: unknown is not gone.
 */
export async function findOrphanAnswers(
  wiki: string,
  index: WikiIndex,
  store: Pick<WikiAnswerExportStore, "listLocations">,
): Promise<OrphanAnswer[]> {
  const byPage = new Map<string, WikiAnswerLocation[]>();
  for (const loc of await store.listLocations(wiki)) {
    const list = byPage.get(loc.relPath) ?? [];
    list.push(loc);
    byPage.set(loc.relPath, list);
  }
  const out: OrphanAnswer[] = [];
  for (const [relPath, locs] of byPage) {
    const meta = index.resolveRelPath(relPath);
    let gone: (questionId: string) => boolean;
    if (!meta) {
      gone = () => true;
    } else {
      const markdown = await readWikiPage(index, meta);
      if (markdown === null) continue;
      const parsed = parseQuestionPage(parseBlocks(stripFrontmatter(markdown)));
      const ids = new Set(parsed.questions.map((q) => q.id).filter((id): id is string => id !== null));
      gone = (id) => !ids.has(id) && (parsed.states.get(id)?.kind ?? "open") === "open";
    }
    for (const l of locs) {
      if (!gone(l.questionId)) continue;
      out.push({ ...l, time: answerStamp(l.createdAt), reason: meta ? "question_gone" : "page_gone" });
    }
  }
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath) || a.createdAt - b.createdAt);
}

/** The orphans as the reader's "Copy orphaned answers" copies them: the block
 *  and the exact `(answerId, version)` rows a confirm would mark. */
function orphanExportOf(wiki: string, orphans: readonly OrphanAnswer[], exportedAt: number) {
  return {
    block: formatOrphanExport({
      wiki,
      exportedAt,
      answers: orphans.map((o) => ({
        questionId: o.questionId,
        authorName: o.authorName,
        asked: null,
        createdAt: o.createdAt,
        choice: o.choice,
        body: o.body,
        version: o.version,
        redacted: false,
        relPath: o.relPath,
        reason: o.reason,
      })),
    }),
    rows: orphans.map((o) => [o.answerId, o.version] as [string, number]),
    count: orphans.length,
  };
}

/** One version as the GET shows it. Never the author's oid or NAV ident. */
interface AnswerVersionView {
  version: number;
  authorName: string;
  choice: string | null;
  body: string;
  createdAt: number;
  exported: boolean;
  redacted: boolean;
}

interface AnswerView extends AnswerVersionView {
  answerId: string;
  questionId: string;
  versionCount: number;
  firstCreatedAt: number;
  /** The viewer wrote it: may edit it and see its earlier versions. */
  mine: boolean;
  /** The question names its author (D2): ident when both sides have one,
   *  else the case-folded name. Null when the page no longer has the question
   *  or it names nobody. Computed here because the author's stored NAV ident
   *  never leaves the server. It is matched against the page's CURRENT
   *  targets, not the ones the question had when the answer was saved. */
  asked: boolean | null;
  /** The `WIKI_ANSWER_GROUPS` groups holding the author's stored NAV ident,
   *  sorted — read from the CURRENT config, never stored, never the ident. */
  authorGroups: string[];
  /** Earlier versions, newest first — with `versions=1`, to the author and an admin only. */
  earlier?: AnswerVersionView[];
}

function versionView(v: WikiAnswerVersion): AnswerVersionView {
  const redacted = v.redactedAt !== null;
  return {
    version: v.version,
    authorName: v.author.name,
    choice: redacted ? null : v.choice,
    body: redacted ? "" : v.body,
    createdAt: v.createdAt,
    exported: v.exportedAt !== null,
    redacted,
  };
}

/** The session's author, or the owner with auth off, or null when auth is off
 *  and no owner is configured. The owner is read in the target format, so
 *  `Rune Lind (X111111)` stores the name and keeps the ident for `asked`. */
function authorFor(c: Context, owner: string | null): WikiAnswerAuthor | null {
  const identity = sessionIdentity(c);
  if (identity) {
    return { userId: identity.userId, oid: identity.oid, navIdent: identity.navIdent, name: identity.displayName };
  }
  const target = owner ? parseQuestionTarget(owner) : null;
  return target ? { userId: null, oid: null, navIdent: target.ident, name: target.name } : null;
}

/** Did the viewer write this answer? With auth off every answer is the owner's. */
function isMine(c: Context, a: { author: WikiAnswerAuthor }): boolean {
  const identity = sessionIdentity(c);
  return identity === null || (a.author.userId !== null && a.author.userId === identity.userId);
}

const err = (c: Context, status: 400 | 403 | 404 | 409 | 422 | 503, code: string, error: string) =>
  c.json({ error, code }, status);

/** A NUL (Postgres refuses it in text) or an unpaired surrogate (stored as
 *  U+FFFD, the next character lost — measured on `"a\udc00b"`). */
function hasUnstorableText(s: string): boolean {
  return s.includes("\u0000") || !s.isWellFormed();
}

const answerRedacted = (c: Context) => err(c, 409, "answer_redacted", "this answer was redacted");

const versionConflict = (c: Context) =>
  err(c, 409, "version_conflict", "the answer changed while you were editing it — reload and try again");

/** A page-resolution failure: the 503 "wiki directory not found" has its own code. */
function pageError(c: Context, page: { status: 400 | 404 | 503; error: string }) {
  return err(c, page.status, page.status === 503 ? "wiki_unavailable" : "no_page", page.error);
}

/** Who each question on the page is for, by id — the first block wins on a
 *  duplicated id, as the card shows it. Empty when the page is unreadable. */
async function questionTargetsOf(
  page: { index: Parameters<typeof readWikiPage>[0]; meta: Parameters<typeof readWikiPage>[1] },
  owner: string | null,
): Promise<Map<string, QuestionTarget[]>> {
  const out = new Map<string, QuestionTarget[]>();
  const markdown = await readWikiPage(page.index, page.meta);
  if (markdown === null) return out;
  const questionsTo = parseQuestionsTo(parseFrontmatter(markdown).questions_to);
  for (const q of parseQuestionPage(parseBlocks(stripFrontmatter(markdown))).questions) {
    if (q.id !== null && !out.has(q.id)) out.set(q.id, resolveQuestionTargets(q.to, questionsTo, owner).to);
  }
  return out;
}

/** Admin, or auth off. A second lock beside the zone model's default-deny,
 *  which keeps both export paths out of every user zone today: answer cards
 *  PR 5 opens the answer routes to role `user`, and the export must not follow. */
const isAdminViewer = (c: Context) => (sessionRole(c) ?? "admin") === "admin";

/** The largest `version` the column holds (Postgres `int4`). */
const VERSION_MAX = 2_147_483_647;

/** A confirm row: `[answerId, version]` with a uuid and a version in 1…int4 max. */
function parseConfirmRows(raw: unknown): [string, number][] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > EXPORT_CONFIRM_MAX_ROWS) return null;
  const rows: [string, number][] = [];
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [id, version] = r;
    if (typeof id !== "string" || !isValidUuid(id) || !Number.isInteger(version)) return null;
    if ((version as number) < 1 || (version as number) > VERSION_MAX) return null;
    rows.push([id, version as number]);
  }
  return rows;
}

/** A stored version the export block prints. */
type ExportRow = WikiAnswerVersion;

function exportAnswerOf(a: ExportRow, targets: Map<string, QuestionTarget[]>, groups: AnswerGroups): ExportAnswer {
  const t = targets.get(a.questionId);
  const redacted = a.redactedAt !== null;
  return {
    questionId: a.questionId,
    authorName: a.author.name,
    authorGroups: authorGroupsOf(a.author.navIdent, groups),
    asked: t ? isAskedAuthor({ name: a.author.name, navIdent: a.author.navIdent }, t, groups) : null,
    createdAt: a.createdAt,
    choice: redacted ? null : a.choice,
    body: redacted ? "" : a.body,
    version: a.version,
    redacted,
  };
}

export function registerWikiAnswerRoutes(
  app: Hono,
  config: Config,
  store: WikiAnswerStore = defaultStore,
  exportStore: WikiAnswerExportStore = defaultExportStore,
): void {
  const profile = config.profile ?? resolveServingProfile();
  const readSliceOnly = servesWikiReadSliceOnly(profile);
  const answerConfig = () => config.wikiAnswers ?? resolveWikiAnswerConfig();

  app.get(WIKI_ANSWERS_PATH, async (c) => {
    const wiki = c.req.query("wiki");
    const relPath = c.req.query("relPath");
    if (!wiki || !relPath) return err(c, 400, "bad_request", "wiki and relPath query params required");
    const page = await resolveScopedPage(readSliceOnly, { wiki, relPath });
    if (!page.ok) return pageError(c, page);
    if (!page.entry || !wikiTakesAnswers(page.entry.name, answerConfig())) {
      return c.json({ answerable: false, answers: [] });
    }
    try {
      const latest = await store.listLatest(page.entry.name, page.meta.relPath);
      const targets = latest.length ? await questionTargetsOf(page, answerConfig().owner) : new Map();
      const groups = answerConfig().groups ?? new Map();
      const isAdmin = (sessionRole(c) ?? "admin") === "admin";
      const withEarlier = c.req.query("versions") === "1"
        ? latest.filter((a) => a.versionCount > 1 && (isAdmin || isMine(c, a))).map((a) => a.answerId)
        : [];
      const earlier = new Map<string, AnswerVersionView[]>();
      for (const v of await store.listVersions(withEarlier)) {
        const latestVersion = latest.find((a) => a.answerId === v.answerId)?.version;
        if (v.version === latestVersion) continue;
        const list = earlier.get(v.answerId) ?? [];
        list.push(versionView(v));
        earlier.set(v.answerId, list);
      }
      const answers: AnswerView[] = latest.map((a: LatestWikiAnswer) => ({
        answerId: a.answerId,
        questionId: a.questionId,
        ...versionView(a),
        versionCount: a.versionCount,
        firstCreatedAt: a.firstCreatedAt,
        mine: isMine(c, a),
        asked: (() => {
          const t = targets.get(a.questionId);
          return t ? isAskedAuthor({ name: a.author.name, navIdent: a.author.navIdent }, t, groups) : null;
        })(),
        authorGroups: authorGroupsOf(a.author.navIdent, groups),
        ...(earlier.has(a.answerId) ? { earlier: earlier.get(a.answerId) } : {}),
      }));
      return c.json({ answerable: true, answers });
    } catch (e) {
      log.error("answers read failed for {wiki}/{relPath}: {error}", {
        wiki,
        relPath,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({ error: "answers unavailable", code: "store_failed" }, 500);
    }
  });

  app.post(WIKI_ANSWERS_PATH, answerBodyLimit, async (c) => {
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "bad_request", "body is not JSON");
    }
    const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const wiki = str(b.wiki);
    const relPath = str(b.relPath);
    const questionId = str(b.questionId)?.trim();
    if (!wiki || !relPath || !questionId) return err(c, 400, "bad_request", "wiki, relPath and questionId required");
    if (b.body !== undefined && typeof b.body !== "string") return err(c, 400, "bad_request", "body must be a string");
    if (b.choice !== undefined && b.choice !== null && typeof b.choice !== "string") {
      return err(c, 400, "bad_request", "choice must be a string");
    }
    if (b.answerId !== undefined && typeof b.answerId !== "string") return err(c, 400, "bad_request", "answerId must be a string");
    const rawBody = (b.body as string | undefined) ?? "";
    // A body that is only white space says nothing: stored empty, so the
    // export prints no empty blockquote.
    const body = rawBody.trim() === "" ? "" : rawBody;
    const choice = (b.choice as string | null | undefined) ?? null;
    // Not lowercased: the store casts to uuid before it compares or locks, and
    // the response echoes `saved.answerId`, the stored spelling.
    const answerId = b.answerId as string | undefined;
    const baseVersion = b.baseVersion;
    if (answerId !== undefined && !(Number.isInteger(baseVersion) && (baseVersion as number) >= 1)) {
      return err(c, 400, "bad_base_version", "an edit needs baseVersion: the version it was made from");
    }
    if (answerId === undefined && baseVersion !== undefined) {
      return err(c, 400, "bad_base_version", "baseVersion belongs to an edit (answerId)");
    }
    if (hasUnstorableText(rawBody) || (choice !== null && hasUnstorableText(choice))) {
      return err(c, 400, "bad_text", "body and choice must not contain a NUL or an unpaired surrogate");
    }

    const page = await resolveScopedPage(readSliceOnly, { wiki, relPath });
    if (!page.ok) return pageError(c, page);
    const cfg = answerConfig();
    if (!page.entry || !wikiTakesAnswers(page.entry.name, cfg)) {
      return err(c, 403, "not_answerable", `wiki "${wiki}" does not take answers (WIKI_ANSWER_WIKIS)`);
    }
    const author = authorFor(c, cfg.owner);
    if (!author) {
      return err(c, 503, "owner_unset", "WIKI_ANSWER_OWNER is not set: with auth off an answer has no author");
    }

    const markdown = await readWikiPage(page.index, page.meta);
    if (markdown === null) return err(c, 503, "page_unreadable", "page file unreadable");
    const parsed = parseQuestionPage(parseBlocks(stripFrontmatter(markdown)));
    const question = parsed.questions.find((q) => q.id === questionId);
    if (!question) return err(c, 404, "unknown_question", `no <Question id="${questionId}"> on this page`);
    if (question.duplicate) {
      return err(c, 409, "duplicate_question", `two <Question> blocks on this page use id "${questionId}"`);
    }
    const state = parsed.states.get(questionId) ?? { kind: "open" as const };
    if (state.kind !== "open") return err(c, 409, "question_closed", `question ${questionId} is ${state.kind}`);

    // The card offers "Not sure yet" only beside parsed choices, so a question
    // with none takes no choice. A page that declares a choice spelled like the
    // fixed value collapses onto it: the two are one stored value.
    if (choice !== null && question.choices.length === 0) {
      return err(c, 400, "bad_choice", `question ${questionId} declares no choices`);
    }
    if (choice !== null && choice !== QUESTION_NOT_SURE && !question.choices.includes(choice)) {
      const allowed = [...new Set([...question.choices, QUESTION_NOT_SURE])];
      return err(c, 400, "bad_choice", `choice must be one of: ${allowed.join(", ")}`);
    }
    if (body === "" && choice === null) return err(c, 400, "empty_answer", "an answer needs a body or a choice");
    if (codePointLength(body) > QUESTION_ANSWER_MAX) {
      return err(c, 400, "body_too_long", `body is over ${QUESTION_ANSWER_MAX} characters`);
    }

    let id: string;
    let version: number;
    if (answerId !== undefined) {
      const latest = isValidUuid(answerId) ? await store.getLatest(answerId) : null;
      if (
        !latest ||
        latest.wiki !== page.entry.name ||
        latest.relPath !== page.meta.relPath ||
        latest.questionId !== questionId
      ) {
        return err(c, 404, "unknown_answer", "no such answer to this question");
      }
      // No admin passthrough: only the author adds a version (D3).
      if (!isMine(c, latest)) return err(c, 403, "not_author", "only the answer's author may edit it");
      // A fast answer only: the insert re-checks under the per-answer lock,
      // which is what closes the race with a concurrent redact.
      if (latest.redactedAt !== null) return answerRedacted(c);
      if (baseVersion !== latest.version) return versionConflict(c);
      // Exactly base + 1: a writer that read the same base and got there first
      // holds this (answer_id, version), and the primary key refuses the second.
      id = answerId;
      version = (baseVersion as number) + 1;
    } else {
      id = randomUUID();
      version = 1;
    }

    // D16: the body is scanned before it is stored — after every refusal that
    // does not depend on the text, so a flagged edit that would be refused
    // anyway says why (not the author, unknown, redacted, stale). `choice` is
    // not scanned: it is one of the page's own parsed choices. nais needs a
    // scanner for every body; default runs one only when WIKI_ANSWER_SCANNER is set.
    if (body !== "") {
      const scanner = cfg.scanner ?? null;
      if (scanner === null && scannerRequired(profile)) {
        return err(c, 503, "scanner_unavailable", "WIKI_ANSWER_SCANNER is not set: this instance stores no answer text");
      }
      if (scanner !== null) {
        const verdict = await scanAnswerText(scanner, body);
        if (verdict.status === "unavailable") return err(c, 503, "scanner_unavailable", verdict.error);
        if (verdict.status === "refused") {
          return c.json(
            {
              error: "scanner_refused",
              code: "scanner_refused",
              reasons: verdict.reasons,
              ...(verdict.omitted ? { moreReasons: verdict.omitted } : {}),
            },
            422,
          );
        }
      }
    }

    try {
      const saved = await store.insert({
        answerId: id,
        version,
        wiki: page.entry.name,
        relPath: page.meta.relPath,
        questionId,
        author,
        choice,
        body,
        questionHash: sha256(question.hashInput),
      });
      return c.json({ answerId: saved.answerId, questionId, ...versionView(saved), mine: true }, version === 1 ? 201 : 200);
    } catch (e) {
      if (e instanceof WikiAnswerVersionConflict) return versionConflict(c);
      // The retention sweep deleted the answer after the read above: the same
      // answer the read itself would have given a moment later.
      if (e instanceof WikiAnswerGone) return err(c, 404, "unknown_answer", "no such answer to this question");
      if (e instanceof WikiAnswerRedacted) return answerRedacted(c);
      log.error("answer write failed for {wiki}/{relPath}: {error}", {
        wiki,
        relPath,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({ error: "answer not saved", code: "store_failed" }, 500);
    }
  });

  // Redact (D15): empties body and choice on every version and sets
  // redacted_at. Not keyed on WIKI_ANSWER_WIKIS or the page: cleanup must
  // still work after a wiki leaves the list or a page is gone. Idempotent —
  // a second call answers 200 with `alreadyRedacted: true`.
  app.post(WIKI_ANSWERS_REDACT_PATH, answerBodyLimit, async (c) => {
    if (!isAdminViewer(c)) return err(c, 403, "admin_only", "only an admin may redact answers");
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "bad_request", "body is not JSON");
    }
    const rawId = raw && typeof raw === "object" ? (raw as Record<string, unknown>).answerId : undefined;
    if (typeof rawId !== "string" || !isValidUuid(rawId)) {
      return err(c, 400, "bad_request", "answerId must be an answer's uuid");
    }
    const answerId = rawId.toLowerCase();
    try {
      const done = await (store.redact ?? redactWikiAnswer)(answerId);
      if (!done) return err(c, 404, "unknown_answer", "no such answer");
      log.info("answer {answerId} redacted ({versions} versions{again})", {
        answerId,
        versions: done.versions,
        again: done.alreadyRedacted ? ", already redacted" : "",
      });
      return c.json({ answerId, redacted: true, ...done });
    } catch (e) {
      log.error("answer redact failed for {answerId}: {error}", {
        answerId,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({ error: "answer not redacted", code: "store_failed" }, 500);
    }
  });

  app.get(WIKI_ANSWERS_EXPORT_PATH, async (c) => {
    if (!isAdminViewer(c)) return err(c, 403, "admin_only", "only an admin may export answers");
    const wiki = c.req.query("wiki");
    if (!wiki) return err(c, 400, "bad_request", "wiki query param required");
    try {
      if (c.req.query("orphans") === "1") {
        const { entry, unknownWiki } = resolveReadRequest(readSliceOnly, wiki, undefined);
        if (unknownWiki || !entry) return err(c, 404, "no_page", "no wiki configured for that name");
        const index = await getWikiIndex({ root: entry.root });
        if (!index) return err(c, 503, "wiki_unavailable", "wiki directory not found");
        if (!wikiTakesAnswers(entry.name, answerConfig())) return c.json({ orphans: [] });
        return c.json({ orphans: await findOrphanAnswers(entry.name, index, exportStore) });
      }
      const relPath = c.req.query("relPath");
      if (!relPath) return err(c, 400, "bad_request", "relPath query param required");
      const page = await resolveScopedPage(readSliceOnly, { wiki, relPath });
      if (!page.ok) return pageError(c, page);
      const again = c.req.query("again") === "1";
      if (!page.entry || !wikiTakesAnswers(page.entry.name, answerConfig())) {
        const empty = { block: "", rows: [], count: 0, orphanCount: 0 };
        const none = { block: "", rows: [], count: 0 };
        return c.json(again ? empty : { ...empty, again: none, orphanExport: none });
      }
      const name = page.entry.name;
      // ONE orphan scan per GET, whether or not the page has anything to copy:
      // the trailer and the reader's orphan button both report it. The reader
      // asks for the plain GET only, which carries the last batch as `again`
      // and the orphans' own block as `orphanExport` too.
      const orphans = await findOrphanAnswers(name, page.index, exportStore);
      const orphanCount = orphans.length;
      const owner = answerConfig().owner;
      let targets: Map<string, QuestionTarget[]> | null = null;
      const build = async (picked: ExportRow[], exportedAt: number) => {
        if (picked.length === 0) return { block: "", rows: [] as [string, number][], count: 0 };
        targets ??= await questionTargetsOf(page, owner);
        const answers = picked.map((a) => exportAnswerOf(a, targets!, answerConfig().groups ?? new Map()));
        return {
          block: formatAnswerExport({ wiki: name, relPath: page.meta.relPath, exportedAt, answers, orphanCount }),
          rows: picked.map((a) => [a.answerId, a.version] as [string, number]),
          count: picked.length,
        };
      };
      // Again: the page's last export batch, a redacted one shown as redacted,
      // stamped with that batch's own time.
      const lastBatch = async () => {
        const rows = await exportStore.listLastExported(name, page.meta.relPath);
        return build(rows, rows[0]?.exportedAt ?? Date.now());
      };
      if (again) return c.json({ ...(await lastBatch()), orphanCount });
      // New: the latest version of every answer that is still unexported AND not
      // redacted — the card's own `unexportedCount` rule, so the button's N and
      // this list agree. Stamped now; the reader restamps it at the click.
      const fresh = (await exportStore.listLatest(name, page.meta.relPath)).filter(
        (a) => a.exportedAt === null && a.redactedAt === null,
      );
      return c.json({
        ...(await build(fresh, Date.now())),
        orphanCount,
        again: await lastBatch(),
        orphanExport: orphanExportOf(name, orphans, Date.now()),
      });
    } catch (e) {
      log.error("answer export failed for {wiki}: {error}", { wiki, error: e instanceof Error ? e.message : String(e) });
      return c.json({ error: "export unavailable", code: "store_failed" }, 500);
    }
  });

  app.post(WIKI_ANSWERS_EXPORT_CONFIRM_PATH, answerBodyLimit, async (c) => {
    if (!isAdminViewer(c)) return err(c, 403, "admin_only", "only an admin may export answers");
    const notJson = requireJsonRequest(c);
    if (notJson) return notJson;
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return err(c, 400, "bad_request", "body is not JSON");
    }
    const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const wiki = typeof b.wiki === "string" ? b.wiki : undefined;
    const relPath = typeof b.relPath === "string" ? b.relPath : undefined;
    if (b.orphans === true) {
      if (!wiki) return err(c, 400, "bad_request", "wiki required");
      if (b.relPath !== undefined) return err(c, 400, "bad_request", "an orphan confirm names no relPath");
      const rows = parseConfirmRows(b.rows);
      if (!rows) {
        return err(c, 400, "bad_rows", `rows must be 1–${EXPORT_CONFIRM_MAX_ROWS} [answerId, version] pairs`);
      }
      return confirmOrphans(c, wiki, rows);
    }
    if (!wiki || !relPath) return err(c, 400, "bad_request", "wiki and relPath required");
    const rows = parseConfirmRows(b.rows);
    if (!rows) {
      return err(c, 400, "bad_rows", `rows must be 1–${EXPORT_CONFIRM_MAX_ROWS} [answerId, version] pairs`);
    }
    // The page resolves exactly as the GET resolved it, and only its rows are marked.
    const page = await resolveScopedPage(readSliceOnly, { wiki, relPath });
    if (!page.ok) return pageError(c, page);
    if (!page.entry || !wikiTakesAnswers(page.entry.name, answerConfig())) {
      return err(c, 403, "not_answerable", `wiki "${wiki}" does not take answers (WIKI_ANSWER_WIKIS)`);
    }
    try {
      return c.json({ marked: await exportStore.markExported(page.entry.name, page.meta.relPath, rows) });
    } catch (e) {
      log.error("answer export confirm failed: {error}", { error: e instanceof Error ? e.message : String(e) });
      return c.json({ error: "export not confirmed", code: "store_failed" }, 500);
    }
  });

  /** The orphan copy's confirm: marks only the listed rows that are, right
   *  now, the latest version of an orphan of this wiki — the orphan rule
   *  recomputed here, never the client's word — each on its own page. */
  async function confirmOrphans(c: Context, wiki: string, rows: [string, number][]) {
    const { entry, unknownWiki } = resolveReadRequest(readSliceOnly, wiki, undefined);
    if (unknownWiki || !entry) return err(c, 404, "no_page", "no wiki configured for that name");
    if (!wikiTakesAnswers(entry.name, answerConfig())) {
      return err(c, 403, "not_answerable", `wiki "${wiki}" does not take answers (WIKI_ANSWER_WIKIS)`);
    }
    const index = await getWikiIndex({ root: entry.root });
    if (!index) return err(c, 503, "wiki_unavailable", "wiki directory not found");
    try {
      const now = new Map(
        (await findOrphanAnswers(entry.name, index, exportStore)).map((o) => [`${o.answerId}:${o.version}`, o.relPath]),
      );
      const verified: [string, number, string][] = [];
      for (const [id, v] of rows) {
        const rel = now.get(`${id}:${v}`);
        if (rel !== undefined) verified.push([id, v, rel]);
      }
      return c.json({ marked: await exportStore.markOrphansExported(entry.name, verified) });
    } catch (e) {
      log.error("orphan export confirm failed: {error}", { error: e instanceof Error ? e.message : String(e) });
      return c.json({ error: "export not confirmed", code: "store_failed" }, 500);
    }
  }
}
