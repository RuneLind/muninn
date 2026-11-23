/// <reference lib="dom" />
/**
 * Live chips in the reader (living facts PR 3b). The server renders an empty
 * `span.fact-chip[data-live-fact]` after each PR or key mention its facts file
 * covers (`src/wiki/live-facts.ts`) and ships the entries as the page's
 * `facts`; this fills the text. A key chip's Jira status comes from the
 * deferred provenance answer (`issues` rows), so the page open never waits on
 * huginn: {@link adoptLiveFactIssues} refills the key chips when it lands.
 * The chips carry `data-reader-only`, so Explain, Ask and fact-check leave
 * their text out.
 */

import { chipView, FACT_CHIP_CLASS, LIVE_FACT_ATTR, type LiveFactsPayload } from "../../../wiki/core/live-facts-chip.ts";

export type { LiveFactsPayload };

export const FACT_CHIP_DIM_CLASS = "fact-chip-dim";

interface JiraFacts {
  status?: string;
  updated?: string;
}

let state: { root: Element; facts: LiveFactsPayload; language?: string; jira: Map<string, JiraFacts> } | null = null;

function paint(): void {
  if (!state) return;
  const { root, facts, language, jira } = state;
  const now = Date.now();
  root.querySelectorAll<HTMLElement>(`span.${FACT_CHIP_CLASS}[${LIVE_FACT_ATTR}]`).forEach((chip) => {
    const id = chip.getAttribute(LIVE_FACT_ATTR) ?? "";
    const view = chipView(id, facts, now, language, jira.get(id));
    chip.textContent = view?.text ?? "";
    chip.hidden = !view;
    chip.classList.toggle(FACT_CHIP_DIM_CLASS, view?.dim === true);
    if (view?.title) chip.title = view.title;
    else chip.removeAttribute("title");
  });
}

/** Fill the chips of a freshly rendered article. Without `facts` (a wiki with
 *  no facts file, or no chip on the page) it only forgets the last page. */
export function enhanceLiveFacts(root: Element, facts: LiveFactsPayload | undefined, language?: string): void {
  state = facts ? { root, facts, language, jira: new Map() } : null;
  paint();
}

/** The deferred provenance answer's issue rows: each key chip gains its Jira
 *  status and Jira's own `updated` date. */
export function adoptLiveFactIssues(issues: readonly { key: string; status?: string; updated?: string }[] | undefined): void {
  if (!state) return;
  state.jira = new Map((issues ?? []).map((r) => [r.key, { status: r.status, updated: r.updated }]));
  paint();
}

/** The chip's look: a quiet pill after the mention, dimmed when stale. */
export function liveFactsCss(): string {
  return `
    .wiki-article .${FACT_CHIP_CLASS} {
      display: inline-block; margin-left: 0.3em; padding: 0 0.45em; border-radius: 0.7em;
      font-size: 0.78em; line-height: 1.5; white-space: nowrap; vertical-align: 0.05em;
      background: var(--bg-surface); color: var(--text-secondary);
      border: 1px solid var(--border-secondary); user-select: none;
    }
    .wiki-article .${FACT_CHIP_CLASS}:empty, .wiki-article .${FACT_CHIP_CLASS}[hidden] { display: none; }
    .wiki-article .${FACT_CHIP_CLASS}.${FACT_CHIP_DIM_CLASS} { opacity: 0.55; }
  `;
}
