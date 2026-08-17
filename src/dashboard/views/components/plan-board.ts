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
  computeMeters,
  familyCounts,
  filterCards,
  formatAge,
  formatUsd,
  isTerminalColumn,
  nudgeOrder,
  rankOf,
  showRankUi,
  sortCards,
  visibleColumns,
  type BoardColumnMeta,
  type BoardFilters,
  type BoardOrder,
  type BoardOverlay,
  type BoardScope,
  type BoardSort,
  type EffectiveCard,
} from "../../../plans/board-client-pure.ts";
import type { BoardPayload } from "../../../plans/board.ts";
import type { PlanPriority } from "../../../plans/constants.ts";

const OVERLAY_KEY = "muninn.planboard.draft.v1";

interface ViewState {
  scope: BoardScope;
  sort: BoardSort;
  filters: BoardFilters;
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
    const parsed = JSON.parse(raw) as Partial<BoardOverlay>;
    return { priority: parsed.priority ?? {}, order: parsed.order ?? {} };
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
  const view: ViewState = {
    scope: "active",
    sort: "rank",
    filters: { families: [], priority: null, query: "" },
    openSlug: null,
  };
  let overlay = loadOverlay();

  const metersBox = root.querySelector<HTMLElement>("#pbMeters")!;
  const controlsBox = root.querySelector<HTMLElement>("#pbControls")!;
  const boardBox = root.querySelector<HTMLElement>("#pbBoard")!;
  const draftBox = root.querySelector<HTMLElement>("#pbDraft")!;

  const columnMeta = new Map<string, BoardColumnMeta>(payload.columns.map((c) => [c.key, c]));
  const money = payload.money.available;

  /** Merge the draft under the payload — disk wins, every render. */
  function merged(): { cards: EffectiveCard[]; order: BoardOrder; draftCols: Set<string> } {
    const res = applyOverlay(payload.cards, payload.queue.order, overlay);
    const draftCols = new Set(
      Object.entries(res.orderIsDraft)
        .filter(([, isDraft]) => isDraft)
        .map(([key]) => key),
    );
    return { cards: res.cards, order: res.order, draftCols };
  }

  function render(): void {
    const { cards, order, draftCols } = merged();
    const shown = filterCards(cards, view.filters);
    renderMeters(shown);
    renderControls(cards);
    renderBoard(shown, cards, order, draftCols);
    renderDraftNote(cards, order, draftCols);
  }

