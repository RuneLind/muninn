import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { escHtml, escJsonScript } from "./components/escape.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { planBoardClientScript } from "./components/plan-board-client.ts";
import { buildHashMetaTag, getDashboardBuildHash } from "../dashboard-build-hash.ts";
import { writeCapability, writeModeSentence } from "../../plans/board-writes.ts";
import type { BoardPayload } from "../../plans/board.ts";

/**
 * `/plans` — the plan board page.
 *
 * The server does the assembly and EMBEDS the payload (`window.PLAN_BOARD`);
 * the browser bundle turns it into columns. That split is deliberate: every
 * number a reader can check — column membership, the meters, the calibration
 * sentence — is computed once, server-side, in `src/plans/board.ts`, and
 * `GET /api/plans/board` serves the very same object, so "what the page shows"
 * and "what the API says" cannot drift. The interactive half (filters, sorts,
 * the hand order, the drawer) is client-side because it is view state, and it
 * re-runs the SAME pure functions the payload was built with.
 *
 * The parts that must survive with no JavaScript at all — the degrade banner
 * naming the ledger it tried, an unregistered mimir, the corpus warnings and
 * the calibration sentence — are rendered here as HTML rather than by the
 * bundle, because they are exactly the states someone reads when the page is
 * not behaving.
 *
 * The masthead's write-mode sentence (`#pbMode`) is the one hybrid: it is
 * rendered here from `writeModeSentence` so a no-JavaScript reader is told what
 * this board writes, and the bundle re-states it from the SAME function on
 * every render, because a 403 mid-session makes the sentence the server sent
 * untrue. One function, so the masthead and the banner under it cannot drift.
 *
 * Styling ports the design prototype (`docs/proto/plan-board.html`) onto
 * muninn's shared theme tokens: the prototype's own palette is replaced by
 * `--bg-*`/`--text-*`/`--status-*`, so light and dark follow the dashboard's
 * toggle, while the status and priority tints stay the prototype's assignment.
 */
