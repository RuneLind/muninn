import { themeInitScript, themeToggleHtml, themeToggleScript } from "./components/theme.ts";
import { resolveServingProfile, type MuninnProfile } from "../../config.ts";
import { droppedRouteGroups, type RouteGroup } from "../route-groups.ts";
import { LAST_WIKI_KEY } from "./components/wiki-home.ts";

/** Dark palette — the default, and the forced value under html[data-theme="dark"]. */
const DARK_TOKENS = `
      /* Backgrounds */
      --bg-page: #0a0a0f;
      --bg-panel: #12121a;
      --bg-surface: #1a1a2e;
      --bg-deep: #0f0f17;
      --bg-inset: #0d0d14;
      --bg-gradient-end: #16162a;
      --bg-card: #1a1a2e;
      --bg-hover: rgba(255, 255, 255, 0.04);

      /* Borders */
      --border-primary: #1e1e2e;
      --border-secondary: #2a2a3e;
      --border-subtle: #1a1a28;
      --scrollbar-thumb: #2a2a3a;

      /* Text */
      --text-primary: #fff;
      --text-secondary: #e0e0e0;
      --text-tertiary: #ccc;
      --text-soft: #aaa;
      --text-muted: #888;
      --text-dim: #666;
      --text-faint: #555;
      --text-disabled: #444;

      /* Accent (brand purple) */
      --accent: #6c63ff;
      --accent-hover: #5a52e0;
      --accent-light: #a5a0ff;

      /* Status colors */
      --status-success: #4ade80;
      --status-error: #f87171;
      --status-warning: #fbbf24;
      --status-info: #60a5fa;
      --status-tool: #f59e0b;
      --status-cyan: #22d3ee;
      --status-magenta: #c084fc;

      /* Tinted backgrounds (for badges, events) */
      --tint-success: #1a3a2a;
      --tint-error: #3a1a1a;
      --tint-warning: #2a2a1a;
      --tint-info: #1e3a5f;
      --tint-purple: #1e1e3e;
      --tint-magenta: #2a1a3a;
      --tint-cyan: #1a2e3a;
      --tint-neutral: #1a1a1a;

      /* Accent text variants */
      --accent-muted: #8b8bcd;

      /* Chat bubbles */
      --chat-user-bg: #1e3a5f;
      --chat-user-text: #c8ddf5;
      --chat-assistant-bg: #1a1d25;
      --chat-assistant-text: #d8d8dc;

      /* Syntax highlighting (src/format/highlight.ts emits .tok-*).
         Deliberately the --status-* ramp rather than a new hue set: those six
         colors are already tuned for both themes, so a code fence reads as the
         same design system as the rest of the page. Every value clears 4.5:1
         against --bg-inset (measured 2026-08-30 — comments are 40% of a
         typical query here, so the dimmest one is the one that matters). */
      --tok-com: #7d8798;
      --tok-str: #4ade80;
      --tok-kw: #c084fc;
      --tok-num: #fbbf24;
      --tok-fn: #60a5fa;
      --tok-typ: #22d3ee;
      --tok-pun: #8e8e9c;

      /* Code-block chrome. --bg-inset is the WRONG fill for a code block on
         dark: it sits ~2 L* BELOW --bg-panel, so the block has no visible edge
         at all (measured from the reported screenshot — contrast ratio is
         useless there, it reads 1.04 either way). Dark separates by going
         LIGHTER than the page, light keeps its well; one token, each theme in
         its own direction. */
      --bg-code: #1a1a2e;
      --bg-code-bar: #22223c;
`;

/**
 * Light palette — applied under `@media (prefers-color-scheme: light)` (system
 * follow) and forced under `html[data-theme="light"]`. Status colors are darkened
 * vs the dark ramp so they stay legible on light backgrounds; tints flip to pale
 * fills. Mirrors the chat page's light theme so the two surfaces match.
 */
