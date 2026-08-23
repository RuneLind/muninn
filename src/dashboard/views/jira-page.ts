import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import {
  MARKED_CDN_SCRIPT,
  docPanelHtml,
  docPanelScript,
  docPanelStyles,
  markdownContentStyles,
} from "./components/doc-panel.ts";
import { escHtml } from "./components/escape.ts";
import { helpersClientScript } from "./components/helpers-client.ts";
import { jiraComposerClientScript } from "./components/jira-composer-client.ts";
import { webFormatClientScript } from "../../chat/views/components/web-format-client.ts";
import { buildHashMetaTag, getDashboardBuildHash } from "../dashboard-build-hash.ts";
import { JC_LEFT_ID, JC_MID_ID, JC_RIGHT_ID, JC_ROOT_ID } from "./components/jira-composer-pure.ts";

/**
 * `/jira` — notes in, a pasteable Jira task out.
 *
 * Three columns: the raw material and the two dials on the LEFT, the retrieved
 * hits you can switch off in the MIDDLE, the draft plus copy/save on the RIGHT.
 *
 * **The shell is server-rendered; everything in it is client-rendered.** Unlike
 * `/plans` there is no payload to embed — the page shows nothing a reader could
 * check against a number until they have typed something. The picker's options
 * come from `GET /api/jira/templates` (one endpoint, one ordering — the shipped
 * set is an ordered array precisely because sorting the ids renders them as
 * `bug, spike, story, task`), and a `?draft=<id>` landing is read by the bundle,
 * which fetches the row and POLLS it while it is still `generating`. Polling,
 * never a stream re-attach: there is nothing to attach to, and a re-POST of
 * identical content hits the single-flight 409.
 *
 * Three bundles are injected, all of them already shipped elsewhere: `helpers`
 * (the doc panel's `esc`), `web-format` (so the **Forhåndsvisning** tab renders
 * through the SAME `formatWebHtml` the web chat and the wiki reader use, rather
 * than a second markdown renderer that could disagree with them about the
 * subset PR 0 measured), and the composer itself.
 */
export async function renderJiraPage(): Promise<string> {
  const [helpers, webFormat, composer, buildHash] = await Promise.all([
    helpersClientScript(),
    webFormatClientScript(),
    jiraComposerClientScript(),
    getDashboardBuildHash(),
  ]);

  return `<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  ${buildHashMetaTag(buildHash)}
  <title>Muninn - Jira</title>
  ${MARKED_CDN_SCRIPT}
  <style>
    ${SHARED_STYLES}
    ${docPanelStyles("jiraSlideIn")}
    ${markdownContentStyles(".jc-preview")}
    ${JIRA_PAGE_STYLES}
  </style>
</head>
<body>
  ${renderNav("jira")}

  <div class="jc" id="${JC_ROOT_ID}">
    <div class="jc-mast">
      <h1>Jira-utkast</h1>
      <p class="jc-sub">Løse notater inn, en ferdig formet Jira-sak ut — som markdown du limer rett inn i
        beskrivelsesfeltet i den nye Jira-editoren. Hentet server-side over de tre melosys-samlingene.
        Teknisk dybde er en egen skala: <em>Ingen</em> for grooming, <em>Skisse</em> til daglig,
        <em>Full</em> når koden allerede er lest.</p>
      <noscript><p class="jc-banner jc-banner-bad">Denne siden trenger JavaScript. API-et er
        <code>POST /api/jira/draft</code> og <code>GET /api/jira/draft/:id</code>.</p></noscript>
    </div>

    <div class="jc-grid">
      <section class="jc-col" id="${JC_LEFT_ID}"></section>
      <section class="jc-col" id="${JC_MID_ID}"></section>
      <section class="jc-col jc-col-wide" id="${JC_RIGHT_ID}"></section>
    </div>
  </div>

  ${docPanelHtml()}

  <script>
    ${helpers}
  </script>
  <script>
    ${webFormat}
  </script>
  <script>
    ${docPanelScript()}
  </script>
  <script>
    ${composer}
  </script>
</body>
</html>`;
}

/** Rendered when the page itself could not be built — a bundle failure must not
 *  surface as an unexplained Hono 500 on the one page that has no other UI. */
export function renderJiraFallback(error: string): string {
  return `<!DOCTYPE html>
<html lang="no"><head><meta charset="UTF-8"><title>Muninn - Jira</title></head>
<body style="font-family:system-ui;padding:40px;max-width:70ch">
<h1>Jira-siden kunne ikke bygges</h1>
<p>${escHtml(error)}</p>
<p>API-et er upåvirket: <code>POST /api/jira/draft</code>, <code>GET /api/jira/draft/:id</code>.</p>
</body></html>`;
}

