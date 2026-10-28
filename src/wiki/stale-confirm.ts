/**
 * The Stale check's model half (plan muninn-wiki-drift-check, PR 2a): verdict
 * keys, the one model call, the confirm loop (D16) and Check (D6).
 *
 * - **Keys (D7, D22)** hash the verdict's validity inputs only, never
 *   commits or `asOf`; the rest of the prompt is evidence and stays out. A
 *   status line keys on the page, the window the model saw, its status words,
 *   the target, its `plan_status` and its own title. A passage keys on the
 *   linking page, its claim passages, the changed page, its content hash
 *   (body, `plan_status`, `status_note`, so a provenance stamp or `updated:`
 *   resets nothing) and own title, and the other linked plans with their
 *   `plan_status`. Both read the own title, never the stem-collision
 *   `displayTitle`. No `git log` runs to build a key.
 * - **The call (D17)** goes through the wiki's own bot
 *   (`resolveWikiSynthesisBot`) and its Haiku router (`callHaikuWithFallback`
 *   with the bot's connector and `haikuBackend`), tool-less, under a deadline
 *   that bounds the backend attempt AND the CLI fallback together.
 * - **The confirm loop (D16)** confirms new status-line hits on the wikis in
 *   `WIKI_STALE_CONFIRM_WIKIS`; a hit shows in the reader only once confirmed
 *   (D11).
 * - **Check (D6)** runs on request over a changed page's To-check linking
 *   pages, at most {@link CHECK_MAX_CALLS} calls a request.
 *
 * Rules and their measurements: `src/wiki/CLAUDE.md`, «Stale check».
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { callHaikuWithFallback } from "../ai/haiku-direct.ts";
import { extractJson } from "../ai/json-extract.ts";
import { discoverAllBots, resolveWikiSynthesisBot, type BotConfig } from "../bots/config.ts";
import type { MuninnProfile } from "../config.ts";
import {
  getStaleVerdicts,
  READER_CHECKED_BY,
  upsertStaleVerdict,
  type StaleEdit,
  type StaleVerdictInput,
  type StaleVerdictKind,
  type StaleVerdictRow,
  type StaleVerdictValue,
} from "../db/wiki-stale-verdicts.ts";
import { getLog } from "../logging.ts";
import { Tracer } from "../tracing/tracer.ts";
import { runProc } from "../utils/run-proc.ts";
import { splitFrontmatter } from "./page-text.ts";
import { isReadonlyWikiRoot, isWikiReadonly } from "./readonly.ts";
import { getWikiRegistry } from "./registry-memo.ts";
import type { WikiRegistryEntry } from "./registry.ts";
import { normalizeRelPath } from "./rel-path.ts";
import { extractWikilinks } from "./wikilinks.ts";
import { maskLineCodeSpans } from "../format/code-spans.ts";
import { lineLinks, linkingBuckets, type LinkingPage, type StatusLineHit } from "./stale.ts";
import { getWikiIndex, parseFrontmatter, type WikiIndex, type WikiPageMeta } from "./store.ts";

const log = getLog("wiki", "stale-confirm");

// ── Keys (D22) ─────────────────────────────────────────────────────────────

const sha = (parts: readonly string[]) => createHash("sha256").update(parts.join("\0")).digest("hex");

/** A changed page's content hash: its body, `plan_status` and `status_note`.
 *  Every other frontmatter key is left out by construction, the provenance
 *  keys (`PROVENANCE_FRONTMATTER_KEYS`) and `updated` among them. */
export function changedPageContentHash(content: string): string {
  const text = content.replace(/\r\n/g, "\n");
  const fm = parseFrontmatter(text);
  const field = (k: string) => (typeof fm[k] === "string" ? (fm[k] as string).trim() : "");
  return sha(["v1", splitFrontmatter(text).body, field("plan_status"), field("status_note")]);
}

/** The linked page's facts as the prompt carries them. */
type TargetFacts = StaleCallInput["target"];

/**
 * A status-line confirmation's key: the page, the hit's text (the window the
 * model saw), the status words it says, the target plan, its `plan_status`
 * (`hit.now`) and its own title (`meta.title`). The target's `status_note`
 * and `description` are prompt evidence, not key inputs; no commits, no
 * `asOf`, no line number.
 */
export function statusLineKeyHash(page: string, hit: Pick<StatusLineHit, "text" | "target" | "now" | "said">, target: TargetFacts): string {
  return sha(["status-line/v3", normalizeRelPath(page), hit.text, hit.said.join(","), normalizeRelPath(hit.target), hit.now, target.title]);
}

/** What a passage prompt carries besides the passage and the commit subjects. */
export interface PassageKeyContext {
  /** The changed page's facts as the prompt carries them. */
  target: TargetFacts;
  /** The page's own title, which the key reads instead of `target.title`. */
  keyTitle: string;
  otherPlans: NonNullable<StaleCallInput["otherPlans"]>;
}

/**
 * A passage verdict's key: the linking page, its passage, the changed page,
 * its content hash and its own title, and the other plans the passage links
 * to with their `plan_status`. The changed page's `description` and display
 * title, the other plans' `status_note`, the commit subjects and `asOf` are
 * prompt evidence, not key inputs (D7, D22).
 */
export function passageKeyHash(linkingPage: string, passage: string, changedHash: string, ctx: PassageKeyContext): string {
  const others = JSON.stringify(ctx.otherPlans.map((o) => [normalizeRelPath(o.relPath), o.planStatus]));
  return sha(["passage/v4", normalizeRelPath(linkingPage), passage, normalizeRelPath(ctx.target.relPath), changedHash, ctx.keyTitle, others]);
}

/** A status-line hit's key, its target facts read from the index. */
export function statusLineVerdictKey(index: Pick<WikiIndex, "resolveRelPath">, page: string, hit: StatusLineHit): string {
  const meta = index.resolveRelPath(hit.target);
  return statusLineKeyHash(page, hit, { ...targetFacts(meta, hit.target), title: ownTitle(meta, hit.target) });
}

/** The facts a To-check linking page's passage call carries on
 *  `changedRelPath`, read from the index; the commit subjects are read
 *  separately, by the call only. */
export function passageKeyContext(index: Pick<WikiIndex, "resolve" | "resolveRelPath">, changedRelPath: string, l: Pick<LinkingPage, "passages">): PassageKeyContext & { passage: string } {
  const passage = linkingPassage(l);
  const meta = index.resolveRelPath(changedRelPath);
  return {
    passage,
    target: targetFacts(meta, changedRelPath),
    keyTitle: ownTitle(meta, changedRelPath),
    otherPlans: otherPlansIn(index, passage, changedRelPath),
  };
}

/** A To-check linking page's passage verdict key: the same under any `asOf`. */
export function passageVerdictKey(index: Pick<WikiIndex, "resolve" | "resolveRelPath">, changedRelPath: string, changedHash: string, l: Pick<LinkingPage, "relPath" | "passages">): string {
  const ctx = passageKeyContext(index, changedRelPath, l);
  return passageKeyHash(l.relPath, ctx.passage, changedHash, ctx);
}

/** The passage lines a To-check linking page is judged on: those that make
 *  a claim, else all, in line order. */
export function linkingPassageRows(lp: Pick<LinkingPage, "passages">): LinkingPage["passages"] {
  const claims = lp.passages.filter((p) => p.claim !== undefined);
  return claims.length ? claims : lp.passages;
}

/** The passage a To-check linking page is judged on: its
 *  {@link linkingPassageRows}, joined by newlines. One verdict covers them. */
export function linkingPassage(lp: Pick<LinkingPage, "passages">): string {
  return linkingPassageRows(lp).map((p) => p.text).join("\n");
}

