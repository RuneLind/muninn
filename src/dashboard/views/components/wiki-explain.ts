/**
 * Pure, side-effect-free helpers for the /wiki reader's **Select-to-Explain**
 * pill. Split out of `wiki-browser.ts` (which runs DOM code at module load, so
 * it can't be imported in tests) so the label-truncation + URL-building logic
 * can be unit-tested directly — the same split rationale as `wiki-filter.ts`
 * and `wiki-ask-render.ts`.
 */

/** Client-side cap on the selected passage — mirrors the server's
 *  `EXPLAIN_SELECTION_MAX` (`src/wiki/explain-context.ts`) so an over-long
 *  selection is trimmed identically before it rides the GET URL. */
export const EXPLAIN_SEL_MAX = 1500;

/** How many chars of the selection to echo in the turn's display label. */
export const EXPLAIN_LABEL_CHARS = 80;

/** Display-only turn label, e.g. `Explain: "the coverage gate…"`. This is what
 *  the user sees in the history list + answer headline; the SERVER builds its
 *  own question from `sel`, so this never has to be exact. */
export function explainLabel(sel: string): string {
  const s = sel.trim().replace(/\s+/g, " ");
  const short = s.length > EXPLAIN_LABEL_CHARS ? s.slice(0, EXPLAIN_LABEL_CHARS) + "…" : s;
  return 'Explain: "' + short + '"';
}

/** Build the `/api/wiki/explain` GET URL, omitting empty `ctx`/`history`/`wiki`
 *  params and capping `sel` at `EXPLAIN_SEL_MAX` to match the server. */
export function buildExplainUrl(opts: {
  sel: string;
  page: string;
  wiki?: string;
  ctx?: string;
  history?: string;
}): string {
  // Cap by code points, not UTF-16 units — a plain slice can bisect a surrogate
  // pair and make encodeURIComponent throw on the lone half.
  const sel =
    opts.sel.length > EXPLAIN_SEL_MAX ? [...opts.sel].slice(0, EXPLAIN_SEL_MAX).join("") : opts.sel;
  let url = "/api/wiki/explain?sel=" + encodeURIComponent(sel);
  url += "&page=" + encodeURIComponent(opts.page);
  if (opts.wiki) url += "&wiki=" + encodeURIComponent(opts.wiki);
  if (opts.ctx) url += "&ctx=" + encodeURIComponent(opts.ctx);
  if (opts.history) url += "&history=" + encodeURIComponent(opts.history);
  return url;
}

/** Display-only turn label for a fact check. `sel` mode echoes the passage; the
 *  whole-article variant passes an empty `sel` and labels by page title. */
export function factcheckLabel(sel: string, pageTitle?: string): string {
  const s = sel.trim().replace(/\s+/g, " ");
  if (!s) return "Fact check: " + (pageTitle ? pageTitle : "this article");
  const short = s.length > EXPLAIN_LABEL_CHARS ? s.slice(0, EXPLAIN_LABEL_CHARS) + "…" : s;
  return 'Fact check: "' + short + '"';
}

/** One `tool` SSE event from the fact-check verify fan-out (`factcheck-sse.ts`).
 *  `start` carries the server-computed `label`/`detail`; `end` just the identity
 *  (`name` + `claimIndex`). `claimIndex` is 1-based. */
export interface ToolLogEvent {
  state: "start" | "end";
  name: string;
  claimIndex: number;
  label?: string;
  detail?: string;
}

/** One row of the compact per-claim fact-check tool log. Rendered as
 *  `Claim <claimIndex> · <label>[: <detail>]`, dimmed once `done`. */
export interface ToolLogRow {
  claimIndex: number;
  name: string;
  label: string;
  detail?: string;
  done: boolean;
}

/** Fold one tool SSE event into the running per-claim tool-log rows (mutates +
 *  returns `rows`). A `start` appends a row; an `end` marks the FIRST still-open
 *  row matching `(name, claimIndex)` done — pairing per claim, so concurrent
 *  claims interleaving their tool events resolve to their own rows. An `end` with
 *  no open match (a dropped/duplicate event) is a no-op. */
export function applyToolLogEvent(rows: ToolLogRow[], ev: ToolLogEvent): ToolLogRow[] {
  if (ev.state === "start") {
    rows.push({
      claimIndex: ev.claimIndex,
      name: ev.name,
      label: ev.label || ev.name,
      detail: ev.detail,
      done: false,
    });
  } else {
    const row = rows.find((r) => !r.done && r.name === ev.name && r.claimIndex === ev.claimIndex);
    if (row) row.done = true;
  }
  return rows;
}

/** Text of a tool-log row's action, e.g. `Reading: example.com` or a bare
 *  `Searching the web` when no detail is present. The `Claim n ·` prefix is added
 *  by the renderer (kept separate so it can be styled as a grouping chip). */
export function toolLogRowLabel(row: ToolLogRow): string {
  return row.detail ? row.label + ": " + row.detail : row.label;
}

/** Build the `/api/wiki/factcheck` GET URL. `mode` is `sel` (selection-scoped —
 *  requires `sel`) or `article` (whole page — `sel` omitted). Caps `sel` at
 *  `EXPLAIN_SEL_MAX` to match the server, and omits empty params. */
export function buildFactcheckUrl(opts: {
  mode: "sel" | "article";
  page: string;
  wiki?: string;
  sel?: string;
  ctx?: string;
}): string {
  let url = "/api/wiki/factcheck?page=" + encodeURIComponent(opts.page);
  url += "&mode=" + opts.mode;
  if (opts.mode === "sel" && opts.sel) {
    const sel =
      opts.sel.length > EXPLAIN_SEL_MAX ? [...opts.sel].slice(0, EXPLAIN_SEL_MAX).join("") : opts.sel;
    url += "&sel=" + encodeURIComponent(sel);
    if (opts.ctx) url += "&ctx=" + encodeURIComponent(opts.ctx);
  }
  if (opts.wiki) url += "&wiki=" + encodeURIComponent(opts.wiki);
  return url;
}
