/**
 * The Stale check's model half (plan muninn-wiki-drift-check, PR 2a): verdict
 * keys, the one model call, the confirm loop (D16) and Check (D6).
 *
 * - **Keys (D22)** hash content, never commits, and every other input the
 *   prompt carries: a status line on the page, the window the model saw, its
 *   status words and the target's facts; a passage on the linking page, its
 *   claim passages, the changed page's content hash (body, `plan_status` and
 *   `status_note` only, so a provenance stamp or an `updated:` bump resets
 *   nothing) and facts, the other plans' status and `asOf`.
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
import {
  getStaleVerdicts,
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
import { linkingBuckets, type LinkingPage, type StatusLineHit } from "./stale.ts";
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
const targetParts = (t: TargetFacts) => [normalizeRelPath(t.relPath), t.title, t.planStatus ?? "", t.statusNote ?? "", t.description ?? ""];

/**
 * A status-line confirmation's key: what the call was judged on — the page,
 * the hit's text (the window the model saw), the status words it says, the
 * target plan and its `plan_status`, and the target facts the prompt carries
 * (title, `status_note`, `description`). No commits (D22), no line number.
 */
export function statusLineKeyHash(page: string, hit: Pick<StatusLineHit, "text" | "target" | "now" | "said">, target: TargetFacts): string {
  return sha(["status-line/v2", normalizeRelPath(page), hit.text, hit.said.join(","), normalizeRelPath(hit.target), hit.now, ...targetParts(target).slice(1)]);
}

/** What a passage prompt carries besides the passage and the commit subjects. */
export interface PassageKeyContext {
  target: TargetFacts;
  otherPlans: NonNullable<StaleCallInput["otherPlans"]>;
  /** The check's `asOf`: it cuts the commit subjects the call reads. */
  asOfMs?: number;
}

/**
 * A passage verdict's key: the linking page, its passage, the changed page's
 * content hash, the changed page's facts the prompt carries, the other plans
 * the passage links to with their status, and `asOf`. No commits (D22).
 */
export function passageKeyHash(linkingPage: string, passage: string, changedHash: string, ctx: PassageKeyContext): string {
  const others = JSON.stringify(ctx.otherPlans.map((o) => [normalizeRelPath(o.relPath), o.planStatus, o.statusNote ?? ""]));
  return sha(["passage/v2", normalizeRelPath(linkingPage), passage, changedHash, ...targetParts(ctx.target), others, ctx.asOfMs === undefined ? "" : String(ctx.asOfMs)]);
}

/** A status-line hit's key, its target facts read from the index. */
export function statusLineVerdictKey(index: Pick<WikiIndex, "resolveRelPath">, page: string, hit: StatusLineHit): string {
  return statusLineKeyHash(page, hit, targetFacts(index.resolveRelPath(hit.target), hit.target));
}

/** The key context of a passage on a page linking to `changedRelPath`. */
export function passageKeyContext(index: Pick<WikiIndex, "resolve" | "resolveRelPath">, changedRelPath: string, passage: string, asOfMs?: number): PassageKeyContext {
  return {
    target: targetFacts(index.resolveRelPath(changedRelPath), changedRelPath),
    otherPlans: otherPlansIn(index, passage, changedRelPath),
    ...(asOfMs !== undefined ? { asOfMs } : {}),
  };
}

/** A To-check linking page's passage verdict key. */
export function passageVerdictKey(
  index: Pick<WikiIndex, "resolve" | "resolveRelPath">,
  changedRelPath: string,
  changedHash: string,
  l: Pick<LinkingPage, "relPath" | "passages">,
  asOfMs?: number,
): string {
  const passage = linkingPassage(l);
  return passageKeyHash(l.relPath, passage, changedHash, passageKeyContext(index, changedRelPath, passage, asOfMs));
}

/** The passage a To-check linking page is judged on: its lines that make a
 *  claim, in line order, joined by newlines. One verdict covers them. */