  // ---------------------------------------------------------------- meters
  function renderMeters(shown: readonly EffectiveCard[]): void {
    const m = computeMeters(shown, money);
    metersBox.textContent = "";
    const tiles: Array<{ k: string; v: string; sub?: string; note: string }> = [
      {
        k: "Active plans",
        v: String(m.activeCount),
        sub: `of ${m.totalCount}`,
        note: "proposed · ready · in flight · blocked",
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
          ? `${formatUsd(m.backlog.low)}–${formatUsd(m.backlog.high)} band over the ${m.backlog.count} active plan(s) that can be priced`
          : payload.money.reason ?? "no estimate available",
      },
      {
        k: "Spent to date",
        v: m.spentToDate !== null ? formatUsd(m.spentToDate) : "—",
        note: m.spentToDate !== null ? "recorded cost of the shipped plans" : "the ledger is not answering",
      },
      {
        k: "Median age",
        v: m.medianAgeDays !== null ? String(m.medianAgeDays) : "—",
        sub: m.medianAgeDays !== null ? "days" : undefined,
        note: "since the last status_date on an active plan",
      },
      {
        k: "Follow-ups open",
        v: String(m.followupsCount),
        note: "shipped, but the plan still carries followups: open",
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
    for (const { family, count } of familyCounts(cards.filter((c) => visible.has(c.column)))) {
      const b = el("button", "pb-chip") as HTMLButtonElement;
      b.type = "button";
      b.append(document.createTextNode(family), el("span", "pb-c", String(count)));
      b.setAttribute("aria-pressed", String(view.filters.families.includes(family)));
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
    controlsBox.append(
      segment("Sort", sorts, view.sort, (k) => {
        view.sort = k;
        render();
      }),
    );

    const search = document.createElement("input");
    search.type = "search";
    search.className = "pb-search";
    search.placeholder = "Filter by title, slug or tag";
    search.value = view.filters.query;
    search.setAttribute("aria-label", "Filter plans");
    // Typing re-renders the board and the meters but NOT the controls: replacing
    // the input under the caret is how a search box loses focus mid-word.
    search.oninput = () => {
      view.filters = { ...view.filters, query: search.value };
      const { cards: all, order, draftCols } = merged();
      const shown = filterCards(all, view.filters);
      renderMeters(shown);
      renderBoard(shown, all, order, draftCols);
    };
    controlsBox.append(search);
  }

  function segment<T extends string>(
    label: string,
    options: Array<[T, string]>,
    active: T,
    onPick: (value: T) => void,
  ): HTMLElement {
    const box = el("div", "pb-ctl");
    box.append(el("span", "pb-lab", label));
    const seg = el("div", "pb-seg");
    for (const [key, text] of options) {
      const b = el("button", null, text) as HTMLButtonElement;
      b.type = "button";
      b.setAttribute("aria-pressed", String(active === key));
      b.onclick = () => onPick(key);
      seg.append(b);
    }
    box.append(seg);
    return box;
  }

  // ---------------------------------------------------------------- board
  function renderBoard(
    shown: readonly EffectiveCard[],
    all: readonly EffectiveCard[],
    order: BoardOrder,
    draftCols: Set<string>,
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
      // The order a nudge writes is the FULL column, not the filtered view: a
      // rank stored while a repo filter was on would drop every plan the filter
      // hid, and the next unfiltered render would read as a reshuffle nobody
      // asked for.
      const fullOrder = sortCards(
        all.filter((c) => c.column === col.key),
        view.sort,
        order[col.key] ?? [],
      ).map((c) => c.slug);
      for (const card of inColumn) stack.append(renderCard(card, col, order, fullOrder));
      box.append(stack);
      boardBox.append(box);
    }
  }

  function renderCard(
    card: EffectiveCard,
    col: BoardColumnMeta,
    order: BoardOrder,
    fullOrder: readonly string[],
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
    fam.title = card.familySource === "prs" ? "family from the PRs this plan landed" : "family guessed from the slug";
    r1.append(fam);
    if (card.mixedRepos) r1.append(el("span", "pb-fam pb-fam-soft", "mixed"));
    if (card.followupsOpen && card.column !== "followups") {
      const flag = el("span", "pb-flag", "⚑");
      flag.title = "followups: open";
      r1.append(flag);
    }
    button.append(r1);

    button.append(el("div", "pb-title", card.title));
    button.append(el("div", "pb-slug", card.slug));

    const r2 = el("div", "pb-r2");
    if (money) {
      if (isTerminalColumn(card.column) && card.ledger) {
        const landed = card.ledger.landed ?? 0;
        r2.append(el("span", "pb-est", `${formatUsd(card.ledger.costUSD)} · ${landed} PR${landed === 1 ? "" : "s"}`));
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

    button.onclick = () => openDrawer(card);
    wrap.append(button);

    const link = openLink(card.wikiUrl, `Open ${card.title} in the mimir reader`);
    link.className = "pb-open";
    wrap.append(link);

    if (showRankUi(view.sort)) {
      const nudges = el("div", "pb-nudge");
      const i = fullOrder.indexOf(card.slug);
      for (const [delta, glyph, word] of [
        [-1, "▲", "up"],
        [1, "▼", "down"],
      ] as Array<[-1 | 1, string, string]>) {
        const b = el("button", null, glyph) as HTMLButtonElement;
        b.type = "button";
        b.title = `Move ${word} in ${col.label}`;
        b.setAttribute("aria-label", `Move ${card.title} ${word}`);
        b.disabled = delta < 0 ? i <= 0 : i < 0 || i >= fullOrder.length - 1;
        b.onclick = (ev) => {
          ev.stopPropagation();
          nudge(card.slug, col.key, fullOrder, delta);
        };
        nudges.append(b);
      }
      wrap.append(nudges);
    }
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
   * Rank a card by hand. The order written is the FULL column in the order the
   * board is showing it — never the filtered view, whose gaps would silently
   * drop every plan a filter hid.
   */
  function nudge(slug: string, column: string, fullOrder: readonly string[], delta: -1 | 1): void {
    const next = nudgeOrder(fullOrder, slug, delta);
    if (!next) return;
    overlay = {
      priority: { ...overlay.priority },
      order: { ...overlay.order, [column]: next },
    };
    saveOverlay(overlay);
    render();
  }

  // ---------------------------------------------------------------- drawer
  function openDrawer(card: EffectiveCard): void {
    closeDrawer();
    view.openSlug = card.slug;

    const scrim = el("div", "pb-scrim");
    scrim.onclick = closeDrawer;
    const drawer = el("aside", "pb-drawer");
    drawer.setAttribute("role", "dialog");
    drawer.setAttribute("aria-label", card.title);
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
    close.onclick = closeDrawer;
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
    if (card.ledger) body.append(ledgerSection(card));
    body.append(prioritySection(card));

    const fileSec = el("div", "pb-sec");
    fileSec.append(el("h3", null, "File"));
    const fileLink = document.createElement("a");
    fileLink.className = "pb-filelink";
    fileLink.href = card.wikiUrl;
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
    document.body.append(scrim, drawer);
    document.addEventListener("keydown", escClose);
    render();
  }

  function estimateSection(card: EffectiveCard): HTMLElement {
    const sec = el("div", "pb-sec");
    sec.append(el("h3", null, isTerminalColumn(card.column) ? "What it cost" : "What it should cost"));
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

  function ledgerSection(card: EffectiveCard): HTMLElement {
    const facts = card.ledger!;
    const sec = el("div", "pb-sec");
    sec.append(el("h3", null, "What the ledger recorded"));
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
        if (pr.url) {
          const a = document.createElement("a");
          a.href = pr.url;
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
      b.style.setProperty("--pb-pri-color", `var(--pb-${p})`);
      b.setAttribute("aria-pressed", String(card.effectivePriority === p));
      b.disabled = onDisk;
      b.onclick = () => {
        const next = { ...overlay.priority };
        if (next[card.slug] === p) delete next[card.slug];
        else next[card.slug] = p;
        overlay = { priority: next, order: { ...overlay.order } };
        saveOverlay(overlay);
        render();
        const updated = merged().cards.find((c) => c.slug === card.slug);
        if (updated) openDrawer(updated);
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

  function closeDrawer(): void {
    document.querySelectorAll(".pb-scrim,.pb-drawer").forEach((n) => n.remove());
    document.removeEventListener("keydown", escClose);
    if (view.openSlug) {
      view.openSlug = null;
      render();
    }
  }

  // ---------------------------------------------------------------- draft note
  function renderDraftNote(
    cards: readonly EffectiveCard[],
    order: BoardOrder,
    draftCols: Set<string>,
  ): void {
    const drafted = cards.filter((c) => c.priorityIsDraft).length;
    const ranked = Object.keys(order).filter((key) => draftCols.has(key));
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
