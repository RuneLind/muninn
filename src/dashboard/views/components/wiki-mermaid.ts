/// <reference lib="dom" />
/**
 * Client-side mermaid rendering for native .md/.mdx wiki pages in the /wiki
 * reader. Server render leaves a ```mermaid fence as
 * `<pre><code class="language-mermaid">…escaped source…</code></pre>`
 * (see src/wiki/render.test.ts) — this module upgrades those, in the browser
 * only, to inline SVG diagrams styled by the PR-A `.diagram` component CSS.
 *
 * Design (pinned — see the PR C brief):
 *  - Zero cost for pages without mermaid: nothing loads unless a rendered
 *    article actually contains `code.language-mermaid`.
 *  - Delivery: the mermaid library is fetched on demand by injecting a pinned
 *    mermaid@11 UMD `<script>` (the reader swaps articles via innerHTML, where
 *    a static template `<script>` would never execute). A module-level shared
 *    load Promise dedupes concurrent triggers; later navigations reuse it. A
 *    failed load (network error, or a 200 whose body never defined the global)
 *    nulls the shared Promise and removes the dud `<script>`, so it stays
 *    retryable on a later navigation.
 *  - Security: `securityLevel: 'strict'`, `suppressErrorRendering: true` — the
 *    default locked-directive set keeps `securityLevel` immune to a
 *    `%%{init}%%` downgrade in page source. The injected `<script>` carries an
 *    `integrity` (sha384 SRI) + `crossOrigin` so the browser refuses a
 *    tampered CDN payload.
 *  - Theme: mermaid's `base` theme with variables built from the reader's own
 *    tokens, resolved at each diagram's place (so every palette and a blog's
 *    accent draw in the page's colours); mermaid's `default`/`dark` only when a
 *    token does not resolve. A MutationObserver on `data-theme` and
 *    `data-palette` and a matchMedia listener re-render the on-screen diagrams
 *    whose resolved colours changed. Every render pass (navigation, theme,
 *    resize) is serialized through a module-level mutex so passes can never
 *    interleave and mix themes on one page. Readable size and the ⤢
 *    full-window view: see the state table below.
 *  - Fail-visible: on any render rejection the original `<pre>` is left exactly
 *    as-is — never blanked, never an error graphic.
 *
 * Consumers: the wiki reader (direct import), the wiki Ask pane, and the
 * /research answer render (via the wiki-mermaid-client globalThis bundle) all
 * call the same exported enhanceMermaid. Chat and explainer iframes are
 * untouched; the server render pipeline is unchanged.
 */

import {
  FALLBACK_FONT_PX,
  MERMAID_TOKENS,
  THEMED_FONT_PX,
  buildMermaidPalette,
  chooseLayout,
  dialogBox,
  dialogHostWidth,
  flipToTopDown,
  hostWidthFor,
  injectClassDefs,
  needsFlipCandidate,
  parseViewBox,
  pickDialogDrawing,
  rescopeSvgIds,
  type MermaidPalette,
  type TokenColors,
} from "./mermaid-theme.ts";
import { syncScrollStop } from "./scroll-stop.ts";

/**
 * Pinned mermaid 11.x UMD build. A classic (non-module) script that ends with
 * `globalThis["mermaid"] = …`, so `window.mermaid` is defined once `onload`
 * fires — exactly what dynamic `<script>` injection needs.
 */
export const MERMAID_CDN_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js";

/**
 * Subresource Integrity hash for {@link MERMAID_CDN_URL}. sha384, base64, the
 * `sha384-` prefix the SRI spec requires. Pinning it means the browser refuses
 * to run the CDN payload unless its bytes hash to exactly this — a CDN
 * compromise or MITM can't slip a different mermaid build past us. Derived with
 * `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`; must be
 * regenerated whenever MERMAID_CDN_URL's version changes.
 */
export const MERMAID_SRI =
  "sha384-T/0lMUdJpd2S1ZHtRiofG3htU3xPCrFVeAQ1UUE2TJwlEJSV5NUwn30kP28n238E";

/** Map the reader's effective light/dark state to mermaid's fallback theme
 *  name (used when a required token does not resolve; see renderPass). */
export function mermaidThemeFor(
  dataTheme: string | undefined,
  prefersDark: boolean,
): "default" | "dark" {
  const dark = dataTheme ? dataTheme === "dark" : prefersDark;
  return dark ? "dark" : "default";
}

/** True when a rendered article contains at least one mermaid fence. */
export function hasMermaid(root: ParentNode): boolean {
  return !!root.querySelector("code.language-mermaid");
}