export function linkingPassage(lp: Pick<LinkingPage, "passages">): string {
  const claims = lp.passages.filter((p) => p.claim !== undefined);
  return (claims.length ? claims : lp.passages).map((p) => p.text).join("\n");
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
    'When the verdict is "stale", set "edit" to {"old":"…","new":"…","home":"…"}: "old" is the shortest span copied VERBATIM from ONE line of the passage that holds the stale claim and occurs on it once, "new" replaces it with the current fact, and "home" replaces it with text that drops the copied status but keeps every link, so the linked page stays the one place the status lives. Write "new" and "home" in the passage\'s language, one line each, at most 400 characters.',
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
/** The links a text holds: wikilink targets and markdown link URLs. */
const linksIn = (s: string) => [...extractWikilinks(s).map((t) => `[[${t}]]`), ...[...s.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]!)];

/**
 * The model's answer, validated strictly: an unreadable answer or an unknown
 * verdict is `unsure`. An edit survives only on a stale verdict (else it is
 * dropped and the verdict kept), and only when (A3): `old` occurs exactly
 * once across the passage's source lines — a passage's `\n`-joined claim
 * lines, a status-line window's `…`-separated pieces — so it never spans a
 * join; `new` is one line of at most {@link EDIT_TEXT_CAP} characters and
 * differs from `old`. `home` is kept only when it fits the same bound,
 * differs from `old` and keeps every link `old` holds.
 */
export function parseStaleAnswer(raw: string, passage: string, kind: StaleCallInput["kind"] = "passage"): StaleAnswer {
  let obj: Record<string, unknown>;
  try {
    const v = extractJson<unknown>(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    obj = v as Record<string, unknown>;
  } catch {
    return { verdict: "unsure", reason: "the model's answer could not be read", edit: null };
  }
  const v = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  const verdict = (MODEL_VERDICTS as readonly string[]).includes(v) ? (v as StaleAnswer["verdict"]) : "unsure";
  const reason = typeof obj.reason === "string" ? cap(obj.reason.trim().replace(/\s+/g, " "), REASON_CAP) : "";
  let edit: StaleEdit | null = null;
  const e = obj.edit as Record<string, unknown> | null | undefined;
  if (verdict === "stale" && e && typeof e === "object" && typeof e.old === "string" && typeof e.new === "string") {
    const old = e.old;
    const sources = kind === "status-line" ? passage.split("…") : passage.split("\n");
    const once = sources.reduce((n, src) => n + occurrences(src, old), 0) === 1;
    if (old.trim() && once && fitsEdit(e.new) && e.new !== old) {
      const home = e.home;
      const homeOk = typeof home === "string" && home !== old && fitsEdit(home) && linksIn(old).every((l) => home.includes(l));
      edit = { old, new: e.new, ...(homeOk ? { home } : {}) };
    }
  }
  return { verdict, reason, edit };
}

/** One model call: the prompt in, the model's raw text out. `deadlineAt`
 *  bounds the whole call, its CLI fallback included. */
export type StaleModel = (prompt: string, ctx: { bot: BotConfig; deadlineAt: number; source: string; tracer?: Tracer }) => Promise<string>;

/**
 * The real call: the bot's Haiku router, tool-less. Each attempt gets half
 * the time left (`timeoutMs`), and the router gives the CLI fallback only
 * what remains before `deadlineAt` (`HaikuRouterOptions.deadlineAt`). A
 * backend can still overrun its own `timeoutMs` (the Anthropic SDK retries,
 * Vertex refreshes its token once), so a race on `deadlineAt` bounds the
 * await; the router then refuses to start a fallback past it.
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
    timeoutMs: Math.floor(left / 2),
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
export async function commitSubjectsSince(root: string, relPath: string, sinceMs: number | undefined, untilMs?: number): Promise<string[] | null> {
  const args = ["git", "-C", root, "log", `--max-count=${COMMIT_SCAN_MAX}`, "--format=%at %s", "--", relPath];
  try {
    const r = await runProc(args, COMMIT_SUBJECTS_TIMEOUT_MS, "stale-commit-subjects", { quietTimeout: true });
    if (r.exitCode !== 0) return null;
    const out: string[] = [];
    for (const line of r.stdout.split("\n")) {
      const m = /^(\d+) (.*)$/.exec(line.trim());
      if (!m) continue;
      const ms = Number(m[1]) * 1000;
      if ((sinceMs !== undefined && ms <= sinceMs) || (untilMs !== undefined && ms > untilMs)) continue;
      out.push(m[2]!.trim());
      if (out.length >= COMMIT_SUBJECTS_MAX) break;
    }
    return out;
  } catch {
    return null;
  }
}

const targetFacts = (meta: WikiPageMeta | undefined, relPath: string): StaleCallInput["target"] => ({
  relPath: meta?.relPath ?? relPath,
  title: meta?.displayTitle ?? meta?.title ?? relPath,
  ...(meta?.plan_status ? { planStatus: meta.plan_status } : {}),
  ...(meta?.status_note ? { statusNote: meta.status_note } : {}),
  ...(meta?.description ? { description: meta.description } : {}),
});

/** The commits a call carries about `target`: null for an uncommitted change
 *  newer than every commit, else the subjects between `sinceMs` and `untilMs`
 *  (the check's `asOf`). */
async function commitsFor(index: WikiIndex, target: WikiPageMeta | undefined, sinceMs: number | undefined, untilMs?: number) {
  if (!target) return undefined;
  const uncommitted = untilMs === undefined && target.gitDirty === true && (target.gitTouchedMs === undefined || (sinceMs !== undefined && target.gitTouchedMs <= sinceMs));
  if (uncommitted) return null;
  return (await commitSubjectsSince(index.root, target.relPath, sinceMs, untilMs)) ?? undefined;
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
  };
}

