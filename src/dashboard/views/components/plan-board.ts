/// <reference lib="dom" />
/**
 * The `/plans` board's DOM half — meters, controls, columns, cards and the
 * drawer, rendered from the payload the page embedded as `window.PLAN_BOARD`.
 *
 * Every RULE lives in `src/plans/board-client-pure.ts` (sorting, the degrade
 * rule, filters, the meter maths, the overlay merge) and is unit-tested there
 * with no DOM. This file only turns those results into elements — so a change
 * to what the board *means* is a test in the pure half, and a change to what it
 * *looks like* is here.
 *
 * Transcribed from the design prototype (`docs/proto/plan-board.html`), with
 * PR 2's two deliberate subtractions:
 *
 *   - **No drag.** Dragging is how a card changes STATUS, and PR 2 writes
 *     nothing; ranking within a column is done with the ▲▼ nudges instead.
 *   - **Priority is a draft.** Setting one writes the `localStorage` overlay
 *     and the UI says so, because there is no endpoint to send it to yet.
 *     `queue.yaml` and the plan's own frontmatter win on every load.
 */

import {
  BOARD_PRIORITIES,
  applyOverlay,
  canNudge,
  cardsInScope,
  computeMeters,
  familyCounts,
  filterCards,
  formatAge,
  formatUsd,
  isTerminalColumn,
  nudgeRanked,
  rankOf,
  sanitizeOverlay,
  showRankUi,
  sortCards,
  viewStateFromQuery,
  viewStateToQuery,
  visibleColumns,
  type BoardColumnKey,
  type BoardColumnMeta,
  type BoardOrder,
  type BoardOverlay,
  type BoardScope,
  type BoardSort,
  type BoardViewState,
  type EffectiveCard,
} from "../../../plans/board-client-pure.ts";
import type { BoardPayload } from "../../../plans/board.ts";
import type { PlanPriority } from "../../../plans/constants.ts";

const OVERLAY_KEY = "muninn.planboard.draft.v1";

/** Why a nudge is refused, in the words the button's tooltip uses. */
const NUDGE_OFF_SORT = "Switch Sort to “My order” to rank by hand";
const NUDGE_ON_DISK = "ranked in mimir's queue.yaml — editing arrives when the board can write";

interface ViewState extends BoardViewState {
  openSlug: string | null;
}

function el(tag: string, cls?: string | null, text?: string | null): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- overlay io

function loadOverlay(): BoardOverlay {
  try {
    const raw = localStorage.getItem(OVERLAY_KEY);
    if (!raw) return { priority: {}, order: {} };
    // Validated field by field, never cast: an older build of this page, a hand
    // edit, or a half-finished write can leave a priority the pill has no
    // colour for and an order entry no card can ever match.
    return sanitizeOverlay(JSON.parse(raw));
  } catch {
    // A corrupt draft is not worth taking the board down for.
    return { priority: {}, order: {} };
  }
}

function saveOverlay(overlay: BoardOverlay): void {
  try {
    localStorage.setItem(OVERLAY_KEY, JSON.stringify(overlay));
  } catch {
    /* private mode / quota — the board still works, the draft just does not persist */
  }
}

// ---------------------------------------------------------------- mount