const LIGHT_TOKENS = `
      /* Backgrounds */
      --bg-page: #f3f4f7;
      --bg-panel: #ffffff;
      --bg-surface: #f1f2f6;
      --bg-deep: #eceef3;
      --bg-inset: #eceef3;
      --bg-gradient-end: #e8eaf2;
      --bg-card: #f1f2f6;
      --bg-hover: rgba(0, 0, 0, 0.04);

      /* Borders */
      --border-primary: #e2e4ea;
      --border-secondary: #d2d5de;
      --border-subtle: #edeef2;
      --scrollbar-thumb: #cfd2db;

      /* Text */
      --text-primary: #14151a;
      --text-secondary: #3a3d47;
      --text-tertiary: #4a4d57;
      --text-soft: #5a5e68;
      --text-muted: #6c707d;
      --text-dim: #80848f;
      --text-faint: #9aa0ad;
      --text-disabled: #b8bcc6;

      /* Accent (brand purple) */
      --accent: #6357f0;
      --accent-hover: #5247d8;
      --accent-light: #5247d8;

      /* Status colors */
      --status-success: #16a34a;
      --status-error: #dc2626;
      --status-warning: #d97706;
      --status-info: #2563eb;
      --status-tool: #c2620a;
      --status-cyan: #0891b2;
      --status-magenta: #9333ea;

      /* Tinted backgrounds (for badges, events) */
      --tint-success: #dcfce7;
      --tint-error: #fee2e2;
      --tint-warning: #fef3c7;
      --tint-info: #dbeafe;
      --tint-purple: #e7e7fb;
      --tint-magenta: #f3e8ff;
      --tint-cyan: #cffafe;
      --tint-neutral: #eceef3;

      /* Accent text variants */
      --accent-muted: #6b6f9a;

      /* Chat bubbles */
      --chat-user-bg: #dbeafe;
      --chat-user-text: #1e3a5f;
      --chat-assistant-bg: #f1f2f6;
      --chat-assistant-text: #3a3d47;

      /* Syntax highlighting — the light half of the ramp above. Darkened past
         the plain --status-* values, which sit at 4.2–4.4:1 on --bg-inset:
         close enough to read as "fine" and measurably under AA. */
      --tok-com: #5e6270;
      --tok-str: #0f6e39;
      --tok-kw: #8b2fd0;
      --tok-num: #9c4a07;
      --tok-fn: #1d4ed8;
      --tok-typ: #0e7490;
      --tok-pun: #5e6270;

      /* The light theme already separated correctly — this is --bg-inset's
         value, kept under the new name so both themes read one token. */
      --bg-code: #eceef3;
      --bg-code-bar: #e2e4ea;
`;