// ── The verdict store (a seam, so the routes run without a database) ───────

export interface StaleVerdictStore {
  get(wiki: string, kind: StaleVerdictKind, keys: readonly string[]): Promise<Map<string, StaleVerdictRow>>;
  upsert(v: StaleVerdictInput): Promise<StaleVerdictRow>;
}

export const dbStaleVerdictStore: StaleVerdictStore = { get: getStaleVerdicts, upsert: upsertStaleVerdict };

let activeStore: StaleVerdictStore = dbStaleVerdictStore;
export const staleVerdictStore = (): StaleVerdictStore => activeStore;
export function __setStaleVerdictStoreForTest(store: StaleVerdictStore | null): void {
  activeStore = store ?? dbStaleVerdictStore;
}

/** An in-memory store with the database's upsert semantics, for tests and the dry runs. */
export function memoryStaleVerdictStore(): StaleVerdictStore & { rows: Map<string, StaleVerdictRow> } {
  const rows = new Map<string, StaleVerdictRow>();
  const k = (wiki: string, kind: string, key: string) => `${wiki}\0${kind}\0${key}`;
  return {
    rows,
    async get(wiki, kind, keys) {
      const out = new Map<string, StaleVerdictRow>();
      for (const key of keys) {
        const r = rows.get(k(wiki, kind, key));
        if (r) out.set(key, r);
      }
      return out;
    },
    async upsert(v) {
      const prev = rows.get(k(v.wiki, v.kind, v.keyHash));
      if (prev?.checkedBy === READER_CHECKED_BY && v.checkedBy !== READER_CHECKED_BY) return prev;
      const row = { ...v, checkedAt: Date.now() };
      rows.set(k(v.wiki, v.kind, v.keyHash), row);
      return row;
    },
  };
}

// ── The model call (D17) ───────────────────────────────────────────────────

/** What one call is about. `commits` null: the change is uncommitted. */
export interface StaleCallInput {
  kind: "status-line" | "passage";
  /** The page the passage is on. */
  page: string;
  passage: string;
  /** The page the passage links to: the target plan, or the changed page. */
  target: { relPath: string; title: string; planStatus?: string; statusNote?: string; description?: string };
  /** For a status line: the status words the line says. */
  said?: readonly string[];
  /** Subjects of the target's commits since `page` last changed, newest first. */
  commits?: readonly string[] | null;
  /** For a passage: the other plans it links to, with their status today. */
  otherPlans?: readonly { relPath: string; planStatus: string; statusNote?: string }[];
  /** The full file line of each `\n`-separated passage row, undefined when
   *  unreadable: {@link parseStaleAnswer} checks `old` against it. Never in the prompt. */
  sourceLines?: readonly (string | undefined)[];
}

const PASSAGE_CAP = 2_000;
const NOTE_CAP = 600;
const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Wiki text in the prompt: a run of three `<` or `>` becomes `‹`/`›`, so
 *  no wiki text can close or forge the passage fence (A3). */
const defang = (s: string) => s.replace(/<{3,}/g, (m) => "‹".repeat(m.length)).replace(/>{3,}/g, (m) => "›".repeat(m.length));
/** A one-line wiki field (title, note, subject): defanged, its line breaks
 *  folded, so it cannot start a prompt line of its own. */
const oneLine = (s: string) => defang(s).replace(/\s*[\r\n]+\s*/g, " ");

/** The prompt for one call. Tool-less: everything the model needs is in it. */
export function buildStalePrompt(input: StaleCallInput): string {
  const t = input.target;
  const status = [
    t.planStatus ? `plan_status: ${oneLine(t.planStatus)}` : "plan_status: (none — not a plan)",
    t.statusNote ? `status_note: ${cap(oneLine(t.statusNote), NOTE_CAP)}` : "",
    t.description ? `description: ${cap(oneLine(t.description), NOTE_CAP)}` : "",
  ].filter(Boolean);
  const commits =
    input.commits === undefined
      ? []
      : input.commits === null
        ? ["The change to the linked page is uncommitted, so there are no commit subjects; judge from its current status above only."]
        : input.commits.length
          ? ["Subjects of the linked page's commits since the passage's page last changed, newest first:", ...input.commits.map((s) => `- ${oneLine(s)}`)]
          : ["The linked page has no commits since the passage's page last changed."];
  const others = input.otherPlans?.length
    ? ["", "Other plans the passage links to, with their status today:", ...input.otherPlans.map((o) => `- [[${oneLine(o.relPath)}]]: plan_status ${oneLine(o.planStatus)}${o.statusNote ? ` — ${cap(oneLine(o.statusNote), 300)}` : ""}`)]
    : [];
  const task =
    input.kind === "status-line"
      ? [
          `The passage links to the plan [[${t.relPath}]] and uses the status word(s) ${(input.said ?? []).map((s) => `«${s}»`).join(", ")} next to the link.`,
          "Decide whether the passage claims a status for THAT plan which its plan_status today contradicts.",
        ]
      : [
          `The passage links to [[${t.relPath}]], a page that changed after the passage's page was last edited.`,
          "Decide whether the passage is still true. It is stale when it states a status for a plan it links to that the plan's status today contradicts, or when it describes how the linked page's subject works (a process, a rule, a flow) and a commit subject above names a newer rule, step or change that the passage leaves out where a reader would act on it.",
          "A passage that only uses the linked page as background, or records a dated past event, stays true.",
        ];
  return [
    "You check a wiki for stale facts. Answer with ONE JSON object and nothing else.",
    "",
    `Wiki page: ${oneLine(input.page)}`,
    "Passage (verbatim):",
    "<<<",
    cap(defang(input.passage), PASSAGE_CAP),
    ">>>",
    "",
    `Linked page: [[${oneLine(t.relPath)}]] — ${oneLine(t.title)}`,
    ...status,
    ...(commits.length ? ["", ...commits] : []),
    ...others,
    "",
    ...task,
    "",
    "Verdicts:",
    '- "stale": the passage states a status or fact about the linked page that is no longer true.',
    '- "true": what the passage says about the linked page is still true (a dated record of a past event stays true).',
    '- "not-status": the status word is not about the linked page\'s status at all (it describes something else, e.g. «forslag om lås» is a proposed lock, «to Jira-utkast» are two draft issues).',
    '- "unsure": you cannot tell from what is here.',
    "",
    'Shape: {"verdict":"stale|true|not-status|unsure","reason":"one sentence","edit":null}',
    'When the verdict is "stale", set "edit" to {"old":"…","new":"…","home":"…"}: "old" is the shortest span copied VERBATIM from ONE line of the passage that holds the stale claim and occurs exactly once in the whole passage — when the same words appear again, on that line or another, copy more of the line until the span is unique. «…» marks text cut from a line or a gap inside it: never copy «…» into "old", and never let "old" cross a line break, cut into a link or sit inside one. "new" replaces it with the current fact, and "home" replaces it with text that drops the copied status but keeps every link, so the linked page stays the one place the status lives. Write "new" and "home" in the passage\'s language, one line each, at most 400 characters.',
    '"new" may restate only facts stated above: the linked page\'s plan_status, status_note and description, the commit subjects and the other plans\' status. Never add a date, number, name, PR or outcome that is not stated above. A commit subject names a change, not how it works: never say how, when or by whom something happens beyond the subject\'s own words. When the inputs do not say what the current fact is, make "new" the same as "home".',
  ].join("\n");
}

export interface StaleAnswer {
  verdict: Exclude<StaleVerdictValue, "fixed">;
  reason: string;
  edit: StaleEdit | null;
}