export function mountPlanBoard(payload: BoardPayload, root: HTMLElement): void {
  // The URL is the view's home: a board someone filtered down to "huginn, p0,
  // by cost" is worth linking to, and a reload that silently threw the filter
  // away read as the board losing the plans it was just showing.
  const view: ViewState = { ...viewStateFromQuery(location.search), openSlug: null };
  // A `?sort=cost` link opened against a board with no money would sort by a
  // number nothing renders; the Cost button is disabled in that state, so the
  // URL must land where the button would.
  if (!payload.money.available && view.sort === "cost") view.sort = "rank";
  let overlay = loadOverlay();

  const metersBox = root.querySelector<HTMLElement>("#pbMeters")!;
  const controlsBox = root.querySelector<HTMLElement>("#pbControls")!;
  const boardBox = root.querySelector<HTMLElement>("#pbBoard")!;
  const draftBox = root.querySelector<HTMLElement>("#pbDraft")!;

  const columnMeta = new Map<string, BoardColumnMeta>(payload.columns.map((c) => [c.key, c]));
  const money = payload.money.available;

  interface Merged {
    cards: EffectiveCard[];
    order: BoardOrder;
    draftCols: Set<string>;
    /** Columns queue.yaml ranks — no ▲▼ until the board can write. */
    diskCols: Set<string>;
  }

  /** Merge the draft under the payload — disk wins, every render. */
  function merged(): Merged {
    const res = applyOverlay(payload.cards, payload.queue.order, overlay);
    // A draft the merge threw away (the disk took the column over, or none of
    // its slugs is in the column any more) is deleted from the STORED overlay
    // too, so it cannot reappear the day someone edits queue.yaml. Purging
    // here is stable: the next applyOverlay reports nothing stale, so this
    // cannot loop.
    if (res.staleDraftColumns.some((key) => overlay.order[key])) {
      const order = { ...overlay.order };
      for (const key of res.staleDraftColumns) delete order[key];
      overlay = { priority: { ...overlay.priority }, order };
      saveOverlay(overlay);
    }
    const draftCols = new Set(
      Object.entries(res.orderIsDraft)
        .filter(([, isDraft]) => isDraft)
        .map(([key]) => key),
    );
    return { cards: res.cards, order: res.order, draftCols, diskCols: new Set(res.diskRanked) };
  }

  /** Mirror the view into the URL. `replaceState`, not `pushState`: a chip
   *  click is not a navigation, and Back must leave the board, not walk back
   *  through eleven filter changes. */
  function syncUrl(): void {
    try {
      history.replaceState(history.state, "", `${location.pathname}${viewStateToQuery(view)}`);
    } catch {
      /* sandboxed / opaque origin — the board works, the link just is not shareable */
    }
  }

  function render(): void {
    // A chip or segment click re-renders the controls it was fired from, which
    // destroys the focused button. Remember which one it was by its stable key
    // and give focus back after the rebuild — otherwise keyboard filtering
    // dumps the user back at the top of the document on every click.
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && controlsBox.contains(active) ? active.dataset.key ?? null : null;
    // A ▲/▼ press rebuilds the whole board, so the pressed button is destroyed
    // too — and it lives in `boardBox`, which the key above deliberately does
    // not cover. Remember it the way the drawer remembers its opener: by the
    // stable pair (slug, direction), re-found after the rebuild.
    const nudgeFocus =
      active && boardBox.contains(active) && active.dataset.slug && active.dataset.dir
        ? { slug: active.dataset.slug, dir: active.dataset.dir }
        : null;

    const { cards, order, draftCols, diskCols } = merged();
    const shown = filterCards(cards, view.filters);
    renderMeters(shown);
    renderControls(cards);
    renderBoard(shown, order, draftCols, diskCols);
    renderDraftNote(cards, order, draftCols);
    syncUrl();

    if (focusKey) {
      controlsBox.querySelector<HTMLElement>(`[data-key="${cssEscape(focusKey)}"]`)?.focus();
    }
    if (nudgeFocus) restoreNudgeFocus(nudgeFocus.slug, nudgeFocus.dir);
  }

  /**
   * Put focus back on the nudge that was just pressed.
   *
   * The same button first — but a nudge can DISABLE the button that fired it:
   * ▲ on an unranked card ranks it, and a card that lands at #1 has no ▲ any
   * more. A disabled button cannot hold focus, so the card's other nudge takes
   * it (same control group, one button away, and it is the move that undoes
   * what was just done), and the card itself is the last resort — anything
   * rather than dropping the keyboard back to `<body>`.
   */
  function restoreNudgeFocus(slug: string, dir: string): void {
    const base = `.pb-nudge button[data-slug="${cssEscape(slug)}"]`;
    const pick = (d: string) =>
      boardBox.querySelector<HTMLButtonElement>(`${base}[data-dir="${d}"]`);
    const same = pick(dir);
    if (same && !same.disabled) {
      same.focus();
      return;
    }
    const other = pick(dir === "up" ? "down" : "up");
    if (other && !other.disabled) {
      other.focus();
      return;
    }
    boardBox.querySelector<HTMLElement>(`.pb-card[data-slug="${cssEscape(slug)}"]`)?.focus();
  }

  // ---------------------------------------------------------------- meters
  /**
   * The meter strip.
   *
   * **Every COUNT is over the cards this scope actually renders** — the strip
   * used to count the filtered corpus, so under `Active` the "of N"
   * denominator and the follow-ups tile described columns that were not on
   * screen. What each tile means, one line each:
   *
   *   - **Active plans** — active cards visible now, of all cards visible now.
   *   - **In flight** — visible cards in the in-flight column (an active
   *     column, so it is in every scope).
   *   - **Backlog, priced** — visible active cards carrying an estimate.
   *   - **Spent to date** — deliberately CORPUS-WIDE (over the filtered cards,
   *     every scope): it is the context the estimates are read against, not a
   *     count of what is on screen, and it would otherwise read `$0` under the
   *     default scope, which shows no terminal column at all. The note says so.
   *   - **Median age** — visible active cards that carry a `status_date`.
   *   - **Follow-ups open** — visible follow-up cards; `—`, never `0`, in a
   *     scope with no follow-ups column, because absent is not zero.
   */
  function renderMeters(shown: readonly EffectiveCard[]): void {
    const inScope = cardsInScope(shown, view.scope);
    const m = computeMeters(inScope, money);
    const corpus = computeMeters(shown, money);
    const showsFollowups = visibleColumns(view.scope).some((c) => c.key === "followups");
    const scoped = view.scope === "all" ? "" : " in this scope";
    metersBox.textContent = "";
    const tiles: Array<{ k: string; v: string; sub?: string; note: string }> = [
      {
        k: "Active plans",
        v: String(m.activeCount),
        sub: `of ${m.totalCount}`,
        note: `proposed · ready · in flight · blocked — of the ${m.totalCount} card(s) this scope shows`,
      },
      {
        k: "In flight",
        v: String(m.inFlightCount),
        note: m.inFlightCount ? "running right now" : "nothing running",
      },
      {
        k: "Backlog, priced",
        v: m.backlog ? formatUsd(m.backlog.mid) : "—",
        note: m.backlog
          ? `${formatUsd(m.backlog.low)}–${formatUsd(m.backlog.high)} band over the ${m.backlog.count} active plan(s)${scoped} that can be priced`
          : payload.money.reason ?? "no estimate available",
      },
      {
        k: "Spent to date",
        v: corpus.spentToDate !== null ? formatUsd(corpus.spentToDate) : "—",
        note:
          corpus.spentToDate !== null
            ? "recorded cost of every shipped plan — all scopes, not just the columns shown"
            : "the ledger is not answering",
      },
      {
        k: "Median age",
        v: m.medianAgeDays !== null ? String(m.medianAgeDays) : "—",
        sub: m.medianAgeDays !== null ? "days" : undefined,
        note: `since the last status_date on an active plan${scoped}`,
      },
      {
        k: "Follow-ups open",
        v: showsFollowups ? String(m.followupsCount) : "—",
        note: showsFollowups
          ? "shipped, but the plan still carries followups: open"
          : "no follow-ups column in this scope — switch to “+ Follow-ups”",
      },
    ];
    for (const t of tiles) {
      const tile = el("div", "pb-meter");
      tile.append(el("div", "pb-k", t.k));
      const v = el("div", "pb-v");
      v.append(document.createTextNode(t.v));
      if (t.sub) v.append(el("small", null, t.sub));
      tile.append(v, el("div", "pb-n", t.note));
      metersBox.append(tile);
    }
  }

  // ---------------------------------------------------------------- controls
  function renderControls(cards: readonly EffectiveCard[]): void {
    controlsBox.textContent = "";

    const scopes: Array<[BoardScope, string]> = [
      ["active", "Active"],
      ["followups", "+ Follow-ups"],
      ["all", "Everything"],
    ];
    controlsBox.append(
      segment("Show", scopes, view.scope, (k) => {
        view.scope = k;
        render();
      }),
    );

    const famBox = el("div", "pb-ctl");
    famBox.append(el("span", "pb-lab", "Repo"));
    const chips = el("div", "pb-chips");
    const visible = new Set(visibleColumns(view.scope).map((c) => c.key));
    const counts = familyCounts(cards.filter((c) => visible.has(c.column)));
    // A selected family with no chip in the current scope still gets one, at
    // count 0. Without it, narrowing the scope deletes the very control that
    // is emptying the board — the facet rule the wiki reader learned the hard
    // way (`facetKeys`): a control may never remove its own active value.
    for (const family of view.filters.families) {
      if (!counts.some((c) => c.family === family)) counts.push({ family, count: 0 });
    }
    for (const { family, count } of counts) {
      const b = el("button", "pb-chip") as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `repo:${family}`;
      b.append(document.createTextNode(family), el("span", "pb-c", String(count)));
      b.setAttribute("aria-pressed", String(view.filters.families.includes(family)));
      if (count === 0) b.title = `no ${family} plan in this scope — click to clear the filter`;
      b.onclick = () => {
        const on = view.filters.families.includes(family);
        view.filters = {
          ...view.filters,
          families: on
            ? view.filters.families.filter((f) => f !== family)
            : [...view.filters.families, family],
        };
        render();
      };
      chips.append(b);
    }
    famBox.append(chips);
    controlsBox.append(famBox);

    const priBox = el("div", "pb-ctl");
    priBox.append(el("span", "pb-lab", "Priority"));
    const pchips = el("div", "pb-chips");
    for (const p of [...BOARD_PRIORITIES, "unset"] as Array<PlanPriority | "unset">) {
      const b = el("button", "pb-chip", p) as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `pri:${p}`;
      b.setAttribute("aria-pressed", String(view.filters.priority === p));
      b.onclick = () => {
        view.filters = { ...view.filters, priority: view.filters.priority === p ? null : p };
        render();
      };
      pchips.append(b);
    }
    priBox.append(pchips);
    controlsBox.append(priBox);

    const sorts: Array<[BoardSort, string]> = [
      ["rank", "My order"],
      ["age", "Age"],
      ["priority", "Priority"],
      ["cost", "Cost"],
    ];
    // With no money there is nothing to sort by: every card's cost is hidden,
    // so a live Cost button can only reshuffle the board into an order the
    // reader cannot see the reason for. Disabled, carrying the reason.
    const disabledSorts = money
      ? undefined
      : new Map<BoardSort, string>([
          ["cost", payload.money.reason ?? "no cost on this board — the ledger is not answering"],
        ]);
    controlsBox.append(
      segment(
        "Sort",
        sorts,
        view.sort,
        (k) => {
          view.sort = k;
          render();
        },
        disabledSorts,
      ),
    );

    const search = document.createElement("input");
    search.type = "search";
    search.className = "pb-search";
    search.dataset.key = "search";
    search.placeholder = "Filter by title, slug or tag";
    search.value = view.filters.query;
    search.setAttribute("aria-label", "Filter plans");
    // Typing re-renders the board and the meters but NOT the controls: replacing
    // the input under the caret is how a search box loses focus mid-word.
    search.oninput = () => {
      view.filters = { ...view.filters, query: search.value };
      const { cards: all, order, draftCols, diskCols } = merged();
      const shown = filterCards(all, view.filters);
      renderMeters(shown);
      renderBoard(shown, order, draftCols, diskCols);
      syncUrl();
    };
    controlsBox.append(search);
  }

  function segment<T extends string>(
    label: string,
    options: Array<[T, string]>,
    active: T,
    onPick: (value: T) => void,
    disabled?: Map<T, string>,
  ): HTMLElement {
    const box = el("div", "pb-ctl");
    box.append(el("span", "pb-lab", label));
    const seg = el("div", "pb-seg");
    for (const [key, text] of options) {
      const b = el("button", null, text) as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `${label}:${key}`;
      b.setAttribute("aria-pressed", String(active === key));
      const why = disabled?.get(key);
      if (why) {
        b.disabled = true;
        b.title = why;
      }
      b.onclick = () => onPick(key);
      seg.append(b);
    }
    box.append(seg);
    return box;
  }

  // ---------------------------------------------------------------- board
  function renderBoard(
    shown: readonly EffectiveCard[],
    order: BoardOrder,
    draftCols: Set<string>,
    diskCols: Set<string>,
  ): void {
    boardBox.textContent = "";
    for (const col of visibleColumns(view.scope)) {
      const inColumn = sortCards(
        shown.filter((c) => c.column === col.key),
        view.sort,
        order[col.key] ?? [],
      );
      const box = el("div", "pb-col");
      box.style.setProperty("--pb-tone", `var(${col.tone})`);

      const head = el("div", "pb-head");
      head.title = col.hint;
      head.append(el("span", "pb-swatch"), el("span", "pb-name", col.label));
      if (money) {
        const sum = inColumn.reduce(
          (s, c) => s + (isTerminalColumn(c.column) ? c.ledger?.costUSD ?? 0 : c.estimate?.mid ?? 0),
          0,
        );
        head.append(el("span", "pb-money", inColumn.length ? formatUsd(sum) : ""));
      }
      if (draftCols.has(col.key) && showRankUi(view.sort)) {
        head.append(el("span", "pb-draft-pill", "draft order"));
      }
      head.append(el("span", "pb-count", String(inColumn.length)));
      box.append(head);

      const stack = el("div", "pb-stack");
      if (inColumn.length === 0) stack.append(el("div", "pb-empty", "nothing here"));
      // A nudge edits the column's RANKED LIST — the prefix someone actually
      // placed — never the displayed column and never the filtered view. Every
      // position in it is explicit, so a repo filter or a search cannot change
      // what ▲▼ does, and ranking one card ranks exactly one card.
      const ranked = order[col.key] ?? [];
      for (const card of inColumn) {
        stack.append(renderCard(card, col, order, ranked, diskCols.has(col.key)));
      }
      box.append(stack);
      boardBox.append(box);
    }
  }

  function renderCard(
    card: EffectiveCard,
    col: BoardColumnMeta,
    order: BoardOrder,
    ranked: readonly string[],
    diskRanked: boolean,
  ): HTMLElement {
    const wrap = el("div", "pb-cardwrap");
    wrap.dataset.slug = card.slug;

    const button = el("button", "pb-card") as HTMLButtonElement;
    button.type = "button";
    button.dataset.slug = card.slug;
    if (view.openSlug === card.slug) button.classList.add("pb-sel");

    const r1 = el("div", "pb-r1");
    const rank = rankOf(order, col.key, card.slug);
    if (rank >= 0 && showRankUi(view.sort)) r1.append(el("span", "pb-rank", `#${rank + 1}`));
    const pill = el(
      "span",
      `pb-pri${card.effectivePriority ? "" : " pb-pri-unset"}${card.priorityIsDraft ? " pb-pri-draft" : ""}`,
      card.effectivePriority ?? "—",
    );
    if (card.effectivePriority) {
      pill.style.setProperty("--pb-pri-color", `var(--pb-${card.effectivePriority})`);
    }
    if (card.priorityIsDraft) pill.title = "Draft — not saved to mimir yet";
    r1.append(pill);
    const fam = el("span", `pb-fam${card.familyConfident ? "" : " pb-fam-soft"}`, card.family);
    // Three-way, exactly as the drawer's basis line reads it — "guessed from
    // the slug" over a family nothing attributed at all is a claim the board
    // did not make.
    fam.title =
      card.familySource === "prs"
        ? "family from the PRs this plan landed"
        : card.familySource === "slug"
          ? "family guessed from the slug"
          : "not attributable — no PRs in the ledger and nothing in the slug";
    r1.append(fam);
    if (card.mixedRepos) r1.append(el("span", "pb-fam pb-fam-soft", "mixed"));
    if (card.followupsOpen && card.column !== "followups") {
      const flag = el("span", "pb-flag", "⚑");
      flag.title = "followups: open";
      r1.append(flag);
    }
    button.append(r1);

    button.append(el("div", "pb-title", card.title));
    // 91 of mimir's 185 plans carry no title, so the store falls back to the
    // slug — printing it twice is noise on half the board.
    if (card.title !== card.slug) button.append(el("div", "pb-slug", card.slug));

    const r2 = el("div", "pb-r2");
    if (money) {
      if (isTerminalColumn(card.column) && card.ledger) {
        const landed = card.ledger.landed ?? 0;
        r2.append(el("span", "pb-est", `${formatUsd(card.ledger.costUSD)} · ${landed} PR${landed === 1 ? "" : "s"}`));
      } else if (isTerminalColumn(card.column)) {
        // A terminal card with no ledger row has no SPEND, and the column
        // header sums actuals only — so the card says "—" too, and the
        // estimate rides along muted and labelled. Rendering the band here
        // unlabelled read as money that was spent.
        const dash = el("span", "pb-est pb-est-guess", "—");
        dash.title = "no ledger row in claude-usage for this plan — nothing recorded to sum";
        r2.append(dash);
        if (card.estimate?.mid != null) {
          r2.append(
            el("span", "pb-prs pb-prs-guess", `est ${formatUsd(card.estimate.mid)} · no ledger row`),
          );
        }
      } else if (card.estimate?.mid != null) {
        const e = card.estimate;
        const est = el(
          "span",
          `pb-est${e.assumedCount ? " pb-est-guess" : ""}`,
          `${formatUsd(e.low)}–${formatUsd(e.high)} · ${formatUsd(e.mid)}`,
        );
        est.title = `Band from ${e.sampleSize} shipped plans in ${e.poolKey}`;
        r2.append(est);
        r2.append(
          el(
            "span",
            e.assumedCount ? "pb-prs pb-prs-guess" : "pb-prs",
            `${e.prCount} PR${e.prCount === 1 ? "" : "s"}${e.assumedCount ? "?" : ""}`,
          ),
        );
      }
    }
    const age = el("span", "pb-age", formatAge(card.ageDays));
    if (card.statusDate) age.title = `status_date ${card.statusDate}`;
    r2.append(age);
    button.append(r2);

    button.onclick = () => openDrawer(card, button);
    wrap.append(button);

    const link = openLink(card.wikiUrl, `Open ${card.title} in the mimir reader`);
    link.className = "pb-open";
    wrap.append(link);

    // The nudges are ALWAYS rendered, disabled where they cannot act, and the
    // tooltip says which of the three reasons applies. A control that vanishes
    // under another sort reads as a board that lost the ability to rank.
    const nudges = el("div", "pb-nudge");
    const rankUi = showRankUi(view.sort);
    const isRanked = ranked.includes(card.slug);
    for (const [delta, glyph, word] of [
      [-1, "▲", "up"],
      [1, "▼", "down"],
    ] as Array<[-1 | 1, string, string]>) {
      const b = el("button", null, glyph) as HTMLButtonElement;
      b.type = "button";
      // The pair that survives the rebuild a nudge causes — see
      // `restoreNudgeFocus`. `data-key` is the controls' namespace; these are
      // per-card, so they carry their own.
      b.dataset.slug = card.slug;
      b.dataset.dir = delta === -1 ? "up" : "down";
      const blocked = !rankUi || diskRanked;
      b.disabled = blocked || !canNudge(ranked, card.slug, delta);
      // The action is stated, not the direction: ▲ on an unranked card RANKS
      // it, and ▼ on the last ranked card un-ranks it.
      const action = !isRanked
        ? delta === -1
          ? `Rank in ${col.label}`
          : `Not ranked in ${col.label}`
        : delta === 1 && ranked[ranked.length - 1] === card.slug
          ? `Un-rank in ${col.label}`
          : `Move ${word} in ${col.label}`;
      b.title = !rankUi ? NUDGE_OFF_SORT : diskRanked ? NUDGE_ON_DISK : action;
      b.setAttribute("aria-label", `${action}: ${card.title}`);
      b.onclick = (ev) => {
        ev.stopPropagation();
        nudge(card.slug, col.key, ranked, delta);
      };
      nudges.append(b);
    }
    wrap.append(nudges);
    return wrap;
  }

  /**
   * The open-the-plan link. Its own anchor rather than a click handler, so
   * cmd-click and middle-click open a tab the way every other link does — and
   * it stops the click from reaching the card, whose body means "open the
   * drawer" (settled by the prototype).
   */
  function openLink(href: string, title: string): HTMLAnchorElement {
    const a = document.createElement("a");
    a.href = href;
    a.title = title;
    // Prototype parity, and the reason for it: the board is a place someone
    // works THROUGH — opening a plan must not replace the filtered board they
    // spent the last minute building.
    a.target = "_blank";
    a.rel = "noopener";
    a.setAttribute("aria-label", title);
    a.innerHTML =
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M6.5 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5v-3"/>' +
      '<path d="M9.5 2.5H14v4.5"/><path d="M7 9l6.5-6.5"/></svg>';
    a.onclick = (ev) => ev.stopPropagation();
    return a;
  }

  /**
   * Rank a card by hand — the ranked PREFIX is what is written, never the
   * displayed column: ranking one card must leave the other 48 unranked, and
   * a filter that hides half the column cannot change what the move means.
   *
   * An emptied list DELETES the column's entry rather than storing `[]`: an
   * empty order is the same statement as no order ("nothing here is
   * hand-ranked"), and keeping it would make the column read as drafted.
   *
   * **What is written is the MERGED list, not the stored one.** `ranked` comes
   * from `applyOverlay`, which filters a column's order to the slugs actually
   * in that column right now — so a nudge rewrites the column's draft as
   * "these cards, in this order", and any slug that has moved column or left
   * the corpus is pruned by the same write. That is the intended behaviour:
   * the reader ranks what they can see, and a dead slug holding position #1
   * pushes every real badge down by one.
   */
  function nudge(
    slug: string,
    column: BoardColumnKey,
    ranked: readonly string[],
    delta: -1 | 1,
  ): void {
    const next = nudgeRanked(ranked, slug, delta);
    if (!next) return;
    const order = { ...overlay.order };
    if (next.length === 0) delete order[column];
    else order[column] = next;
    overlay = { priority: { ...overlay.priority }, order };
    saveOverlay(overlay);
    render();
  }

  // ---------------------------------------------------------------- drawer

  /** The card button the drawer was opened from — focus goes back to it on
   *  close, so Escape leaves the keyboard where it was, not at `<body>`. */
  let drawerOpener: HTMLElement | null = null;

  function openDrawer(card: EffectiveCard, opener?: HTMLElement | null): void {
    const restoreTo = opener ?? drawerOpener;
    closeDrawer({ silent: true });
    drawerOpener = restoreTo ?? null;
    view.openSlug = card.slug;

    const scrim = el("div", "pb-scrim");
    scrim.onclick = () => closeDrawer();
    const drawer = el("aside", "pb-drawer");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-modal", "true");
    drawer.setAttribute("aria-label", card.title);
    // Focusable so the panel itself can hold focus — a dialog whose focus is
    // still on the card behind the scrim tabs into a board the reader cannot
    // see and cannot click.
    drawer.tabIndex = -1;
    const col = columnMeta.get(card.column);
    if (col) drawer.style.setProperty("--pb-tone", `var(${col.tone})`);

    const head = el("div", "pb-dh");
    const titleBox = el("div");
    titleBox.append(el("h2", null, card.title));
    const sub = el("div", "pb-r2");
    sub.append(el("span", "pb-fam", card.family), el("span", "pb-slug", card.slug));
    sub.append(el("span", "pb-est", col?.label ?? card.column));
    sub.append(el("span", "pb-age", card.statusDate ? `since ${card.statusDate}` : "no status_date"));
    titleBox.append(sub);
    const acts = el("div", "pb-acts");
    const big = openLink(card.wikiUrl, `Open ${card.relPath} in the mimir reader`);
    big.className = "pb-openbig";
    big.append(document.createTextNode("Open plan"));
    const close = el("button", "pb-x", "Close") as HTMLButtonElement;
    close.type = "button";
    close.onclick = () => closeDrawer();
    acts.append(big, close);
    head.append(titleBox, acts);

    const body = el("div", "pb-db");
    if (card.description) body.append(el("p", "pb-desc", card.description));
    if (card.statusNote) {
      const s = el("div", "pb-sec");
      s.append(el("h3", null, "Status note"), el("div", "pb-note", card.statusNote));
      body.append(s);
    }
    if (card.tags.length) {
      const s = el("div", "pb-sec");
      s.append(el("h3", null, "Tags"));
      const list = el("div", "pb-chips");
      for (const tag of card.tags) list.append(el("span", "pb-chip pb-chip-static", tag));
      s.append(list);
      body.append(s);
    }

    body.append(estimateSection(card));
    if (card.ledger) {
      body.append(ledgerSection(card));
    } else if (money && isTerminalColumn(card.column)) {
      // Terminal and unrecorded: say so under the same heading the recorded
      // ones use, so the card, the drawer and the column total tell one story
      // (the header sums actuals, and this plan contributes none).
      const s = el("div", "pb-sec");
      s.append(
        el("h3", null, "What it actually cost"),
        el(
          "p",
          "pb-basis",
          "No ledger row — claude-usage has nothing recorded against this plan, so it adds nothing to the column's total.",
        ),
      );
      body.append(s);
    }
    body.append(prioritySection(card));

    const fileSec = el("div", "pb-sec");
    fileSec.append(el("h3", null, "File"));
    const fileLink = document.createElement("a");
    fileLink.className = "pb-filelink";
    fileLink.href = card.wikiUrl;
    fileLink.target = "_blank";
    fileLink.rel = "noopener";
    fileLink.textContent = card.relPath;
    fileSec.append(fileLink);
    fileSec.append(
      el(
        "p",
        "pb-basis",
        `Family ${card.family} — ${card.familySource === "prs" ? "by the PRs it landed" : card.familySource === "slug" ? "by its slug" : "not attributable"}${card.mixedRepos ? ", PRs span more than one repo" : ""}.`,
      ),
    );
    body.append(fileSec);

    drawer.append(head, body);
    // Mounted INSIDE `#pbRoot`, not on `<body>`: every `--pb-*` token is
    // defined on `.pb`, so a drawer outside it renders with each of them
    // undefined — which is how the selected priority button lost its fill in
    // light theme and the status note lost its coloured spine.
    root.append(scrim, drawer);
    document.addEventListener("keydown", escClose);
    // `aria-modal="true"` is a CLAIM, and these two are what make it true: the
    // scrim stops the pointer, `inert` stops the tab order and the screen
    // reader from reaching the board underneath, and the Tab handler wraps
    // within the panel so the keyboard cannot walk out of it either.
    drawer.addEventListener("keydown", trapDrawerTab);
    setBackdropInert(true);
    // Selection is a one-class change on two buttons, NOT a re-render: a full
    // render rebuilds every card, which throws away the focus the drawer just
    // took and the caret in the search box.
    markSelected(card.slug);
    drawer.focus();
  }

  /** Paint the `pb-sel` ring without touching the rest of the board. */
  function markSelected(slug: string | null): void {
    boardBox.querySelectorAll<HTMLElement>(".pb-card").forEach((b) => {
      b.classList.toggle("pb-sel", slug !== null && b.dataset.slug === slug);
    });
  }

  function estimateSection(card: EffectiveCard): HTMLElement {
    const terminal = isTerminalColumn(card.column);
    const sec = el("div", "pb-sec");
    // On a terminal card this section is the PREDICTION, not the spend — the
    // actuals live under "What it actually cost" below it. Heading it "What it
    // cost" put an estimate under the one word that means money that left.
    sec.append(el("h3", null, terminal ? "What the model would have estimated" : "What it should cost"));
    if (!money || !card.estimate || card.estimate.mid === null) {
      sec.append(
        el("p", "pb-basis", payload.money.reason ?? "No shipped plan in the ledger prices this one yet."),
      );
      return sec;
    }
    const e = card.estimate;
    const kv = el("div", "pb-kv");
    const cell = (k: string, v: string) => {
      const c = el("div");
      c.append(el("div", "pb-k", k), el("div", "pb-v", v));
      return c;
    };
    kv.append(
      cell("Estimate", formatUsd(e.mid)),
      cell("Band", `${formatUsd(e.low)}–${formatUsd(e.high)}`),
      cell("PRs", `${e.prCount}${e.assumedCount ? "?" : ""}`),
      cell("$/PR", e.dollarsPerPR ? formatUsd(e.dollarsPerPR.p50) : "—"),
    );
    sec.append(kv);
    const perPr = e.dollarsPerPR
      ? `$${Math.round(e.dollarsPerPR.p25)}/$${Math.round(e.dollarsPerPR.p50)}/$${Math.round(e.dollarsPerPR.p75)}`
      : "—";
    sec.append(
      el(
        "p",
        "pb-basis",
        `Priced off ${e.sampleSize} ${e.poolKey} plans at ${perPr} per PR × ${e.prCount} PRs.` +
          (e.assumedCount
            ? " This plan declares no PR slate, so the count is the pool's median — treat the number as an order of magnitude."
            : ""),
      ),
    );
    return sec;
  }

  /**
   * A URL we are willing to put in an `href`. The ledger's `url` is a string
   * from another service's JSON, and an anchor is the one sink where that
   * matters — `javascript:` and `data:` both execute on click. Anything that
   * is not http(s) falls through to the plain-span branch this function's
   * caller already has for a PR with no URL at all.
   */
  function httpUrl(raw: string | null): string | null {
    if (!raw) return null;
    try {
      const u = new URL(raw, location.origin);
      return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
    } catch {
      return null;
    }
  }

  function ledgerSection(card: EffectiveCard): HTMLElement {
    const facts = card.ledger!;
    const sec = el("div", "pb-sec");
    sec.append(el("h3", null, "What it actually cost"));
    // A ledger row exists for every plan claude-usage has ever seen, including
    // the ones it has recorded NOTHING about. Six "—" cells under "what it
    // actually cost" read as data that failed to load; one sentence says the
    // true thing.
    const recorded =
      (facts.landed ?? 0) > 0 || (facts.costUSD ?? 0) > 0 || (facts.sessions ?? 0) > 0;
    if (!recorded) {
      sec.append(
        el("p", "pb-basis", "Nothing recorded yet — no session, no cost and no landed PR against this plan."),
      );
      return sec;
    }
    const kv = el("div", "pb-kv");
    const cell = (k: string, v: string) => {
      const c = el("div");
      c.append(el("div", "pb-k", k), el("div", "pb-v", v));
      return c;
    };
    kv.append(
      cell("Cost", formatUsd(facts.costUSD)),
      cell("PRs landed", facts.landed !== null ? String(facts.landed) : "—"),
      cell("Active hours", facts.activeHours !== null ? facts.activeHours.toFixed(1) : "—"),
      cell("Findings", facts.findings !== null ? String(facts.findings) : "—"),
      cell("Max rounds", facts.maxRounds !== null ? String(facts.maxRounds) : "—"),
      cell("Sessions", facts.sessions !== null ? String(facts.sessions) : "—"),
    );
    sec.append(kv);
    if (facts.prs.length) {
      const list = el("div", "pb-prlist");
      for (const pr of facts.prs.slice(0, 40)) {
        const label = `#${pr.number ?? "?"}`;
        let node: HTMLElement;
        const href = httpUrl(pr.url);
        if (href) {
          const a = document.createElement("a");
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener";
          a.textContent = label;
          node = a;
        } else {
          node = el("span", null, label);
        }
        if (pr.reviewed === false) node.classList.add("pb-unrev");
        node.title = [pr.repo, pr.mergedAt?.slice(0, 10), pr.reviewed === false ? "no review recorded" : null]
          .filter(Boolean)
          .join(" · ");
        list.append(node);
      }
      sec.append(list);
    }
    return sec;
  }

  function prioritySection(card: EffectiveCard): HTMLElement {
    const sec = el("div", "pb-sec");
    sec.append(el("h3", null, "Priority"));
    const set = el("div", "pb-priset");
    const onDisk = card.priority !== null;
    for (const p of BOARD_PRIORITIES) {
      const b = el("button", null, p) as HTMLButtonElement;
      b.type = "button";
      b.dataset.key = `pri-${p}`;
      b.style.setProperty("--pb-pri-color", `var(--pb-${p})`);
      b.setAttribute("aria-pressed", String(card.effectivePriority === p));
      b.disabled = onDisk;
      if (onDisk) b.title = `priority: ${card.priority} is on disk — edit it in mimir, not here`;
      b.onclick = () => {
        const next = { ...overlay.priority };
        if (next[card.slug] === p) delete next[card.slug];
        else next[card.slug] = p;
        overlay = { priority: next, order: { ...overlay.order } };
        saveOverlay(overlay);
        render();
        const updated = merged().cards.find((c) => c.slug === card.slug);
        if (updated) {
          openDrawer(updated);
          // The drawer was rebuilt under the pointer; put focus back on the
          // button that was just pressed rather than on the panel.
          root
            .querySelector<HTMLElement>(`.pb-drawer .pb-priset button[data-key="pri-${p}"]`)
            ?.focus();
        }
      };
      set.append(b);
    }
    sec.append(set);
    sec.append(
      el(
        "p",
        "pb-basis",
        onDisk
          ? `priority: ${card.priority} is in the plan's frontmatter — edit it in mimir, not here.`
          : "Draft — not saved to mimir yet. Kept in this browser until the board can write frontmatter.",
      ),
    );
    return sec;
  }

  function escClose(ev: KeyboardEvent): void {
    if (ev.key === "Escape") closeDrawer();
  }

  /** Everything the drawer covers. `inert` rather than `aria-hidden`, because
   *  the board behind a modal must be unfocusable as well as unreadable — the
   *  draft note is in the list too: it carries a live "Discard drafts" button,
   *  which is the worst thing to reach by accident from behind a scrim. */
  function setBackdropInert(on: boolean): void {
    for (const box of [metersBox, controlsBox, draftBox, boardBox]) {
      if (on) box.setAttribute("inert", "");
      else box.removeAttribute("inert");
    }
  }

  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

  /** Wrap Tab/Shift+Tab inside the open drawer. Read off the live DOM on every
   *  press rather than captured at open: the priority buttons rebuild the panel
   *  (and change which of them are disabled), so a list taken once goes stale. */
  function trapDrawerTab(ev: KeyboardEvent): void {
    if (ev.key !== "Tab") return;
    const drawer = root.querySelector<HTMLElement>(".pb-drawer");
    if (!drawer) return;
    // `Array.from`, not a spread: this file compiles without `dom.iterable`.
    const items = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      // Nothing to move to — hold the panel rather than tabbing into the page.
      ev.preventDefault();
      drawer.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    // Shift+Tab off the panel itself wraps to the end: the drawer takes focus
    // on open, and its own node sits BEFORE its children in document order.
    if (ev.shiftKey && (active === first || active === drawer || !drawer.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && active === last) {
      ev.preventDefault();
      first.focus();
    }
  }

  /** `silent` is the re-open path (a priority click rebuilds the drawer):
   *  neither the focus restore nor the selection clear should run there. */
  function closeDrawer(opts: { silent?: boolean } = {}): void {
    root.querySelectorAll(".pb-scrim,.pb-drawer").forEach((n) => n.remove());
    document.removeEventListener("keydown", escClose);
    // Before the early return AND before any focus restore below: a board left
    // inert is a page nothing can be clicked or tabbed on, and the restore
    // targets a card inside it. (The re-open path sets it straight back.)
    setBackdropInert(false);
    if (opts.silent) return;
    if (view.openSlug) {
      view.openSlug = null;
      markSelected(null);
    }
    const back = drawerOpener;
    drawerOpener = null;
    // The card may have been re-rendered since; find it again by slug rather
    // than focusing a node that is no longer in the document.
    if (back?.isConnected) back.focus();
    else if (back?.dataset.slug) {
      boardBox
        .querySelector<HTMLElement>(`.pb-card[data-slug="${cssEscape(back.dataset.slug)}"]`)
        ?.focus();
    }
  }

  function cssEscape(value: string): string {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value;
  }

  // ---------------------------------------------------------------- draft note
  function renderDraftNote(
    cards: readonly EffectiveCard[],
    order: BoardOrder,
    draftCols: Set<string>,
  ): void {
    const drafted = cards.filter((c) => c.priorityIsDraft).length;
    // Column LABELS, not the payload's keys: "hand order on in-flight" is a
    // raw enum value leaking into a sentence someone is meant to read.
    const ranked = Object.keys(order)
      .filter((key) => draftCols.has(key))
      .map((key) => columnMeta.get(key)?.label ?? key);
    draftBox.textContent = "";
    if (!drafted && ranked.length === 0) {
      draftBox.classList.remove("pb-visible");
      return;
    }
    draftBox.classList.add("pb-visible");
    const parts = [
      drafted ? `${drafted} priority draft${drafted === 1 ? "" : "s"}` : null,
      ranked.length ? `hand order on ${ranked.join(" + ")}` : null,
    ].filter(Boolean) as string[];
    draftBox.append(
      el("span", "pb-draft-pill", "draft"),
      el(
        "span",
        null,
        `${parts.join(" · ")} — kept in this browser only. mimir wins on every load; nothing is written back yet.`,
      ),
    );
    const discard = el("button", "pb-discard", "Discard drafts") as HTMLButtonElement;
    discard.type = "button";
    discard.onclick = () => {
      overlay = { priority: {}, order: {} };
      saveOverlay(overlay);
      render();
    };
    draftBox.append(discard);
  }

  render();
}