/*
 * ── Palette, readable size and the full-window view ─────────────────────
 *
 * Palette: each pass resolves the reader's tokens (`MERMAID_TOKENS`) at the
 * diagram's own place in the page (a blog's accent is scoped to its article)
 * through a hidden probe's computed `color`, and draws with mermaid's `base`
 * theme from them (`buildMermaidPalette`). A token that does not resolve sends
 * that pass to mermaid's own `default`/`dark` theme instead. A `flowchart` or
 * `graph` also gets four node classes (`good`, `warn`, `bad`, `muted`),
 * injected at render time only: `data-mermaid-src` keeps the page's source.
 *
 * Readable size: each drawing is measured once after render for its smallest
 * visible text in SVG user units (`measureMinText`: 14 px for flowchart nodes,
 * 10 px for gantt ticks, 16 px for sequence messages, whatever a page's init
 * sets), drawn at that × min(1, body width ÷ viewBox width). Under 11 px, an
 * `LR`/`RL` flowchart is drawn top-down too and shown that way when its text
 * is larger and it stays under 900 px tall as shown; still under 11 px, the
 * SVG is given the width that draws its smallest text at 11 px and
 * `.diagram-body` scrolls sideways, a named tab stop while it does
 * (`syncScrollStop`). A diagram whose viewBox follows its box (gantt) is
 * redrawn at the width that, widened to 11 px, fills the body exactly, so it
 * reads at 11 px with no scrollbar (`hostWidthFor`). Decided from the page's
 * own orientation on every measure (`chooseLayout`).
 *
 * The ⤢ dialog shows a copy at natural × 1.3 while that fits the window (both
 * axes), smaller to fit, but never with its smallest text under 11 px or under
 * what the page shows; past that the dialog scrolls inside (`dialogFit`). Of
 * the page's own orientation and its top-down copy (when drawn), the one that
 * spills less wins, then the larger text (`pickDialogDrawing`). A gantt is
 * drawn again for the dialog at the width that fills the window at 1.3 × its
 * text (`dialogHostWidth`), not at its column-derived width. The copy carries
 * a new root id in every id reference, never in its text (`rescopeSvgIds`).
 * A copy of a diagram elsewhere on the page (ref-link peek, fact-check card)
 * is redrawn plain and fit to width, with no ⤢ and no scroll stop
 * (`adoptMermaidCopies`).
 *
 * | Starting state                 | Event                                  | Result                                                        |
 * |--------------------------------|----------------------------------------|---------------------------------------------------------------|
 * | dialog closed, focus on ⤢      | click / Enter / Space                  | showModal; focus on the dialog's close button; sized from the |
 * |                                |                                        | window (above); a gantt is redrawn for it through the mutex   |
 * | dialog open                    | Esc                                    | closes; focus back on the ⤢ that opened it                    |
 * | dialog open                    | press and release on the backdrop      | closes; focus back on ⤢ (both outside the dialog's box)       |
 * | dialog open                    | press inside, drag out, release outside| stays open (the click targets the dialog, but the press was   |
 * |                                |                                        | inside its box)                                               |
 * | dialog open                    | click on the dialog's own scrollbar    | stays open (inside its box)                                   |
 * | dialog open                    | click inside the diagram               | stays open                                                    |
 * | dialog open                    | close button                           | closes; focus back on ⤢                                       |
 * | dialog open                    | theme / palette / OS scheme flip       | the page diagrams re-render, then the dialog's copy is redrawn|
 * |                                |                                        | from the new render in the same pass; it stays open and focus |
 * |                                |                                        | stays where it was in the dialog                              |
 * | dialog open                    | popstate / hashchange                  | closes at once                                                |
 * | dialog open                    | article swapped (loadPage, Ask)        | the next enhanceMermaid call closes it (its ⤢ is detached, so |
 * |                                |                                        | focus goes to body, as for any control in a replaced article) |
 * | dialog open                    | the same answer repainted (Ask `done`, | stays open: the redraw pass reuses the detached diagram's     |
 * |                                | `answer_html`, a ↻ splice)             | drawings (same source and colours, no mermaid.render) and     |
 * |                                |                                        | hands the dialog to the new ⤢                                 |
 * | dialog open                    | rail / column / window resize          | no effect on the dialog (its size was set when filled)        |
 * | copy (peek, fact-check card)   | inserted, `adoptMermaidCopies`         | ⤢ and scroll stop removed at once; redrawn fit to width under |
 * |                                |                                        | its own id in the colours at its place                        |
 * | copy                           | theme / palette / OS scheme flip       | redrawn in the new colours (`rerenderChanged`, no state)      |
 * | ⤢ focused                      | flip re-renders the page diagram       | only `.diagram-body`'s SVG is replaced: ⤢ survives with focus |
 * | body with no layout (closed    | first render                           | drawn as the page wrote it, not measured, flipped or widened  |
 * | fold, a lens hiding it)        |                                        | (width 0 would read as tiny text)                             |
 * | body with no layout            | gains a width (fold opened, lens off)  | ResizeObserver → measure → maybe flip / widen                 |
 * | scrolling body, focused        | resize to fit                          | stop kept while focused, removed on blur                      |
 * | any measured body              | column narrower / wider                | debounced re-measure through the pass mutex; layout decided   |
 * |                                |                                        | again from the original orientation; only a WIDTH change      |
 * |                                |                                        | re-measures, so widening (height change) never loops          |
 * | any                            | two quick theme flips                  | passes serialize; each reads the tokens at its start, so the  |
 * |                                |                                        | final colours are the final theme's                           |
 * | fence                          | render fails                           | fail-visible: the original `<pre>` stays, no ⤢                |
 * | rendered diagram               | re-render fails                        | the previous drawing stays                                    |
 */