/** Shared CSS for all dashboard pages — base reset, header, and nav */
export const SHARED_STYLES = `
    :root {${DARK_TOKENS}    }

    /* System follow: honor the OS preference when no explicit override is set. */
    @media (prefers-color-scheme: light) {
      :root {${LIGHT_TOKENS}      }
    }

    /* Explicit overrides (set by the theme toggle). html[data-theme] has higher
       specificity than the media-query :root, so it wins regardless of OS setting. */
    html[data-theme="dark"] {${DARK_TOKENS}    }
    html[data-theme="light"] {${LIGHT_TOKENS}    }

    /* Theme toggle button (right of the nav, on every page) */
    .header-right { display: flex; align-items: center; gap: 12px; }
    .theme-toggle {
      width: 30px;
      height: 30px;
      display: grid;
      place-items: center;
      cursor: pointer;
      background: var(--bg-surface);
      border: 1px solid var(--border-primary);
      border-radius: 6px;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1;
      font-family: inherit;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .theme-toggle:hover { color: var(--text-primary); border-color: var(--border-secondary); }

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg-page);
      color: var(--text-secondary);
      min-height: 100vh;
    }

    /* Header */
    header {
      background: var(--bg-panel);
      border-bottom: 1px solid var(--border-primary);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { font-size: 20px; font-weight: 600; color: var(--text-primary); }
    header h1 span { color: var(--accent); }
    .header-left { display: flex; align-items: center; gap: 16px; }
    .nav-link { color: var(--text-muted); text-decoration: none; font-size: 13px; padding: 4px 10px; border-radius: 6px; transition: all 0.2s; }
    .nav-link:hover { color: var(--accent-light); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .nav-link.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }

    .error-banner {
      display: none;
      margin: 0 24px 12px;
      padding: 12px 16px;
      background: color-mix(in srgb, var(--status-error) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--status-error) 30%, transparent);
      border-radius: 8px;
      color: var(--status-error);
      font-size: 13px;
    }
    .error-banner.visible { display: block; }
    .error-banner code { background: rgba(255,255,255,0.1); padding: 2px 6px; border-radius: 4px; font-size: 12px; }

    /* --- Live-activity animation primitives (shared) ------------------------
       Promoted out of /agents so the chat + gardener live strips can adopt the
       same pulse-ring dot and shimmer bar later. Consumers set the color via the
       element's own background; the pulse can be stopped via --pulse-anim: none.
       Keyframes are global. */
    @keyframes pulse-ring {
      0%   { transform: scale(0.6); opacity: 0.6; }
      100% { transform: scale(2.2); opacity: 0; }
    }
    @keyframes shimmer { 0% { left: -35%; } 100% { left: 100%; } }

    /* A small live dot with an expanding ring. Color follows its own background
       (override per-kind); a done/paused variant sets --pulse-anim: none. */
    .pulse-dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--status-success);
      position: relative; flex-shrink: 0;
    }
    .pulse-dot::after {
      content: ''; position: absolute; inset: -4px; border-radius: 50%;
      background: inherit; opacity: 0.5;
      animation: pulse-ring 1.6s ease-out infinite;
      animation-name: var(--pulse-anim, pulse-ring);
    }

    /* Indeterminate shimmer sweep — drop inside a clipped, positioned track. */
    .shimmer-bar {
      position: absolute; top: 0; left: 0; height: 100%; width: 35%; border-radius: 3px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
      animation: shimmer 1.4s linear infinite;
    }

    /* --- Nav cluster separators (thin vertical rule between the 3 nav groups) --- */
    header nav { display: inline-flex; align-items: center; gap: 2px; flex-wrap: wrap; }
    .nav-sep {
      display: inline-block; width: 1px; height: 14px;
      background: var(--border-secondary); margin: 0 6px; align-self: center;
    }

    /* --- Tools ▾ dropdown (native <details>, no per-page JS) -----------------
       The trigger reuses .nav-link so it matches its sibling links; the panel
       floats over the page body on --bg-panel + a border so it stays legible in
       BOTH themes (never a hardcoded dark hex). */
    .nav-dropdown { position: relative; display: inline-block; }
    .nav-dropdown > summary {
      list-style: none; cursor: pointer; user-select: none;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .nav-dropdown > summary::-webkit-details-marker { display: none; }
    .nav-dropdown > summary::marker { content: ""; }
    .nav-caret { font-size: 9px; color: var(--text-dim); transition: transform 0.15s ease; }
    .nav-dropdown[open] .nav-caret { transform: rotate(180deg); }
    .nav-dropdown[open] > summary { color: var(--accent-light); }
    .nav-dropdown-panel {
      position: absolute; top: calc(100% + 6px); left: 0; z-index: 60;
      min-width: 168px; padding: 6px;
      background: var(--bg-panel);
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
      display: flex; flex-direction: column; gap: 2px;
    }
    .nav-dropdown-item {
      color: var(--text-muted); text-decoration: none; font-size: 13px;
      padding: 6px 10px; border-radius: 6px; white-space: nowrap; transition: all 0.15s;
    }
    .nav-dropdown-item:hover { color: var(--accent-light); background: color-mix(in srgb, var(--accent) 10%, transparent); }
    .nav-dropdown-item.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent); }

    /* --- Syntax highlighting -------------------------------------------------
       Deliberately UNSCOPED. The .tok-* classes are emitted by exactly one
       module (src/format/highlight.ts) and every page that renders markdown
       through formatWebHtml wants them: /wiki, /jira, the gardener preview,
       /research. Scoping them to .wiki-article was the version of this that
       shipped colored code on one page and gray code on four. */
    .tok-com { color: var(--tok-com); font-style: italic; }
    .tok-str { color: var(--tok-str); }
    .tok-kw  { color: var(--tok-kw); }
    .tok-num { color: var(--tok-num); }
    .tok-fn  { color: var(--tok-fn); }
    .tok-typ { color: var(--tok-typ); }
    .tok-pun { color: var(--tok-pun); }

    /* --- Code-block chrome (header bar + copy) ------------------------------
       Built by the enhanceCodeBlocks CLIENT enhancer, never server-rendered:
       the chat sanitizer drops a div at the fence level, so a server-emitted
       wrapper flattens code blocks to plain text in chat. See that module.

       ⚠️ The element-qualified selectors are load-bearing, not style. Page
       sheets are injected AFTER these (wiki-page.ts defines .wiki-article
       pre, chat defines .web-content pre code), and at equal specificity the
       later rule wins — so .fence pre would lose to the very fill this
       replaces. div.fence > pre outranks it by one element selector. */
    .fence {
      margin: 14px 0;
      border: 1px solid var(--border-secondary);
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-code);
    }
    .fence-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      background: var(--bg-code-bar);
      border-bottom: 1px solid var(--border-secondary);
      padding: 5px 8px 5px 12px;
      min-height: 30px;
    }
    .fence-lang {
      font: 500 10.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
      letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-dim);
    }
    div.fence > pre {
      margin: 0; background: transparent; border: 0; border-radius: 0;
      padding: 12px 14px 14px; overflow-x: auto;
    }
    div.fence > pre > code {
      background: none; padding: 0; border-radius: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }

    /* Copy: hidden until the block is hovered or holds focus — zero resting
       noise on a page of fences. :focus-within is what keeps it reachable by
       keyboard, and the hover: none block is what keeps it usable at all on a
       touch device, where the hover state never arrives. */
    .fence-copy {
      display: inline-flex; align-items: center; gap: 5px;
      font: 500 11px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: var(--text-muted); background: var(--bg-surface);
      border: 1px solid var(--border-secondary);
      padding: 4px 9px; border-radius: 6px; cursor: pointer;
      opacity: 0; transition: opacity 0.13s, color 0.13s, border-color 0.13s;
    }
    .fence:hover .fence-copy,
    .fence:focus-within .fence-copy { opacity: 1; }
    @media (hover: none) { .fence-copy { opacity: 1; } }
    .fence-copy:hover { color: var(--text-primary); border-color: var(--text-dim); }
    .fence-copy:focus-visible { opacity: 1; outline: 2px solid var(--accent); outline-offset: 1px; }
    .fence-copy.is-done { color: var(--status-success); border-color: var(--status-success); }
    .fence-copy.is-failed { color: var(--status-error); border-color: var(--status-error); }
    .fence-copy svg { width: 12px; height: 12px; flex: none; }

    /* ========================================================================
       Shared dashboard-redesign primitives (PR 1). Consumed by /agents,
       /models and /indexing in PRs 2–4. Every tint is expressed through
       color-mix on a status/accent variable so the LIGHT palette works — the
       design prototypes hardcode the dark rgba values of these same tokens.
       ======================================================================== */

    /* --- Summary tiles (stat row under a page header) ------------------------
       tileHtml() (summary-tiles.ts client script) builds these. Attention rule:
       a tile gets a colored border ONLY when its tone says it needs attention;
       neutral (toneless) tiles stay quiet. The tone also colors the label. */
    .summary-tiles { display: flex; gap: 10px; flex-wrap: wrap; margin: 16px 0 20px; }
    .s-tile {
      background: var(--bg-panel); border: 1px solid var(--border-primary);
      border-radius: 10px; padding: 11px 16px; min-width: 130px;
    }
    .s-tile-label { font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--text-dim); margin-bottom: 4px; }
    .s-tile-value { font-size: 16px; font-weight: 600; color: var(--text-primary); }
    .s-tile-sub   { font-size: 11px; color: var(--text-dim); margin-top: 2px; }
    .s-tile-warning { border-color: color-mix(in srgb, var(--status-warning) 35%, transparent); }
    .s-tile-warning .s-tile-label { color: var(--status-warning); }
    .s-tile-success { border-color: color-mix(in srgb, var(--status-success) 30%, transparent); }
    .s-tile-success .s-tile-label { color: var(--status-success); }
    .s-tile-error   { border-color: color-mix(in srgb, var(--status-error) 35%, transparent); }
    .s-tile-error .s-tile-label { color: var(--status-error); }
    .s-tile-info    { border-color: color-mix(in srgb, var(--status-info) 30%, transparent); }
    .s-tile-info .s-tile-label { color: var(--status-info); }

    /* --- Unified status chips (9px geometry) --------------------------------
       Attention (STALE), origin/routing (full 11-value Origin union), job-kind
       (fixed 68px) and run-status. status-chips.ts renders these. */
    .dchip {
      display: inline-flex; align-items: center; gap: 4px;
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 1px 7px; border-radius: 9px; line-height: 1.7;
      text-transform: uppercase; white-space: nowrap; vertical-align: middle;
    }
    /* Attention chip — shown ONLY when something is wrong. */
    .dchip-attn     { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
    /* Origin / routing chips (config env override default derived legacy fixed none pinned owner fallback). */
    .dchip-config,
    .dchip-pinned   { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-light); }
    .dchip-override,
    .dchip-owner    { background: color-mix(in srgb, var(--status-success) 14%, transparent); color: var(--status-success); }
    .dchip-env      { background: color-mix(in srgb, var(--status-info) 16%, transparent); color: var(--status-info); }
    /* derived adopts the design's neutral gray (was cyan) — decision from the plan. */
    .dchip-derived,
    .dchip-default  { background: var(--tint-neutral); color: var(--text-muted); }
    .dchip-fallback,
    .dchip-legacy   { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
    .dchip-fixed    { background: color-mix(in srgb, var(--status-magenta) 16%, transparent); color: var(--status-magenta); }
    .dchip-none     { background: var(--tint-neutral); color: var(--text-disabled); }

    /* Job-kind chips (Agents) — fixed 68px, centered. */
    .kind-chip {
      display: inline-flex; align-items: center; justify-content: center;
      width: 68px; text-align: center; flex-shrink: 0;
      font-size: 9px; font-weight: 700; letter-spacing: 0.5px;
      padding: 1px 7px; border-radius: 9px; line-height: 1.7;
      text-transform: uppercase; white-space: nowrap;
    }
    .kind-watcher { background: color-mix(in srgb, var(--status-info) 14%, transparent); color: var(--status-info); }
    .kind-task    { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent-light); }
    .kind-capture { background: color-mix(in srgb, var(--status-magenta) 16%, transparent); color: var(--status-magenta); }
    .kind-digest  { background: color-mix(in srgb, var(--status-cyan) 13%, transparent); color: var(--status-cyan); }
    /* Remaining AgentKind chips (Agents page). GARDENER→success, EXTRACTOR→warning;
       chat/research/profile share a quiet neutral (the 4 hue slots above are the
       design-canonical kinds, error stays reserved for run-status failures). */
    .kind-gardener  { background: color-mix(in srgb, var(--status-success) 16%, transparent); color: var(--status-success); }
    .kind-extractor { background: color-mix(in srgb, var(--status-warning) 16%, transparent); color: var(--status-warning); }
    .kind-chat,
    .kind-research,
    .kind-factcheck,
    .kind-profile   { background: var(--tint-neutral); color: var(--text-muted); }

    /* Run status — 7px colored dot + lowercase text (NOT an uppercase pill).
       Failure/staleness also tints the text. */
    .run-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-soft); white-space: nowrap; }
    .run-status .run-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-disabled); }
    .run-success .run-dot { background: var(--status-success); }
    .run-warning .run-dot { background: var(--status-warning); }
    .run-error   .run-dot { background: var(--status-error); }
    .run-info    .run-dot { background: var(--status-info); }
    .run-magenta .run-dot { background: var(--status-magenta); }
    .run-warning { color: var(--status-warning); }
    .run-error   { color: var(--status-error); }
    .run-info    { color: var(--status-info); }
    .run-magenta { color: var(--status-magenta); }
    /* running → pulsing dot (reuses the shared pulse-ring idiom; --pulse-anim: none stops it). */
    .run-info .run-dot { position: relative; }
    .run-info .run-dot::after {
      content: ''; position: absolute; inset: -3px; border-radius: 50%;
      background: inherit; opacity: 0.5;
      animation: pulse-ring 1.6s ease-out infinite;
      animation-name: var(--pulse-anim, pulse-ring);
    }

    /* Aging / stale relative-time text (design's #d0a94a) — a muted warning that
       works in both themes. */
    .text-aging { color: color-mix(in srgb, var(--status-warning) 65%, var(--text-muted)); }

    /* Expand caret — rotates 90° on open (shared by the PR 2–4 expandable rows). */
    .caret { display: inline-block; transition: transform 0.12s ease; color: var(--text-dim); font-size: 9px; }
    .caret.open { transform: rotate(90deg); }

    /* Row hover wash (accent 5%). */
    .hover-wash:hover { background: color-mix(in srgb, var(--accent) 5%, transparent); }
`;

