/**
 * The boot line's peer rows (mimir plan «Drain the owner-step queue», P1b):
 * each muninn in `MUNINN_PEERS` answers its OWN boot line on
 * `GET /api/checks/boot-line` in a closed shape, and the asking instance shows
 * it under its own line on the Your work card. It is a route of its own, not a
 * step-check probe kind: a probe kind is a `<Check>` attribute a page can write.
 *
 * - The reply is checked whole ({@link readPeerBootLine}): `v`, `machine` equal
 *   to the name asked, a known row kind, every field present with its type,
 *   the text and unread names under their caps and passed through the peer
 *   channel's unsafe-character strip, the branch by {@link BRANCH_RE}. Anything
 *   off refuses the whole reply, and the row reads «<name>: no answer».
 * - Each peer is read inside {@link PEER_BOOT_LINE_TIMEOUT_MS}, apart from the
 *   local line; an answer is kept {@link PEER_BOOT_LINE_TTL_MS} under the
 *   machine's own key, a failure is not kept but opens this reader's down
 *   window: the step-check client's code (`createDownWindow`), its own
 *   instance, so an older muninn that 404s this route never makes the step
 *   checks skip a peer that answers them.
 * - The answering route returns only its own line, never its peers': two
 *   instances that list each other never loop.
 */

import { getLog } from "../../logging.ts";
import type { BootLine, BootRow } from "./boot-line.ts";
import { oneLine, PEER_DOWN_WINDOW_MS } from "./peer.ts";
import { boundedPeerGet, createDownWindow, failureLogFields, type FetchLike } from "./peer-request.ts";
import { stampSource, within, type Stamp } from "./two-clock.ts";

export const BOOT_LINE_PEER_PATH = "/api/checks/boot-line";
export const BOOT_LINE_PEER_VERSION = 1;
/** The asking side's whole request: the local line never waits longer than this for a peer. */
export const PEER_BOOT_LINE_TIMEOUT_MS = 4_000;
/** The answering side's own bound on its line, under {@link PEER_BOOT_LINE_TIMEOUT_MS}: a part still running then reads «not read». */
export const PEER_BOOT_ROUTE_BOUND_MS = 3_000;
/** A peer's answer is shown again for this long without asking. */
export const PEER_BOOT_LINE_TTL_MS = 20_000;
/** One line and its envelope are well under 4 KiB. */
export const PEER_BOOT_LINE_MAX_BYTES = 16 * 1024;
/** The longest text taken; a longer one refuses the reply. {@link toPeerBootLine} clamps to these caps, so a healthy peer never trips them. */
export const PEER_TEXT_MAX = 1_000;
/** The longest unread name taken, and how many. */
export const PEER_UNREAD_MAX = 100;
export const PEER_UNREAD_COUNT_MAX = 8;
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
const ROWS: ReadonlySet<string> = new Set<BootRow>(["start-unknown", "unread", "elsewhere", "moved-off", "newer", "same"]);

/** What a peer answers: its own line, no path. */
export interface PeerBootLine {
  row: BootRow;
  restart: boolean;
  text: string;
  /** The start commit, short; null when the start is unknown. */
  commit: string | null;
  pr: number | null;
  /** The branch muninn started on; null when detached or unknown. */
  branch: string | null;
  /** When it started, epoch ms; null when unknown. */
  at: number | null;
  unread: string[];
}

/** One peer row of `GET /api/wiki/boot-line`'s `peers`. */
export type BootLinePeerRow = ({ machine: string; answered: true } & PeerBootLine) | { machine: string; answered: false; why: string };

/** This instance's line in the closed shape it answers peers with, clamped to the caps {@link readPeerBootLine} refuses past. */
export function toPeerBootLine(line: BootLine): PeerBootLine {
  const s = line.start;
  const ref = s.known ? s.ref : null;
  const branch = ref?.startsWith("refs/heads/") ? ref.slice(11) : null;
  return {
    row: line.row,
    restart: line.restart,
    text: clamp(line.text, PEER_TEXT_MAX),
    commit: s.known ? s.commit.slice(0, 8) : null,
    pr: s.known ? s.pr : null,
    branch: branch !== null && BRANCH_RE.test(branch) && !branch.includes("..") ? branch : null,
    at: s.known ? s.at : null,
    unread: line.unread.slice(0, PEER_UNREAD_COUNT_MAX).map((u) => clamp(u, PEER_UNREAD_MAX)),
  };
}

