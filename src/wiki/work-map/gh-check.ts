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
 * The status date check ({@link prFactsFor}) shares the cache, the flight and
 * the hourly budget, but keeps its own failure record and its own holds: the
 * card's body reads only failures from the card's queries, and the card asks
 * whatever is due whatever a page view saw.
 *
 * Nothing here writes to a wiki.
 */

import type { WorkMap } from "./schema.ts";
import { parseBlocks } from "../../format/markdown-ast.ts";
import { CLAIMABLE_STATES, pageLedgers, type Ledger, type LedgerRow, type PrState as LedgerState } from "../../format/pr-ledger.ts";
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
/** How long {@link prFactsFor} asks nothing of a repo whose last query from it
 *  went unanswered (no `gh`, auth, no access, SSO, a timeout), or of a PR its
 *  answered query left with no state and no NOT_FOUND. */
export const GH_FAILED_REPO_HOLD_MS = 10 * 60_000;
/** How much of an unlinked row's label the drill list carries. */
const ROW_LABEL_MAX = 80;

export type GhState = "OPEN" | "MERGED" | "CLOSED";
export type NotCheckedReason = "no-gh" | "auth" | "sso" | "no-access" | "disabled";

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
  /** The checked rows that could contradict: they say open, not started or planned. */
  compared: number;
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

/** All `gh` gets from muninn's env: where it is and where its login is (`HOME`
 *  alone reaches the macOS keychain, measured). The login is the identity: an env
 *  token outranks it, so a card remedy naming `gh auth login` could never work,
 *  and a low-scope one reads private repos as missing. Felles spawns the same way. */
const GH_CHILD_ENV = ["PATH", "HOME", "GH_CONFIG_DIR", "XDG_CONFIG_HOME"] as const;

function ghChildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of GH_CHILD_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** `gh` on `Bun.spawn`, killed at the timeout (`Bun.$` has none). A killed call
 *  answers without waiting for its pipes: a child can hold them open. */
