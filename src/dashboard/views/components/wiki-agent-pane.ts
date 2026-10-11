/// <reference lib="dom" />
/**
 * The Agent lens pane (reader-lenses D4, D7): the plan-card output for the open
 * page, word for word, in monospace, with its size against the card's 12k cap,
 * the list of cut sections, and `--since` / `--id` inputs.
 *
 * The pane fetches `GET /api/wiki/plan-card` each time the reader enters the
 * Agent lens (a click, or a `?lens=agent` link, the only two ways in: Agent is
 * never stored, D1), and when the reader runs it with other inputs. Nothing
 * fetches it on a page open, and an in-place reload of the page (a fact-check
 * append) carries the shown card and inputs over, marked as possibly stale,
 * rather than starting a child. A new run aborts the one in flight, so does a
 * navigation ({@link abortAgentRuns}), and a run that has no answer by
 * {@link AGENT_CLIENT_DEADLINE_MS} (the route's worst case, queue wait
 * included) is aborted with an error. A visually hidden status line is the
 * live region, so a screen reader hears the outcome, not the card. The server decides
 * whether the lens exists (`reader.agentLens`).
 */
import type { QuestionLanguage } from "../../../format/question-labels.ts";
import { PLAN_CARD_CLIENT_DEADLINE_MS } from "../../../wiki/plan-card-bounds.ts";

/** plan-card's `TOTAL_MAX`: the card's own cap, which `--full` alone lifts. */
export const AGENT_CARD_CAP = 12_000;
export const AGENT_PANE_CLASS = "wiki-agent-pane";
/** The client's own deadline: the route's worst case for an admitted request,
 *  its queue wait included (see `PLAN_CARD_CLIENT_DEADLINE_MS`). */
export const AGENT_CLIENT_DEADLINE_MS = PLAN_CARD_CLIENT_DEADLINE_MS;

type Lang = QuestionLanguage;

export interface AgentCut {
  section: string;
  pointer: string;
  start?: number;
  end?: number;
  /** Single lines (a log cut, a capped reference list), in place of a range. */
  lines?: number[];
  file?: string;
}

export interface AgentCard {
  text: string;
  chars: number;
  cuts: AgentCut[];
  ms: number;
}

export type AgentPaneState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; status: number; message: string }
  | { kind: "ok"; card: AgentCard };

/** The pane's words, per wiki language. */
export const AGENT_WORDS: Record<
  Lang,
  {
    pane: string;
    since: string;
    id: string;
    run: string;
    running: string;
    done: (chars: string) => string;
    failed: (status: string, message: string) => string;
    network: string;
    deadline: (s: number) => string;
    cuts: (n: number) => string;
    noCut: string;
    chars: string;
    overCap: string;
    stale: string;
    notRun: string;
    locale: string;
  }
> = {
  en: {
    pane: "Agent: the plan card a session loads",
    since: "since",
    id: "id",
    run: "Run plan-card",
    running: "Running plan-card…",
    done: (chars) => `plan-card done: ${chars} chars`,
    failed: (status, message) => `plan-card failed (${status}): ${message}`,
    network: "network",
    deadline: (s) => `no answer within ${s} s`,
    cuts: (n) => `${n} cut section${n === 1 ? "" : "s"}`,
    noCut: "No section cut.",
    chars: "chars",
    overCap: "over the cap",
    stale: "This card is from before the page was reloaded and may be stale. Run plan-card for a fresh one.",
    notRun: "The page was reloaded. Run plan-card for its card.",
    locale: "en-US",
  },
  no: {
    pane: "Agent: plankortet en sesjon laster",
    since: "siden",
    id: "id",
    run: "Kjør plan-card",
    running: "Kjører plan-card…",
    done: (chars) => `plan-card ferdig: ${chars} tegn`,
    failed: (status, message) => `plan-card feilet (${status}): ${message}`,
    network: "nettverk",
    deadline: (s) => `ikke svar innen ${s} s`,
    cuts: (n) => `${n} ${n === 1 ? "kuttet seksjon" : "kuttede seksjoner"}`,
    noCut: "Ingen seksjon er kuttet.",
    chars: "tegn",
    overCap: "over taket",
    stale: "Kortet er fra før siden ble lastet på nytt og kan være utdatert. Kjør plan-card for et ferskt kort.",
    notRun: "Siden ble lastet på nytt. Kjør plan-card for å se kortet.",
    locale: "nb-NO",
  },
};

