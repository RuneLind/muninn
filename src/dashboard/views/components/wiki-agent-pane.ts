/// <reference lib="dom" />
/**
 * The Agent lens pane (reader-lenses D4, D7): the plan-card output for the open
 * page, word for word, in monospace, with its size against the card's 12k cap,
 * the list of cut sections, and `--since` / `--id` inputs.
 *
 * The pane fetches `GET /api/wiki/plan-card` when the Agent lens is shown, and
 * again when the reader runs it with other inputs. Nothing fetches it on a page
 * open: Agent is never stored (D1), so only a click or a `?lens=agent` link
 * shows it. The server decides whether the lens exists (`reader.agentLens`).
 */

/** plan-card's `TOTAL_MAX`: the card's own cap, which `--full` alone lifts. */
export const AGENT_CARD_CAP = 12_000;
export const AGENT_PANE_CLASS = "wiki-agent-pane";

export interface AgentCut {
  section: string;
  pointer: string;
  start?: number;
  end?: number;
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

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

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
export function agentMetaText(card: AgentCard): string {
  const n = (v: number) => v.toLocaleString("en-US");
  const over = card.chars > AGENT_CARD_CAP ? " (over the cap)" : "";
  return `${n(card.chars)} / ${n(AGENT_CARD_CAP)} chars${over} · ${(card.ms / 1000).toFixed(1)} s`;
}

/** One cut as a row: the section, the range the pointer names, and the pointer. */
export function agentCutText(c: AgentCut): string {
  const range = c.start !== undefined && c.end !== undefined ? ` L${c.start}-${c.end}` : "";
  const file = c.file ? ` ${c.file.split("/").pop()}` : "";
  return `${c.section}${range}${file} — ${c.pointer}`;
}

/** The pane body (everything under the controls) for a state. */
export function agentBodyHtml(state: AgentPaneState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "loading":
      return `<p class="wiki-agent-status">Running plan-card…</p>`;
    case "error":
      return `<p class="wiki-agent-status wiki-agent-error" role="alert">plan-card failed (${state.status || "network"}): ${esc(state.message)}</p>`;
    case "ok": {
      const { card } = state;
      const cuts = card.cuts.length
        ? `<details class="wiki-agent-cuts" open><summary>${card.cuts.length} cut section${card.cuts.length === 1 ? "" : "s"}</summary><ul>${card.cuts
            .map((c) => `<li>${esc(agentCutText(c))}</li>`)
            .join("")}</ul></details>`
        : `<p class="wiki-agent-status">No section cut.</p>`;
      return `${cuts}<pre class="wiki-agent-text">${esc(card.text)}</pre>`;
    }
  }
}

export interface AgentPaneOptions {
  wiki: string;
  relPath: string;
  /** Test seam; default `fetch`. */
  fetchImpl?: typeof fetch;
}

interface Pane {
  el: HTMLElement;
  loaded: boolean;
  run: () => Promise<void>;
}

const panes = new WeakMap<Element, Pane>();

function buildPane(article: HTMLElement, opts: AgentPaneOptions): Pane {
  const el = document.createElement("section");
  el.className = AGENT_PANE_CLASS;
  el.setAttribute("aria-label", "Agent: the plan card a session loads");
  el.innerHTML =
    `<form class="wiki-agent-controls">` +
    `<label>since <input type="date" name="since"></label>` +
    `<label>id <input type="text" name="id" placeholder="D7, S1, Q-14" size="10" maxlength="40" autocomplete="off"></label>` +
    `<button type="submit">Run plan-card</button>` +
    `<span class="wiki-agent-meta" aria-live="polite"></span>` +
    `</form><div class="wiki-agent-body"></div>`;
  article.after(el);
  const form = el.querySelector("form")!;
  const body = el.querySelector<HTMLElement>(".wiki-agent-body")!;
  const meta = el.querySelector<HTMLElement>(".wiki-agent-meta")!;
  let seq = 0;
  const paint = (state: AgentPaneState) => {
    body.innerHTML = agentBodyHtml(state);
    meta.textContent = state.kind === "ok" ? agentMetaText(state.card) : "";
  };
  const pane: Pane = {
    el,
    loaded: false,
    run: async () => {
      const mine = ++seq;
      pane.loaded = true;
      const since = (form.elements.namedItem("since") as HTMLInputElement).value;
      const id = (form.elements.namedItem("id") as HTMLInputElement).value;
      paint({ kind: "loading" });
      let state: AgentPaneState;
      try {
        const res = await (opts.fetchImpl ?? fetch)(agentCardUrl(opts.wiki, opts.relPath, since, id));
        const json = (await res.json().catch(() => null)) as (AgentCard & { error?: string }) | null;
        state =
          res.ok && json && typeof json.text === "string"
            ? { kind: "ok", card: { text: json.text, chars: json.chars, cuts: Array.isArray(json.cuts) ? json.cuts : [], ms: json.ms ?? 0 } }
            : { kind: "error", status: res.status, message: json?.error ?? res.statusText };
      } catch (e) {
        state = { kind: "error", status: 0, message: e instanceof Error ? e.message : String(e) };
      }
      // A later run (or another page) owns the pane now.
      if (mine === seq && el.isConnected) paint(state);
    },
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void pane.run();
  });
  return pane;
}

/** Show or hide the pane for `article`; the first show runs plan-card. */
export function setAgentPane(article: HTMLElement, shown: boolean, opts: AgentPaneOptions | null): void {
  let pane = panes.get(article);
  if (!pane && shown && opts) {
    pane = buildPane(article, opts);
    panes.set(article, pane);
  }
  if (!pane) return;
  pane.el.hidden = !shown;
  if (shown && !pane.loaded) void pane.run();
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