const MODEL_VERDICTS = ["stale", "unsure", "true", "not-status"] as const;
const REASON_CAP = 500;
/** An edit's `new` or `home` is at most this long (the prompt says 400 too). */
export const EDIT_TEXT_CAP = 400;

const occurrences = (hay: string, needle: string) => {
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) n++;
  return n;
};
const fitsEdit = (s: string) => s.length <= EDIT_TEXT_CAP && !/[\r\n]/.test(s);
/** The links a text holds as written: each whole `[[…]]` (an embed's `!`
 *  included) or `[text](url)` source span, read as `lineLinks` reads a line. */
const linksIn = (s: string) => lineLinks(maskLineCodeSpans(s)).map((l) => s.slice(l.start, l.end));
/** Does `home` hold every link `old` holds, as written and as often? */
function keepsLinks(old: string, home: string): boolean {
  const have = new Map<string, number>();
  for (const l of linksIn(home)) have.set(l, (have.get(l) ?? 0) + 1);
  for (const l of linksIn(old)) {
    const n = have.get(l) ?? 0;
    if (n === 0) return false;
    have.set(l, n - 1);
  }
  return true;
}
/** Does `at`–`at + len` on `text` cut into a link, or lie inside one? A
 *  replacement there would break the link or retarget it. */
const cutsLink = (text: string, at: number, len: number) =>
  lineLinks(maskLineCodeSpans(text)).some((l) => l.start < at + len && l.end > at && !(at <= l.start && l.end <= at + len));
/** Does `old`, its whole links blanked, still hold a piece of one (`[[`,
 *  `]]`, `](`)? A window's cut end can hide the rest of the link. */
function holdsLinkPiece(old: string): boolean {
  let m = maskLineCodeSpans(old);
  for (const l of lineLinks(m)) m = m.slice(0, l.start) + " ".repeat(l.end - l.start) + m.slice(l.end);
  return /\[\[|\]\]|\]\(/.test(m);
}

/** Where `old` sits in the passage: the one row and piece that hold it,
 *  or null unless it occurs exactly once across every row's pieces. */
function placeOld(passage: string, old: string): { row: number; piece: string; at: number } | null {
  let found: { row: number; piece: string; at: number } | null = null;
  let n = 0;
  passage.split("\n").forEach((r, row) => {
    for (const piece of r.split("…")) for (let at = piece.indexOf(old); at >= 0; at = piece.indexOf(old, at + 1)) (n++, (found = { row, piece, at }));
  });
  return n === 1 ? found : null;
}

/** An answer that names no known verdict (A4): the call failed, so nothing
 *  is cached and the next run or Check asks again. */
export class StaleAnswerUnreadableError extends Error {
  constructor() {
    super("the model's answer could not be read");
    this.name = "StaleAnswerUnreadableError";
  }
}

/** A JSON object whose last key was cut after its opening quote
 *  (`…,"edit":null,"` or `…,"}`), the shape a real answer on kode
 *  `repos/melosys-e2e-tests.md:128` had (A4): the dangling key dropped and
 *  the open braces closed. Null for any other text. */
export function repairDanglingKey(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const m = /,\s*"\s*\}*\s*$/.exec(t);
  if (!m || !t.startsWith("{")) return null;
  const head = t.slice(0, m.index);
  let depth = 0;
  let inString = false;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  if (inString || depth < 1) return null;
  try {
    return JSON.parse(head + "}".repeat(depth));
  } catch {
    return null;
  }
}

/**
 * The model's answer, validated strictly: an unreadable answer or one with
 * no known verdict throws {@link StaleAnswerUnreadableError} (A4), after one
 * repair ({@link repairDanglingKey}). An edit survives only on a stale verdict (else it is
 * dropped and the verdict kept), and only when (A3, A17, fix round 2):
 * `old` occurs exactly once across the passage's source pieces — its
 * `\n`-joined rows, each cut at a window's `…` (a status-line hit and a long
 * passage line are both windows) — the rule the prompt states; it neither
 * cuts into nor lies inside a link; given `sourceLines` (each row's full
 * file line), it occurs exactly once on its row's full line too, so PR 3's
 * Apply finds one line and one position; `new` is one line of at most
 * {@link EDIT_TEXT_CAP} characters and differs from `old`. `home` is kept
 * only when it fits the same bound, differs from `old` and holds every link
 * `old` holds as written (alias, anchor, title, embed `!`), as often.
 */
export function parseStaleAnswer(raw: string, passage: string, sourceLines?: readonly (string | undefined)[]): StaleAnswer {
  const verdictOf = (x: unknown) => {
    const v = x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>).verdict : undefined;
    const t = typeof v === "string" ? v.trim().toLowerCase() : "";
    return (MODEL_VERDICTS as readonly string[]).includes(t) ? (t as StaleAnswer["verdict"]) : null;
  };
  let parsed: unknown;
  try {
    parsed = extractJson<unknown>(raw);
  } catch {
    parsed = null;
  }
  // A cut outer object leaves extractJson an inner one (the edit), so the
  // repair runs whenever no verdict was read.
  if (!verdictOf(parsed)) parsed = repairDanglingKey(raw);
  const verdict = verdictOf(parsed);
  if (!verdict) throw new StaleAnswerUnreadableError();
  const obj = parsed as Record<string, unknown>;
  const reason = typeof obj.reason === "string" ? cap(obj.reason.trim().replace(/\s+/g, " "), REASON_CAP) : "";
  let edit: StaleEdit | null = null;
  const e = obj.edit as Record<string, unknown> | null | undefined;
  if (verdict === "stale" && e && typeof e === "object" && typeof e.old === "string" && typeof e.new === "string") {
    const old = e.old;
    const at = old.trim() ? placeOld(passage, old) : null;
    let placed = !!at && !cutsLink(at.piece, at.at, old.length) && !holdsLinkPiece(old);
    if (placed && sourceLines) {
      const full = sourceLines[at!.row];
      placed = typeof full === "string" && occurrences(full, old) === 1 && !cutsLink(full, full.indexOf(old), old.length);
    }
    if (placed && fitsEdit(e.new) && e.new !== old) {
      const home = e.home;
      const homeOk = typeof home === "string" && home !== old && fitsEdit(home) && keepsLinks(old, home);
      edit = { old, new: e.new, ...(homeOk ? { home } : {}) };
    }
  }
  return { verdict, reason, edit };
}

/** One model call: the prompt in, the model's raw text out. `deadlineAt`
 *  bounds the whole call, its CLI fallback included. */
export type StaleModel = (prompt: string, ctx: { bot: BotConfig; deadlineAt: number; source: string; tracer?: Tracer }) => Promise<string>;

/**
 * The real call: the bot's Haiku router, tool-less, under `deadlineAt`
 * (`HaikuRouterOptions.deadlineAt`). The router gives a backend attempt at
 * most half the time left, aborted at that point, and the CLI what remains,
 * all of it when no backend runs. A race on `deadlineAt` bounds the await.
 */
export const routedStaleModel: StaleModel = async (prompt, { bot, deadlineAt, source, tracer }) => {
  const left = deadlineAt - Date.now();
  if (left <= 1_000) throw new Error("no time left in this run for a model call");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = callHaikuWithFallback(prompt, {
    source,
    entrypoint: `${bot.name}-${source}`,
    botName: bot.name,
    connector: bot.connector,
    haikuBackend: bot.haikuBackend,
    timeoutMs: left,
    deadlineAt,
    ...(tracer ? { tracer } : {}),
  });
  call.catch(() => {});
  try {
    const res = await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`model call passed its deadline (${left} ms)`)), left);
      }),
    ]);
    return res.result;
  } finally {
    clearTimeout(timer);
  }
};

