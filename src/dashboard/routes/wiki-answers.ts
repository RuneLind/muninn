/**
 * The `wiki-answers` route group: answers to a `<Question>` card on a wiki page
 * (answer cards PR 2).
 *
 *   GET  /api/wiki/answers?wiki=&relPath=[&versions=1]
 *   POST /api/wiki/answers  {wiki, relPath, questionId, choice?, body, answerId?, baseVersion?}
 *
 * Its own group so `MUNINN_PROFILE=nais` keeps it (D14) while it drops `wiki`.
 * Both routes resolve the page through the read slice's own ladder
 * (`resolveScopedPage`), so on the pod they serve read-only roots only. With
 * auth on, both paths are outside every user zone (`src/auth/zones.ts`), so
 * role `user` gets 403 until PR 5 opens them.
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
import { randomUUID } from "node:crypto";
import { resolveServingProfile, resolveWikiAnswerConfig, wikiTakesAnswers, type Config } from "../../config.ts";
import { servesWikiReadSliceOnly } from "../route-groups.ts";
import { resolveScopedPage } from "./wiki-read-scope.ts";
import { requireJsonRequest } from "./json-request.ts";
import { isValidUuid } from "./route-utils.ts";
import { readWikiPage, stripFrontmatter } from "../../wiki/store.ts";
import { parseBlocks } from "../../format/markdown-ast.ts";
import { parseQuestionPage, QUESTION_NOT_SURE } from "../../format/question.ts";
import { sha256 } from "../../gardener/util.ts";
import { sessionIdentity, sessionRole } from "../../auth/guard.ts";
import {
  getLatestWikiAnswerVersion,
  insertWikiAnswerVersion,
  listLatestWikiAnswers,
  listWikiAnswerVersions,
  WikiAnswerVersionConflict,
  type LatestWikiAnswer,
  type WikiAnswerAuthor,
  type WikiAnswerVersion,
} from "../../db/wiki-answers.ts";
import { getLog } from "../../logging.ts";

const log = getLog("dashboard", "wiki-answers");

/** An answer's body cap, in characters (code points — what Postgres
 *  `char_length` counts, and the table's CHECK). */
export const WIKI_ANSWER_BODY_MAX = 8000;

/** The store, injectable so the route's rules are testable without a database. */
export interface WikiAnswerStore {
  insert: typeof insertWikiAnswerVersion;
  getLatest: typeof getLatestWikiAnswerVersion;
  listLatest: typeof listLatestWikiAnswers;
  listVersions: typeof listWikiAnswerVersions;
}

const defaultStore: WikiAnswerStore = {
  insert: insertWikiAnswerVersion,
  getLatest: getLatestWikiAnswerVersion,
  listLatest: listLatestWikiAnswers,
  listVersions: listWikiAnswerVersions,
};

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
 *  and no owner is configured. */
function authorFor(c: Context, owner: string | null): WikiAnswerAuthor | null {
  const identity = sessionIdentity(c);
  if (identity) {
    return { userId: identity.userId, oid: identity.oid, navIdent: identity.navIdent, name: identity.displayName };
  }
  return owner ? { userId: null, oid: null, navIdent: null, name: owner } : null;
}

/** Did the viewer write this answer? With auth off every answer is the owner's. */
function isMine(c: Context, a: { author: WikiAnswerAuthor }): boolean {
  const identity = sessionIdentity(c);
  return identity === null || (a.author.userId !== null && a.author.userId === identity.userId);
}

const err = (c: Context, status: 400 | 403 | 404 | 409 | 503, code: string, error: string) =>
  c.json({ error, code }, status);

/** A NUL (Postgres refuses it in text) or an unpaired surrogate (stored as
 *  U+FFFD, the next character lost — measured on `"a\udc00b"`). */
function hasUnstorableText(s: string): boolean {
  return s.includes("\u0000") || !s.isWellFormed();
}

const versionConflict = (c: Context) =>
  err(c, 409, "version_conflict", "the answer changed while you were editing it — reload and try again");

/** A page-resolution failure: the 503 "wiki directory not found" has its own code. */
function pageError(c: Context, page: { status: 400 | 404 | 503; error: string }) {
  return err(c, page.status, page.status === 503 ? "wiki_unavailable" : "no_page", page.error);
}

export function registerWikiAnswerRoutes(app: Hono, config: Config, store: WikiAnswerStore = defaultStore): void {
  const profile = config.profile ?? resolveServingProfile();
  const readSliceOnly = servesWikiReadSliceOnly(profile);
  const answerConfig = () => config.wikiAnswers ?? resolveWikiAnswerConfig();

  app.get("/api/wiki/answers", async (c) => {
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

  app.post("/api/wiki/answers", async (c) => {
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
    const body = (b.body as string | undefined) ?? "";
    const choice = (b.choice as string | null | undefined) ?? null;
    const answerId = b.answerId as string | undefined;
    const baseVersion = b.baseVersion;
    if (answerId !== undefined && !(Number.isInteger(baseVersion) && (baseVersion as number) >= 1)) {
      return err(c, 400, "bad_base_version", "an edit needs baseVersion: the version it was made from");
    }
    if (answerId === undefined && baseVersion !== undefined) {
      return err(c, 400, "bad_base_version", "baseVersion belongs to an edit (answerId)");
    }
    if (hasUnstorableText(body) || (choice !== null && hasUnstorableText(choice))) {
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
    if (body.trim() === "" && choice === null) return err(c, 400, "empty_answer", "an answer needs a body or a choice");
    if ([...body].length > WIKI_ANSWER_BODY_MAX) {
      return err(c, 400, "body_too_long", `body is over ${WIKI_ANSWER_BODY_MAX} characters`);
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
      if (latest.redactedAt !== null) return err(c, 409, "answer_redacted", "this answer was redacted");
      if (baseVersion !== latest.version) return versionConflict(c);
      // Exactly base + 1: a writer that read the same base and got there first
      // holds this (answer_id, version), and the primary key refuses the second.
      id = answerId;
      version = (baseVersion as number) + 1;
    } else {
      id = randomUUID();
      version = 1;
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
      log.error("answer write failed for {wiki}/{relPath}: {error}", {
        wiki,
        relPath,
        error: e instanceof Error ? e.message : String(e),
      });
      return c.json({ error: "answer not saved", code: "store_failed" }, 500);
    }
  });
}