// ── Runtime state (module-level, browser only) ────────────────────────
/** Shared load Promise — a second trigger before onload has something to await. */
let scriptLoad: Promise<void> | null = null;
/** Monotonic id source so each `render()` call gets a unique svg id. */
let idCounter = 0;
/** The config key mermaid was last initialized with (avoid redundant re-inits). */
let initializedKey: string | null = null;
/** Theme re-render listeners are wired at most once. */
let observersInstalled = false;
/**
 * Mutex: every render pass chains onto this so passes run strictly
 * one-after-another. `mermaid.initialize` mutates *global* mermaid config, so a
 * navigation pass, a theme-change pass and a resize pass overlapping would let
 * one re-init the config while another is awaiting `mermaid.render()` —
 * yielding mixed-theme diagrams on one page.
 */
let passChain: Promise<void> = Promise.resolve();

/** One pass's mermaid configuration, resolved at a diagram's place. */
interface PassConfig {
  key: string;
  fontPx: number;
  classDefs: readonly string[];
  init: Record<string, unknown>;
}

interface Rendered {
  svg: string;
  id: string;
  vb: { width: number; height: number } | null;
  /** Smallest visible text in SVG user units, or null when it has none. */
  minText: number | null;
  /** Width of the box it was drawn in. */
  hostWidth: number;
  /** Its viewBox width followed that box (gantt), so a redraw can resize it. */
  tracksHost: boolean;
}

interface DiagramState {
  wrap: HTMLElement;
  body: HTMLElement;
  source: string;
  cfg: PassConfig;
  orig: Rendered;
  /** The top-down copy: undefined = not drawn yet, null = none (not LR/RL, or failed). */
  flip: Rendered | null | undefined;
  shown: "orig" | "flip";
  /** Width forced on the shown SVG, or null when it fits. */
  widened: number | null;
  /** Body width the current layout was decided at; 0 = not measured. */
  measuredWidth: number;
  /** A gantt's dialog drawing, keyed by config and width (see `refineDialog`). */
  dialogDraw?: { key: string; r: Rendered };
}

const states = new WeakMap<HTMLElement, DiagramState>();
/** Every diagram drawn and not yet found detached (see {@link renderFences}). */
const live = new Set<DiagramState>();
/** Drawings a later pass may reuse: a detached diagram's, or one drawn for a
 *  fence the swap removed mid-draw. `wrap` is the detached diagram, if any. */
type Reusable = Pick<DiagramState, "source" | "cfg" | "orig" | "flip" | "dialogDraw"> & { wrap?: HTMLElement };
let reusable: Reusable[] = [];
/** Bodies the ResizeObserver watches (detached ones are dropped on each enhance). */
const watched = new Set<HTMLElement>();
let resizer: ResizeObserver | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
const resizePending = new Set<DiagramState>();
const RESIZE_DEBOUNCE_MS = 120;
const SCROLL_LABEL = "Diagram, scrolls sideways";

/** Inject the pinned mermaid script once; reuse the shared Promise thereafter. */
function loadMermaid(): Promise<void> {
  return (scriptLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MERMAID_CDN_URL;
    // SRI: the browser hashes the fetched bytes and refuses to execute unless
    // they match — crossOrigin=anonymous is required for the check on a
    // cross-origin script.
    s.integrity = MERMAID_SRI;
    s.crossOrigin = "anonymous";
    s.onload = () => {
      // A 200 with the wrong body (captive portal, truncated payload) can fire
      // onload without defining the global. Treat that as a failure so a later
      // navigation can retry, and don't leave the dud script node behind.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((globalThis as any).mermaid) {
        resolve();
      } else {
        scriptLoad = null; // allow a later navigation to retry the load
        s.remove();
        reject(new Error("mermaid loaded but window.mermaid is undefined"));
      }
    };
    s.onerror = () => {
      scriptLoad = null; // allow a later navigation to retry the load
      s.remove(); // don't accumulate orphaned failed <script> nodes on retries
      reject(new Error("mermaid failed to load"));
    };
    document.head.appendChild(s);
  }));
}