let activeModel: StaleModel = routedStaleModel;
export const staleModel = (): StaleModel => activeModel;
export function __setStaleModelForTest(model: StaleModel | null): void {
  activeModel = model ?? routedStaleModel;
}

/** At most this many commit subjects go into one call. */
const COMMIT_SUBJECTS_MAX = 20;
/** The one bounded `git log -- <page>`. */
export const COMMIT_SUBJECTS_TIMEOUT_MS = 5_000;

/** Commits read before the date filter: `--since` reads the committer date,
 *  and the index dates a page by its author date (`%at`), so the filter is ours. */
const COMMIT_SCAN_MAX = 200;

/** Subjects of `relPath`'s commits authored after `sinceMs` and at or before
 *  `untilMs`, newest first, at most {@link COMMIT_SUBJECTS_MAX}; null when git
 *  is unavailable or the call fails (the prompt then carries no section). */
export async function commitSubjectsSince(root: string, relPath: string, sinceMs: number | undefined, untilMs?: number, memo?: SubjectsMemo): Promise<string[] | null> {
  const memoKey = `${root}\0${relPath}`;
  let log = memo?.get(memoKey);
  if (!log) {
    log = readCommitLog(root, relPath);
    memo?.set(memoKey, log);
  }
  const all = await log;
  if (all === null) return null;
  const out: string[] = [];
  for (const c of all) {
    if ((sinceMs !== undefined && c.ms <= sinceMs) || (untilMs !== undefined && c.ms > untilMs)) continue;
    out.push(c.subject);
    if (out.length >= COMMIT_SUBJECTS_MAX) break;
  }
  return out;
}

/** One request's `git log` reads, by root and page: Check reads the changed
 *  page's log once for all its calls. */
export type SubjectsMemo = Map<string, Promise<{ ms: number; subject: string }[] | null>>;

async function readCommitLog(root: string, relPath: string): Promise<{ ms: number; subject: string }[] | null> {
  const args = ["git", "-C", root, "log", `--max-count=${COMMIT_SCAN_MAX}`, "--format=%at %s", "--", relPath];
  try {
    const r = await runProc(args, COMMIT_SUBJECTS_TIMEOUT_MS, "stale-commit-subjects", { quietTimeout: true });
    if (r.exitCode !== 0) return null;
    const out: { ms: number; subject: string }[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = /^(\d+) (.*)$/.exec(line.trim());
      if (m) out.push({ ms: Number(m[1]) * 1000, subject: m[2]!.trim() });
    }
    return out;
  } catch {
    return null;
  }
}

/** A page's own title for a key: its frontmatter/H1 title, never `displayTitle`. */
const ownTitle = (meta: WikiPageMeta | undefined, relPath: string) => meta?.title ?? relPath;

const targetFacts = (meta: WikiPageMeta | undefined, relPath: string): StaleCallInput["target"] => ({
  relPath: meta?.relPath ?? relPath,
  title: meta?.displayTitle ?? meta?.title ?? relPath,
  ...(meta?.plan_status ? { planStatus: meta.plan_status } : {}),
  ...(meta?.status_note ? { statusNote: meta.status_note } : {}),
  ...(meta?.description ? { description: meta.description } : {}),
});

/** The commits a call carries about `target`: null while it has uncommitted
 *  edits (D29: they are its last change, and no subject describes them; A14),
 *  else the subjects between `sinceMs` and `untilMs`. Check passes no
 *  `untilMs`: `asOf` scopes only its window, never the prompt's evidence. */
export async function commitsFor(index: Pick<WikiIndex, "root">, target: WikiPageMeta | undefined, sinceMs: number | undefined, untilMs?: number, memo?: SubjectsMemo) {
  if (!target) return undefined;
  if (untilMs === undefined && target.gitDirty === true) return null;
  return (await commitSubjectsSince(index.root, target.relPath, sinceMs, untilMs, memo)) ?? undefined;
}

/** The plans a passage links to other than `exclude`, with their status, at most 5. */
export function otherPlansIn(index: Pick<WikiIndex, "resolve">, passage: string, exclude: string): NonNullable<StaleCallInput["otherPlans"]> {
  const out: { relPath: string; planStatus: string; statusNote?: string }[] = [];
  const seen = new Set([normalizeRelPath(exclude)]);
  for (const t of extractWikilinks(passage)) {
    const m = index.resolve(t);
    if (!m?.plan_status || seen.has(normalizeRelPath(m.relPath))) continue;
    seen.add(normalizeRelPath(m.relPath));
    out.push({ relPath: m.relPath, planStatus: m.plan_status, ...(m.status_note ? { statusNote: m.status_note } : {}) });
    if (out.length >= 5) break;
  }
  return out;
}

/** The full file lines `lines` (1-based) of `relPath`, CRLF folded as the
 *  index counts them; each undefined when the page cannot be read. */
export async function sourceLinesOf(root: string, relPath: string, lines: readonly number[]): Promise<(string | undefined)[]> {
  let all: string[] = [];
  try {
    all = (await Bun.file(path.join(root, relPath)).text()).replace(/\r\n/g, "\n").split("\n");
  } catch {
    // Unreadable: every line undefined, so no edit survives.
  }
  return lines.map((n) => all[n - 1]);
}

/** The call input for a status-line hit. */
export async function statusLineCallInput(index: WikiIndex, page: WikiPageMeta, hit: StatusLineHit): Promise<StaleCallInput> {
  const target = index.resolveRelPath(hit.target);
  return {
    kind: "status-line",
    page: page.relPath,
    passage: hit.text,
    target: targetFacts(target, hit.target),
    said: hit.said,
    commits: await commitsFor(index, target, page.gitTouchedMs ?? page.workedMs),
    sourceLines: await sourceLinesOf(index.root, page.relPath, [hit.line]),
  };
}

// ── The confirm loop (D16) ─────────────────────────────────────────────────

/** A run ends within this long: the index rebuilds, the store and every call
 *  race one timer, and every call's deadline is at most the run's. */
export const CONFIRM_RUN_BUDGET_MS = 4 * 60_000;
/** No call starts this long after a run began. */
export const CONFIRM_START_CUTOFF_MS = 3 * 60_000;
/** One call's deadline is at most this far out, so a hung backend leaves the
 *  rest of the run to the other hits. Real calls took 2.4–8.2 s (PR 2a stop
 *  trigger, 11 calls). */
export const CONFIRM_CALL_MAX_MS = 60_000;
/** A run makes at most this many calls, failed ones included; the rest wait for the next run. */
export const CONFIRM_MAX_CALLS = 20;
/** The next run starts this long after the previous one ended. */
export const CONFIRM_INTERVAL_MS = 5 * 60_000;
/** One wiki's index rebuild races at most this long, so a hung rebuild costs
 *  the run this much and the next wiki still rebuilds. */
export const CONFIRM_REBUILD_MAX_MS = 60_000;
/** A key that failed this many times in a row waits before its next call. */
export const CONFIRM_BACKOFF_AFTER = 2;
/** The longest a failing key waits between calls. */
export const CONFIRM_BACKOFF_CAP_MS = 6 * 60 * 60_000;

/** How long a key waits after its `count`-th failure in a row: none after the
 *  first (a blip is retried next run), then 10, 20, 40 … minutes, at most 6 h. */
export function confirmBackoffMs(count: number): number {
  if (count < CONFIRM_BACKOFF_AFTER) return 0;
  return Math.min(CONFIRM_INTERVAL_MS * 2 ** (count - 1), CONFIRM_BACKOFF_CAP_MS);
}

