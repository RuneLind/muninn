/**
 * The reader's `<Chart>` toggles, `<Diagram>` view buttons and scroll stops, `<RuleTree>` case picker, `<Glossary>`
 * term definitions and `<CaseBoard view="dots">` squares. The server
 * draws every chart variant (`src/format/chart-view.ts`); this file only shows
 * one: Chart or Table, and the variant (points or % of target, the bar as
 * decided or after). A picked case marks the tree's rows on its path
 * (`src/format/rule-tree-view.ts`).
 * No third-party imports; part of the /wiki bundle via `wiki-browser.ts`.
 *
 * State lives on the DOM (`aria-pressed`, `hidden`, the `vc-mode-table`
 * class), so a fresh render starts every chart as the server wrote it, and
 * one document-level listener serves every render without re-wiring.
 */

/** Press `btn` and release the other buttons of its group. */
function pressOne(btn: HTMLElement): void {
  btn.closest(".vc-group")?.querySelectorAll<HTMLElement>("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
}

/** Apply one toggle click; false when `target` is not a chart toggle. */
function applyChartToggle(target: Element | null): boolean {
  const btn = target?.closest?.<HTMLElement>("button[data-vc-mode], button[data-vc-variant]");
  const chart = btn?.closest<HTMLElement>("section.vc");
  if (!btn || !chart || chart.closest(".wiki-ref-peek")) return false;
  const mode = btn.dataset.vcMode;
  if (mode) {
    chart.classList.toggle("vc-mode-table", mode === "table");
  } else {
    const id = btn.dataset.vcVariant;
    chart.querySelectorAll<HTMLElement>(":scope > .vc-plot").forEach((plot) => {
      plot.hidden = plot.dataset.vcPlot !== id;
    });
  }
  pressOne(btn);
  return true;
}

/** Whether a diagram view dims an edge: both ends out of focus. An edge with
 *  one end in focus stays lit, since it is how the focused part connects. An
 *  empty focus (the "All" view) dims nothing. */
export function diagramEdgeDimmed(focus: ReadonlySet<string>, from: string, to: string): boolean {
  return focus.size > 0 && !focus.has(from) && !focus.has(to);
}

/** Apply one `<Diagram>` view button; false when `target` is not one. Dims
 *  each node outside the view's focus (`data-node-id`) and each edge whose
 *  ends are both outside it (`data-edge-from`/`data-edge-to`); an element
 *  with neither attribute (the lifecycle's main rail) never dims. */
function applyDiagramView(target: Element | null): boolean {
  const btn = target?.closest?.<HTMLElement>("button[data-dgm-view]");
  const fig = btn?.closest<HTMLElement>("figure.dgm");
  if (!btn || !fig || fig.closest(".wiki-ref-peek")) return false;
  const view = btn.dataset.dgmView ?? "";
  const focus = new Set((btn.dataset.dgmFocus ?? "").split(" ").filter(Boolean));
  const svg = fig.querySelector(".dgm-svg");
  svg?.querySelectorAll<Element>("[data-node-id]").forEach((n) => {
    n.classList.toggle("dgm-dim", focus.size > 0 && !focus.has(n.getAttribute("data-node-id") ?? ""));
  });
  svg?.querySelectorAll<Element>("[data-edge-from][data-edge-to]").forEach((e) => {
    e.classList.toggle("dgm-dim", diagramEdgeDimmed(focus, e.getAttribute("data-edge-from") ?? "", e.getAttribute("data-edge-to") ?? ""));
  });
  fig.querySelectorAll<HTMLElement>(":scope > .dgm-note").forEach((p) => {
    p.hidden = p.dataset.dgmNote !== view;
  });
  fig.querySelectorAll<HTMLElement>(":scope > .dgm-views button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  return true;
}

/** A `<Diagram>` picture's box is a named, focusable region while its drawing
 *  is wider than the box (`scrollWidth > clientWidth`), so the keyboard can
 *  scroll it; while the drawing fits, it is a plain box and no tab stop. The
 *  name is the server's `data-dgm-label`. */
function syncDiagramStop(box: HTMLElement): void {
  if (box.scrollWidth > box.clientWidth) {
    box.setAttribute("role", "region");
    box.setAttribute("aria-label", box.dataset.dgmLabel ?? "");
    box.tabIndex = 0;
  } else {
    box.removeAttribute("role");
    box.removeAttribute("aria-label");
    box.removeAttribute("tabindex");
  }
}

let diagramBoxes: ResizeObserver | null = null;

/** Keep every picture box under `root` in step with {@link syncDiagramStop},
 *  now and on each resize (a window resize moves the column). Re-observes from
 *  scratch on each call: the article render replaces the previous boxes. */
export function watchDiagramPictures(root: ParentNode): void {
  if (typeof ResizeObserver === "undefined") return;
  diagramBoxes ??= new ResizeObserver((entries) => entries.forEach((e) => syncDiagramStop(e.target as HTMLElement)));
  diagramBoxes.disconnect();
  root.querySelectorAll<HTMLElement>(".dgm-svg").forEach((box) => diagramBoxes!.observe(box));
}

/** The case ids a rule tree row's leaf names (`data-rt-cases`, a JSON list). */
function leafCases(li: Element): string[] {
  try {
    const v: unknown = JSON.parse(li.getAttribute("data-rt-cases") ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Apply one picker change; false when `target` is not a rule tree picker.
 *  An empty value clears the pick. */
function applyRuleTreePick(target: Element | null): boolean {
  const select = target instanceof HTMLSelectElement && target.matches("select[data-rt-select]") ? target : null;
  const tree = select?.closest<HTMLElement>("section.rt");
  if (!select || !tree || tree.closest(".wiki-ref-peek")) return false;
  const id = select.value;
  const nodes = Array.from(tree.querySelectorAll<HTMLElement>("li.rt-node"));
  const on = new Set<Element>();
  if (id) {
    for (const li of nodes) {
      if (!leafCases(li).includes(id)) continue;
      for (let n: Element | null = li; n && n !== tree; n = n.parentElement) if (n.matches("li.rt-node")) on.add(n);
    }
  }
  tree.classList.toggle("rt-picked", id !== "");
  for (const li of nodes) {
    li.classList.toggle("rt-on", id !== "" && on.has(li));
    li.classList.toggle("rt-off", id !== "" && !on.has(li));
  }
  // On the server's id, never the chip's text: the reader adds an idLabels noun to it.
  tree.querySelectorAll<HTMLElement>(".rt-case").forEach((c) => c.classList.toggle("rt-hit", id !== "" && c.dataset.rtCase === id));
  let kort = "";
  tree.querySelectorAll<HTMLElement>("[data-rt-kort]").forEach((k) => {
    k.hidden = k.dataset.rtKort !== id;
    if (!k.hidden) kort = k.textContent ?? "";
  });
  // A screen reader learns which leaves are on the path, and hears the result.
  for (const li of nodes) {
    if (leafCases(li).includes(id)) li.setAttribute("aria-current", "true");
    else li.removeAttribute("aria-current");
  }
  const live = tree.querySelector<HTMLElement>("[data-rt-live]");
  if (live) live.textContent = id ? [ruleTreeSays(live)[id] ?? id, kort].filter(Boolean).join(". ") : "";
  return true;
}

/** The server's per-case result lines (`data-rt-say`); `{}` when unreadable. */
function ruleTreeSays(live: HTMLElement): Record<string, string> {
  try {
    const v: unknown = JSON.parse(live.dataset.rtSay ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The client box of the nearest ancestor that clips `el` (overflow other
 *  than visible), cut to the viewport: the reader's article pane scrolls, so
 *  the viewport alone let a definition run under its edge or scrollbar. */
function clipBox(el: Element): { left: number; top: number; right: number; bottom: number } {
  const root = el.ownerDocument.documentElement;
  const box = { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight };
  for (let a = el.parentElement; a && a !== root; a = a.parentElement) {
    const s = getComputedStyle(a);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const r = a.getBoundingClientRect();
    const left = r.left + a.clientLeft;
    const top = r.top + a.clientTop;
    box.left = Math.max(box.left, left);
    box.top = Math.max(box.top, top);
    box.right = Math.min(box.right, left + a.clientWidth);
    box.bottom = Math.min(box.bottom, top + a.clientHeight);
    break;
  }
  return box;
}

/** Keep a glossary definition inside the box that clips it: no wider than
 *  that box, shifted back from its right edge, and opened above the term
 *  (`gl-above`) when there is no room below and more room above. */
function placeGlossaryTip(mark: Element): void {
  const tip = mark.querySelector<HTMLElement>(":scope > .gl-tip");
  if (!tip) return;
  tip.style.insetInlineStart = "";
  tip.style.maxInlineSize = "";
  mark.classList.remove("gl-above");
  const r0 = tip.getBoundingClientRect();
  if (r0.width === 0) return;
  const box = clipBox(mark);
  const pad = 8;
  const room = box.right - box.left - 2 * pad;
  if (r0.width > room) tip.style.maxInlineSize = `${Math.max(0, room)}px`;
  const r = tip.getBoundingClientRect();
  // Physical shift, + moves right; the left case is an rtl tip, opening leftwards.
  const dx = r.right > box.right - pad ? box.right - pad - r.right : Math.max(0, box.left + pad - r.left);
  if (dx) tip.style.insetInlineStart = `${getComputedStyle(tip).direction === "rtl" ? -dx : dx}px`;
  const term = mark.getBoundingClientRect();
  const below = box.bottom - term.bottom;
  const above = term.top - box.top;
  if (r.height > below && above > below) mark.classList.add("gl-above");
}

/** A definition shown by hover or focus: place it; Escape hides it until the
 *  pointer or focus leaves the term. */
function wireGlossary(doc: Document): void {
  const markOf = (t: EventTarget | null) => (t instanceof Element ? t.closest(".gl-mark") : null);
  doc.addEventListener("mouseover", (e) => {
    const m = markOf(e.target);
    if (m) placeGlossaryTip(m);
  });
  doc.addEventListener("focusin", (e) => {
    const m = markOf(e.target);
    if (m) placeGlossaryTip(m);
  });
  doc.addEventListener("mouseout", (e) => {
    const m = markOf(e.target);
    if (m && !(e.relatedTarget instanceof Node && m.contains(e.relatedTarget))) m.classList.remove("gl-dismissed");
  });
  doc.addEventListener("focusout", (e) => markOf(e.target)?.classList.remove("gl-dismissed"));
  doc.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      const m = markOf(doc.activeElement) ?? doc.querySelector(".gl-mark:hover:not(.gl-dismissed)");
      if (!m || m.classList.contains("gl-dismissed")) return;
      m.classList.add("gl-dismissed");
      // The open definition takes this Escape; the reader's own keys get the next one.
      e.stopPropagation();
    },
    true,
  );
}

/** Press one CaseBoard square: it alone is pressed, and the board's live line
 *  says its case (`data-cb-say`). Pressing it again releases it. False when
 *  `target` is not a square. */
function applyCaseDot(target: Element | null): boolean {
  const dot = target?.closest?.<HTMLElement>("button.cb-dot");
  const dots = dot?.closest<HTMLElement>(".cb-dots");
  if (!dot || !dots || dots.closest(".wiki-ref-peek")) return false;
  const on = dot.getAttribute("aria-pressed") !== "true";
  dots.querySelectorAll<HTMLElement>("button.cb-dot").forEach((b) => {
    b.setAttribute("aria-pressed", String(on && b === dot));
    b.setAttribute("tabindex", b === dot ? "0" : "-1");
  });
  const say = dots.querySelector<HTMLElement>(".cb-dots-say");
  if (say) say.textContent = on ? (dot.dataset.cbSay ?? "") : "";
  return true;
}

const DOT_KEYS = new Set(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"]);

/** The arrow keys, Home and End move between a board's squares; the board is
 *  one tab stop (the square focused last keeps `tabindex="0"`). */
function moveCaseDot(e: KeyboardEvent): void {
  if (!DOT_KEYS.has(e.key) || !(e.target instanceof Element)) return;
  const dot = e.target.closest<HTMLElement>("button.cb-dot");
  const dots = dot?.closest(".cb-dots");
  if (!dot || !dots) return;
  // A square a lens hides (Overview's none group) is skipped.
  const all = Array.from(dots.querySelectorAll<HTMLElement>("button.cb-dot")).filter((b) => b === dot || b.getClientRects().length > 0);
  const i = all.indexOf(dot);
  // Right means the previous square under rtl; Up, Down, Home and End do not flip.
  const ahead = getComputedStyle(dot).direction === "rtl" ? "ArrowLeft" : "ArrowRight";
  const forward = e.key === ahead || e.key === "ArrowDown";
  const next = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : forward ? Math.min(i + 1, all.length - 1) : Math.max(i - 1, 0);
  e.preventDefault();
  dots.querySelectorAll<HTMLElement>("button.cb-dot").forEach((b) => b.setAttribute("tabindex", b === all[next] ? "0" : "-1"));
  all[next]?.focus();
}

let installed = false;

/** Install the delegated listeners; later calls do nothing. */
export function initWikiVisuals(doc: Document = document): void {
  if (installed) return;
  installed = true;
  doc.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!applyChartToggle(target) && !applyDiagramView(target)) applyCaseDot(target);
  });
  doc.addEventListener("keydown", moveCaseDot);
  doc.addEventListener("change", (e) => {
    applyRuleTreePick(e.target instanceof Element ? e.target : null);
  });
  wireGlossary(doc);
  // The rule tree picker and the CaseBoard squares show only once their listeners are in place.
  doc.documentElement.classList.add("rt-js");
}