export function spawnGhRunner(bin = "gh", timeoutMs = GH_CALL_TIMEOUT_MS): GhRunner {
  return async (args) => {
    let proc;
    try {
      proc = Bun.spawn([bin, ...args], { env: ghChildEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

/** The live plan pages: open plans, and shipped ones with follow-ups open. A
 *  retired page is out, as it is from the rail's live lists. */
export function isLiveCheckPage(p: Pick<WikiPageMeta, "plan_status" | "followups" | "culled">): boolean {
  if (p.culled) return false;
  const s = p.plan_status;
  return s === "proposed" || s === "ready" || s === "in-flight" || s === "blocked" || (s === "shipped" && p.followups === "open");
}

export interface PrRef {
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

export function parseRefString(s: string): PrRef | null {
  const m = /^(.+)#(\d+)$/.exec(s);
  return m ? prRef(m[1]!, Number(m[2])) : null;
}

// ── Reading the pages ──────────────────────────────────────────────────
type ScannedRow =
  | { kind: "skipped" }
  | { kind: "unlinked"; page: string; label: string }
  /** `refs` are the row's own PRs, `state` what it claims about them. */
  | { kind: "pr"; page: string; refs: PrRef[]; state: LedgerState };

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

const NOT_NUMBER_END = "(?![\\p{L}\\p{N}_]|\\.\\d)";
const OWNER_REPO = "[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._][A-Za-z0-9._-]*";

const ITEM_REF_RE = new RegExp(
  [
    "https?://(?:www\\.)?github\\.com/([\\w.-]+/[\\w.-]+)/pull/(\\d+)[^\\s)\\]]*",
    // Any other URL: its anchor is no PR.
    "[a-z][a-z0-9+.-]*://[^\\s)\\]]+",
    `(?<![\\p{L}\\p{N}_./-])(${OWNER_REPO})#(\\d{1,7})${NOT_NUMBER_END}`,
    // `&#39;` and a path's anchor (`/#5`) are no PR; `a.#5` is a glued word's.
    `(?<![&/#])#(\\d{1,7})${NOT_NUMBER_END}`,
  ].join("|"),
  "giu",
);

/** Item text is the model's and unbounded, and these patterns are quadratic on a
 *  run (100k characters took 30 s), so past this an item's text names nothing. */
const ITEM_TEXT_MAX = 200;

const ASK_VERBS = ["merge", "merg", "lukk", "close", "godkjenn", "approve", "review"];
const ASK_VERB = `(?:${ASK_VERBS.join("|")})`;
/** VERB, a second VERB, a QUALIFIER (1) and the REF list (2). */
const ASK_HEAD_RE = new RegExp(`^${ASK_VERB}(?:\\s+(?:eller|or|og|and)\\s+${ASK_VERB})?\\s+(?:([\\p{L}\\p{N}._-]+)\\s+)?(\\S.*)$`, "iu");
const ASK_LIST_JOIN_RE = /\s*[,&]\s*|\s+(?:og|and)\s+/i;
const ASK_REF_RE = new RegExp(`^(?:(?:${OWNER_REPO})?#\\d{1,7}|https?://(?:www\\.)?github\\.com/[\\w.-]+/[\\w.-]+/pull/\\d{1,7})$`, "i");

/**
 * The refs of an action that asks for its PRs, read over the whole of it: `VERB
 * [(eller|or|og|and) VERB] [QUALIFIER] REF [(og|and|,|&) REF]…`, with one trailing
 * `.` or `!` and page markers after it. Anything else is null: a neutral note is
 * the safe mark, a wrong strike is not.
 */
function askedRefs(action: string): { qualifier: string | null; refs: ItemRef[] } | null {
  const text = action.trim();
  if (text.length > ITEM_TEXT_MAX) return null;
  const head = ASK_HEAD_RE.exec(text.replace(/(?:\s*⟦[^⟧]*⟧)+([.!]?)$/, "$1").replace(/[.!]$/, ""));
  const parts = head?.[2]!.split(ASK_LIST_JOIN_RE);
  if (!parts?.every((part) => ASK_REF_RE.test(part))) return null;
  const qualifier = /^pr$/i.test(head![1] ?? "") ? null : (head![1] ?? null);
  const refs = parts.flatMap(scanItemRefs);
  if (qualifier && refs[0]!.form === "bare") refs[0] = { ...refs[0]!, word: qualifier };
  return { qualifier, refs };
}

/** A word naming a repo: its name, or one `-`-separated token of it (`e2e`). */
function repoWordFits(word: string, repo: string): boolean {
  const name = repo.slice(repo.indexOf("/") + 1).toLowerCase();
  return [name, ...name.split("-")].includes(word.toLowerCase());
}

/** What an item's words name, in order, its page markers masked. A verb before
 *  the number is the verb, even on a page knowing a repo called that. */
function scanItemRefs(text: string): ItemRef[] {
  if (text.length > ITEM_TEXT_MAX) return [];
  const words = text.replace(/⟦[^⟧]*⟧/g, " ");
  const out: ItemRef[] = [];
  for (const m of words.matchAll(ITEM_REF_RE)) {
    if (m[1]) out.push({ form: "url", n: Number(m[2]), repo: m[1] });
    else if (m[3]) out.push({ form: "slug", n: Number(m[4]), repo: m[3] });
    else if (m[5]) {
      const before = /([\p{L}\p{N}_.-]+)(\s*)$/u.exec(words.slice(0, m.index));
      const glued = !!before && !before[2];
      out.push({ form: "bare", n: Number(m[5]), word: !before || (!glued && ASK_VERBS.includes(before[1]!.toLowerCase())) ? null : before[1]!, glued });
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
    const asked = askedRefs(item.action);
    const scanned = [...scanItemRefs(item.title), ...(asked?.refs ?? scanItemRefs(item.action))];
    if (!scanned.length) continue;
    // No `⟦` in the class, so a run of them with no close stays linear.
    const markers = [...`${item.title} ${item.why} ${item.action}`.matchAll(/⟦([^⟦⟧]+)⟧/g)].map((m) => m[1]!);
    const known: PrRef[] = [];
    for (const rel of new Set([...item.pages, ...markers])) {
      const meta = index.resolveRelPath(rel);
      if (meta) known.push(...refsOf(meta, await ledgers(meta)));
    }
    const { prs, incomplete } = resolveItemRefs(scanned, known);
    if (!prs.length) continue;
    for (const { ref } of prs) if (ref && !refs.has(ref.id)) refs.set(ref.id, ref);
    // Every entry is one PR, and the qualifier names the repo of the PR it stands before.
    const asksForIt = asked !== null && !incomplete && prs.every((p) => p.ref && (!asked.qualifier || p.n !== asked.refs[0]!.n || repoWordFits(asked.qualifier, p.ref.repo)));
    needs.push({ kind: item.kind, title: item.title, asksForIt, prs });
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
/** What GitHub says about one PR. */
export interface PrFact {
  state: GhState;
  mergedAt: string | null;
}

interface CachedState {
  at: number;
  /** Null: GitHub answered that no such PR exists (an issue, a gone number). */
  state: PrFact | null;
}

/** Who started a flight: the card's check or the status date check. */
type Asker = "card" | "page";

interface Flight {
  ids: ReadonlySet<string>;
  promise: Promise<void>;
  by: Asker;
}

type Failure = { repo: string; reason: Exclude<NotCheckedReason, "disabled"> };

interface WikiCache {
  states: Map<string, CachedState>;
  /** PRs GitHub answered for, per ask: the hourly cap's ledger. */
  asked: { at: number; n: number }[];
  /** Per lowercased repo, why the card's last query could not be read. The
   *  card's body reads only this, so a page view never shows in it. */
  failures: Map<string, Failure>;
  /** The same for the status date check's own flights, which read only this. */
  pageFailures: Map<string, Failure>;
  /** Per lowercased repo, when a status date flight's queries for it all went
   *  unanswered; cleared when any flight, the card's too, is answered for it. */
  failedAt: Map<string, number>;
  /** Per PR id, when a status date flight asked it and the repo answered with
   *  no state and no NOT_FOUND for it. Never cleared: a state cached later
   *  outlives the hold ({@link GH_STATE_TTL_MS} > {@link GH_FAILED_REPO_HOLD_MS}). */
  prHeldAt: Map<string, number>;
  flight: Flight | null;
}

const caches = new Map<string, WikiCache>();

function cacheFor(wiki: string): WikiCache {
  const key = wiki.toLowerCase();
  let c = caches.get(key);
  if (!c) {
    c = { states: new Map(), asked: [], failures: new Map(), pageFailures: new Map(), failedAt: new Map(), prHeldAt: new Map(), flight: null };
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

/** Why GitHub refused, from what it said. Stderr and a message can quote the repo,
 *  so a repo called `SAML-tools` must not read as a SAML block: its name is cut out. */
function failureReason(result: GhResult, repo: string, message: string, errors: readonly GqlError[]): QueryAnswer["failure"] {
  if (result.noBinary) return "no-gh";
  if (result.exitCode === 4) return "auth";
  if (errors.some((e) => e.type === "FORBIDDEN")) return "sso";
  if (errors.length && errors.every((e) => e.type === "NOT_FOUND")) return undefined;
  const parsed = [message, ...errors.map((e) => e.message ?? "")].join("\n").trim();
  const text = (parsed || result.stderr).replace(new RegExp(repo.replace(/\./g, "\\."), "gi"), "");
  if (/Bad credentials|HTTP 401/i.test(text)) return "auth";
  return /SAML|\bFORBIDDEN\b/.test(text) ? "sso" : undefined;
}

/** Stdout is read on exit 0 or 1: `gh api` exits 1 when `errors` sits beside partial `data`. */
export function readGhAnswer(result: GhResult, numbers: readonly number[], repo = ""): QueryAnswer {
  const unanswered = (failure?: QueryAnswer["failure"]): QueryAnswer => ({ states: new Map(), unanswered: true, ...(failure ? { failure } : {}) });
  if (result.timedOut) return unanswered();
  if (result.exitCode !== 0 && result.exitCode !== 1) return unanswered(failureReason(result, repo, "", []));
  let json: { data?: { repository?: Record<string, unknown> | null } | null; errors?: GqlError[]; message?: string } | null;
  try {
    json = JSON.parse(result.stdout) as typeof json;
  } catch {
    return unanswered(failureReason(result, repo, "", []));
  }
  const errors = Array.isArray(json?.errors) ? json.errors.filter((e) => e !== null) : [];
  const failure = failureReason(result, repo, typeof json?.message === "string" ? json.message : "", errors);
  if (!json?.data) return unanswered(failure);
  const repository = json.data.repository;
  // GitHub answers null for a repo that is gone and for a private one this login
  // cannot read, so null says nothing about its PRs: nothing to cache.
  if (repository === null) return unanswered(failure ?? (errors.some((e) => e.type === "NOT_FOUND") ? "no-access" : undefined));
  if (typeof repository !== "object" || !numbers.some((n) => Object.hasOwn(repository, `p${n}`))) return unanswered(failure);
  const notFound = (n: number): boolean => errors.some((e) => e.type === "NOT_FOUND" && Array.isArray(e.path) && e.path.includes(`p${n}`));
  const states = new Map<number, CachedState["state"]>();
  for (const n of numbers) {
    const alias = repository[`p${n}`] as { state?: unknown; mergedAt?: unknown } | null | undefined;
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

/**
 * One flight over `ask`. Its failures go to the record of who started it (`by`).
 * The holds are written once every job is done, so they do not depend on which
 * job finishes last: a repo any job answered for is not held and its hold is
 * cleared, whoever started the flight; only a status date flight holds a repo
 * none of its jobs answered for, and the PRs it asked that got no state in a
 * repo that did answer.
 */
function startFlight(c: WikiCache, ask: readonly PrRef[], deps: GhCheckDeps, now: () => number, by: Asker): Flight {
  const jobs = jobsFor(ask);
  const record = by === "card" ? c.failures : c.pageFailures;
  for (const j of jobs) record.delete(j.repo.toLowerCase());
  const answeredRepos = new Set<string>();
  const unansweredRepos = new Set<string>();
  /** PRs asked in this flight that got no state, answered or not. */
  const noState: PrRef[] = [];
  const runJob = async (job: { repo: string; refs: PrRef[] }): Promise<void> => {
    const numbers = job.refs.map((r) => r.n);
    let result: GhResult;
    try {
      result = await deps.runGh(ghQueryArgs(job.repo, numbers));
    } catch (err) {
      result = { exitCode: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
    const answer = readGhAnswer(result, numbers, job.repo);
    const repoKey = job.repo.toLowerCase();
    if (answer.failure) record.set(repoKey, { repo: job.repo, reason: answer.failure });
    if (answer.unanswered) {
      unansweredRepos.add(repoKey);
      noState.push(...job.refs);
      log.warn("GitHub check: the query for {repo} was not answered (exit {code}): {stderr}", { repo: job.repo, code: result.exitCode, stderr: result.stderr.trim().slice(0, 200) });
      return;
    }
    const at = now();
    answeredRepos.add(repoKey);
    c.asked.push({ at, n: job.refs.length });
    for (const ref of job.refs) {
      if (answer.states.has(ref.n)) c.states.set(ref.id, { at, state: answer.states.get(ref.n)! });
      else noState.push(ref);
    }
  };
  const writeHolds = (): void => {
    const at = now();
    for (const repo of answeredRepos) c.failedAt.delete(repo);
    if (by !== "page") return;
    for (const repo of unansweredRepos) if (!answeredRepos.has(repo)) c.failedAt.set(repo, at);
    // In a repo that answered, each PR left with no state is held on its own,
    // an unanswered sibling job's PRs among them.
    for (const ref of noState) if (answeredRepos.has(ref.repo.toLowerCase())) c.prHeldAt.set(ref.id, at);
  };
  const queue = [...jobs];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) await runJob(job);
  };
  const promise = Promise.all(Array.from({ length: Math.min(GH_QUERIES_AT_ONCE, jobs.length) }, worker))
    .then(writeHolds)
    .finally(() => {
      c.flight = null;
    });
  const flight: Flight = { ids: new Set(ask.map((r) => r.id)), promise, by };
  c.flight = flight;
  return flight;
}

function budgetLeft(c: WikiCache, at: number): number {
  c.asked = c.asked.filter((a) => at - a.at < GH_STATE_TTL_MS);
  return Math.max(0, GH_PRS_PER_HOUR - c.asked.reduce((sum, a) => sum + a.n, 0));
}

interface Refresh {
  /** The refresh outlasted the wait. */
  refreshing: boolean;
  /** Due PRs the hourly budget left unasked. */
  overBudget: Set<string>;
}

/**
 * Bring what is due up to date for `by`. For the status date check (`page`), a
 * PR under a hold younger than {@link GH_FAILED_REPO_HOLD_MS} (its repo's, or
 * its own) is not due, so a failing repo or PR costs one spawn per hold, not one
 * per request. The card reads no hold. A caller that joins the other one's
 * flight asks again for whatever that flight left due, so each one's failures
 * and holds come from its own queries.
 */
async function refreshDue(c: WikiCache, refs: ReadonlyMap<string, PrRef>, deps: GhCheckDeps, now: () => number, by: Asker): Promise<Refresh> {
  const overBudget = new Set<string>();
  const fresh = (at: number | undefined): boolean => at !== undefined && now() - at < GH_FAILED_REPO_HOLD_MS;
  const held = (r: PrRef): boolean => by === "page" && (fresh(c.failedAt.get(r.repo.toLowerCase())) || fresh(c.prHeldAt.get(r.id)));
  const due = (): PrRef[] =>
    [...refs.values()].filter((r) => {
      const hit = c.states.get(r.id);
      return (!hit || now() - hit.at >= GH_STATE_TTL_MS) && !held(r);
    });
  if (!due().length) return { refreshing: false, overBudget };
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
      if (!open.length) return { refreshing: false, overBudget };
      const running: Flight | null = c.flight;
      let flight: Flight;
      if (running) flight = running;
      else {
        const budget = budgetLeft(c, now());
        for (const r of open.slice(budget)) overBudget.add(r.id);
        flight = startFlight(c, open.slice(0, budget), deps, now, by);
      }
      if ((await Promise.race([flight.promise, timeout])) === "timeout") return { refreshing: true, overBudget };
      if (!running) return { refreshing: false, overBudget };
      joined = flight.by === by ? flight.ids : new Set();
    }
    return { refreshing: false, overBudget };
  } finally {
    clearTimeout(timer);
  }
}

// ── The body ───────────────────────────────────────────────────────────
function emptyBody(at: number): WorkMapChecksBody {
  return { at, checked: 0, compared: 0, unchecked: 0, unlinked: 0, skipped: 0, contradictions: [], prs: {}, needs: [], uncheckedRows: [], unlinkedRows: [] };
}

export function disabledChecksBody(at: number): WorkMapChecksBody {
  return { ...emptyBody(at), notChecked: { reason: "disabled", repos: [] } };
}

const FAILURE_ORDER = ["no-gh", "auth", "sso", "no-access"] as const;

function buildBody(s: Scan, c: WikiCache, refreshing: boolean, at: number): WorkMapChecksBody {
  const body = emptyBody(at);
  // A state past its hour is served only while its refresh runs: once that
  // refresh has failed, the state counts as unchecked.
  const known = (ref: PrRef): PrFact | null => knownFact(c, ref, refreshing, at) ?? null;
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
      if (!CLAIMABLE_STATES.has(row.state)) continue;
      body.compared++;
      if (row.refs.some((ref) => known(ref)!.state === "OPEN")) continue;
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
  const failure = failureFor(c, s.refs.values());
  if (failure) body.notChecked = failure;
  return body;
}

/** A state past its hour is served only while its refresh runs: once that
 *  refresh has failed, the state counts as unchecked. Undefined: not known;
 *  null: GitHub said no such PR. */
function knownFact(c: WikiCache, ref: PrRef, refreshing: boolean, at: number): PrFact | null | undefined {
  const hit = c.states.get(ref.id);
  return hit && (refreshing || at - hit.at < GH_STATE_TTL_MS) ? hit.state : undefined;
}

/** The worst reason a wanted repo's last query went unread, with its repos. */
function failureFor(c: WikiCache, refs: Iterable<PrRef>): { reason: Exclude<NotCheckedReason, "disabled">; repos: string[] } | undefined {
  const wanted = new Set([...refs].map((r) => r.repo.toLowerCase()));
  const failed = [...c.failures.entries()].filter(([repo]) => wanted.has(repo)).map(([, f]) => f);
  const reason = FAILURE_ORDER.find((r) => failed.some((f) => f.reason === r));
  return reason ? { reason, repos: failed.filter((f) => f.reason === reason).map((f) => f.repo) } : undefined;
}

/** What {@link prFactsFor} knows about some PRs. */
export interface PrFacts {
  /** Per `PrRef.id`: the fact, or null when GitHub said no such PR. A PR with
   *  no known state is absent. */
  facts: Map<string, PrFact | null>;
  refreshing: boolean;
  /** Ids the hourly budget left unasked. */
  overBudget: Set<string>;
  /** Per lowercased repo, why its last query went unread. */
  failures: Map<string, Exclude<NotCheckedReason, "disabled">>;
}

/**
 * Some PRs' states through this wiki's cache, flight and hourly budget, the
 * ones the card's check uses (the status date check reads one page's `prs:`
 * through it). A repo its queries left unanswered, and a PR its answered
 * query left with no state and no NOT_FOUND, are held for
 * {@link GH_FAILED_REPO_HOLD_MS}: no spawn for them until then. Its failures
 * are its own queries', never the card's.
 */
export async function prFactsFor(wiki: string, refs: readonly PrRef[], deps: GhCheckDeps, now: () => number): Promise<PrFacts> {
  const c = cacheFor(wiki);
  const byId = new Map(refs.map((r) => [r.id, r]));
  const { refreshing, overBudget } = await refreshDue(c, byId, deps, now, "page");
  const at = now();
  const facts = new Map<string, PrFact | null>();
  for (const ref of byId.values()) {
    const fact = knownFact(c, ref, refreshing, at);
    if (fact !== undefined) facts.set(ref.id, fact);
  }
  const failures = new Map<string, Exclude<NotCheckedReason, "disabled">>();
  for (const repo of new Set([...byId.values()].map((r) => r.repo.toLowerCase()))) {
    const f = c.pageFailures.get(repo);
    if (f) failures.set(repo, f.reason);
  }
  return { facts, refreshing, overBudget, failures };
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
  const { refreshing } = await refreshDue(c, scanned.refs, deps, now, "card");
  return buildBody(scanned, c, refreshing, now());
}