/** A key's failures in a row and when the last one came. */
export interface FailureMark {
  count: number;
  at: number;
}

/** Record one more failure of `key` at `now`; returns the count in a row. */
function markFailure(failures: Map<string, FailureMark>, key: string, now: number): number {
  const count = (failures.get(key)?.count ?? 0) + 1;
  failures.set(key, { count, at: now });
  return count;
}

/** Is `key` inside its backoff at `now`? */
const inBackoff = (m: FailureMark | undefined, now: number) => m !== undefined && now - m.at < confirmBackoffMs(m.count);
/** The first run comes this long after boot. */
export const CONFIRM_FIRST_DELAY_MS = 60_000;

export interface ConfirmLimits {
  budgetMs: number;
  startCutoffMs: number;
  callMaxMs: number;
  maxCalls: number;
  rebuildMaxMs: number;
}

const CONFIRM_LIMITS: ConfirmLimits = {
  budgetMs: CONFIRM_RUN_BUDGET_MS,
  startCutoffMs: CONFIRM_START_CUTOFF_MS,
  callMaxMs: CONFIRM_CALL_MAX_MS,
  maxCalls: CONFIRM_MAX_CALLS,
  rebuildMaxMs: CONFIRM_REBUILD_MAX_MS,
};

/** Each key's failures in a row, dropped a day after the last: a run skips a
 *  key inside its backoff ({@link confirmBackoffMs}), calls never-failed hits
 *  first, then failed ones oldest failure first (A6). */
const confirmFailures = new Map<string, FailureMark>();
const FAILURE_MEMORY_MS = 24 * 60 * 60_000;
/** When each wiki's index rebuild last failed (timed out or threw), by
 *  lowercased name: a run rebuilds those wikis last, oldest failure first. */
const rebuildFailures = new Map<string, number>();

export interface ConfirmDeps {
  registry: () => WikiRegistryEntry[];
  bots: () => BotConfig[];
  index: (root: string) => Promise<WikiIndex | null>;
  store: () => StaleVerdictStore;
  model: () => StaleModel;
  now: () => number;
  /** One span per run that made a call; tests capture the attributes. */
  span: (attrs: Record<string, unknown>, tracer: Tracer | null) => void;
  /** The run's tracer, for the calls' `haiku_usage` join. Null in tests. */
  tracer: () => Tracer | null;
  /** Key → its failures in a row. Defaults to the process's own map. */
  failures?: Map<string, FailureMark>;
  /** Wiki → when its rebuild last failed. Defaults to the process's own map. */
  rebuildFailures?: Map<string, number>;
  /** Overrides of the run's limits; tests shrink them. */
  limits?: Partial<ConfirmLimits>;
}

const realConfirmDeps: ConfirmDeps = {
  registry: getWikiRegistry,
  bots: discoverAllBots,
  index: (root) => getWikiIndex({ root, refresh: true }),
  store: staleVerdictStore,
  model: staleModel,
  now: Date.now,
  span: (attrs, tracer) => tracer?.finish(attrs.errors ? "error" : "ok", attrs),
  tracer: () => new Tracer("wiki_stale_confirm", { platform: "scheduler" }),
};

export interface ConfirmRunSummary {
  /** `backoff`: hits not called because their key is inside its backoff. */
  wikis: { wiki: string; skipped?: string; hits: number; cached: number; calls: number; stale: number; errors: number; left: number; backoff: number }[];
  calls: number;
  errors: number;
  left: number;
  elapsedMs: number;
}

class ConfirmTimeout extends Error {}
/** The loop was stopped (A8): the run starts nothing more and writes nothing more. */
class ConfirmStopped extends Error {}

/** The loop's verdict writes in flight, an abandoned one included, so shutdown
 *  can wait for them before the pool closes (A8). A direct run (no `signal`) is not the loop's. */
const pendingWrites = new Set<Promise<unknown>>();
function trackWrite<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  const done = () => void pendingWrites.delete(p);
  p.then(done, done);
  return p;
}