export async function renderPlansPage(payload: BoardPayload): Promise<string> {
  const [client, helpers, buildHash] = await Promise.all([
    planBoardClientScript(),
    helpersClientScript(),
    getDashboardBuildHash(),
  ]);
  const asOf = new Date(payload.generatedAt).toISOString().slice(0, 16).replace("T", " ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${buildHashMetaTag(buildHash)}
  <title>Muninn - Plans</title>
  <style>
    ${SHARED_STYLES}
    ${PLAN_BOARD_STYLES}
  </style>
</head>
<body>
  ${renderNav("plans")}

  <div class="pb" id="pbRoot">
    <div class="pb-mast">
      <h1>Plan board</h1>
      <p class="pb-sub">
        Every plan in <code>${escHtml(payload.wiki.name)}/plans/</code>, filed by its own <code>plan_status</code>,
        priced against what comparable work actually cost in the claude-usage ledger.
        Read ${escHtml(asOf)} UTC. Rank a column by hand with ▲▼ under <em>My order</em>; the ↗ opens the plan.
        <span id="pbMode">${escHtml(
          writeModeSentence(
            writeCapability({ readonly: payload.readonly, queueHash: payload.queue.hash }),
          ),
        )}</span>
      </p>
    </div>

    ${renderBanners(payload)}

    <div class="pb-notice" id="pbNotice"></div>
    <div class="pb-meters" id="pbMeters"></div>
    <div class="pb-controls" id="pbControls"></div>
    <div class="pb-draft" id="pbDraft"></div>
    <div class="pb-board" id="pbBoard">
      <noscript>
        <p class="pb-empty">This board needs JavaScript. The same payload is available as
        <code>GET /api/plans/board</code>.</p>
      </noscript>
    </div>

    <footer class="pb-foot">
      <div class="pb-fgrid">
        <div>
          <h3>Where the numbers come from</h3>
          <ul>
            <li><strong>Status, priority, tags, follow-ups</strong> — the plan file's own frontmatter.</li>
            <li><strong>Hand order</strong> — <code>plans/queue.yaml</code> in the wiki.</li>
            <li><strong>Cost, PRs, hours, findings</strong> — claude-usage <code>GET /api/plans</code>.</li>
            <li><strong>Estimates</strong> — the $/PR quartiles of shipped plans in the same repo family, × the PR count the plan declares.</li>
          </ul>
        </div>
        <div>
          <h3>How good the estimate is</h3>
          <p>${escHtml(payload.calibrationSentence ?? "Not enough shipped plans in the ledger to score the estimate yet.")}</p>
        </div>
        <div>
          <h3>What these numbers are not</h3>
          <p>Attribution is per session → one plan, so a session that worked two plans at once is charged to one of them.
          Costs are the ledger's reconstruction, not a settled invoice. Use the band, never the midpoint.</p>
        </div>
      </div>
    </footer>
  </div>

  <script>
    window.PLAN_BOARD = ${escJsonScript(payload)};
  </script>
  <script>
    ${helpers}
  </script>
  <script>
    ${client}
  </script>
</body>
</html>`;
}

/**
 * The states a reader needs before the board makes sense. Server-rendered on
 * purpose — a page whose ledger is down must say so even if the bundle never
 * runs, and the banner NAMES the base URL it tried, because the browser can
 * never reach that host itself (tailnet + mixed content) and so has no link to
 * offer instead.
 */
function renderBanners(payload: BoardPayload): string {
  const parts: string[] = [];

  if (!payload.wiki.registered) {
    parts.push(`<div class="pb-banner pb-banner-bad">
      <strong>${escHtml(payload.wiki.name)} wiki not registered on this host.</strong>
      Set <code>WIKI_EXTRA=${escHtml(payload.wiki.name)}=&lt;path&gt;</code> (or a bot's <code>wikiDir</code>) and restart —
      the board reads the wiki registry, never a hard-coded path.
    </div>`);
  }

  if (!payload.money.available) {
    const errors = payload.ledger.errors.length
      ? `<ul>${payload.ledger.errors.map((e) => `<li>${escHtml(e)}</li>`).join("")}</ul>`
      : "";
    parts.push(`<div class="pb-banner pb-banner-warn">
      <strong>No money on this board.</strong> ${escHtml(payload.money.reason ?? "")}.
      Columns, priorities and the hand order are unaffected; every estimate and cost is hidden rather than guessed.
      <strong>Repo chips can move</strong>: with the ledger up a plan's family is the repo its PRs actually landed in,
      and without it every plan falls back to what its slug suggests — so a chip that changed on its own is this,
      not the filter.
      Tried <code>${escHtml(payload.ledger.baseUrl)}</code>${payload.ledger.urlConfigured ? "" : " (the default — <code>CLAUDE_USAGE_URL</code> is not set)"}.
      ${errors}
    </div>`);
  } else if (payload.ledger.errors.length > 0) {
    parts.push(`<div class="pb-banner pb-banner-note">
      <strong>The ledger answered with caveats.</strong>
      <code>${escHtml(payload.ledger.baseUrl)}</code>:
      <ul>${payload.ledger.errors.map((e) => `<li>${escHtml(e)}</li>`).join("")}</ul>
    </div>`);
  }

  if (payload.warnings.length > 0) {
    const shown = payload.warnings.slice(0, 12);
    const rest = payload.warnings.length - shown.length;
    parts.push(`<details class="pb-banner pb-banner-note">
      <summary>${payload.warnings.length} plan file(s) had something the board dropped</summary>
      <ul>${shown.map((w) => `<li>${escHtml(w)}</li>`).join("")}</ul>
      ${rest > 0 ? `<p>…and ${rest} more.</p>` : ""}
    </details>`);
  }

  if (payload.ledgerOnlySlugs.length > 0) {
    parts.push(`<details class="pb-banner pb-banner-note">
      <summary>${payload.ledgerOnlySlugs.length} ledger row(s) name a plan that is not in the wiki</summary>
      <p>Usually a rename or a retired plan upstream. They still price the board — a retired plan's cost is
      evidence about what a PR in that repo costs.</p>
      <ul>${payload.ledgerOnlySlugs.slice(0, 20).map((s) => `<li><code>${escHtml(s)}</code></li>`).join("")}</ul>
      ${payload.ledgerOnlySlugs.length > 20 ? `<p>…and ${payload.ledgerOnlySlugs.length - 20} more.</p>` : ""}
    </details>`);
  }

  return parts.join("\n");
}

/** Ported from the prototype's stylesheet; palette re-pointed at the dashboard's
 *  shared tokens so both themes and the toggle work with no second definition. */
const PLAN_BOARD_STYLES = `
    .pb {
      /* Prototype palette → muninn tokens. Status/priority tints keep the
         prototype's assignment but come from the shared status ramp, which is
         already defined for both themes. */
      --pb-surface: var(--bg-panel);
      --pb-surface-2: var(--bg-surface);
      --pb-surface-3: var(--bg-card);
      --pb-line: var(--border-primary);
      --pb-line-soft: var(--border-subtle);
      --pb-ink: var(--text-primary);
      --pb-ink-2: var(--text-secondary);
      --pb-muted: var(--text-muted);
      --pb-faint: var(--text-dim);
      --pb-accent: var(--accent);
      --pb-accent-ink: var(--accent-light);
      --pb-accent-wash: color-mix(in srgb, var(--accent) 14%, transparent);
      --pb-proposed: var(--status-info);
      --pb-ready: var(--status-cyan);
      --pb-inflight: var(--status-warning);
      --pb-blocked: var(--status-error);
      --pb-followups: var(--status-magenta);
      --pb-shipped: var(--status-success);
      --pb-p0: var(--status-error);
      --pb-p1: var(--status-warning);
      --pb-p2: var(--status-info);
      --pb-p3: var(--text-dim);
      --pb-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --pb-r: 8px;

      max-width: 1720px;
      margin: 0 auto;
      padding: 20px 24px 40px;
      color: var(--pb-ink-2);
    }
    .pb code { font-family: var(--pb-mono); font-size: 12px; color: var(--pb-ink-2); }
    .pb button { font: inherit; color: inherit; cursor: pointer; }
    .pb h1 { font-size: 21px; font-weight: 600; color: var(--pb-ink); }

    .pb-mast .pb-sub { color: var(--pb-muted); font-size: 12.5px; max-width: 96ch; margin-top: 6px; line-height: 1.5; }

    /* ---- banners -------------------------------------------------------- */
    .pb-banner {
      margin: 14px 0 0; padding: 10px 14px; border-radius: var(--pb-r);
      font-size: 12.5px; border: 1px solid var(--pb-line); background: var(--pb-surface);
    }
    .pb-banner ul { margin: 6px 0 0; padding-left: 18px; }
    .pb-banner li { margin-bottom: 3px; }
    .pb-banner summary { cursor: pointer; color: var(--pb-muted); }
    .pb-banner-bad { border-color: color-mix(in srgb, var(--status-error) 45%, transparent); background: color-mix(in srgb, var(--status-error) 8%, transparent); }
    .pb-banner-warn { border-color: color-mix(in srgb, var(--status-warning) 45%, transparent); background: color-mix(in srgb, var(--status-warning) 8%, transparent); }
    .pb-banner-note { color: var(--pb-muted); }

    /* ---- meters --------------------------------------------------------- */
    .pb-meters {
      display: grid; gap: 1px; background: var(--pb-line-soft);
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      border: 1px solid var(--pb-line); border-radius: var(--pb-r); overflow: hidden; margin: 16px 0 0;
    }
    .pb-meter { background: var(--pb-surface); padding: 11px 14px 12px; }
    .pb-meter .pb-k { font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--pb-faint); font-weight: 600; }
    .pb-meter .pb-v { font-family: var(--pb-mono); font-size: 20px; font-weight: 600; margin-top: 3px; display: flex; align-items: baseline; gap: 5px; color: var(--pb-ink); }
    .pb-meter .pb-v small { font-family: inherit; font-size: 11.5px; font-weight: 500; color: var(--pb-muted); }
    .pb-meter .pb-n { font-size: 11.5px; color: var(--pb-muted); margin-top: 2px; }

    /* ---- controls ------------------------------------------------------- */
    .pb-controls {
      display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center;
      padding: 13px 0 12px; border-bottom: 1px solid var(--pb-line); margin-top: 12px;
    }
    .pb-ctl { display: flex; align-items: center; gap: 7px; }
    .pb-lab { font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--pb-faint); font-weight: 600; }
    .pb-chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .pb-chip {
      border: 1px solid var(--pb-line); background: var(--pb-surface); color: var(--pb-ink-2);
      border-radius: 999px; padding: 3px 10px; font-size: 12px; line-height: 1.4;
      display: inline-flex; align-items: center; gap: 5px;
    }
    .pb-chip:hover { border-color: var(--pb-accent); color: var(--pb-ink); }
    .pb-chip[aria-pressed="true"] { background: var(--pb-accent-wash); border-color: var(--pb-accent); color: var(--pb-accent-ink); font-weight: 600; }
    .pb-chip-static { cursor: default; color: var(--pb-muted); }
    .pb-chip .pb-c { font-family: var(--pb-mono); font-size: 10.5px; color: var(--pb-faint); }
    .pb-seg { display: inline-flex; border: 1px solid var(--pb-line); border-radius: var(--pb-r); overflow: hidden; background: var(--pb-surface); }
    .pb-seg button { border: 0; background: transparent; padding: 4px 11px; font-size: 12px; color: var(--pb-muted); border-right: 1px solid var(--pb-line); }
    .pb-seg button:last-child { border-right: 0; }
    .pb-seg button[aria-pressed="true"] { background: var(--pb-accent-wash); color: var(--pb-accent-ink); font-weight: 600; }
    .pb-search {
      font: inherit; font-size: 12.5px; padding: 4px 9px; border-radius: var(--pb-r);
      border: 1px solid var(--pb-line); background: var(--pb-surface); color: var(--pb-ink); min-width: 200px;
    }

    /* ---- write notices --------------------------------------------------- */
    /* Client-rendered (a 403 raises the readonly banner mid-session), so the
       banner classes above are reused rather than re-styled. The strip holds
       three permanent slots — banners, the live-region message, dropped-entry
       details — so an :empty rule on the strip itself cannot be the hide rule;
       each slot hides itself instead. */
    .pb-notice-part:empty { display: none; }
    .pb-banner[hidden] { display: none; }
    .pb-wmsg { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .pb-reload {
      border: 1px solid var(--pb-accent); background: var(--pb-accent-wash); color: var(--pb-accent-ink);
      border-radius: 5px; padding: 2px 10px; font-size: 12px; font-weight: 600;
    }
    .pb-reload:disabled { opacity: .55; cursor: default; }

    /* ---- draft note ----------------------------------------------------- */
    .pb-draft { display: none; align-items: center; gap: 10px; margin-top: 10px; font-size: 12.5px; color: var(--pb-muted); }
    .pb-draft.pb-visible { display: flex; flex-wrap: wrap; }
    .pb-draft-pill { font-size: 10px; font-family: var(--pb-mono); color: var(--status-warning); border: 1px solid currentColor; border-radius: 3px; padding: 0 4px; text-transform: uppercase; letter-spacing: .06em; }
    .pb-discard { border: 1px solid var(--pb-line); background: var(--pb-surface-2); border-radius: 5px; padding: 3px 10px; font-size: 12px; color: var(--pb-muted); }
    .pb-discard:hover { border-color: var(--pb-accent); color: var(--pb-accent-ink); }

    /* ---- board ---------------------------------------------------------- */
    .pb-board { display: flex; gap: 14px; align-items: flex-start; overflow-x: auto; padding: 14px 0; scrollbar-width: thin; }
    .pb-col {
      flex: 0 0 292px; background: var(--pb-surface-2); border: 1px solid var(--pb-line);
      border-radius: var(--pb-r); display: flex; flex-direction: column; max-height: calc(100vh - 150px);
    }
    .pb-head {
      position: sticky; top: 0; z-index: 2; background: var(--pb-surface-2);
      border-bottom: 1px solid var(--pb-line); border-radius: var(--pb-r) var(--pb-r) 0 0;
      padding: 9px 11px 8px; display: flex; align-items: center; gap: 8px;
      /* Five labels can be on this row at once (name · money · draft order ·
         saving… · count) and 292px does not always hold them. Wrapping is the
         graceful end of that: nothing in here shrinks (below), so without it the
         shortfall was taken out of whichever label could give. */
      flex-wrap: wrap; row-gap: 4px;
    }
    .pb-swatch { width: 8px; height: 8px; border-radius: 2px; background: var(--pb-tone); flex: none; }
    .pb-name { font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--pb-tone); }
    /* The count's is the ONE auto margin in this header — everything else sits
       with the column's own labels, in DOM order. Two autos split the free
       space between them, and the difference came out of the neighbours: on a
       drafted AND priced column the "draft order" pill was crushed from 83px to
       54px and broke over two lines the moment "saving…" appeared (measured in
       the browser at the shipped 292px column width). */
    .pb-count { margin-left: auto; font-family: var(--pb-mono); font-size: 12px; color: var(--pb-muted); }
    /* The per-column write marker. It REPLACES disabling the nudges, so it must
       read as activity rather than as a refusal: same weight as the count, in
       the accent, sitting before it. */
    .pb-saving { font-size: 10.5px; font-style: italic; color: var(--pb-accent-ink); }
    .pb-money, .pb-draft-pill, .pb-saving, .pb-count { flex: none; white-space: nowrap; }
    .pb-money { font-family: var(--pb-mono); font-size: 11px; color: var(--pb-faint); }
    .pb-stack { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 7px; scrollbar-width: thin; }
    .pb-empty { color: var(--pb-faint); font-size: 12px; padding: 10px 4px; font-style: italic; }

    /* ---- cards ---------------------------------------------------------- */
    .pb-cardwrap { position: relative; display: flex; }
    .pb-card {
      background: var(--pb-surface); border: 1px solid var(--pb-line); border-left: 3px solid var(--pb-tone);
      border-radius: 5px; padding: 8px 10px 9px; text-align: left; width: 100%;
      display: flex; flex-direction: column; gap: 5px;
      transition: border-color .12s, transform .12s;
    }
    .pb-card:hover { transform: translateY(-1px); border-color: var(--pb-accent); }
    .pb-card.pb-sel { border-color: var(--pb-accent); }
    .pb-title { font-size: 13px; font-weight: 600; line-height: 1.3; color: var(--pb-ink); padding-right: 20px; }
    /* Card body text is held at --pb-muted, never --pb-faint: measured on the
       card's own background, faint is 2.5:1 in dark and 2.7:1 in light — below
       the 4.5:1 floor for text this size. The de-emphasis these carried in
       colour is carried in italics instead. */
    .pb-slug { font-family: var(--pb-mono); font-size: 10.5px; color: var(--pb-muted); overflow-wrap: anywhere; }
    .pb-r1 { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding-right: 18px; }
    .pb-r2 { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 11.5px; color: var(--pb-muted); }
    .pb-pri {
      font-family: var(--pb-mono); font-size: 10px; font-weight: 700; border-radius: 3px;
      padding: 1px 5px; color: #fff; background: var(--pb-pri-color); flex: none;
    }
    .pb-pri-unset { background: transparent; color: var(--pb-faint); border: 1px dashed var(--pb-line); }
    .pb-pri-draft { outline: 1px dashed var(--status-warning); outline-offset: 1px; }
    .pb-fam { font-size: 10.5px; color: var(--pb-muted); background: var(--pb-surface-3); border-radius: 3px; padding: 1px 6px; }
    .pb-fam-soft { color: var(--pb-muted); font-style: italic; }
    .pb-flag { font-size: 11px; color: var(--pb-followups); font-weight: 600; }
    .pb-est { font-family: var(--pb-mono); font-size: 11.5px; color: var(--pb-ink-2); }
    .pb-est-guess, .pb-prs-guess { color: var(--pb-muted); font-style: italic; }
    .pb-prs { font-family: var(--pb-mono); font-size: 11.5px; }
    .pb-age { font-size: 11.5px; }
    .pb-rank { font-family: var(--pb-mono); font-size: 10.5px; font-weight: 700; color: var(--pb-accent-ink); background: var(--pb-accent-wash); border-radius: 3px; padding: 1px 5px; flex: none; }

    a.pb-open {
      position: absolute; top: 6px; right: 6px; z-index: 1; line-height: 0;
      color: var(--pb-faint); border-radius: 3px; padding: 2px;
    }
    a.pb-open:hover { color: var(--pb-accent-ink); background: var(--pb-accent-wash); }
    a.pb-open svg { display: block; }

    .pb-nudge { position: absolute; right: 5px; bottom: 5px; z-index: 1; display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
    .pb-cardwrap:hover .pb-nudge, .pb-cardwrap:focus-within .pb-nudge { opacity: 1; }
    .pb-nudge button {
      border: 1px solid var(--pb-line); background: var(--pb-surface); color: var(--pb-muted);
      border-radius: 3px; width: 19px; height: 17px; line-height: 1; padding: 0; font-size: 10px;
    }
    .pb-nudge button:hover:not(:disabled) { border-color: var(--pb-accent); color: var(--pb-accent-ink); background: var(--pb-accent-wash); }
    .pb-nudge button:disabled { opacity: .3; cursor: default; }

    /* ---- drawer --------------------------------------------------------- */
    /* Above the nav's own dropdown (z-index 60) — the drawer lives inside
       .pb now (for the tokens), and .pb creates no stacking context, so these
       are still root-level layers. */
    .pb-scrim { position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 200; }
    .pb-drawer {
      position: fixed; top: 0; right: 0; bottom: 0; width: min(540px, 100%); z-index: 201;
      background: var(--bg-panel); border-left: 1px solid var(--border-primary);
      display: flex; flex-direction: column; color: var(--text-secondary);
      --pb-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .pb-dh { padding: 16px 20px 12px; border-bottom: 1px solid var(--border-primary); display: flex; gap: 12px; align-items: flex-start; }
    .pb-dh h2 { font-size: 18px; font-weight: 600; line-height: 1.25; color: var(--text-primary); }
    .pb-acts { display: flex; gap: 6px; flex: none; align-items: center; }
    .pb-x { background: transparent; border: 1px solid var(--border-primary); border-radius: 6px; padding: 3px 9px; color: var(--text-muted); }
    a.pb-openbig {
      display: inline-flex; align-items: center; gap: 5px; text-decoration: none;
      border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent);
      color: var(--accent-light); border-radius: 6px; padding: 3px 9px; font-size: 12px; font-weight: 600; white-space: nowrap;
    }
    .pb-db { overflow-y: auto; padding: 16px 20px 28px; display: flex; flex-direction: column; gap: 16px; }
    .pb-desc { font-size: 13px; color: var(--text-secondary); }
    .pb-sec > h3 { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); font-weight: 700; margin-bottom: 7px; }
    .pb-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(116px, 1fr)); gap: 1px; background: var(--border-subtle); border: 1px solid var(--border-primary); border-radius: 8px; overflow: hidden; }
    .pb-kv > div { background: var(--bg-panel); padding: 7px 10px; }
    .pb-kv .pb-k { font-size: 10.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--text-dim); font-weight: 600; }
    .pb-kv .pb-v { font-family: var(--pb-mono); font-size: 15px; font-weight: 600; margin-top: 1px; color: var(--text-primary); }
    .pb-basis { font-size: 12px; color: var(--text-muted); margin-top: 7px; }
    .pb-note { font-size: 12.5px; color: var(--text-secondary); background: var(--bg-surface); border: 1px solid var(--border-primary); border-left: 3px solid var(--pb-tone); border-radius: 5px; padding: 8px 11px; }
    .pb-prlist { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .pb-prlist a, .pb-prlist span {
      font-family: var(--pb-mono); font-size: 11.5px; text-decoration: none; color: var(--text-secondary);
      border: 1px solid var(--border-primary); border-radius: 3px; padding: 1px 6px; background: var(--bg-surface);
    }
    .pb-prlist .pb-unrev { border-color: var(--status-error); color: var(--status-error); }
    .pb-priset { display: flex; gap: 5px; flex-wrap: wrap; }
    .pb-priset button { border: 1px solid var(--border-primary); background: var(--bg-panel); border-radius: 6px; padding: 3px 11px; font-family: var(--pb-mono); font-size: 12px; color: var(--text-muted); }
    .pb-priset button[aria-pressed="true"] { background: var(--pb-pri-color); border-color: var(--pb-pri-color); color: #fff; font-weight: 700; }
    .pb-priset button:disabled { opacity: .55; cursor: default; }
    a.pb-filelink { font-family: var(--pb-mono); font-size: 12px; color: var(--accent-light); text-decoration: none; overflow-wrap: anywhere; }

    /* ---- footer --------------------------------------------------------- */
    .pb-foot { color: var(--pb-muted); font-size: 12px; margin-top: 8px; }
    .pb-fgrid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); border-top: 1px solid var(--pb-line); padding-top: 14px; }
    .pb-foot h3 { font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--pb-faint); font-weight: 700; margin-bottom: 5px; }
    .pb-foot ul { margin: 0; padding-left: 16px; }
    .pb-foot li { margin-bottom: 4px; }

    @media (prefers-reduced-motion: reduce) { .pb * { transition: none !important; } }
    @media (max-width: 700px) { .pb { padding-left: 14px; padding-right: 14px; } .pb-col { flex-basis: 84vw; } }
`;