type NavPage = "dashboard" | "traces" | "search" | "research" | "logs" | "mcp-debug" | "chat" | "summaries" | "serena" | "wiki" | "graph" | "plans" | "benchmark" | "models" | "indexing" | "agents" | "jira";

/**
 * Which route GROUP each nav destination belongs to — the whole reason the nav
 * takes a profile. A link to a group the profile did not register is a 404 from
 * every page that renders this header, `/chat` included, which on a nais pod is
 * the only page there is. Mapping EVERY link (not just today's dropped ones)
 * means a change to `NAIS_DROPPED_ROUTE_GROUPS` updates the nav by itself.
 *
 * `dashboard` and `chat` map to nothing: `/` is inline in the route factory and
 * `/chat` is a separately-mounted sub-app, so neither is droppable.
 */
const NAV_PAGE_GROUP: Record<NavPage, RouteGroup | null> = {
  dashboard: null, chat: null,
  agents: "agents", traces: "traces", research: "research", search: "search",
  summaries: "summaries", wiki: "wiki", graph: "graph", plans: "plans",
  jira: "jira", logs: "logs", "mcp-debug": "tools", serena: "tools",
  benchmark: "benchmark", models: "models", indexing: "indexing",
};

/** Shared header HTML with nav links */
export function renderNav(
  activePage: NavPage,
  options?: { headerLeftExtra?: string; headerRight?: string; profile?: MuninnProfile },
): string {
  // Read at CALL time when the caller does not say, like `isWikiReadonly()`:
  // a view takes no `Config`, and the option exists so a test never has to set
  // a process-wide flag. Same one parse either way.
  const dropped = droppedRouteGroups(options?.profile ?? resolveServingProfile());
  const shown = (page: NavPage): boolean => {
    const group = NAV_PAGE_GROUP[page];
    return group === null || !dropped.has(group);
  };
  /** A top-level link, or nothing at all when its group was not registered. */
  const link = (page: NavPage, href: string, label: string): string =>
    shown(page) ? `<a href="${href}" class="nav-link${activePage === page ? " active" : ""}">${label}</a>` : "";
  const dropItem = (page: NavPage, href: string, label: string): string =>
    shown(page) ? `<a href="${href}" class="nav-dropdown-item${activePage === page ? " active" : ""}">${label}</a>` : "";
  // Pages collapsed under the "Tools ▾" dropdown. The trigger reads as active
  // whenever the current page is one of these (and the matching entry inside is
  // highlighted too).
  // `/jira` goes HERE rather than beside Plans: the top-level row already
  // carries ten links, and an eleventh would be the one that pushed it into a
  // second line on a laptop. The page is the read-only ARCHIVE of Jira drafts —
  // a place you look one up afterwards, reached from a chat card or a link in
  // someone's notes, not a surface you watch. (The composer it replaced was in
  // the dropdown for the same reason.)
  const toolsPages = ["logs", "mcp-debug", "serena", "benchmark", "models", "indexing", "jira"] as const;
  const toolsActive = (toolsPages as readonly string[]).includes(activePage);
  // The dropdown itself goes when it would be empty — a profile that dropped
  // every tool would otherwise render a "Tools ▾" trigger opening onto nothing.
  const toolsItems = [
    dropItem("jira", "/jira", "Jira"),
    dropItem("logs", "/logs", "Logs"),
    dropItem("mcp-debug", "/mcp-debug", "MCP Debug"),
    dropItem("serena", "/serena", "Serena"),
    dropItem("benchmark", "/benchmark", "Benchmark"),
    dropItem("models", "/models", "Models"),
    dropItem("indexing", "/indexing", "Indexing"),
  ].filter((item) => item !== "");
  // The "Wiki" link goes to the wiki ON SCREEN when this is the reader AND it
  // serves one — `__WIKI_ROOT__` is a string (both injected by the page above
  // the nav; "" under the WIKI_DIR override keeps the bare link) — else the wiki
  // last opened by URL. Not `__WIKI_NAME__` alone: that is the REQUESTED name
  // on the "No wiki named X" page, whose root is null, and preferring it pointed
  // the nav at the error page (measured in review). The store is written by the
  // reader under `LAST_WIKI_KEY` (components/wiki-home.ts owns the rule
  // and refuses to store a name the picker does not offer). Bare /wiki resolves
  // to the DEFAULT wiki server-side, so without this every trip through the nav
  // dropped the reader back to jarvis. Runs on DOMContentLoaded: this script
  // sits ABOVE the nav markup, so at parse time the link is not in the document
  // yet (measured: 0 rewrites). Emitted only when the link is — a profile that
  // dropped the wiki group must render no `href="/wiki"` at all, script included.
  const wikiNavRewrite = !shown("wiki") ? "" : `
      document.addEventListener('DOMContentLoaded', function() {
        try {
          var served = typeof window.__WIKI_ROOT__ === 'string' && window.__WIKI_ROOT__ !== ''
            && typeof window.__WIKI_NAME__ === 'string';
          var wiki = served ? window.__WIKI_NAME__ : localStorage.getItem(${JSON.stringify(LAST_WIKI_KEY)});
          if (wiki) {
            document.querySelectorAll('a.nav-link[href="/wiki"]').forEach(function(a) {
              a.setAttribute('href', '/wiki?wiki=' + encodeURIComponent(wiki));
            });
          }
        } catch (e) { /* storage unavailable: keep the bare link */ }
      });
`;
  const toolsDropdown = toolsItems.length === 0 ? "" : `<details class="nav-dropdown">
          <summary class="nav-link${toolsActive ? " active" : ""}">Tools <span class="nav-caret" aria-hidden="true">▾</span></summary>
          <div class="nav-dropdown-panel">
${toolsItems.map((item) => `            ${item}`).join("\n")}
          </div>
        </details>`;
  return `
  <script>${themeInitScript()}</script>
  <script>
    if (!window.__fullscreenNav) {
      window.__fullscreenNav = true;

      // Toggle fullscreen with 'f' (skip when typing in inputs)
      document.addEventListener('keydown', function(e) {
        if (e.key === 'f' && !e.ctrlKey && !e.metaKey && !e.altKey &&
            !['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) &&
            !e.target.isContentEditable) {
          if (document.fullscreenElement) {
            document.exitFullscreen();
            sessionStorage.removeItem('fs');
          } else {
            document.documentElement.requestFullscreen();
            sessionStorage.setItem('fs', '1');
          }
        }
      });

      // Track exit via Escape or browser UI
      document.addEventListener('fullscreenchange', function() {
        if (!document.fullscreenElement) sessionStorage.removeItem('fs');
      });

      // Re-enter fullscreen after navigation if it was active
      if (sessionStorage.getItem('fs')) {
        document.documentElement.requestFullscreen().catch(function() {});
      }

${wikiNavRewrite}      // Close the Tools ▾ dropdown on outside-click / Escape (native <details>
      // stays open otherwise). One global listener, no per-page wiring.
      document.addEventListener('click', function(e) {
        document.querySelectorAll('details.nav-dropdown[open]').forEach(function(d) {
          if (!d.contains(e.target)) d.removeAttribute('open');
        });
      });
      document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
          document.querySelectorAll('details.nav-dropdown[open]').forEach(function(d) {
            d.removeAttribute('open');
          });
        }
      });
    }
  </script>
  <header>
    <div class="header-left">
      <h1><span>M</span>uninn</h1>
      <nav>
        ${link("dashboard", "/", "Dashboard")}
        ${link("agents", "/agents", "Agents")}
        ${link("traces", "/traces", "Traces")}
        <span class="nav-sep" aria-hidden="true"></span>
        ${link("chat", "/chat", "Chat")}
        ${link("research", "/research", "Research")}
        ${link("search", "/search", "Search")}
        ${link("summaries", "/summaries", "Summaries")}
        ${link("wiki", "/wiki", "Wiki")}
        ${link("graph", "/graph", "Graph")}
        ${link("plans", "/plans", "Plans")}
        <span class="nav-sep" aria-hidden="true"></span>
        ${toolsDropdown}
      </nav>
${options?.headerLeftExtra ?? ""}
    </div>
    <div class="header-right">
${options?.headerRight ?? ""}
      ${themeToggleHtml()}
    </div>
  </header>
  <script>${themeToggleScript()}</script>`;
}