/** `p`, or a rejection after `ms`; the timer is cleared either way. */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => (t = setTimeout(() => reject(new ConfirmTimeout(what)), Math.max(0, ms))))]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * One confirm run over the named wikis: rebuild each index once (each within
 * {@link CONFIRM_REBUILD_MAX_MS}; wikis whose rebuild failed last), then
 * confirm the status-line hits with no verdict yet across all of them, keys
 * inside their backoff left out, never-failed hits first, at most
 * {@link CONFIRM_MAX_CALLS} calls, none started after
 * {@link CONFIRM_START_CUTOFF_MS}, each call's deadline at most
 * {@link CONFIRM_CALL_MAX_MS} out. The rebuilds, the store and the calls all
 * race the run's {@link CONFIRM_RUN_BUDGET_MS}, so the run returns within it.
 * A failed call writes nothing, so a later run retries it once its backoff
 * ({@link confirmBackoffMs}) is over. Never rejects.
 * Once `signal` aborts (the loop's stop, A8) no rebuild, call or write starts,
 * and every await the run is in rejects except a verdict write already sent:
 * the run waits for that one (within its bound) and counts it. A run that
 * built a tracer finishes it on every way out.
 */
export async function runStaleConfirm(wikiNames: readonly string[], deps: ConfirmDeps = realConfirmDeps, signal?: AbortSignal): Promise<ConfirmRunSummary> {
  const lim = { ...CONFIRM_LIMITS, ...deps.limits };
  const failures = deps.failures ?? confirmFailures;
  const rebuildFailed = deps.rebuildFailures ?? rebuildFailures;
  const started = deps.now();
  const deadlineAt = started + lim.budgetMs;
  // Real time, whatever `deps.now` says: this is the bound the run returns within.
  const endsAt = Date.now() + lim.budgetMs;
  const stoppedRace = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new ConfirmStopped());
    else signal?.addEventListener("abort", () => reject(new ConfirmStopped()), { once: true });
  });
  stoppedRace.catch(() => {});
  const inBudget = <T>(p: Promise<T>, what: string) => within(p, endsAt - Date.now(), `${what}: the run passed its ${lim.budgetMs} ms bound`);
  const bounded = <T>(p: Promise<T>, what: string) => {
    if (signal?.aborted) return Promise.reject(new ConfirmStopped());
    return Promise.race([inBudget(p, what), stoppedRace]);
  };
  const out: ConfirmRunSummary = { wikis: [], calls: 0, errors: 0, left: 0, elapsedMs: 0 };
  /** Calls sent whose answer stop dropped: not counted as calls, but on the trace. */
  let stopped = 0;
  let tracer: Tracer | null = null;
  const tracerOnce = () => (tracer ??= deps.tracer());
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
  for (const [k, m] of failures) if (started - m.at > FAILURE_MEMORY_MS) failures.delete(k);

  type Row = ConfirmRunSummary["wikis"][number];
  const todo: { row: Row; entry: WikiRegistryEntry; index: WikiIndex; bot: BotConfig; page: WikiPageMeta; hit: StatusLineHit; key: string }[] = [];
  const wanted = new Set(wikiNames.map((n) => n.toLowerCase()));
  // Wikis whose rebuild last failed go last, oldest failure first (stable sort),
  // so a wiki that keeps hanging costs each run one bounded rebuild, after the rest.
  const entries = deps
    .registry()
    .filter((e) => wanted.has(e.name.toLowerCase()))
    .sort((a, b) => (rebuildFailed.get(a.name.toLowerCase()) ?? 0) - (rebuildFailed.get(b.name.toLowerCase()) ?? 0));
  for (const entry of entries) {
    if (signal?.aborted) break;
    const row: Row = { wiki: entry.name, hits: 0, cached: 0, calls: 0, stale: 0, errors: 0, left: 0, backoff: 0 };
    out.wikis.push(row);
    let rebuilding = false;
    try {
      if (isReadonlyWikiRoot(entry.root)) {
        row.skipped = "readonly root";
        continue;
      }
      rebuilding = true;
      const index = await bounded(
        within(deps.index(entry.root), Math.min(lim.rebuildMaxMs, endsAt - Date.now()), `index rebuild of ${entry.name} passed its ${lim.rebuildMaxMs} ms bound`),
        `index rebuild of ${entry.name}`,
      );
      rebuilding = false;
      rebuildFailed.delete(entry.name.toLowerCase());
      if (!index) {
        row.skipped = "no index";
        continue;
      }
      if (!index.pages.some((p) => p.plan_status)) {
        row.skipped = "no plan_status page";
        continue;
      }
      const { bot } = resolveWikiSynthesisBot(entry, deps.bots());
      if (!bot) {
        row.skipped = "no routing bot";
        continue;
      }
      const mine: typeof todo = [];
      for (const [rel, hits] of index.statusLineHits ?? []) {
        const page = index.resolveRelPath(rel);
        if (!page) continue;
        for (const hit of hits) mine.push({ row, entry, index, bot, page, hit, key: statusLineVerdictKey(index, page.relPath, hit) });
      }
      row.hits = mine.length;
      const cached = await bounded(deps.store().get(entry.name, "status-line", mine.map((t) => t.key)), `verdict read for ${entry.name}`);
      for (const t of mine) {
        if (cached.has(t.key)) row.cached++;
        else if (inBackoff(failures.get(t.key), started)) row.backoff++;
        else todo.push(t);
      }
    } catch (err) {
      if (err instanceof ConfirmStopped) break;
      if (rebuilding) rebuildFailed.set(entry.name.toLowerCase(), started);
      row.errors++;
      log.warn("Stale confirm: wiki {wiki} failed: {error}", { wiki: entry.name, error: errText(err) });
    }
  }

  // Never-failed hits keep their order; failed ones follow, oldest failure first (stable sort).
  todo.sort((a, b) => (failures.get(a.key)?.at ?? 0) - (failures.get(b.key)?.at ?? 0));
  for (const t of todo) {
    const { row } = t;
    if (signal?.aborted || out.calls >= lim.maxCalls || deps.now() - started >= lim.startCutoffMs || Date.now() >= endsAt) {
      row.left++;
      continue;
    }
    out.calls++;
    row.calls++;
    let sent = false;
    try {
      const input = await bounded(statusLineCallInput(t.index, t.page, t.hit), "call input");
      const callDeadline = Math.min(deadlineAt, deps.now() + lim.callMaxMs);
      sent = true;
      const raw = await bounded(
        within(
          deps.model()(buildStalePrompt(input), {
            bot: t.bot,
            deadlineAt: callDeadline,
            source: "wiki_stale_confirm",
            ...(tracerOnce() ? { tracer: tracerOnce()! } : {}),
          }),
          callDeadline - deps.now(),
          `the call passed its ${lim.callMaxMs} ms bound`,
        ),
        "model call",
      );
      const answer = parseStaleAnswer(raw, input.passage, input.sourceLines);
      // An answer that resolved as the loop stopped is dropped, not written.
      if (signal?.aborted) throw new ConfirmStopped();
      // A write once sent is waited for through a stop, so it is counted as it
      // lands; only the run's bound abandons it, and shutdown still waits (A8).
      const stored = await inBudget(
        (signal ? trackWrite : <T>(p: Promise<T>) => p)(deps.store().upsert({
          wiki: t.entry.name,
          kind: "status-line",
          page: t.page.relPath,
          keyHash: t.key,
          verdict: answer.verdict,
          reason: answer.reason,
          edit: answer.edit,
          checkedBy: `model:${t.bot.name}`,
        })),
        "verdict write",
      );
      failures.delete(t.key);
      if (stored.verdict === "stale") row.stale++;
    } catch (err) {
      // Stopped mid-call: the answer is dropped and the hit waits for the next run, not counted as failed.
      if (err instanceof ConfirmStopped) {
        out.calls--;
        row.calls--;
        row.left++;
        if (sent) stopped++;
        continue;
      }
      row.errors++;
      const count = markFailure(failures, t.key, deps.now());
      log.warn("Stale confirm: call for {page}:{line} failed ({count} in a row, next try in {waitMs} ms or later): {error}", {
        wiki: t.entry.name,
        page: t.page.relPath,
        line: t.hit.line,
        count,
        waitMs: confirmBackoffMs(count),
        error: errText(err),
      });
    }
  }
  for (const row of out.wikis) {
    out.errors += row.errors;
    out.left += row.left;
  }
  out.elapsedMs = deps.now() - started;
  // The tracer is built as the first call is sent and inserts its root span at
  // once: a run whose only calls stop cut still finishes it.
  if (out.calls > 0 || out.errors > 0 || stopped > 0) {
    deps.span({ calls: out.calls, errors: out.errors, left: out.left, stopped, elapsedMs: out.elapsedMs, wikis: out.wikis }, tracerOnce());
    log.info("Stale confirm: {calls} call(s), {errors} error(s), {left} left for the next run, {elapsedMs} ms", {
      calls: out.calls,
      errors: out.errors,
      left: out.left,
      elapsedMs: out.elapsedMs,
    });
  }
  return out;
}

/** What the loop can cover of `wikiNames` (A13): the registered wikis with a
 *  writable root and a routing bot, and the names it cannot cover, by reason. */
export function confirmLoopCoverage(
  wikiNames: readonly string[],
  registry: readonly WikiRegistryEntry[],
  bots: BotConfig[],
): { wikis: string[]; unknown: string[]; readonly: string[]; noBot: string[] } {
  const byName = new Map(registry.map((e) => [e.name.toLowerCase(), e]));
  const out = { wikis: [] as string[], unknown: [] as string[], readonly: [] as string[], noBot: [] as string[] };
  const seen = new Set<string>();
  for (const name of wikiNames) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const entry = byName.get(name.toLowerCase());
    if (!entry) out.unknown.push(name);
    else if (isReadonlyWikiRoot(entry.root)) out.readonly.push(entry.name);
    else if (!resolveWikiSynthesisBot(entry, bots).bot) out.noBot.push(entry.name);
    else out.wikis.push(entry.name);
  }
  return out;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<unknown> | null = null;
let runAbort: AbortController | null = null;
let stopped = true;
/** Bumped by every start and stop: a chain whose generation is past schedules nothing (A8). */
let generation = 0;

/**
 * Start the loop (D16) when the scheduler runs, the instance is not readonly,
 * the profile is not `nais` (it drops the tool half) and `wikiNames` names a
 * wiki the loop can cover; returns the covered wikis, or [] when it did not
 * start. A second start while the loop runs is a no-op. Each name it cannot
 * cover logs one warning (A13). The next run is scheduled when the previous
 * one ends, so runs never overlap; holds no bot's scheduler tick.
 */