/** Effective mermaid theme from `<html data-theme>` else the OS preference. */
function effectiveTheme(): "default" | "dark" {
  const dataTheme = document.documentElement.dataset.theme;
  const prefersDark = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
  return mermaidThemeFor(dataTheme, prefersDark);
}

/**
 * Resolve the pass config at `anchor` (a fence's `<pre>` or a `.diagram`):
 * a hidden `div.diagram` probe inside it reads the box's own background and,
 * through a span's computed `color`, every token. Any token undefined there →
 * mermaid's own theme for the light/dark state.
 */
function readPassConfig(anchor: HTMLElement): PassConfig {
  const fallbackTheme = effectiveTheme();
  const dark = fallbackTheme === "dark";
  const probe = document.createElement("div");
  probe.className = "diagram";
  probe.style.display = "none";
  probe.setAttribute("aria-hidden", "true");
  const span = document.createElement("span");
  probe.appendChild(span);
  anchor.appendChild(probe);
  let palette: MermaidPalette | null = null;
  try {
    const cs = getComputedStyle(probe);
    const tokens: Partial<Record<keyof TokenColors, string>> = {};
    let missing = false;
    for (const [k, name] of Object.entries(MERMAID_TOKENS) as [keyof TokenColors, string][]) {
      if (!cs.getPropertyValue(name).trim()) {
        missing = true;
        break;
      }
      span.style.color = `var(${name})`;
      tokens[k] = getComputedStyle(span).color;
    }
    if (!missing) {
      palette = buildMermaidPalette({
        tokens,
        ground: cs.backgroundColor,
        fontFamily: getComputedStyle(anchor.parentElement ?? document.body).fontFamily,
        dark,
      });
    }
  } finally {
    probe.remove();
  }
  if (!palette) {
    return { key: `fallback:${fallbackTheme}`, fontPx: FALLBACK_FONT_PX, classDefs: [], init: { theme: fallbackTheme } };
  }
  return {
    key: palette.key,
    fontPx: THEMED_FONT_PX,
    classDefs: palette.classDefs,
    init: { theme: "base", themeVariables: palette.themeVariables },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mermaidLib(): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).mermaid;
}

/** Initialize mermaid for `cfg` unless it already is (the mutex is held). */
function ensureInit(cfg: PassConfig): void {
  if (initializedKey === cfg.key) return;
  mermaidLib().initialize({
    securityLevel: "strict",
    suppressErrorRendering: true,
    startOnLoad: false,
    ...cfg.init,
  });
  initializedKey = cfg.key;
}

/**
 * The smallest visible text in a laid-out SVG, in its own user units: the
 * computed `font-size` of each element with its own non-blank text and a
 * non-empty box (foreignObject HTML labels included; mermaid's hidden
 * measuring text and `<style>` excluded). Null when it has no visible text.
 */
function measureMinText(svg: SVGSVGElement): number | null {
  let min = Infinity;
  for (const el of Array.from(svg.querySelectorAll<Element>("*"))) {
    const tag = el.tagName.toLowerCase();
    if (tag === "style" || tag === "title" || tag === "desc" || tag === "script") continue;
    if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim())) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size > 0) min = Math.min(min, size);
  }
  return Number.isFinite(min) ? min : null;
}

/**
 * Render one source under `cfg` (classes injected) inside an off-screen box
 * `hostWidth` px wide, then lay the result out there once to measure its
 * smallest text. Throws on a bad fence.
 */