// ── The confirm loop (D16) ─────────────────────────────────────────────────

/** A run ends within this long: every call's deadline is the run's. */
export const CONFIRM_RUN_BUDGET_MS = 4 * 60_000;
/** No call starts this long after a run began. */
export const CONFIRM_START_CUTOFF_MS = 3 * 60_000;
/** A run makes at most this many calls; the rest wait for the next run. */
export const CONFIRM_MAX_CALLS = 20;
/** The next run starts this long after the previous one ended. */
export const CONFIRM_INTERVAL_MS = 5 * 60_000;
/** The first run comes this long after boot. */
export const CONFIRM_FIRST_DELAY_MS = 60_000;

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
  wikis: { wiki: string; skipped?: string; hits: number; cached: number; calls: number; stale: number; errors: number; left: number }[];
  calls: number;
  errors: number;
  left: number;
  elapsedMs: number;
}

/**
 * One confirm run over the named wikis: rebuild each index once, confirm the
 * status-line hits with no verdict yet, at most {@link CONFIRM_MAX_CALLS},
 * none started after {@link CONFIRM_START_CUTOFF_MS}, every call's deadline
 * the run's {@link CONFIRM_RUN_BUDGET_MS}. A failed call writes nothing, so
 * the next run retries it. Never rejects.
 */