export function startStaleConfirmLoop(
  config: { schedulerEnabled: boolean; wikiStaleConfirmWikis: readonly string[]; profile: MuninnProfile },
  opts: { deps?: ConfirmDeps; firstDelayMs?: number; intervalMs?: number } = {},
): string[] {
  if (!stopped || config.wikiStaleConfirmWikis.length === 0) return [];
  const listed = config.wikiStaleConfirmWikis.join(",");
  if (config.profile === "nais") {
    log.warn("Stale confirm loop off: MUNINN_PROFILE=nais drops the tool half (WIKI_STALE_CONFIRM_WIKIS={wikis})", { wikis: listed });
    return [];
  }
  if (!config.schedulerEnabled || isWikiReadonly()) {
    log.info("Stale confirm loop off: {why} (WIKI_STALE_CONFIRM_WIKIS={wikis})", { why: config.schedulerEnabled ? "the instance is readonly" : "SCHEDULER_ENABLED is off", wikis: listed });
    return [];
  }
  const deps = opts.deps ?? realConfirmDeps;
  const cover = confirmLoopCoverage(config.wikiStaleConfirmWikis, deps.registry(), deps.bots());
  for (const wiki of cover.unknown) log.warn("Stale confirm: WIKI_STALE_CONFIRM_WIKIS names {wiki}, which is not a registered wiki — skipped", { wiki });
  for (const wiki of cover.readonly) log.warn("Stale confirm: {wiki} has a readonly root (WIKI_READONLY_ROOTS) — skipped", { wiki });
  for (const wiki of cover.noBot) log.warn("Stale confirm: {wiki} has no routing bot (synthesisBot, owner or research bot) — skipped", { wiki });
  const wikis = cover.wikis;
  if (wikis.length === 0) return [];
  stopped = false;
  const gen = ++generation;
  const live = () => !stopped && gen === generation;
  const schedule = (ms: number) => {
    if (!live()) return;
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  const tick = () => {
    timer = null;
    if (!live()) return;
    if (running) {
      log.warn("Stale confirm skipped: the previous run is still in flight");
      return schedule(opts.intervalMs ?? CONFIRM_INTERVAL_MS);
    }
    const ac = new AbortController();
    runAbort = ac;
    const run = runStaleConfirm(wikis, deps, ac.signal).finally(() => {
      if (running === run) running = null;
      if (runAbort === ac) runAbort = null;
      schedule(opts.intervalMs ?? CONFIRM_INTERVAL_MS);
    });
    running = run;
  };
  schedule(opts.firstDelayMs ?? CONFIRM_FIRST_DELAY_MS);
  return wikis;
}

/**
 * Stop the loop (A8): no run or call starts after this, a run in flight is
 * aborted (its pending await rejects; a model call already sent is not
 * cancelled, its answer is dropped; a verdict write already sent is waited
 * for), and the returned promise waits at most `waitMs` for that run and for
 * the verdict writes a run's bound abandoned, so they land before the
 * database pool closes.
 */
export async function stopStaleConfirmLoop(waitMs = 5_000): Promise<void> {
  stopped = true;
  generation++;
  if (timer) clearTimeout(timer);
  timer = null;
  runAbort?.abort();
  const settle = [...(running ? [running] : []), ...pendingWrites];
  if (settle.length === 0) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    Promise.allSettled(settle).then(() => false),
    new Promise<boolean>((r) => (t = setTimeout(() => r(true), waitMs))),
  ]);
  clearTimeout(t);
  if (timedOut) log.warn("Shutdown: timed out waiting for the stale confirm run");
}

// ── Check (D6) and the verdicts on the GET answer ──────────────────────────

/** Check makes at most this many calls a request. */
export const CHECK_MAX_CALLS = 10;
/** Calls in flight at once during a Check. */
export const CHECK_CONCURRENCY = 3;
/** A Check request ends within this long of its arrival (each call's deadline). */
export const CHECK_BUDGET_MS = 4 * 60_000;
/** The route ends a Check stream this long past its budget, whatever its calls
 *  are doing: the server's idle timer is off for the request, so this is its bound. */
export const CHECK_STREAM_GRACE_MS = 15_000;
/** A Check stream writes a heartbeat comment this often, for a proxy between
 *  the reader and muninn. Bun's own `idleTimeout` is not reset by writes
 *  (measured, Bun 1.3.10), so the route turns it off for the request. */
export const CHECK_HEARTBEAT_MS = 30_000;
let heartbeatMs = CHECK_HEARTBEAT_MS;
export const checkHeartbeatMs = () => heartbeatMs;
export function __setCheckHeartbeatMsForTest(ms: number | null): void {
  heartbeatMs = ms ?? CHECK_HEARTBEAT_MS;
}
let checkTiming = { budgetMs: CHECK_BUDGET_MS, graceMs: CHECK_STREAM_GRACE_MS };
export const checkBudget = () => checkTiming;
export function __setCheckBudgetForTest(t: { budgetMs: number; graceMs: number } | null): void {
  checkTiming = t ?? { budgetMs: CHECK_BUDGET_MS, graceMs: CHECK_STREAM_GRACE_MS };
}

/** The fixed text of Check's error events (A11): the raw error goes to the log only. */
export const CHECK_CALL_FAILED = "The check call failed or timed out.";
export const CHECK_ANSWER_UNREADABLE = "The model's answer could not be read.";
export const CHECK_FAILED = "The check failed. The server log has the details.";
export const CHECK_TIMED_OUT = "The check ran out of time. Check again for the pages it did not reach.";
/** The note an error event gains when its key failed before: Check calls on
 *  every click, so a reader sees that this answer keeps failing. */
export const checkRepeatNote = (count: number) => ` It failed ${count} times in a row.`;

export type StaleCheckEvent =
  | { type: "start"; changed: string; toCheck: number; cached: number; toCall: number; left: number }
  | { type: "verdict"; relPath: string; verdict: StaleVerdictValue; reason: string; edit: StaleEdit | null; cached: boolean }
  | { type: "error"; relPath: string; message: string }
  /** `calls` this request started; `joined` the calls another Check had in flight (A9). */
  | { type: "done"; calls: number; joined: number; verdicts: number; errors: number; left: number };

/** Check's calls in flight, by wiki, kind and key (A9): a second Check on the
 *  same page waits for the first call's row instead of buying it again. */
const checkFlights = new Map<string, Promise<StaleVerdictRow>>();
/** Check's failures in a row, by flight key; a success clears its key. Dropped
 *  a day after the last failure, as the loop's are. */
const checkFailures = new Map<string, FailureMark>();
export function __resetStaleCheckFailuresForTest(): void {
  checkFailures.clear();
}
const checkFlightKey = (wiki: string, kind: StaleVerdictKind, key: string) => `${wiki}\0${kind}\0${key}`;

const readText = async (abs: string): Promise<string | null> => {
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
};

/** Check on a changed page that cannot be read: its content hash, and so
 *  every passage key, is unknown (A14). */
export class StaleChangedUnreadableError extends Error {
  constructor(relPath: string) {
    super(`the changed page ${relPath} cannot be read`);
    this.name = "StaleChangedUnreadableError";
  }
}

/** The changed page's content hash, or null when it cannot be read. A null
 *  hash gives no passage key: callers skip or refuse, never key on a sentinel. */
export async function changedHashOf(index: WikiIndex, relPath: string): Promise<string | null> {
  const text = await readText(path.join(index.root, relPath));
  return text === null ? null : changedPageContentHash(text);
}

/**
 * Check one changed page's To-check linking pages: a cached verdict is
 * reported as is, the rest get one call each, at most {@link CHECK_MAX_CALLS},
 * {@link CHECK_CONCURRENCY} at a time. Returns false when the page is not a
 * changed page (no event is sent).
 */