/** The route URL for one run; blank inputs are left out. */
export function agentCardUrl(wiki: string, relPath: string, since: string, id: string): string {
  const q = new URLSearchParams();
  if (wiki) q.set("wiki", wiki);
  q.set("relPath", relPath);
  if (since.trim()) q.set("since", since.trim());
  if (id.trim()) q.set("id", id.trim());
  return `/api/wiki/plan-card?${q.toString()}`;
}

/** `8,321 / 12,000 chars · 1.2 s`, flagged when over the cap. */
export function agentMetaText(card: AgentCard, lang: Lang = "en"): string {
  const w = AGENT_WORDS[lang];
  const n = (v: number) => v.toLocaleString(w.locale);
  const over = card.chars > AGENT_CARD_CAP ? ` (${w.overCap})` : "";
  const secs = (card.ms / 1000).toLocaleString(w.locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${n(card.chars)} / ${n(AGENT_CARD_CAP)} ${w.chars}${over} · ${secs} s`;
}

/** One cut as a row: the section, the range or lines the pointer names, and
 *  the pointer. */
export function agentCutText(c: AgentCut): string {
  const range =
    c.start !== undefined && c.end !== undefined
      ? ` L${c.start}-${c.end}`
      : Array.isArray(c.lines) && c.lines.length
        ? ` ${c.lines.map((n) => `L${n}`).join(", ")}`
        : "";
  const file = c.file ? ` ${c.file.split("/").pop()}` : "";
  return `${c.section}${range}${file} — ${c.pointer}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** The pane body (everything under the controls) for a state. The card's
 *  `<pre>` is EMPTY here: the caller sets its `textContent`, because the HTML
 *  parser drops a `<pre>`'s leading newline and the card is shown word for word. */
export function agentBodyHtml(state: AgentPaneState, lang: Lang = "en"): string {
  const w = AGENT_WORDS[lang];
  switch (state.kind) {
    case "idle":
      return "";
    case "loading":
      return `<p class="wiki-agent-status">${esc(w.running)}</p>`;
    case "error":
      return `<p class="wiki-agent-status wiki-agent-error">${esc(w.failed(state.status ? String(state.status) : w.network, state.message))}</p>`;
    case "ok": {
      const { card } = state;
      const cuts = card.cuts.length
        ? `<details class="wiki-agent-cuts" open><summary>${esc(w.cuts(card.cuts.length))}</summary><ul>${card.cuts
            .map((c) => `<li>${esc(agentCutText(c))}</li>`)
            .join("")}</ul></details>`
        : `<p class="wiki-agent-status">${esc(w.noCut)}</p>`;
      return `${cuts}<pre class="wiki-agent-text"></pre>`;
    }
  }
}

/** The pane's live status line: one short sentence per state, so a screen
 *  reader hears "running", "done, N chars" or the error, never the card. */
export function agentLiveText(state: AgentPaneState, lang: Lang = "en"): string {
  const w = AGENT_WORDS[lang];
  switch (state.kind) {
    case "idle":
      return "";
    case "loading":
      return w.running;
    case "error":
      return w.failed(state.status ? String(state.status) : w.network, state.message);
    case "ok":
      return w.done(state.card.chars.toLocaleString(w.locale));
  }
}

/**
 * One run's request: the state it ends in, or null when `ctrl` was aborted from
 * outside (a newer run, a navigation), whose owner paints the pane. A run with
 * no answer by `deadlineMs` is aborted and ends in an error naming the deadline.
 */
export async function fetchAgentCard(
  url: string,
  ctrl: AbortController,
  opts: { fetchImpl?: typeof fetch; deadlineMs?: number; language?: Lang } = {},
): Promise<AgentPaneState | null> {
  const w = AGENT_WORDS[opts.language ?? "en"];
  const deadline = opts.deadlineMs ?? AGENT_CLIENT_DEADLINE_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, deadline);
  let state: AgentPaneState;
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, { signal: ctrl.signal });
    const json = (await res.json().catch(() => null)) as (AgentCard & { error?: string }) | null;
    state =
      res.ok && json && typeof json.text === "string"
        ? { kind: "ok", card: { text: json.text, chars: json.chars, cuts: Array.isArray(json.cuts) ? json.cuts : [], ms: json.ms ?? 0 } }
        : { kind: "error", status: res.status, message: json?.error ?? res.statusText };
  } catch (e) {
    state = { kind: "error", status: 0, message: timedOut ? w.deadline(Math.round(deadline / 1000)) : e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
  return ctrl.signal.aborted && !timedOut ? null : state;
}

/** What an in-place reload carries from the old pane to the new one. */
export interface AgentPaneSnapshot {
  since: string;
  id: string;
  /** The card on screen, or null when none was (a run in flight, an error). */
  card: AgentCard | null;
}

export interface AgentPaneOptions {
  wiki: string;
  relPath: string;
  /** The wiki's `language`, for the pane's words. */
  language?: Lang;
  /** An in-place reload's carry-over: shown instead of a run. */
  carry?: AgentPaneSnapshot;
  /** Test seam; default `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam; default {@link AGENT_CLIENT_DEADLINE_MS}. */
  deadlineMs?: number;
}

interface Pane {
  el: HTMLElement;
  run: () => Promise<void>;
  snapshot: () => AgentPaneSnapshot;
}

const panes = new WeakMap<Element, Pane>();
/** The runs in flight, for {@link abortAgentRuns}. */
const inFlight = new Set<AbortController>();

/** Abort every run in flight: the reader navigated away from its page. */
export function abortAgentRuns(): void {
  for (const c of inFlight) c.abort();
  inFlight.clear();
}

/** The pane's inputs and card for `article`, for an in-place reload; inputs
 *  blank and no card when the article has no pane. */
export function snapshotAgentPane(article: Element): AgentPaneSnapshot {
  return panes.get(article)?.snapshot() ?? { since: "", id: "", card: null };
}

function buildPane(article: HTMLElement, opts: AgentPaneOptions): Pane {
  const lang: Lang = opts.language ?? "en";
  const w = AGENT_WORDS[lang];
  const el = document.createElement("section");
  el.className = AGENT_PANE_CLASS;
  el.setAttribute("aria-label", w.pane);
  el.innerHTML =
    `<form class="wiki-agent-controls">` +
    `<label>${esc(w.since)} <input type="date" name="since"></label>` +
    `<label>${esc(w.id)} <input type="text" name="id" placeholder="D7, S1, Q-14" size="10" maxlength="40" autocomplete="off"></label>` +
    `<button type="submit">${esc(w.run)}</button>` +
    `<span class="wiki-agent-meta"></span>` +
    `</form><p class="wiki-agent-live" role="status" aria-live="polite"></p>` +
    `<p class="wiki-agent-status wiki-agent-stale" hidden></p><div class="wiki-agent-body"></div>`;
  article.after(el);
  const form = el.querySelector("form")!;
  const body = el.querySelector<HTMLElement>(".wiki-agent-body")!;
  const meta = el.querySelector<HTMLElement>(".wiki-agent-meta")!;
  const stale = el.querySelector<HTMLElement>(".wiki-agent-stale")!;
  const live = el.querySelector<HTMLElement>(".wiki-agent-live")!;
  const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  let shown: AgentCard | null = null;
  let current: AbortController | null = null;
  const paint = (state: AgentPaneState) => {
    body.innerHTML = agentBodyHtml(state, lang);
    body.setAttribute("aria-busy", state.kind === "loading" ? "true" : "false");
    shown = state.kind === "ok" ? state.card : null;
    if (state.kind === "ok") body.querySelector<HTMLElement>(".wiki-agent-text")!.textContent = state.card.text;
    meta.textContent = state.kind === "ok" ? agentMetaText(state.card, lang) : "";
    live.textContent = agentLiveText(state, lang);
  };
  const pane: Pane = {
    el,
    snapshot: () => ({ since: input("since").value, id: input("id").value, card: shown }),
    run: async () => {
      // A new run supersedes the one in flight.
      current?.abort();
      const ctrl = new AbortController();
      current = ctrl;
      inFlight.add(ctrl);
      stale.hidden = true;
      paint({ kind: "loading" });
      const state = await fetchAgentCard(agentCardUrl(opts.wiki, opts.relPath, input("since").value, input("id").value), ctrl, {
        fetchImpl: opts.fetchImpl,
        deadlineMs: opts.deadlineMs,
        language: lang,
      });
      inFlight.delete(ctrl);
      // Superseded by a later run, or aborted by a navigation: that one owns
      // the pane (or there is no pane on screen any more).
      if (!state) return;
      if (current === ctrl && el.isConnected) paint(state);
    },
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void pane.run();
  });
  if (opts.carry) {
    input("since").value = opts.carry.since;
    input("id").value = opts.carry.id;
    if (opts.carry.card) paint({ kind: "ok", card: opts.carry.card });
    stale.textContent = opts.carry.card ? w.stale : w.notRun;
    stale.hidden = false;
  }
  return pane;
}