export async function runStaleConfirm(wikiNames: readonly string[], deps: ConfirmDeps = realConfirmDeps): Promise<ConfirmRunSummary> {
  const started = deps.now();
  const deadlineAt = started + CONFIRM_RUN_BUDGET_MS;
  const out: ConfirmRunSummary = { wikis: [], calls: 0, errors: 0, left: 0, elapsedMs: 0 };
  let tracer: Tracer | null = null;
  const tracerOnce = () => (tracer ??= deps.tracer());
  const wanted = new Set(wikiNames.map((n) => n.toLowerCase()));
  for (const entry of deps.registry()) {
    if (!wanted.has(entry.name.toLowerCase())) continue;
    const row = { wiki: entry.name, hits: 0, cached: 0, calls: 0, stale: 0, errors: 0, left: 0 } as ConfirmRunSummary["wikis"][number];
    out.wikis.push(row);
    try {
      if (isReadonlyWikiRoot(entry.root)) {
        row.skipped = "readonly root";
        continue;
      }
      const index = await deps.index(entry.root);
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
      const todo: { page: WikiPageMeta; hit: StatusLineHit; key: string }[] = [];
      for (const [rel, hits] of index.statusLineHits ?? []) {
        const page = index.resolveRelPath(rel);
        if (!page) continue;
        for (const hit of hits) todo.push({ page, hit, key: statusLineVerdictKey(index, page.relPath, hit) });
      }
      row.hits = todo.length;
      const cached = await deps.store().get(entry.name, "status-line", todo.map((t) => t.key));
      for (const t of todo) {
        if (cached.has(t.key)) {
          row.cached++;
          continue;
        }
        if (out.calls >= CONFIRM_MAX_CALLS || deps.now() - started >= CONFIRM_START_CUTOFF_MS) {
          row.left++;
          continue;
        }
        out.calls++;
        row.calls++;
        try {
          const input = await statusLineCallInput(index, t.page, t.hit);
          const raw = await deps.model()(buildStalePrompt(input), {
            bot,
            deadlineAt,
            source: "wiki_stale_confirm",
            ...(tracerOnce() ? { tracer: tracerOnce()! } : {}),
          });
          const answer = parseStaleAnswer(raw, input.passage, "status-line");
          await deps.store().upsert({
            wiki: entry.name,
            kind: "status-line",
            page: t.page.relPath,
            keyHash: t.key,
            verdict: answer.verdict,
            reason: answer.reason,
            edit: answer.edit,
            checkedBy: `model:${bot.name}`,
          });
          if (answer.verdict === "stale") row.stale++;
        } catch (err) {
          row.errors++;
          log.warn("Stale confirm: call for {page}:{line} failed: {error}", {
            wiki: entry.name,
            page: t.page.relPath,
            line: t.hit.line,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      row.errors++;
      log.warn("Stale confirm: wiki {wiki} failed: {error}", { wiki: entry.name, error: err instanceof Error ? err.message : String(err) });
    }
    out.errors += row.errors;
    out.left += row.left;
  }
  out.elapsedMs = deps.now() - started;
  if (out.calls > 0 || out.errors > 0) {
    deps.span({ calls: out.calls, errors: out.errors, left: out.left, elapsedMs: out.elapsedMs, wikis: out.wikis }, tracerOnce());
    log.info("Stale confirm: {calls} call(s), {errors} error(s), {left} left for the next run, {elapsedMs} ms", {
      calls: out.calls,
      errors: out.errors,
      left: out.left,
      elapsedMs: out.elapsedMs,
    });
  }
  return out;
}

/** The wikis the loop covers: `wikiNames` that are registered. */
export function confirmLoopWikis(wikiNames: readonly string[], registry: readonly WikiRegistryEntry[]): string[] {
  const names = new Map(registry.map((e) => [e.name.toLowerCase(), e.name]));
  return [...new Set(wikiNames.map((n) => names.get(n.toLowerCase())).filter((n): n is string => !!n))];
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running: Promise<unknown> | null = null;
let stopped = true;

/**
 * Start the loop (D16) when the scheduler runs, the instance is not readonly
 * and `wikiNames` names a registered wiki; returns the covered wikis, or []
 * when it did not start. The next run is scheduled when the previous one
 * ends, so runs never overlap; holds no bot's scheduler tick.
 */
export function startStaleConfirmLoop(
  config: { schedulerEnabled: boolean; wikiStaleConfirmWikis: readonly string[] },
  opts: { deps?: ConfirmDeps; firstDelayMs?: number; intervalMs?: number } = {},
): string[] {
  if (!stopped) return [];
  if (!config.schedulerEnabled || isWikiReadonly()) return [];
  const deps = opts.deps ?? realConfirmDeps;
  const wikis = confirmLoopWikis(config.wikiStaleConfirmWikis, deps.registry());
  if (wikis.length === 0) return [];
  stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  const tick = () => {
    timer = null;
    if (running) {
      log.warn("Stale confirm skipped: the previous run is still in flight");
      return schedule(opts.intervalMs ?? CONFIRM_INTERVAL_MS);
    }
    running = runStaleConfirm(wikis, deps).finally(() => {
      running = null;
      schedule(opts.intervalMs ?? CONFIRM_INTERVAL_MS);
    });
  };
  schedule(opts.firstDelayMs ?? CONFIRM_FIRST_DELAY_MS);
  return wikis;
}

/** Stop the loop and wait (bounded) for a run in flight. */
export async function stopStaleConfirmLoop(waitMs = 5_000): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  const inFlight = running;
  if (!inFlight) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([inFlight.then(() => false), new Promise<boolean>((r) => (t = setTimeout(() => r(true), waitMs)))]);
  clearTimeout(t);
  if (timedOut) log.warn("Shutdown: timed out waiting for the stale confirm run");
}

// ── Check (D6) and the verdicts on the GET answer ──────────────────────────

/** Check makes at most this many calls a request. */
export const CHECK_MAX_CALLS = 10;
/** Calls in flight at once during a Check. */
export const CHECK_CONCURRENCY = 3;
/** A Check request ends within this long (each call's deadline). */
export const CHECK_BUDGET_MS = 4 * 60_000;

export type StaleCheckEvent =
  | { type: "start"; changed: string; toCheck: number; cached: number; toCall: number; left: number }
  | { type: "verdict"; relPath: string; verdict: StaleVerdictValue; reason: string; edit: StaleEdit | null; cached: boolean }
  | { type: "error"; relPath: string; message: string }
  | { type: "done"; calls: number; verdicts: number; errors: number; left: number };

const readText = async (abs: string): Promise<string | null> => {
  try {
    return await Bun.file(abs).text();
  } catch {
    return null;
  }
};

/** The changed page's content hash, or null when it cannot be read. */
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
}): Promise<boolean> {
  const { wiki, index, bot, onEvent } = opts;
  const store = opts.store ?? staleVerdictStore();
  const model = opts.model ?? staleModel();
  const buckets = await linkingBuckets(index, opts.relPath, opts.asOfMs !== undefined ? { asOfMs: opts.asOfMs } : {});
  if (!buckets) return false;
  const changedMeta = index.resolveRelPath(buckets.relPath);
  const changedHash = (await changedHashOf(index, buckets.relPath)) ?? "unreadable";
  const items = buckets.linking
    .filter((l) => l.bucket === "toCheck")
    .map((l) => {
      const passage = linkingPassage(l);
      const ctx = passageKeyContext(index, buckets.relPath, passage, opts.asOfMs);
      return { l, passage, ctx, key: passageKeyHash(l.relPath, passage, changedHash, ctx) };
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
  const deadlineAt = Date.now() + CHECK_BUDGET_MS;
  const queue = [...toCall];
  const worker = async () => {
    for (let i = queue.shift(); i; i = queue.shift()) {
      if (opts.isGone?.()) return;
      try {
        const input: StaleCallInput = {
          kind: "passage",
          page: i.l.relPath,
          passage: i.passage,
          target: i.ctx.target,
          commits: await commitsFor(index, changedMeta, i.l.lastChangeMs, opts.asOfMs),
          otherPlans: i.ctx.otherPlans,
        };
        const raw = await model(buildStalePrompt(input), { bot, deadlineAt, source: "wiki_stale_check" });
        const a = parseStaleAnswer(raw, i.passage, "passage");
        await store.upsert({ wiki, kind: "passage", page: i.l.relPath, keyHash: i.key, verdict: a.verdict, reason: a.reason, edit: a.edit, checkedBy: `model:${bot.name}` });
        verdicts++;
        await onEvent({ type: "verdict", relPath: i.l.relPath, verdict: a.verdict, reason: a.reason, edit: a.edit, cached: false });
      } catch (err) {
        errors++;
        await onEvent({ type: "error", relPath: i.l.relPath, message: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, toCall.length) }, worker));
  await onEvent({ type: "done", calls: toCall.length, verdicts, errors, left });
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

/** The cached passage verdicts of a changed page's To-check pages under `asOfMs`, by linking relPath. */
export async function passageVerdicts(
  wiki: string,
  index: WikiIndex,
  changedRelPath: string,
  linking: readonly LinkingPage[],
  opts: { asOfMs?: number; store?: StaleVerdictStore } = {},
): Promise<Map<string, VerdictView>> {
  const store = opts.store ?? staleVerdictStore();
  const toCheck = linking.filter((l) => l.bucket === "toCheck");
  if (toCheck.length === 0) return new Map();
  const changedHash = (await changedHashOf(index, changedRelPath)) ?? "unreadable";
  const keys = new Map(toCheck.map((l) => [l.relPath, passageVerdictKey(index, changedRelPath, changedHash, l, opts.asOfMs)]));
  const rows = await store.get(wiki, "passage", [...keys.values()]);
  const out = new Map<string, VerdictView>();
  for (const [rel, k] of keys) {
    const r = rows.get(k);
    if (r) out.set(rel, view(r));
  }
  return out;
}
