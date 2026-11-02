/**
 * The Your work card's GitHub check (plan `muninn-wiki-your-work-board`, P2):
 * what GitHub says about the PRs the live plan pages and the Needs you items
 * name, asked on `GET /api/wiki/work-map/checks` by the muninn that serves the
 * card. The model's digest and the map file never see any of it.
 *
 * Only the PR states are cached, an hour each. The rows and the marks are read
 * from the current pages and the current map on every request, so a new map is
 * matched at once. One flight per wiki asks for what is due; a failed call
 * caches nothing and counts as unchecked, never as a contradiction.
 *
 * Nothing here writes to a wiki.
 */

import type { WorkMap } from "./schema.ts";
import { parseBlocks } from "../../format/markdown-ast.ts";
import { pageLedgers, type Ledger, type LedgerRow, type PrState as LedgerState } from "../../format/pr-ledger.ts";
import { getLog } from "../../logging.ts";
import { truncateUnits } from "../ask-chat.ts";
import { splitFrontmatter } from "../page-text.ts";
import { getWikiIndex, readWikiPage, type WikiIndex, type WikiPageMeta } from "../store.ts";

const log = getLog("wiki", "work-map-gh");

/** A PR state is served as is for this long. */
export const GH_STATE_TTL_MS = 60 * 60_000;
/** A request waits this long for a refresh before answering `refreshing`. */
export const GH_REFRESH_WAIT_MS = 10_000;
/** One `gh` call is killed after this long. */
export const GH_CALL_TIMEOUT_MS = 10_000;
export const GH_PRS_PER_QUERY = 50;
export const GH_QUERIES_AT_ONCE = 4;
/** PRs asked per wiki per hour; the rest count as unchecked. */
export const GH_PRS_PER_HOUR = 500;
/** How much of an unlinked row's label the drill list carries. */
const ROW_LABEL_MAX = 80;

export type GhState = "OPEN" | "MERGED" | "CLOSED";
export type NotCheckedReason = "no-gh" | "auth" | "sso" | "disabled";

export interface ChecksContradiction {
  page: string;
  pr: number;
  repo: string;
  rowState: string;
  ghState: GhState;
  mergedAt: string | null;
}

export interface ChecksNeed {
  kind: string;
  title: string;
  pr: number;
  /** Null when the PR's state is not known: its `#n` matched no single repo,
   *  or GitHub did not answer. Such a PR keeps the item from counting as done. */
  state: GhState | null;
  mergedAt: string | null;
  asksForIt: boolean;
}

/** `GET /api/wiki/work-map/checks`'s body. The two row lists feed the cell's drill list. */
export interface WorkMapChecksBody {
  at: number;
  refreshing?: boolean;
  notChecked?: { reason: NotCheckedReason; repos: string[] };
  checked: number;
  unchecked: number;
  unlinked: number;
  skipped: number;
  contradictions: ChecksContradiction[];
  prs: Record<string, { state: GhState; mergedAt: string | null }>;
  needs: ChecksNeed[];
  uncheckedRows: { page: string; pr: number; repo: string }[];
  unlinkedRows: { page: string; label: string }[];
}

export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Killed at the call's timeout. */
  timedOut?: boolean;
  /** The spawn itself failed with ENOENT: no `gh` on PATH. */
  noBinary?: boolean;
}

/** The seam: `gh` with these arguments, passed as an array. Never rejects. */
export type GhRunner = (args: string[]) => Promise<GhResult>;

/** `gh` on `Bun.spawn`, killed at the timeout (`Bun.$` has none). A killed call
 *  answers without waiting for its pipes: a child can hold them open. */