const JIRA_PAGE_STYLES = `
    .jc {
      --jc-line: var(--border-primary);
      --jc-line-soft: var(--border-subtle);
      --jc-surface: var(--bg-panel);
      --jc-surface-2: var(--bg-surface);
      --jc-ink: var(--text-primary);
      --jc-ink-2: var(--text-secondary);
      --jc-muted: var(--text-muted);
      --jc-faint: var(--text-dim);
      --jc-accent: var(--accent);
      --jc-accent-ink: var(--accent-light);
      --jc-accent-wash: color-mix(in srgb, var(--accent) 14%, transparent);
      --jc-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --jc-r: 8px;
      max-width: 1720px;
      margin: 0 auto;
      padding: 18px 24px 32px;
      color: var(--jc-ink-2);
    }
    .jc h1 { font-size: 21px; font-weight: 600; color: var(--jc-ink); }
    .jc code { font-family: var(--jc-mono); font-size: 12px; color: var(--jc-ink-2); }
    .jc button { font: inherit; color: inherit; cursor: pointer; }
    .jc-sub { color: var(--jc-muted); font-size: 12.5px; max-width: 110ch; margin-top: 6px; line-height: 1.5; }

    /* Three columns that fit 1440px without a horizontal scrollbar: the widest
       fixed contribution is 300+300+380 + 2×16 gap + 2×24 page padding = 1060.
       Each column scrolls on its OWN axis, so a 24-row hit list and a long draft
       never push the page sideways. */
    .jc-grid {
      display: grid; gap: 16px; margin-top: 16px; align-items: start;
      grid-template-columns: minmax(300px, 360px) minmax(300px, 1fr) minmax(380px, 1.3fr);
    }
    .jc-col {
      background: var(--jc-surface); border: 1px solid var(--jc-line); border-radius: var(--jc-r);
      padding: 14px 15px 16px; display: flex; flex-direction: column; gap: 9px;
      max-height: calc(100vh - 190px); overflow-y: auto; scrollbar-width: thin;
      min-width: 0;
    }
    .jc-h { font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--jc-faint); }
    .jc-count { font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--jc-muted); font-size: 11.5px; }
    /* 11.5px on --text-muted, not 10.5px on --text-dim: the field labels are the
       page's only name for each control, and measured in the browser the old pair
       was 3.2:1 in dark and 3.7:1 in light — under WCAG AA's 4.5:1 for text this
       small. --jc-muted measures 5.9:1 dark / 5.4:1 light. */
    .jc-lab { font-size: 11.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--jc-muted); font-weight: 600; margin-top: 4px; }
    .jc-opt { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--jc-muted); }
    .jc-note { font-size: 11.5px; color: var(--jc-muted); line-height: 1.5; }
    .jc-err { font-size: 12px; color: var(--status-error); line-height: 1.5; }
    .jc-run { font-size: 12px; color: var(--jc-accent-ink); }
    .jc-dim { color: var(--jc-faint); }
    .jc-empty { color: var(--jc-faint); font-size: 12.5px; font-style: italic; padding: 8px 0; }
    .jc-status { min-height: 18px; display: flex; flex-direction: column; gap: 4px; }

    /* The action row STICKS to the top of its own scrolling column. Measured at
       1440×950 with a 1.4 KB note pasted, the button and the status line it
       writes into were both below the fold — the reader clicked, nothing visibly
       moved, and the phase copy was two scrolls away. */
    .jc-actions {
      position: sticky; top: -14px; z-index: 2; margin: -14px -15px 0; padding: 12px 15px 8px;
      background: var(--jc-surface); border-bottom: 1px solid var(--jc-line-soft);
      display: flex; flex-direction: column; gap: 6px;
    }
    .jc-actions .jc-primary { margin-top: 0; align-self: flex-start; }

    /* The unsaved-edits gate — inline, above the draft, never a window.confirm. */
    .jc-gate {
      border: 1px solid color-mix(in srgb, var(--status-warning) 55%, transparent);
      background: color-mix(in srgb, var(--status-warning) 10%, transparent);
      border-radius: 6px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px;
    }
    .jc-gate-lead { font-size: 12.5px; font-weight: 600; color: var(--jc-ink); }
    .jc-gate-buttons { display: flex; flex-wrap: wrap; gap: 6px; }

    .jc-notes, .jc-extra, .jc-md {
      font: inherit; font-size: 13px; line-height: 1.5; width: 100%; resize: vertical;
      border: 1px solid var(--jc-line); border-radius: 6px; background: var(--jc-surface-2);
      color: var(--jc-ink); padding: 9px 11px;
    }
    .jc-notes, .jc-md { font-family: var(--jc-mono); font-size: 12.5px; }
    /* The column is a flex container, so the rows= attribute is only a BASIS: the
       textarea shrank to ~4 visible lines under the controls below it. Measured
       in the browser at 1440×950 — hence an explicit min-height and no shrink. */
    .jc-notes { min-height: 240px; flex: none; }
    .jc-extra { flex: none; }
    .jc-md { min-height: 46vh; flex: 1; }
    .jc-charcount { font-family: var(--jc-mono); font-size: 10.5px; color: var(--jc-faint); text-align: right; }
    /* Over the cap the button is off for THIS reason — the counter says which. */
    .jc-charcount .jc-over { color: var(--status-error); font-weight: 700; }
    .jc-select {
      font: inherit; font-size: 13px; padding: 5px 9px; border-radius: 6px;
      border: 1px solid var(--jc-line); background: var(--jc-surface-2); color: var(--jc-ink);
    }

    .jc-depths { display: flex; flex-direction: column; gap: 5px; }
    .jc-depth {
      display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; align-items: baseline;
      border: 1px solid var(--jc-line); border-radius: 6px; padding: 6px 9px; cursor: pointer;
      background: var(--jc-surface-2);
    }
    .jc-depth-on { border-color: var(--jc-accent); background: var(--jc-accent-wash); }
    .jc-depth-name { font-size: 12.5px; font-weight: 600; color: var(--jc-ink); }
    .jc-depth-hint { grid-column: 2; font-size: 11.5px; color: var(--jc-muted); line-height: 1.45; }

    .jc-primary {
      border: 1px solid var(--jc-accent); background: var(--jc-accent-wash); color: var(--jc-accent-ink);
      border-radius: 6px; padding: 7px 14px; font-size: 13px; font-weight: 600; margin-top: 4px;
    }
    .jc-primary:disabled, .jc-secondary:disabled { opacity: .5; cursor: default; }
    .jc-secondary {
      border: 1px solid var(--jc-line); background: var(--jc-surface-2); color: var(--jc-ink-2);
      border-radius: 6px; padding: 4px 11px; font-size: 12px;
    }
    .jc-secondary:hover:not(:disabled) { border-color: var(--jc-accent); color: var(--jc-accent-ink); }

    /* ---- banners -------------------------------------------------------- */
    .jc-banner {
      padding: 9px 12px; border-radius: 6px; font-size: 12.5px; line-height: 1.5;
      border: 1px solid var(--jc-line); background: var(--jc-surface-2);
    }
    .jc-banner ul { margin: 6px 0 0; padding-left: 18px; }
    .jc-banner li { margin-bottom: 3px; }
    .jc-banner-warn { border-color: color-mix(in srgb, var(--status-warning) 45%, transparent); background: color-mix(in srgb, var(--status-warning) 9%, transparent); }
    .jc-banner-bad { border-color: color-mix(in srgb, var(--status-error) 45%, transparent); background: color-mix(in srgb, var(--status-error) 9%, transparent); }
    /* "this draft came out of a conversation" — provenance, not a problem, so it
       borrows the accent rather than a status colour. */
    .jc-banner-thread { border-color: var(--jc-accent); background: var(--jc-accent-wash); color: var(--jc-ink-2); }
    a.jc-threadlink { color: var(--jc-accent-ink); text-decoration: none; white-space: nowrap; }
    a.jc-threadlink:hover { text-decoration: underline; }
    .jc-threadname { font-size: 13px; font-weight: 600; color: var(--jc-ink); overflow-wrap: anywhere; }
    .jc-threadname a { color: var(--jc-ink); text-decoration: none; }
    .jc-threadname a:hover { color: var(--jc-accent-ink); text-decoration: underline; }

    /* ---- citations ------------------------------------------------------ */
    .jc-searched { font-size: 11.5px; color: var(--jc-muted); font-style: italic; line-height: 1.45; }
    .jc-citelist { display: flex; flex-direction: column; gap: 6px; }
    .jc-cite {
      display: grid; grid-template-columns: auto 1fr; gap: 8px; align-items: start;
      border: 1px solid var(--jc-line); border-radius: 6px; padding: 7px 9px; background: var(--jc-surface-2);
      min-width: 0;
    }
    /* Switched off is a real state, not a hover: dimmed AND struck through, so it
       reads at a glance which rows the next generation will not see. */
    .jc-cite-off { opacity: .5; }
    .jc-cite-off .jc-cite-title { text-decoration: line-through; }
    .jc-cite-toggle { display: flex; padding-top: 2px; }
    .jc-cite-body { min-width: 0; }
    .jc-cite-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; min-width: 0; }
    .jc-cite-title {
      border: 0; background: transparent; padding: 0; text-align: left;
      font-size: 12.5px; font-weight: 600; color: var(--jc-ink); line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .jc-cite-title:hover { color: var(--jc-accent-ink); text-decoration: underline; }
    a.jc-cite-src { color: var(--jc-faint); text-decoration: none; font-size: 12px; }
    a.jc-cite-src:hover { color: var(--jc-accent-ink); }
    .jc-badge {
      font-size: 10px; letter-spacing: .04em; text-transform: uppercase; font-weight: 700;
      color: var(--jc-muted); background: var(--bg-card); border: 1px solid var(--jc-line-soft);
      border-radius: 3px; padding: 1px 5px; flex: none;
    }
    .jc-rel { font-family: var(--jc-mono); font-size: 10.5px; color: var(--jc-faint); margin-left: auto; flex: none; }
    /* The stored snippet is up to 900 chars (JIRA_SNIPPET_CHARS) and a
       jira-issues body is raw indexer text, so an unclamped row was ~25 lines
       tall and two hits filled the column. Clamped to four lines; the whole
       document is one click away in the doc panel. */
    .jc-snip {
      font-size: 11.5px; color: var(--jc-muted); line-height: 1.45; margin-top: 4px;
      overflow-wrap: anywhere; overflow: hidden;
      display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4;
    }
    .jc-citefoot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 4px; }

    /* ---- the draft ------------------------------------------------------ */
    .jc-drafthead { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
    .jc-draftid { font-family: var(--jc-mono); font-size: 10.5px; color: var(--jc-faint); overflow-wrap: anywhere; }
    .jc-keycount { font-size: 11.5px; color: var(--jc-muted); margin-left: auto; }
    .jc-chip {
      font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700;
      border-radius: 3px; padding: 1px 6px; border: 1px solid currentColor;
    }
    .jc-chip-ready { color: var(--status-success); }
    .jc-chip-generating { color: var(--status-warning); }
    .jc-chip-failed { color: var(--status-error); }

    .jc-switch { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .jc-spacer { flex: 1 1 auto; }
    .jc-tab {
      border: 1px solid var(--jc-line); background: var(--jc-surface-2); color: var(--jc-muted);
      border-radius: 6px; padding: 4px 11px; font-size: 12px;
    }
    .jc-tab-on { background: var(--jc-accent-wash); border-color: var(--jc-accent); color: var(--jc-accent-ink); font-weight: 600; }
    .jc-dirty { color: var(--status-warning); }
    /* "the server has moved on and your edit was kept" — a warning, not an error:
       nothing failed and nothing was lost, the reader just has a decision. */
    .jc-server-newer { color: var(--status-warning); }
    /* A disabled draft textarea (a ?draft= landing on a row still being
       written) must LOOK inert, or it reads as a broken editor. */
    .jc-md:disabled { opacity: 0.6; cursor: not-allowed; }
    .jc-saved { color: var(--status-success); }

    .jc-stream, .jc-preview {
      border: 1px solid var(--jc-line); border-radius: 6px; background: var(--jc-surface-2);
      padding: 11px 13px; min-height: 46vh; max-height: 60vh; overflow: auto; font-size: 13px;
    }
    .jc-stream { font-family: var(--jc-mono); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--jc-muted); }
    .jc-preview { color: var(--jc-ink-2); }
    .jc-preview table { display: block; overflow-x: auto; }

    /* ---- key verdicts --------------------------------------------------- */
    .jc-keys { display: flex; flex-wrap: wrap; gap: 5px; }
    .jc-key {
      font-family: var(--jc-mono); font-size: 11px; border-radius: 4px; padding: 2px 7px;
      border: 1px solid currentColor; text-decoration: none; display: inline-flex; gap: 5px; align-items: baseline;
    }
    .jc-key em { font-family: inherit; font-style: normal; font-size: 10px; opacity: .85; }
    .jc-key-ok { color: var(--status-success); }
    .jc-key-notes { color: var(--status-warning); }
    .jc-key-unknown { color: var(--status-error); }

    @media (max-width: 1180px) {
      .jc-grid { grid-template-columns: 1fr; }
      .jc-col { max-height: none; }
    }
`;
