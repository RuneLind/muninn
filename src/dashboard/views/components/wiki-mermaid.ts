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
 *  - Theme: effective light/dark follows the reader's toggle
 *    (`<html data-theme>`) or, absent that, the OS preference; both a
 *    MutationObserver on `data-theme` and a matchMedia listener re-render the
 *    on-screen diagrams from their retained source. Every render pass is
 *    serialized through a module-level mutex so a navigation pass and a
 *    theme-change pass can never interleave and mix themes on one page.
 *  - Fail-visible: on any render rejection the original `<pre>` is left exactly
 *    as-is — never blanked, never an error graphic.
 *
 * Consumers: the wiki reader (direct import), the wiki Ask pane, and the
 * /research answer render (via the wiki-mermaid-client globalThis bundle) all
 * call the same exported enhanceMermaid. Chat and explainer iframes are
 * untouched; the server render pipeline is unchanged.
 */

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
/**
 * Mutex: every render pass chains onto this so passes run strictly
 * one-after-another. `mermaid.initialize({theme})` mutates *global* mermaid
 * config, so a navigation pass and a theme-change pass overlapping would let a
 * mid-flight theme flip re-init the config while the first pass is still
 * awaiting `mermaid.render()` — yielding mixed-theme diagrams on one page.
 */
let passChain: Promise<void> = Promise.resolve();

interface RenderTarget {
  source: string;
  apply: (svg: string) => void;
}

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
 * Queue a render pass behind any in-flight pass (see {@link passChain}) so
 * passes never interleave. The effective theme is read *inside* the pass, only
 * once the mutex is held — so a rerender queued while the theme was still stale
 * renders the theme current at pass start, never the stale one.
 */
function renderTargets(targets: RenderTarget[]): Promise<void> {
  const run = passChain.then(() => renderPass(targets));
  // Keep the chain alive even if a pass rejects (renderPass swallows its own
  // per-diagram errors, so this is belt-and-suspenders).
  passChain = run.catch(() => {});
  return run;
}

/**
 * Render each target sequentially (unique id per call, one temp node at a time)
 * with the effective theme read at pass start. Each failure is swallowed
 * per-diagram so one bad fence never blocks the rest — the caller leaves that
 * node untouched.
 */
async function renderPass(targets: RenderTarget[]): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mermaid = (globalThis as any).mermaid;
  if (!mermaid || targets.length === 0) return;
  // Re-read the theme now that we own the mutex — a theme flip that arrived
  // while a prior pass was rendering is reflected here, not missed.
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