export function spawnGhRunner(bin = "gh", timeoutMs = GH_CALL_TIMEOUT_MS): GhRunner {
  return async (args) => {
    let proc;
    try {
      proc = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const noBinary = (err as { code?: string } | null)?.code === "ENOENT" || /ENOENT|not found/i.test(message);
      return { exitCode: -1, stdout: "", stderr: message, ...(noBinary ? { noBinary } : {}) };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const killed = new Promise<GhResult>((resolve) => {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ exitCode: -1, stdout: "", stderr: `killed after ${timeoutMs} ms`, timedOut: true });
      }, timeoutMs);
    });
    const finished = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
      ([stdout, stderr, exitCode]): GhResult => ({ exitCode, stdout, stderr }),
    );
    try {
      return await Promise.race([finished, killed]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface GhCheckDeps {
  index: (root: string) => Promise<WikiIndex | null>;
  readBody: (index: WikiIndex, meta: WikiPageMeta) => Promise<string | null>;
  runGh: GhRunner;
  /** The instance's off switch. */
  disabled: () => boolean;
  /** Test seam; defaults to {@link GH_REFRESH_WAIT_MS}. */
  refreshWaitMs?: number;
}

/** `WORK_MAP_GH_CHECK=off` (`0`, `false`) turns the check off; unset or blank is on. */
export function ghCheckDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["off", "0", "false"].includes((env.WORK_MAP_GH_CHECK ?? "").trim().toLowerCase());
}

export function realGhCheckDeps(): GhCheckDeps {
  return {
    index: (root) => getWikiIndex({ root }),
    readBody: readWikiPage,
    runGh: spawnGhRunner(),
    disabled: () => ghCheckDisabled(),
  };
}

/** The imperatives that ask for a PR, Norwegian included, whole words only:
 *  `merged`, `merges`, `reviewer`, `re-review` and `preview` stay out. */
export const NEEDS_ASK_VERB_RE = /(?<![\p{L}\p{N}_-])(?:merge|merg|lukk|close|godkjenn|approve|review)(?![\p{L}\p{N}_-])/iu;

const ASK_VERBS = `${NEEDS_ASK_VERB_RE.source}(?:\\s+(?:eller|or|og|and)\\s+${NEEDS_ASK_VERB_RE.source})*`;
/** A word between the verb and the number that can name a repo. A preposition
 *  says the PR is something else's condition: «Merge after #5». */
const ASK_QUALIFIER = "(?:(?!(?:after|before|with|without|until|once|since|when|on|in|into|to|for|from|of|by|at|not|no|the|this|that|it|i|på|etter|før|når|med|uten|til|fra|av|inn|mot|ikke)\\s)[\\p{L}\\p{N}][\\p{L}\\p{N}._/-]*\\s+)?";
const ASK_PR_END = "(?![\\p{L}\\p{N}_]|\\.\\d)";
const ASK_URL = "https?://(?:www\\.)?github\\.com/[\\w.-]+/[\\w.-]+/pull/\\d+";
const ASK_BARE_PR = `(?:\\(?(?:[\\p{L}\\p{N}._/-]*#\\d{1,7}${ASK_PR_END}\\)?|${ASK_URL}\\S*)|\\[#\\d{1,7}\\]\\(${ASK_URL}\\S*\\))`;
const ASK_LIST_JOIN = "(?:\\s*,\\s*|\\s+(?:og|and)\\s+)";
/** A verb opens the action or a clause. `og`/`and` alone join two steps of which
 *  the merge is only one, so they open nothing; a negation never gets here,
 *  since `ikke`, `not` and `don't` are no openers. */
const ASK_OPENER = "(?:^|[,;:.!—–]\\s+|\\s-\\s+|(?<![\\p{L}\\p{N}_-])(?<!(?:ikke|not|never)\\s+)(?:then|så)\\s+)";

/** The action ends in a clause asking for its PRs: nothing follows them. A word
 *  before a later PR needs its own verb: «og deploy #2» is a step, not a repo. */
export const NEEDS_ASK_RE = new RegExp(`${ASK_OPENER}${ASK_VERBS}\\s+${ASK_QUALIFIER}${ASK_BARE_PR}(?:${ASK_LIST_JOIN}(?:${ASK_VERBS}\\s+${ASK_QUALIFIER})?${ASK_BARE_PR})*[.!]?$`, "iu");

/** Whether an item's action asks for the PRs it names. When unsure this answers
 *  false: a neutral note is the safe mark, a wrong strike is not. */
export function needsAskFor(action: string): boolean {
  return NEEDS_ASK_RE.test(action.replace(/(?:\s*⟦[^⟧]*⟧)+[\s.!]*$/, "").trim());
}

/** The live plan pages: open plans, and shipped ones with follow-ups open. A
 *  retired page is out, as it is from the rail's live lists. */
export function isLiveCheckPage(p: Pick<WikiPageMeta, "plan_status" | "followups" | "culled">): boolean {
  if (p.culled) return false;
  const s = p.plan_status;
  return s === "proposed" || s === "ready" || s === "in-flight" || s === "blocked" || (s === "shipped" && p.followups === "open");
}

interface PrRef {
  repo: string;
  n: number;
  /** `owner/repo#n` as first spelled. */
  key: string;
  /** The key the cache and the dedupe read: GitHub ignores case in a slug. */
  id: string;
}

const REPO_SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.{1,2}$)[A-Za-z0-9._][A-Za-z0-9._-]*$/;

