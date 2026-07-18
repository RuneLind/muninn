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
 *    load Promise dedupes concurrent triggers; later navigations reuse it.
 *  - Security: `securityLevel: 'strict'`, `suppressErrorRendering: true` — the
 *    default locked-directive set keeps `securityLevel` immune to a
 *    `%%{init}%%` downgrade in page source.
 *  - Theme: effective light/dark follows the reader's toggle
 *    (`<html data-theme>`) or, absent that, the OS preference; both a
 *    MutationObserver on `data-theme` and a matchMedia listener re-render the
 *    on-screen diagrams from their retained source.
 *  - Fail-visible: on any render rejection the original `<pre>` is left exactly
 *    as-is — never blanked, never an error graphic.
 *
 * Scope is the wiki reader only. Chat, research answers, and explainer iframes
 * are untouched; the server render pipeline is unchanged.
 */

/**
 * Pinned mermaid 11.x UMD build. A classic (non-module) script that ends with
 * `globalThis["mermaid"] = …`, so `window.mermaid` is defined once `onload`
 * fires — exactly what dynamic `<script>` injection needs.
 */
export const MERMAID_CDN_URL =
  "https://cdn.jsdelivr.net/npm/mermaid@11.16.0/dist/mermaid.min.js";

/** Map the reader's effective light/dark state to a mermaid theme name. */
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

// ── Runtime state (module-level, browser only) ────────────────────────
/** Shared load Promise — a second trigger before onload has something to await. */
let scriptLoad: Promise<void> | null = null;
/** Monotonic id source so each `render()` call gets a unique temp-node id. */
let idCounter = 0;
/** The mermaid theme the on-screen diagrams were last rendered with. */
let lastTheme: "default" | "dark" | null = null;
/** Theme re-render listeners are wired at most once. */
let observersInstalled = false;

interface RenderTarget {
  source: string;
  apply: (svg: string) => void;
}

/** Inject the pinned mermaid script once; reuse the shared Promise thereafter. */
function loadMermaid(): Promise<void> {
  return (scriptLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = MERMAID_CDN_URL;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptLoad = null; // allow a later navigation to retry the load
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
 * Render each target sequentially (unique id per call, one temp node at a time)
 * with the current effective theme. Each failure is swallowed per-diagram so
 * one bad fence never blocks the rest — the caller leaves that node untouched.
 */
async function renderTargets(targets: RenderTarget[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mermaid = (globalThis as any).mermaid;
  if (!mermaid || targets.length === 0) return;
  const theme = effectiveTheme();
  // Re-init before every pass — theme changes only take effect on initialize().
  mermaid.initialize({
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme,
    startOnLoad: false,
  });
  lastTheme = theme;
  for (const t of targets) {
    try {
      const { svg } = await mermaid.render(`mermaid-${idCounter++}`, t.source);
      t.apply(svg);
    } catch {
      // fail-visible: leave this diagram's original markup in place.
    }
  }
}

/** Collect the `<pre><code class="language-mermaid">` fences to upgrade. */
function collectFences(root: ParentNode): RenderTarget[] {
  const targets: RenderTarget[] = [];
  root.querySelectorAll("code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    if (!pre) return;
    // Entities decode automatically via textContent → the raw fence source.
    const source = code.textContent ?? "";
    targets.push({
      source,
      apply: (svg) => {
        const wrap = document.createElement("div");
        wrap.className = "diagram";
        // Retain the source so a theme change can re-render without the fence.
        wrap.setAttribute("data-mermaid-src", source);
        const body = document.createElement("div");
        body.className = "diagram-body";
        body.innerHTML = svg;
        wrap.appendChild(body);
        pre.replaceWith(wrap);
      },
    });
  });
  return targets;
}

/** Collect already-rendered diagrams to re-render (theme change). */
function collectRendered(root: ParentNode): RenderTarget[] {
  const targets: RenderTarget[] = [];
  root.querySelectorAll("div.diagram[data-mermaid-src]").forEach((wrap) => {
    const body = wrap.querySelector(".diagram-body");
    if (!body) return;
    const source = wrap.getAttribute("data-mermaid-src") ?? "";
    targets.push({ source, apply: (svg) => (body.innerHTML = svg) });
  });
  return targets;
}

/** Wire theme re-render triggers exactly once (after mermaid has loaded). */
function installThemeObservers(): void {
  if (observersInstalled) return;
  observersInstalled = true;
  const rerender = () => {
    if (effectiveTheme() === lastTheme) return; // no effective change → skip
    const targets = collectRendered(document.body);
    if (targets.length > 0) void renderTargets(targets);
  };
  new MutationObserver(rerender).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  const mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) mq.addEventListener("change", rerender);
}

/**
 * Upgrade any mermaid fences in `root` to inline SVG. No-op (and zero mermaid
 * bytes) when the article has none. Call once after each article swap in the
 * reader — every navigation path funnels through `loadPage`.
 */
export function enhanceMermaid(root: ParentNode): void {
  if (!hasMermaid(root)) return;
  loadMermaid()
    .then(() => {
      installThemeObservers();
      return renderTargets(collectFences(root));
    })
    .catch(() => {
      // fail-visible: the library never loaded; leave every <pre> untouched.
    });
}
