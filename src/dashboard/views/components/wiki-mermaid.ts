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
  dialogWidth,
  flipToTopDown,
  injectClassDefs,
  needsFlipCandidate,
  parseViewBox,
  rewriteSvgId,
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
 * Readable size: node text is drawn at 14 px × min(1, body width ÷ viewBox
 * width). Under 11 px, an `LR`/`RL` flowchart is drawn top-down too and shown
 * that way when its text is larger and it stays under 900 px tall; still under
 * 11 px, the SVG is given the width that draws 11 px and `.diagram-body`
 * scrolls sideways, a named tab stop while it does (`syncScrollStop`). Decided
 * from the page's own orientation on every measure (`chooseLayout`).
 *
 * | Starting state                 | Event                                  | Result                                                        |
 * |--------------------------------|----------------------------------------|---------------------------------------------------------------|
 * | dialog closed, focus on ⤢      | click / Enter / Space                  | showModal; focus on the dialog's close button                 |
 * | dialog open                    | Esc                                    | closes; focus back on the ⤢ that opened it                    |
 * | dialog open                    | click on the backdrop (target = dialog)| closes; focus back on ⤢ (the dialog itself has no padding, so |
 * |                                |                                        | only a backdrop click targets it)                             |
 * | dialog open                    | click inside the diagram               | stays open                                                    |
 * | dialog open                    | close button                           | closes; focus back on ⤢                                       |
 * | dialog open                    | theme / palette / OS scheme flip       | the page diagrams re-render, then the dialog's copy is redrawn|
 * |                                |                                        | from the new render in the same pass; it stays open and focus |
 * |                                |                                        | stays where it was in the dialog                              |
 * | dialog open                    | popstate / hashchange                  | closes at once                                                |
 * | dialog open                    | article swapped (loadPage, Ask)        | the next enhanceMermaid call closes it (its ⤢ is detached, so |
 * |                                |                                        | focus goes to body, as for any control in a replaced article) |
 * | dialog open                    | rail / column / window resize          | no effect on the dialog (its width was set when filled)       |
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
}

const states = new WeakMap<HTMLElement, DiagramState>();
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

/** Render one source under `cfg` (classes injected). Throws on a bad fence. */
async function draw(cfg: PassConfig, source: string): Promise<Rendered> {
  ensureInit(cfg);
  const id = `wm-${idCounter++}`;
  const { svg } = await mermaidLib().render(id, injectClassDefs(source, cfg.classDefs));
  return { svg, id, vb: parseViewBox(svg) };
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
  if (st.flip === undefined) {
    const flipped = flipToTopDown(st.source);
    if (!flipped) st.flip = null;
    else if (needsFlipCandidate(width, st.cfg.fontPx, st.orig.vb)) {
      try {
        st.flip = await draw(st.cfg, flipped);
      } catch {
        st.flip = null;
      }
      if (!st.wrap.isConnected) return;
    }
  }
  const d = chooseLayout({ bodyWidth: width, fontPx: st.cfg.fontPx, original: st.orig.vb, flipped: st.flip?.vb ?? null });
  const want = d.flipped && st.flip ? "flip" : "orig";
  if (want !== st.shown || (st.widened !== null && d.widenTo === null) || !st.body.querySelector("svg")) {
    st.body.innerHTML = (want === "flip" ? st.flip! : st.orig).svg;
    st.shown = want;
    st.widened = null;
  }
  if (want === "flip") st.wrap.setAttribute("data-mermaid-flipped", "");
  else st.wrap.removeAttribute("data-mermaid-flipped");
  const svg = st.body.querySelector<SVGSVGElement>("svg");
  if (svg && d.widenTo !== null) {
    const w = Math.ceil(d.widenTo);
    svg.style.maxWidth = "none";
    svg.setAttribute("width", String(w));
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
  // The dialog has no padding of its own: only a backdrop click targets it.
  dlg.addEventListener("click", (e) => {
    if (dlg && e.target === dlg) dlg.close();
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

/** Draw the dialog's copy from the diagram's current render, under a new id
 *  (the page's SVG keeps its own; see `rewriteSvgId`). */
function fillDialog(st: DiagramState): void {
  if (!dlgBody) return;
  const r = st.orig;
  dlgBody.innerHTML = rewriteSvgId(r.svg, r.id, `wm-dlg-${dlgSeq++}`);
  const svg = dlgBody.querySelector<SVGSVGElement>("svg");
  if (svg && r.vb) {
    svg.style.maxWidth = "none";
    svg.setAttribute("width", String(Math.round(dialogWidth(r.vb.width, window.innerWidth))));
  }
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
}

/** Close the dialog when the diagram that opened it has left the page. */
function closeDialogIfDetached(): void {
  if (dlg?.open && !dlgWrap?.isConnected) dlg.close();
}

function addExpandButton(wrap: HTMLElement): void {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "diagram-expand";
  b.setAttribute("aria-label", "Open diagram full-window");
  b.title = "Open full-window";
  b.textContent = "⤢";
  b.addEventListener("click", () => openDialog(wrap, b));
  wrap.appendChild(b);
}

// ── Passes ────────────────────────────────────────────────────────────

/** Upgrade each `<pre><code class="language-mermaid">` under `root`. */
async function renderFences(root: ParentNode): Promise<void> {
  const codes = Array.from(root.querySelectorAll("code.language-mermaid"));
  for (const code of codes) {
    const pre = code.closest("pre");
    if (!pre || !pre.isConnected) continue;
    // Entities decode automatically via textContent → the raw fence source.
    const source = code.textContent ?? "";
    const cfg = readPassConfig(pre);
    let orig: Rendered;
    try {
      orig = await draw(cfg, source);
    } catch {
      continue; // fail-visible: leave this diagram's original markup in place.
    }
    if (!pre.isConnected) continue;
    const wrap = document.createElement("div");
    wrap.className = "diagram";
    // Retain the source so a theme change can re-render without the fence.
    wrap.setAttribute("data-mermaid-src", source);
    const body = document.createElement("div");
    body.className = "diagram-body";
    body.innerHTML = orig.svg;
    wrap.appendChild(body);
    addExpandButton(wrap);
    pre.replaceWith(wrap);
    const st: DiagramState = { wrap, body, source, cfg, orig, flip: undefined, shown: "orig", widened: null, measuredWidth: 0 };
    states.set(wrap, st);
    watchBody(st);
    await layout(st);
  }
}

/** Re-render every on-screen diagram whose resolved colours changed. */
async function rerenderChanged(): Promise<void> {
  const wraps = Array.from(document.querySelectorAll<HTMLElement>("div.diagram[data-mermaid-src]"));
  for (const wrap of wraps) {
    const st = states.get(wrap);
    if (!st || !wrap.isConnected) continue;
    const cfg = readPassConfig(wrap);
    if (cfg.key === st.cfg.key) continue;
    let orig: Rendered;
    try {
      orig = await draw(cfg, st.source);
    } catch {
      continue; // the previous drawing stays
    }
    if (!wrap.isConnected) continue;
    Object.assign(st, { cfg, orig, flip: undefined, shown: "orig", widened: null, measuredWidth: 0 });
    st.body.innerHTML = orig.svg;
    await layout(st);
    if (dlg?.open && dlgWrap === wrap) fillDialog(st);
  }
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
  closeDialogIfDetached();
  dropDetached();
  if (!hasMermaid(root)) return;
  loadMermaid()
    .then(() => {
      installThemeObservers();
      return enqueue(() => renderFences(root));
    })
    .catch(() => {
      // fail-visible: the library never loaded; leave every <pre> untouched.
    });
}