function prRef(repo: string, n: number): PrRef | null {
  if (!REPO_SLUG_RE.test(repo) || !Number.isSafeInteger(n) || n <= 0) return null;
  const key = `${repo}#${n}`;
  return { repo, n, key, id: key.toLowerCase() };
}

function parseRefString(s: string): PrRef | null {
  const m = /^(.+)#(\d+)$/.exec(s);
  return m ? prRef(m[1]!, Number(m[2])) : null;
}

// ── Reading the pages ──────────────────────────────────────────────────
type ScannedRow =
  | { kind: "skipped" }
  | { kind: "unlinked"; page: string; label: string }
  /** `refs` are the row's own PRs, `state` what it claims about them. */
  | { kind: "pr"; page: string; refs: PrRef[]; state: LedgerState };

const CONTRADICTABLE: ReadonlySet<LedgerState> = new Set<LedgerState>(["open", "not-started", "planned"]);

async function ledgersOf(index: WikiIndex, meta: WikiPageMeta, deps: GhCheckDeps): Promise<Ledger[]> {
  if (!/\.mdx?$/i.test(meta.relPath)) return [];
  const body = await deps.readBody(index, meta);
  if (body === null) return [];
  return pageLedgers(parseBlocks(splitFrontmatter(body).body), meta.plan_status === "proposed", { everyRow: true });
}