export async function runStaleCheck(opts: {
  wiki: string;
  index: WikiIndex;
  relPath: string;
  asOfMs?: number;
  bot: BotConfig;
  store?: StaleVerdictStore;
  model?: StaleModel;
  onEvent: (e: StaleCheckEvent) => void | Promise<void>;
  isGone?: () => boolean;
  /** Every call's deadline: the route takes it at the request's arrival (A11). */
  deadlineAt?: number;
  /** Flight key → failures in a row. Defaults to the process's own map. */
  failures?: Map<string, FailureMark>;
}): Promise<boolean> {
  const deadlineAt = opts.deadlineAt ?? Date.now() + CHECK_BUDGET_MS;
  const { wiki, index, bot, onEvent } = opts;
  const store = opts.store ?? staleVerdictStore();
  const model = opts.model ?? staleModel();
  const failures = opts.failures ?? checkFailures;
  for (const [k, m] of failures) if (Date.now() - m.at > FAILURE_MEMORY_MS) failures.delete(k);
  const buckets = await linkingBuckets(index, opts.relPath, opts.asOfMs !== undefined ? { asOfMs: opts.asOfMs } : {});
  if (!buckets) return false;
  const changedHash = await changedHashOf(index, buckets.relPath);
  if (changedHash === null) throw new StaleChangedUnreadableError(buckets.relPath);
  const subjects: SubjectsMemo = new Map();
  const changedMeta = index.resolveRelPath(buckets.relPath);
  const items = buckets.linking
    .filter((l) => l.bucket === "toCheck")
    .map((l) => {
      const ctx = passageKeyContext(index, buckets.relPath, l);
      return { l, passage: ctx.passage, ctx, key: passageKeyHash(l.relPath, ctx.passage, changedHash, ctx) };
    });
  const cached = await store.get(wiki, "passage", items.map((i) => i.key));
  const fresh = items.filter((i) => !cached.has(i.key));
  const toCall = fresh.slice(0, CHECK_MAX_CALLS);
  const left = fresh.length - toCall.length;
  await onEvent({ type: "start", changed: buckets.relPath, toCheck: items.length, cached: items.length - fresh.length, toCall: toCall.length, left });
  let verdicts = 0;
  let errors = 0;
  for (const i of items) {
    const row = cached.get(i.key);
    if (!row) continue;
    verdicts++;
    await onEvent({ type: "verdict", relPath: i.l.relPath, verdict: row.verdict, reason: row.reason, edit: row.edit, cached: true });
  }
  let calls = 0;
  let joined = 0;
  const call = async (i: (typeof toCall)[number]): Promise<StaleVerdictRow> => {
    const input: StaleCallInput = {
      kind: "passage",
      page: i.l.relPath,
      passage: i.passage,
      target: i.ctx.target,
      // `asOf` scopes only the window (which pages are To check); the subjects
      // run up to now, so a Check with and without it sends one prompt and
      // sharing the key is sound.
      commits: await commitsFor(index, changedMeta, i.l.lastChangeMs, undefined, subjects),
      otherPlans: i.ctx.otherPlans,
      sourceLines: await sourceLinesOf(index.root, i.l.relPath, linkingPassageRows(i.l).map((p) => p.line)),
    };
    const raw = await model(buildStalePrompt(input), { bot, deadlineAt, source: "wiki_stale_check" });
    const a = parseStaleAnswer(raw, i.passage, input.sourceLines);
    // The stored row: a reader's verdict that landed during the call stays (A5).
    return store.upsert({ wiki, kind: "passage", page: i.l.relPath, keyHash: i.key, verdict: a.verdict, reason: a.reason, edit: a.edit, checkedBy: `model:${bot.name}` });
  };
  const queue = [...toCall];
  const worker = async () => {
    for (let i = queue.shift(); i; i = queue.shift()) {
      // A reader who left starts no new call; one already in flight finishes.
      if (opts.isGone?.()) return;
      const fk = checkFlightKey(wiki, "passage", i.key);
      let flight = checkFlights.get(fk);
      if (flight) joined++;
      else {
        calls++;
        const p = call(i).then(
          (row) => (failures.delete(fk), row),
          (err: unknown) => {
            markFailure(failures, fk, Date.now());
            throw err;
          },
        );
        flight = p;
        checkFlights.set(fk, p);
        void p.then(
          () => checkFlights.get(fk) === p && checkFlights.delete(fk),
          () => checkFlights.get(fk) === p && checkFlights.delete(fk),
        );
      }
      try {
        const row = await flight;
        verdicts++;
        await onEvent({ type: "verdict", relPath: i.l.relPath, verdict: row.verdict, reason: row.reason, edit: row.edit, cached: false });
      } catch (err) {
        errors++;
        log.warn("Stale check call failed for {page} (linking {linking}): {error}", { wiki, page: buckets.relPath, linking: i.l.relPath, error: err instanceof Error ? err.message : String(err) });
        const count = failures.get(fk)?.count ?? 1;
        const base = err instanceof StaleAnswerUnreadableError ? CHECK_ANSWER_UNREADABLE : CHECK_CALL_FAILED;
        await onEvent({ type: "error", relPath: i.l.relPath, message: count >= 2 ? base + checkRepeatNote(count) : base });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, toCall.length) }, worker));
  await onEvent({ type: "done", calls, joined, verdicts, errors, left });
  return true;
}

/** A verdict as the GET answer carries it. */
export interface VerdictView {
  verdict: StaleVerdictValue;
  reason: string;
  edit: StaleEdit | null;
  checkedAt: number;
  checkedBy: string;
}

const view = (r: StaleVerdictRow): VerdictView => ({ verdict: r.verdict, reason: r.reason, edit: r.edit, checkedAt: r.checkedAt, checkedBy: r.checkedBy });

/** Every status-line hit's confirmation in one read, keyed `relPath\0line\0target`. */
export async function hitConfirmations(
  wiki: string,
  index: Pick<WikiIndex, "resolveRelPath">,
  hitsByPage: Iterable<readonly [string, readonly StatusLineHit[]]>,
  store: StaleVerdictStore = staleVerdictStore(),
): Promise<Map<string, VerdictView>> {
  const keyOf = new Map<string, string>();
  for (const [rel, hits] of hitsByPage) for (const h of hits) keyOf.set(`${rel}\0${h.line}\0${h.target}`, statusLineVerdictKey(index, rel, h));
  const rows = await store.get(wiki, "status-line", [...new Set(keyOf.values())]);
  const out = new Map<string, VerdictView>();
  for (const [k, hash] of keyOf) {
    const r = rows.get(hash);
    if (r) out.set(k, view(r));
  }
  return out;
}

export const hitKey = (relPath: string, h: Pick<StatusLineHit, "line" | "target">) => `${relPath}\0${h.line}\0${h.target}`;

/** Is a hit a confirmed stale status line (D11, D26)? */
export const isConfirmedStale = (v: VerdictView | undefined) => v?.verdict === "stale";

/** The cached passage verdicts of a changed page's To-check pages, by linking relPath. */
export async function passageVerdicts(
  wiki: string,
  index: WikiIndex,
  changedRelPath: string,
  linking: readonly LinkingPage[],
  opts: { store?: StaleVerdictStore } = {},
): Promise<Map<string, VerdictView>> {
  const store = opts.store ?? staleVerdictStore();
  const toCheck = linking.filter((l) => l.bucket === "toCheck");
  if (toCheck.length === 0) return new Map();
  const changedHash = await changedHashOf(index, changedRelPath);
  if (changedHash === null) return new Map();
  const keys = new Map(toCheck.map((l) => [l.relPath, passageVerdictKey(index, changedRelPath, changedHash, l)] as const));
  const rows = await store.get(wiki, "passage", [...keys.values()]);
  const out = new Map<string, VerdictView>();
  for (const [rel, k] of keys) {
    const r = rows.get(k);
    if (r) out.set(rel, view(r));
  }
  return out;
}