/**
 * Show or hide the pane for `article`. Entering the Agent lens runs plan-card
 * (a click is the reader's request, so a re-entry runs it again with the
 * inputs on screen); a pane built from an in-place reload's `carry` does not.
 */
export function setAgentPane(article: HTMLElement, shown: boolean, opts: AgentPaneOptions | null): void {
  let pane = panes.get(article);
  let carried = false;
  if (!pane && shown && opts) {
    pane = buildPane(article, opts);
    panes.set(article, pane);
    carried = !!opts.carry;
    pane.el.hidden = true;
  }
  if (!pane) return;
  const entering = shown && pane.el.hidden;
  pane.el.hidden = !shown;
  if (entering && !carried) void pane.run();
}

/** The pane's CSS; the lens CSS hides the article itself in the Agent lens. */
export function agentPaneCss(): string {
  return `
    .${AGENT_PANE_CLASS}[hidden] { display: none; }
    .${AGENT_PANE_CLASS} { margin: 8px 0 24px; }
    .${AGENT_PANE_CLASS} .wiki-agent-controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
    .${AGENT_PANE_CLASS} input { font: inherit; padding: 2px 6px; background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-secondary); border-radius: 4px; }
    .${AGENT_PANE_CLASS} button { font: inherit; padding: 2px 10px; border: 1px solid var(--border-secondary); border-radius: 4px; background: var(--bg-surface); color: var(--text-primary); cursor: pointer; }
    .${AGENT_PANE_CLASS} .wiki-agent-meta { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--text-soft); }
    .${AGENT_PANE_CLASS} .wiki-agent-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .${AGENT_PANE_CLASS} .wiki-agent-status { font-size: 12px; color: var(--text-soft); margin: 4px 0; }
    .${AGENT_PANE_CLASS} .wiki-agent-error { color: var(--status-error, var(--text-primary)); }
    .${AGENT_PANE_CLASS} .wiki-agent-cuts { font-size: 12px; color: var(--text-secondary); margin: 4px 0 8px; }
    .${AGENT_PANE_CLASS} .wiki-agent-cuts ul { margin: 4px 0 0; padding-left: 18px; }
    .${AGENT_PANE_CLASS} .wiki-agent-text {
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.45;
      white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; padding: 12px;
      background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-secondary); border-radius: 6px;
    }
  `;
}