/** `s` cut to `max` UTF-16 units with a visible «…», never splitting a surrogate pair. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}

const KEYS = ["row", "restart", "text", "commit", "pr", "branch", "at", "unread"] as const;

/** `machine`'s reply, or why it is refused. Pure. */
export function readPeerBootLine(body: unknown, machine: string): { value: PeerBootLine } | { refused: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { refused: "not a JSON object" };
  const b = body as Record<string, unknown>;
  if (b.v !== BOOT_LINE_PEER_VERSION) return { refused: "speaks another version" };
  if (b.machine !== machine) return { refused: "answered as another machine" };
  const l = b.line as Record<string, unknown> | null;
  if (!l || typeof l !== "object" || Array.isArray(l)) return { refused: "sent no line" };
  for (const k of KEYS) if (!(k in l)) return { refused: `sent no ${k}` };
  if (typeof l.row !== "string" || !ROWS.has(l.row)) return { refused: "answered a row muninn does not know" };
  if (typeof l.restart !== "boolean") return { refused: "sent a restart flag that is not true or false" };
  if (typeof l.text !== "string" || l.text.length > PEER_TEXT_MAX) return { refused: "sent a text that is not text or is too long" };
  const text = oneLine(l.text, PEER_TEXT_MAX);
  if (text === "") return { refused: "sent an empty text" };
  if (l.commit !== null && (typeof l.commit !== "string" || !COMMIT_RE.test(l.commit))) return { refused: "sent a commit that is not a sha" };
  if (l.pr !== null && (typeof l.pr !== "number" || !Number.isSafeInteger(l.pr) || l.pr <= 0)) return { refused: "sent a PR that is not a number" };
  if (l.branch !== null && (typeof l.branch !== "string" || !BRANCH_RE.test(l.branch) || l.branch.includes(".."))) return { refused: "sent a branch muninn does not take" };
  if (l.at !== null && (typeof l.at !== "number" || !Number.isFinite(l.at) || l.at < 0)) return { refused: "sent a start time that is not a time" };
  if (!Array.isArray(l.unread) || l.unread.length > PEER_UNREAD_COUNT_MAX) return { refused: "sent an unread list muninn does not take" };
  const unread: string[] = [];
  for (const u of l.unread) {
    if (typeof u !== "string" || u.length > PEER_UNREAD_MAX) return { refused: "sent an unread name muninn does not take" };
    const one = oneLine(u, PEER_UNREAD_MAX);
    if (one) unread.push(one);
  }
  return {
    value: { row: l.row as BootRow, restart: l.restart, text, commit: l.commit === null ? null : l.commit.slice(0, 8), pr: l.pr, branch: l.branch, at: l.at, unread },
  };
}

const log = getLog("wiki", "boot-line-peer");

export interface BootLinePeerDeps {
  peers: ReadonlyMap<string, string>;
  fetch?: FetchLike;
  timeoutMs?: number;
  ttlMs?: number;
  downMs?: number;
  maxBytes?: number;
  now?: () => number;
  /** Test seam: where the reader's failure and recovery lines go. */
  log?: PeerReaderLog;
}

type LogFn = (msg: string, props: Record<string, unknown>) => void;
export type PeerReaderLog = { warn: LogFn; info: LogFn; debug: LogFn };

/** Reads every peer's line; never rejects, and each peer is bounded by `timeoutMs` on its own. */
export type BootLinePeerReader = () => Promise<BootLinePeerRow[]>;

/** One instance per process: its cache and in-flight reads keep the card's asks from fanning out. */
export function createBootLinePeerReader(deps: BootLinePeerDeps): BootLinePeerReader {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = deps.timeoutMs ?? PEER_BOOT_LINE_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? PEER_BOOT_LINE_TTL_MS;
  const downMs = deps.downMs ?? PEER_DOWN_WINDOW_MS;
  const maxBytes = deps.maxBytes ?? PEER_BOOT_LINE_MAX_BYTES;
  const now = stampSource(deps.now);
  const out: PeerReaderLog = deps.log ?? log;
  // The card asks every minute and the window lasts 15 s, so each ask of a peer that stays down
  // opens a new window: only a peer's first failure, a changed reason and its recovery are warned.
  const failing = new Map<string, string>();
  const down = createDownWindow({
    downMs,
    now,
    onOpen: (machine, { reason, err }) => {
      const fields = { machine, reason, seconds: Math.round(downMs / 1000), ...failureLogFields(err) };
      if (failing.get(machine) === reason) out.debug("Boot-line peer {machine} still fails ({reason})", fields);
      else out.warn("Boot-line peer {machine} failed ({reason}); its row reads no answer until it answers", fields);
      failing.set(machine, reason);
    },
  });
  const cache = new Map<string, { row: BootLinePeerRow; at: Stamp }>();
  const inFlight = new Map<string, Promise<BootLinePeerRow>>();

  const ask = async (machine: string, base: string): Promise<BootLinePeerRow> => {
    const qs = new URLSearchParams({ v: String(BOOT_LINE_PEER_VERSION) });
    const got = await boundedPeerGet(`${base}${BOOT_LINE_PEER_PATH}?${qs}`, { fetch: doFetch, timeoutMs, maxBytes }, (body) => readPeerBootLine(body, machine));
    down.settle(machine, "failure" in got ? got.failure : undefined);
    if ("failure" in got) return { machine, answered: false, why: `the peer ${got.failure.reason}` };
    if (failing.delete(machine)) out.info("Boot-line peer {machine} answers again", { machine });
    const row: BootLinePeerRow = { machine, answered: true, ...got.value };
    cache.set(machine, { row, at: now() });
    return row;
  };

  const one = (machine: string, base: string): Promise<BootLinePeerRow> => {
    const t = now();
    const hit = cache.get(machine);
    if (hit && within(hit.at, ttlMs, t)) return Promise.resolve(hit.row);
    cache.delete(machine);
    const d = down.isDown(machine, t);
    if (d) return Promise.resolve({ machine, answered: false, why: `the peer was unreachable a moment ago (${d.reason})` });
    const running = inFlight.get(machine);
    if (running) return running;
    const p = ask(machine, base)
      .catch((): BootLinePeerRow => ({ machine, answered: false, why: "the peer read failed" }))
      .finally(() => inFlight.delete(machine));
    inFlight.set(machine, p);
    return p;
  };

  return () => Promise.all([...deps.peers].map(([machine, base]) => one(machine, base)));
}

/** The process's one reader, rebuilt only when the configured peers change; none without peers. */
let shared: { sig: string; read: BootLinePeerReader } | null = null;
export function sharedBootLinePeerReader(peers: ReadonlyMap<string, string>): BootLinePeerReader | undefined {
  if (peers.size === 0) return undefined;
  const sig = JSON.stringify([...peers]);
  if (shared?.sig !== sig) shared = { sig, read: createBootLinePeerReader({ peers }) };
  return shared.read;
}