/** «Say it once»: the state cell links a page that owns a Jira key the row names. */
function stateOwnedElsewhere(row: LedgerRow, stateColumn: number, index: WikiIndex): boolean {
  const cell = stateColumn >= 0 ? row.cells[stateColumn] : undefined;
  if (!cell) return false;
  const text = row.cells.join(" ");
  for (const m of cell.matchAll(/\[\[([^\]|#\\]+)/g)) {
    const owns = index.resolve(m[1]!.trim())?.owns ?? [];
    if (owns.some((key) => new RegExp(`(?<![\\p{L}\\p{N}_-])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`, "u").test(text))) return true;
  }
  return false;
}

/** The row's first cell as the drill list shows it; a slate number stays a
 *  number, since no PR may stand behind it. A table row splits on every `|`, so
 *  a piped wikilink reaches the cell with no close: `[[target\`. */
function rowLabel(row: LedgerRow): string {
  const flat = (row.label || (row.cells[0] ?? ""))
    .replace(/\[\[([^\]\\#]*)[^\]]*(?:\]\])?/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*|`|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .trim();
  const text = flat || "(no label)";
  return text.length > ROW_LABEL_MAX ? `${truncateUnits(text, ROW_LABEL_MAX - 1)}…` : text;
}

function scanRow(row: LedgerRow, ledger: Ledger, page: string, index: WikiIndex): ScannedRow {
  if (stateOwnedElsewhere(row, ledger.stateColumn, index)) return { kind: "skipped" };
  const refs = (row.ownPrs ?? []).flatMap((p) => prRef(p.repo, p.n) ?? []);
  return refs.length ? { kind: "pr", page, refs, state: row.claimedState } : { kind: "unlinked", page, label: rowLabel(row) };
}

type ItemRef =
  /** A full PR URL: that PR, whatever the page knows. */
  | { form: "url"; n: number; repo: string }
  /** `owner/repo#n`. */
  | { form: "slug"; n: number; repo: string }
  /** `#n`, with the word right before it, if any. */
  | { form: "bare"; n: number; word: string | null; glued: boolean };

const ITEM_REF_RE = new RegExp(
  [
    "https?://(?:www\\.)?github\\.com/([\\w.-]+/[\\w.-]+)/pull/(\\d+)[^\\s)\\]]*",
    // Any other URL: its anchor is no PR.
    "[a-z][a-z0-9+.-]*://[^\\s)\\]]+",
    `(?<![\\p{L}\\p{N}_./-])([A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._][A-Za-z0-9._-]*)#(\\d{1,7})${ASK_PR_END}`,
    // `&#39;` and a path's anchor (`/#5`) are no PR; `a.#5` is a glued word's.
    `(?<![&/#])#(\\d{1,7})${ASK_PR_END}`,
  ].join("|"),
  "giu",
);

/** What an item's words name, in order, its page markers masked. */
function scanItemRefs(text: string): ItemRef[] {
  const words = text.replace(/⟦[^⟧]*⟧/g, " ");
  const out: ItemRef[] = [];
  for (const m of words.matchAll(ITEM_REF_RE)) {
    if (m[1]) out.push({ form: "url", n: Number(m[2]), repo: m[1] });
    else if (m[3]) out.push({ form: "slug", n: Number(m[4]), repo: m[3] });
    else if (m[5]) {
      const before = /([\p{L}\p{N}_.-]+)(\s*)$/u.exec(words.slice(0, m.index));
      out.push({ form: "bare", n: Number(m[5]), word: before?.[1] ?? null, glued: !!before && !before[2] });
    }
  }
  return out;
}

interface ResolvedItem {
  prs: { n: number; ref: PrRef | null }[];
  /** The words name a PR with no entry, so the entries are not the whole item. */
  incomplete: boolean;
}

/**
 * An item's PRs against the refs its pages know. A named repo is that repo and
 * only that one: a page that does not know its PR gives no entry. A bare `#n`
 * needs exactly one repo to match, and is the named PR when the item also names
 * that number with a repo.
 */
function resolveItemRefs(refs: readonly ItemRef[], known: readonly PrRef[]): ResolvedItem {
  const nameOf = (repo: string): string => repo.slice(repo.indexOf("/") + 1).toLowerCase();
  const names = new Set(known.map((r) => nameOf(r.repo)));
  const distinct = (rs: readonly PrRef[]): PrRef[] => [...new Map(rs.map((r) => [r.id, r])).values()];
  const named = (r: ItemRef): boolean => r.form !== "bare" || (r.word !== null && names.has(r.word.toLowerCase()));
  const namedNumbers = new Set(refs.filter(named).map((r) => r.n));

  const out = new Map<string, { n: number; ref: PrRef | null }>();
  const add = (n: number, ref: PrRef | null): void => {
    const key = ref?.id ?? `?${n}`;
    if (!out.has(key)) out.set(key, { n, ref });
  };
  let incomplete = false;
  for (const r of refs) {
    const same = known.filter((k) => k.n === r.n);
    if (r.form === "url") {
      const ref = prRef(r.repo, r.n);
      if (ref) add(r.n, ref);
      else incomplete = true;
    } else if (r.form === "slug") {
      const hit = same.find((k) => k.repo.toLowerCase() === r.repo.toLowerCase());
      if (hit) add(r.n, hit);
      else incomplete = true;
    } else if (named(r)) {
      const hits = distinct(same.filter((k) => nameOf(k.repo) === r.word!.toLowerCase()));
      if (hits.length) add(r.n, hits.length === 1 ? hits[0]! : null);
      else incomplete = true;
    } else if (r.glued) {
      // `x#5`, `foo.md#5`: no PR, but no strike either beside a real one.
      incomplete = true;
    } else if (!namedNumbers.has(r.n)) {
      const repos = new Map(same.map((k) => [k.repo.toLowerCase(), k]));
      add(r.n, repos.size === 1 ? [...repos.values()][0]! : null);
    }
  }
  return { prs: [...out.values()], incomplete };
}

interface ScannedNeed {
  kind: string;
  title: string;
  asksForIt: boolean;
  prs: { n: number; ref: PrRef | null }[];
}

/** The PR refs a page names: its `prRefs` from the index and its ledger links. */
function refsOf(meta: WikiPageMeta, ledgers: readonly Ledger[]): PrRef[] {
  const out: PrRef[] = [];
  for (const raw of meta.prRefs ?? []) {
    const ref = parseRefString(raw);
    if (ref) out.push(ref);
  }
  for (const l of ledgers) {
    for (const r of l.rows) {
      const ref = r.ownPr ? prRef(r.ownPr.repo, r.ownPr.n) : null;
      if (ref) out.push(ref);
    }
  }
  return out;
}

interface Scan {
  rows: ScannedRow[];
  needs: ScannedNeed[];
  /** What is looked up, Needs you first: an item's mark outranks a row under the cap. */
  refs: Map<string, PrRef>;
}

async function scan(index: WikiIndex, map: WorkMap, deps: GhCheckDeps): Promise<Scan> {
  const ledgerCache = new Map<string, Promise<Ledger[]>>();
  const ledgers = (meta: WikiPageMeta): Promise<Ledger[]> => {
    let hit = ledgerCache.get(meta.relPath);
    if (!hit) {
      hit = ledgersOf(index, meta, deps);
      ledgerCache.set(meta.relPath, hit);
    }
    return hit;
  };

  const refs = new Map<string, PrRef>();
  const needs: ScannedNeed[] = [];
  const itemSeen = new Set<string>();
  for (const item of map.needsYou) {
    const itemKey = `${item.kind}|${item.title}`;
    if (itemSeen.has(itemKey)) continue;
    itemSeen.add(itemKey);
    const scanned = scanItemRefs(`${item.title} ${item.action}`);
    if (!scanned.length) continue;
    const markers = [...`${item.title} ${item.why} ${item.action}`.matchAll(/⟦([^⟧]+)⟧/g)].map((m) => m[1]!);
    const known: PrRef[] = [];
    for (const rel of new Set([...item.pages, ...markers])) {
      const meta = index.resolveRelPath(rel);
      if (meta) known.push(...refsOf(meta, await ledgers(meta)));
    }
    const { prs, incomplete } = resolveItemRefs(scanned, known);
    if (!prs.length) continue;
    for (const { ref } of prs) if (ref && !refs.has(ref.id)) refs.set(ref.id, ref);
    needs.push({ kind: item.kind, title: item.title, asksForIt: !incomplete && needsAskFor(item.action), prs });
  }

  const rows: ScannedRow[] = [];
  for (const meta of index.pages.filter(isLiveCheckPage)) {
    for (const ledger of await ledgers(meta)) {
      for (const row of ledger.rows) {
        const scanned = scanRow(row, ledger, meta.relPath, index);
        rows.push(scanned);
        if (scanned.kind === "pr") for (const ref of scanned.refs) if (!refs.has(ref.id)) refs.set(ref.id, ref);
      }
    }
  }
  return { rows, needs, refs };
}

// ── Asking GitHub ──────────────────────────────────────────────────────
interface CachedState {
  at: number;
  /** Null: GitHub answered that no such PR exists (an issue, a gone number). */
  state: { state: GhState; mergedAt: string | null } | null;
}

interface Flight {
  ids: ReadonlySet<string>;
  promise: Promise<void>;
}

interface WikiCache {
  states: Map<string, CachedState>;
  /** PRs GitHub answered for, per ask: the hourly cap's ledger. */
  asked: { at: number; n: number }[];
  /** Per lowercased repo, why its last query could not be read. */
  failures: Map<string, { repo: string; reason: Exclude<NotCheckedReason, "disabled"> }>;
  flight: Flight | null;
}

const caches = new Map<string, WikiCache>();

function cacheFor(wiki: string): WikiCache {
  const key = wiki.toLowerCase();
  let c = caches.get(key);
  if (!c) {
    c = { states: new Map(), asked: [], failures: new Map(), flight: null };
    caches.set(key, c);
  }
  return c;
}

export function __resetGhCheckForTest(): void {
  caches.clear();
}

/** The arguments of one query. Variables carry the slug; the numbers are integers. */
export function ghQueryArgs(repo: string, numbers: readonly number[]): string[] {
  const [owner, name] = repo.split("/") as [string, string];
  const fields = numbers.map((n) => `p${n}:pullRequest(number:${n}){state mergedAt}`).join(" ");
  const query = `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){${fields}}}`;
  return ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `repo=${name}`];
}

interface GqlError {
  type?: string;
  message?: string;
  path?: unknown[];
}

interface QueryAnswer {
  /** Per PR number: a state, or null for an alias GitHub says is no PR. An
   *  alias that failed some other way is absent, so it is asked again. */
  states: Map<number, CachedState["state"]>;
  failure?: Exclude<NotCheckedReason, "disabled">;
  /** The query as a whole went unanswered. */
  unanswered: boolean;
}

function failureReason(result: GhResult, message: string, errors: readonly GqlError[]): QueryAnswer["failure"] {
  if (result.noBinary) return "no-gh";
  const text = `${result.stderr}\n${message}`;
  if (result.exitCode === 4 || /Bad credentials|HTTP 401/i.test(text)) return "auth";
  if (errors.some((e) => e.type === "FORBIDDEN") || /SAML|\bFORBIDDEN\b/.test(`${text}\n${errors.map((e) => e.message ?? "").join("\n")}`)) return "sso";
  return undefined;
}

/** Stdout is read on exit 0 or 1: `gh api` exits 1 when `errors` sits beside partial `data`. */
export function readGhAnswer(result: GhResult, numbers: readonly number[]): QueryAnswer {
  const unanswered = (failure?: QueryAnswer["failure"]): QueryAnswer => ({ states: new Map(), unanswered: true, ...(failure ? { failure } : {}) });
  if (result.timedOut) return unanswered();
  if (result.exitCode !== 0 && result.exitCode !== 1) return unanswered(failureReason(result, "", []));
  let json: { data?: { repository?: Record<string, unknown> | null } | null; errors?: GqlError[]; message?: string } | null;
  try {
    json = JSON.parse(result.stdout) as typeof json;
  } catch {
    return unanswered(failureReason(result, "", []));
  }
  const errors = Array.isArray(json?.errors) ? json.errors : [];
  const failure = failureReason(result, typeof json?.message === "string" ? json.message : "", errors);
  if (!json?.data) return unanswered(failure);
  const repository = json.data.repository;
  // A repository the token may not read answers FORBIDDEN and null: nothing to cache.
  if (repository === null && failure) return unanswered(failure);
  const notFound = (n: number): boolean =>
    repository === null || errors.some((e) => e.type === "NOT_FOUND" && Array.isArray(e.path) && e.path.includes(`p${n}`));
  const states = new Map<number, CachedState["state"]>();
  for (const n of numbers) {
    const alias = repository?.[`p${n}`] as { state?: unknown; mergedAt?: unknown } | null | undefined;
    if (alias && (alias.state === "OPEN" || alias.state === "MERGED" || alias.state === "CLOSED")) {
      states.set(n, { state: alias.state, mergedAt: typeof alias.mergedAt === "string" ? alias.mergedAt : null });
    } else if (notFound(n)) {
      states.set(n, null);
    }
  }
  return { states, unanswered: false, ...(failure ? { failure } : {}) };
}

function jobsFor(refs: readonly PrRef[]): { repo: string; refs: PrRef[] }[] {
  const byRepo = new Map<string, PrRef[]>();
  for (const r of refs) {
    const k = r.repo.toLowerCase();
    const list = byRepo.get(k);
    if (list) list.push(r);
    else byRepo.set(k, [r]);
  }
  const jobs: { repo: string; refs: PrRef[] }[] = [];
  for (const list of byRepo.values()) {
    for (let i = 0; i < list.length; i += GH_PRS_PER_QUERY) jobs.push({ repo: list[0]!.repo, refs: list.slice(i, i + GH_PRS_PER_QUERY) });
  }
  return jobs;
}

function startFlight(c: WikiCache, ask: readonly PrRef[], deps: GhCheckDeps, now: () => number): Flight {
  const jobs = jobsFor(ask);
  for (const j of jobs) c.failures.delete(j.repo.toLowerCase());
  const runJob = async (job: { repo: string; refs: PrRef[] }): Promise<void> => {
    const numbers = job.refs.map((r) => r.n);
    let result: GhResult;
    try {
      result = await deps.runGh(ghQueryArgs(job.repo, numbers));
    } catch (err) {
      result = { exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
    const answer = readGhAnswer(result, numbers);
    if (answer.failure) c.failures.set(job.repo.toLowerCase(), { repo: job.repo, reason: answer.failure });
    if (answer.unanswered) {
      log.warn("GitHub check: the query for {repo} was not answered (exit {code}): {stderr}", { repo: job.repo, code: result.exitCode, stderr: result.stderr.trim().slice(0, 200) });
      return;
    }
    const at = now();
    c.asked.push({ at, n: job.refs.length });
    for (const ref of job.refs) if (answer.states.has(ref.n)) c.states.set(ref.id, { at, state: answer.states.get(ref.n)! });
  };
  const queue = [...jobs];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
  };
  const promise = Promise.all(Array.from({ length: Math.min(GH_QUERIES_AT_ONCE, jobs.length) }, worker))
    .then(() => {})
    .finally(() => {
      c.flight = null;
    });
  const flight: Flight = { ids: new Set(ask.map((r) => r.id)), promise };
  c.flight = flight;
  return flight;
}

function budgetLeft(c: WikiCache, at: number): number {
  c.asked = c.asked.filter((a) => at - a.at < GH_STATE_TTL_MS);
  return Math.max(0, GH_PRS_PER_HOUR - c.asked.reduce((sum, a) => sum + a.n, 0));
}

/** Bring what is due up to date; true when the refresh outlasted the wait. */
async function refreshDue(c: WikiCache, refs: ReadonlyMap<string, PrRef>, deps: GhCheckDeps, now: () => number): Promise<boolean> {
  const due = (): PrRef[] =>
    [...refs.values()].filter((r) => {
      const hit = c.states.get(r.id);
      return !hit || now() - hit.at >= GH_STATE_TTL_MS;
    });
  if (!due().length) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deps.refreshWaitMs ?? GH_REFRESH_WAIT_MS);
  });
  try {
    let joined: ReadonlySet<string> | null = null;
    // One pass, or two when the flight joined never asked for some of what is due.
    for (let pass = 0; pass < 2; pass++) {
      const asked: ReadonlySet<string> | null = joined;
      const open: PrRef[] = due().filter((r) => !asked?.has(r.id));
      if (!open.length) return false;
      const running: Flight | null = c.flight;
      const flight: Flight = running ?? startFlight(c, open.slice(0, budgetLeft(c, now())), deps, now);
      if ((await Promise.race([flight.promise, timeout])) === "timeout") return true;
      if (!running) return false;
      joined = flight.ids;
    }
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── The body ───────────────────────────────────────────────────────────
function emptyBody(at: number): WorkMapChecksBody {
  return { at, checked: 0, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [] };
}

export function disabledChecksBody(at: number): WorkMapChecksBody {
  return { ...emptyBody(at), notChecked: { reason: "disabled", repos: [] } };
}

const FAILURE_ORDER = ["no-gh", "auth", "sso"] as const;

function buildBody(s: Scan, c: WikiCache, refreshing: boolean, at: number): WorkMapChecksBody {
  const body = emptyBody(at);
  // A state past its hour is served only while its refresh runs: once that
  // refresh has failed, the state counts as unchecked.
  const known = (ref: PrRef): { state: GhState; mergedAt: string | null } | null => {
    const hit = c.states.get(ref.id);
    return hit?.state && (refreshing || at - hit.at < GH_STATE_TTL_MS) ? hit.state : null;
  };
  const listed = new Set<string>();
  for (const row of s.rows) {
    if (row.kind === "skipped") body.skipped++;
    else if (row.kind === "unlinked") {
      body.unlinked++;
      body.unlinkedRows.push({ page: row.page, label: row.label });
    } else {
      const gone = row.refs.find((ref) => !known(ref));
      if (gone) {
        body.unchecked++;
        body.uncheckedRows.push({ page: row.page, pr: gone.n, repo: gone.repo });
        continue;
      }
      body.checked++;
      // Several PRs in one cell are one statement: it fails only once none is left open.
      if (!CONTRADICTABLE.has(row.state) || row.refs.some((ref) => known(ref)!.state === "OPEN")) continue;
      const key = `${row.page}\0${row.refs.map((ref) => ref.id).join(" ")}`;
      if (listed.has(key)) continue;
      listed.add(key);
      const first = row.refs[0]!;
      const gh = known(first)!;
      body.contradictions.push({ page: row.page, pr: first.n, repo: first.repo, rowState: row.state, ghState: gh.state, mergedAt: gh.mergedAt });
    }
  }
  for (const need of s.needs) {
    for (const { n, ref } of need.prs) {
      const gh = ref ? known(ref) : null;
      body.needs.push({ kind: need.kind, title: need.title, pr: n, state: gh?.state ?? null, mergedAt: gh?.mergedAt ?? null, asksForIt: need.asksForIt });
    }
  }
  for (const ref of s.refs.values()) {
    const gh = known(ref);
    if (gh) body.prs[ref.key] = gh;
  }
  if (refreshing) body.refreshing = true;
  const wanted = new Set([...s.refs.values()].map((r) => r.repo.toLowerCase()));
  const failed = [...c.failures.entries()].filter(([repo]) => wanted.has(repo)).map(([, f]) => f);
  const reason = FAILURE_ORDER.find((r) => failed.some((f) => f.reason === r));
  if (reason) body.notChecked = { reason, repos: failed.filter((f) => f.reason === reason).map((f) => f.repo) };
  return body;
}

/** The check for one wiki, against its current pages and `map`. */
export async function checkWorkMapPrs(
  input: { wiki: string; root: string; map: WorkMap },
  deps: GhCheckDeps,
  now: () => number,
): Promise<WorkMapChecksBody> {
  if (deps.disabled()) return disabledChecksBody(now());
  const index = await deps.index(input.root);
  if (!index) return emptyBody(now());
  const scanned = await scan(index, input.map, deps);
  const c = cacheFor(input.wiki);
  const refreshing = await refreshDue(c, scanned.refs, deps, now);
  return buildBody(scanned, c, refreshing, now());
}