async function draw(cfg: PassConfig, source: string, hostWidth: number): Promise<Rendered> {
  ensureInit(cfg);
  const id = `wm-${idCounter++}`;
  const w = Math.max(1, Math.round(hostWidth));
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:absolute;left:-100000px;top:0;width:${w}px;visibility:hidden;pointer-events:none`;
  document.body.appendChild(host);
  try {
    const { svg } = await mermaidLib().render(id, injectClassDefs(source, cfg.classDefs), host);
    const vb = parseViewBox(svg);
    host.innerHTML = svg;
    const el = host.querySelector<SVGSVGElement>("svg");
    const minText = el ? measureMinText(el) : null;
    return { svg, id, vb, minText, hostWidth: w, tracksHost: !!vb && Math.abs(vb.width - w) < 1 };
  } finally {
    host.remove();
  }
}

/** Queue `fn` behind any in-flight pass (see {@link passChain}). Anything read
 *  inside it (theme, widths) is read once the mutex is held. */
function enqueue(fn: () => Promise<void>): Promise<void> {
  const run = passChain.then(() => (mermaidLib() ? fn() : undefined));
  passChain = run.catch(() => {});
  return run;
}

/**
 * The body's width, or 0 when the reader cannot see it: no layout (a lens hid
 * it) or inside a closed `<details>` (a `<Fold>`), where Chromium can still
 * report a width but a ResizeObserver stays silent until the fold opens.
 */
function laidOutWidth(body: HTMLElement): number {
  if (body.closest("details:not([open])")) return 0;
  return body.clientWidth;
}

/**
 * Measure, then flip / widen / un-widen from the original orientation. A body
 * with no layout (width 0) is left as drawn and measured when the
 * ResizeObserver sees it gain a width. Runs inside the mutex.
 */
async function layout(st: DiagramState): Promise<void> {
  const width = laidOutWidth(st.body);
  if (width <= 0 || !st.orig.vb) {
    syncScrollStop(st.body, SCROLL_LABEL);
    return;
  }
  st.measuredWidth = width;
  let redrawn = false;
  if (st.orig.tracksHost && st.orig.minText) {
    // A gantt's viewBox is its box's width: draw it at the width that, widened
    // to 11 px text, fills this body exactly (`hostWidthFor`).
    const target = hostWidthFor(width, st.orig.minText);
    if (target > 0 && target !== st.orig.hostWidth) {
      try {
        st.orig = await draw(st.cfg, st.source, target);
        redrawn = true;
      } catch {
        /* the previous drawing stays */
      }
      if (!st.wrap.isConnected) return;
    }
  }
  const origVb = st.orig.vb;
  if (!origVb) {
    syncScrollStop(st.body, SCROLL_LABEL);
    return;
  }
  const original = { ...origVb, minText: st.orig.minText };
  if (st.flip === undefined) {
    const flipped = flipToTopDown(st.source);
    if (!flipped) st.flip = null;
    else if (needsFlipCandidate(width, st.cfg.fontPx, original)) {
      try {
        st.flip = await draw(st.cfg, flipped, width);
      } catch {
        st.flip = null;
      }
      if (!st.wrap.isConnected) return;
    }
  }
  const d = chooseLayout({
    bodyWidth: width,
    fontPx: st.cfg.fontPx,
    original,
    flipped: st.flip?.vb ? { ...st.flip.vb, minText: st.flip.minText } : null,
  });
  const want = d.flipped && st.flip ? "flip" : "orig";
  if (redrawn || want !== st.shown || (st.widened !== null && d.widenTo === null) || !st.body.querySelector("svg")) {
    st.body.innerHTML = (want === "flip" ? st.flip! : st.orig).svg;
    st.shown = want;
    st.widened = null;
  }
  if (want === "flip") st.wrap.setAttribute("data-mermaid-flipped", "");
  else st.wrap.removeAttribute("data-mermaid-flipped");
  const svg = st.body.querySelector<SVGSVGElement>("svg");
  if (svg && d.widenTo !== null) {
    const w = Math.ceil(d.widenTo - 1e-6); // float noise must not add a 1 px scroll
    svg.style.maxWidth = "none";
    svg.setAttribute("width", String(w));
    svg.setAttribute("data-widened", ""); // print scales it back (component-styles.ts)
    st.widened = w;
  }
  syncScrollStop(st.body, SCROLL_LABEL);
}

/** Start watching a body for width changes (fold opened, rail drag, window). */
function watchBody(st: DiagramState): void {
  if (typeof ResizeObserver === "undefined") return;
  resizer ??= new ResizeObserver((entries) => {
    for (const e of entries) {
      const body = e.target as HTMLElement;
      const st = states.get(body);
      if (!st) continue;
      syncScrollStop(body, SCROLL_LABEL);
      const w = laidOutWidth(body);
      if (w > 0 && w !== st.measuredWidth) resizePending.add(st);
    }
    if (resizePending.size === 0) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      const batch = [...resizePending];
      resizePending.clear();
      void enqueue(async () => {
        for (const s of batch) {
          // Re-checked under the mutex: a theme pass may have measured it since.
          const w = laidOutWidth(s.body);
          if (s.wrap.isConnected && w > 0 && w !== s.measuredWidth) await layout(s);
        }
      });
    }, RESIZE_DEBOUNCE_MS);
  });
  states.set(st.body, st);
  watched.add(st.body);
  resizer.observe(st.body);
  st.body.addEventListener("blur", () => syncScrollStop(st.body, SCROLL_LABEL));
}

/** Unobserve bodies no longer in the document (the article was replaced). */
function dropDetached(): void {
  for (const b of watched) {
    if (!b.isConnected) {
      resizer?.unobserve(b);
      watched.delete(b);
    }
  }
}

/** Move every detached diagram into {@link reusable}. Runs inside the mutex. */
function collectDetached(): void {
  for (const st of live) {
    if (!st.wrap.isConnected) {
      live.delete(st);
      reusable.push(st);
    }
  }
}

// ── The full-window view ──────────────────────────────────────────────
let dlg: HTMLDialogElement | null = null;
let dlgBody: HTMLElement | null = null;
let dlgClose: HTMLButtonElement | null = null;
let dlgWrap: HTMLElement | null = null;
let dlgOpener: HTMLButtonElement | null = null;
let dlgSeq = 0;

function ensureDialog(): HTMLDialogElement {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "diagram-dialog";
  dlg.setAttribute("aria-label", "Diagram, full window");
  const inner = document.createElement("div");
  inner.className = "diagram-dialog-inner";
  dlgClose = document.createElement("button");
  dlgClose.type = "button";
  dlgClose.className = "diagram-dialog-close";
  dlgClose.setAttribute("aria-label", "Close full-window diagram");
  dlgClose.textContent = "✕";
  dlgClose.addEventListener("click", () => dlg?.close());
  dlgBody = document.createElement("div");
  dlgBody.className = "diagram-dialog-body";
  inner.append(dlgClose, dlgBody);
  dlg.appendChild(inner);
  // A backdrop click: pressed AND released outside the dialog's box. A drag
  // that starts on a label and ends on the backdrop, or a click on the
  // dialog's own scrollbar, also targets the dialog, and must not close it.
  const outside = (e: MouseEvent) => {
    if (!dlg || e.target !== dlg) return false;
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  let pressedOutside = false;
  dlg.addEventListener("pointerdown", (e) => {
    pressedOutside = outside(e);
  });
  dlg.addEventListener("click", (e) => {
    const pressed = pressedOutside;
    pressedOutside = false;
    if (dlg && pressed && outside(e)) dlg.close();
  });
  dlg.addEventListener("close", () => {
    const opener = dlgOpener;
    dlgOpener = null;
    dlgWrap = null;
    dlgBody?.replaceChildren();
    if (opener?.isConnected) opener.focus();
  });
  document.body.appendChild(dlg);
  return dlg;
}

/** The smallest text the page shows this diagram at, CSS px (0 = not laid out). */
function pageTextPx(st: DiagramState): number {
  const r = st.shown === "flip" && st.flip ? st.flip : st.orig;
  const w = st.body.querySelector("svg")?.getBoundingClientRect().width ?? 0;
  if (!r.vb || w <= 0) return 0;
  return ((r.minText ?? st.cfg.fontPx) * w) / r.vb.width;
}

/**
 * Draw the dialog's copy from drawings already made: a gantt's dialog drawing
 * (else its page drawing until `refineDialog` lands), otherwise the page's own
 * orientation and, when drawn, its top-down copy, whichever spills less in the
 * window (`pickDialogDrawing`). Under a new id (`rescopeSvgIds`).
 */
function fillDialog(st: DiagramState): void {
  if (!dlgBody) return;
  const cands: Rendered[] = st.orig.tracksHost
    ? [st.dialogDraw?.r ?? st.orig]
    : [st.orig, ...(st.flip ? [st.flip] : [])];
  const usable = cands.filter((r) => r.vb);
  const box = dialogBox(window.innerWidth, window.innerHeight);
  const pick = pickDialogDrawing(
    usable.map((r) => ({ width: r.vb!.width, height: r.vb!.height, minText: r.minText ?? st.cfg.fontPx })),
    box,
    pageTextPx(st),
  );
  const r = pick ? usable[pick.index]! : st.orig;
  const t = document.createElement("template");
  t.innerHTML = r.svg;
  const svg = t.content.querySelector<SVGSVGElement>("svg");
  if (svg) {
    rescopeSvgIds(svg, r.id, `wm-dlg-${dlgSeq++}`);
    if (pick) {
      svg.style.maxWidth = "none";
      svg.setAttribute("width", String(Math.round(pick.fit.width)));
    }
  }
  dlgBody.replaceChildren(t.content);
  dlgBody.toggleAttribute("data-mermaid-flipped", r === st.flip);
}

/** A gantt: draw it for the dialog at the width that fills the window at the
 *  aimed text size (`dialogHostWidth`), then refill. Runs inside the mutex. */
async function refineDialog(st: DiagramState): Promise<void> {
  if (!st.orig.tracksHost || !st.orig.minText) return;
  const box = dialogBox(window.innerWidth, window.innerHeight);
  const hw = dialogHostWidth(box.width, st.orig.minText, pageTextPx(st));
  const key = `${st.cfg.key}|${hw}`;
  if (st.dialogDraw?.key !== key) {
    try {
      st.dialogDraw = { key, r: await draw(st.cfg, st.source, hw) };
    } catch {
      return; // the page drawing stays in the dialog
    }
  }
  if (dlg?.open && dlgWrap === st.wrap) fillDialog(st);
}

function openDialog(wrap: HTMLElement, opener: HTMLButtonElement): void {
  const st = states.get(wrap);
  if (!st) return;
  const d = ensureDialog();
  dlgWrap = wrap;
  dlgOpener = opener;
  fillDialog(st);
  if (!d.open) d.showModal();
  dlgClose?.focus();
  if (st.orig.tracksHost) {
    void enqueue(async () => {
      if (d.open && dlgWrap === wrap) await refineDialog(st);
    });
  }
}

/** Close the dialog when the diagram that opened it has left the page, unless
 *  `root` brings its source back: the pass that redraws it hands the dialog on. */
function closeDialogIfDetached(root?: ParentNode): void {
  if (!dlg?.open || dlgWrap?.isConnected) return;
  const src = dlgWrap?.getAttribute("data-mermaid-src");
  const back = !!root && src != null && Array.from(root.querySelectorAll("code.language-mermaid")).some((c) => c.textContent === src);
  if (!back) dlg.close();
}

function addExpandButton(wrap: HTMLElement): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "diagram-expand";
  b.setAttribute("aria-label", "Open diagram full-window");
  b.title = "Open full-window";
  b.textContent = "⤢";
  b.addEventListener("click", () => openDialog(wrap, b));
  wrap.appendChild(b);
  return b;
}

// ── Passes ────────────────────────────────────────────────────────────

/**
 * Upgrade each `<pre><code class="language-mermaid">` under `root`. A fence
 * whose source and colours match a drawing the previous swap left behind
 * reuses it rather than drawing again: the Ask pane repaints the same answer at
 * `done`, at `answer_html` (often while the `done` pass is still drawing) and on
 * each ↻ splice. What this pass does not reuse is dropped at its end.
 */
async function renderFences(root: ParentNode): Promise<void> {
  collectDetached();
  const offered = new Set(reusable);
  const codes = Array.from(root.querySelectorAll("code.language-mermaid"));
  for (const code of codes) {
    const pre = code.closest("pre");
    if (!pre || !pre.isConnected) continue;
    // Entities decode automatically via textContent → the raw fence source.
    const source = code.textContent ?? "";
    const cfg = readPassConfig(pre);
    const i = reusable.findIndex((d) => d.source === source && d.cfg.key === cfg.key);
    const prev = i >= 0 ? reusable.splice(i, 1)[0] : undefined;
    let orig: Rendered;
    if (prev) orig = prev.orig;
    else {
      try {
        orig = await draw(cfg, source, pre.parentElement?.clientWidth || window.innerWidth);
      } catch {
        continue; // fail-visible: leave this diagram's original markup in place.
      }
    }
    if (!pre.isConnected) {
      reusable.push(prev ?? { source, cfg, orig, flip: undefined }); // the next pass may want it
      continue;
    }
    const wrap = document.createElement("div");
    wrap.className = "diagram";
    // Retain the source so a theme change can re-render without the fence.
    wrap.setAttribute("data-mermaid-src", source);
    const body = document.createElement("div");
    body.className = "diagram-body";
    body.innerHTML = orig.svg;
    wrap.appendChild(body);
    const expand = addExpandButton(wrap);
    pre.replaceWith(wrap);
    const st: DiagramState = {
      wrap, body, source, cfg, orig, flip: prev ? prev.flip : undefined, shown: "orig",
      widened: null, measuredWidth: 0, dialogDraw: prev?.dialogDraw,
    };
    states.set(wrap, st);
    live.add(st);
    if (prev?.wrap && dlg?.open && dlgWrap === prev.wrap) {
      dlgWrap = wrap; // the dialog shows these same drawings: it stays open
      dlgOpener = expand;
    }
    watchBody(st);
    await layout(st);
  }
  reusable = reusable.filter((r) => !offered.has(r));
  closeDialogIfDetached();
}

/** Re-render every on-screen diagram whose resolved colours changed. */
async function rerenderChanged(): Promise<void> {
  const wraps = Array.from(document.querySelectorAll<HTMLElement>("div.diagram[data-mermaid-src]"));
  for (const wrap of wraps) {
    if (!wrap.isConnected) continue;
    const st = states.get(wrap);
    if (!st) {
      await drawCopy(wrap); // a copy: no state of its own
      continue;
    }
    const cfg = readPassConfig(wrap);
    if (cfg.key === st.cfg.key) continue;
    let orig: Rendered;
    try {
      orig = await draw(cfg, st.source, st.body.clientWidth || window.innerWidth);
    } catch {
      continue; // the previous drawing stays
    }
    if (!wrap.isConnected) continue;
    Object.assign(st, { cfg, orig, flip: undefined, shown: "orig", widened: null, measuredWidth: 0, dialogDraw: undefined });
    st.body.innerHTML = orig.svg;
    await layout(st);
    if (dlg?.open && dlgWrap === wrap) {
      fillDialog(st);
      await refineDialog(st);
    }
  }
}

// ── Copies (ref-link peeks, fact-check cards) ─────────────────────────
/** The config each copy was last drawn under. */
const copyKeys = new WeakMap<HTMLElement, string>();

/** Drop what only a live diagram has: ⤢ (its listener is not copied), the
 *  flipped mark and the scroll stop (no ResizeObserver keeps them true). */
function bareCopy(wrap: HTMLElement): void {
  wrap.querySelectorAll(".diagram-expand").forEach((b) => b.remove());
  wrap.removeAttribute("data-mermaid-flipped");
  const body = wrap.querySelector<HTMLElement>(":scope > .diagram-body");
  body?.removeAttribute("role");
  body?.removeAttribute("aria-label");
  body?.removeAttribute("tabindex");
}

/** Draw a copy afresh, fit to its width, under its own id and the colours at
 *  its place, unless it already is. Runs inside the mutex. */
async function drawCopy(wrap: HTMLElement): Promise<void> {
  bareCopy(wrap);
  const body = wrap.querySelector<HTMLElement>(":scope > .diagram-body");
  if (!body || !wrap.isConnected) return;
  const cfg = readPassConfig(wrap);
  if (copyKeys.get(wrap) === cfg.key) return;
  let r: Rendered;
  try {
    r = await draw(cfg, wrap.getAttribute("data-mermaid-src") ?? "", body.clientWidth || window.innerWidth);
  } catch {
    return; // the copied drawing stays
  }
  if (!wrap.isConnected) return;
  body.innerHTML = r.svg;
  copyKeys.set(wrap, cfg.key);
}

/**
 * A copy of a rendered diagram placed elsewhere on the page (a ref-link peek, a
 * fact-check card): call once it is in the document. Its ⤢ and scroll stop go
 * at once; it is then redrawn as a plain fit-to-width diagram, since a copy
 * that lost its ids (the peek strips them) no longer matches its own `<style>`.
 * Theme flips redraw it like any diagram (`rerenderChanged`).
 */
export function adoptMermaidCopies(root: Element): void {
  const sel = "div.diagram[data-mermaid-src]";
  const wraps = [root, ...Array.from(root.querySelectorAll(sel))].filter(
    (w): w is HTMLElement => w.matches(sel) && !states.has(w as HTMLElement),
  );
  if (wraps.length === 0) return;
  wraps.forEach(bareCopy);
  void enqueue(async () => {
    for (const w of wraps) await drawCopy(w);
  });
}

/** Wire theme / palette re-render triggers exactly once (after mermaid loaded). */
function installThemeObservers(): void {
  if (observersInstalled) return;
  observersInstalled = true;
  // The resolved colours are compared per diagram, so a palette flip that
  // keeps light/dark redraws too, and a no-op attribute write redraws nothing.
  const rerender = () => void enqueue(rerenderChanged);
  new MutationObserver(rerender).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-palette"],
  });
  const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) mq.addEventListener("change", rerender);
  const closeOnNav = () => {
    if (dlg?.open) dlg.close();
  };
  window.addEventListener("popstate", closeOnNav);
  window.addEventListener("hashchange", closeOnNav);
}

/**
 * Upgrade any mermaid fences in `root` to inline SVG. No-op (and zero mermaid
 * bytes) when the article has none. Call once after each article swap in the
 * reader — every navigation path funnels through `loadPage`. Every call first
 * closes a full-window view whose diagram the swap removed.
 */
export function enhanceMermaid(root: ParentNode): void {
  closeDialogIfDetached(root);
  dropDetached();
  if (!hasMermaid(root)) return;
  loadMermaid()
    .then(() => {
      installThemeObservers();
      return enqueue(() => renderFences(root));
    })
    .catch(() => {
      // fail-visible: the library never loaded; leave every <pre> untouched.
      closeDialogIfDetached();
    });
}
