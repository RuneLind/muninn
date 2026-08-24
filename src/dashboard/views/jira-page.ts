import { SHARED_STYLES, renderNav } from "./shared-styles.ts";
import { markdownContentStyles } from "./components/doc-panel.ts";
import { escHtml } from "./components/escape.ts";
import { jiraArchiveClientScript } from "./components/jira-archive-client.ts";
import { formatWebHtml } from "../../web/web-format.ts";
import { buildHashMetaTag, getDashboardBuildHash } from "../dashboard-build-hash.ts";
import {
  JA_ROOT_ID,
  deriveDraftHeading,
  jiraArchiveListHtml,
  jiraArchiveMissingHtml,
  jiraDraftHasControls,
  jiraDraftViewHtml,
} from "./components/jira-archive-pure.ts";
import type { JiraArchiveListState, JiraDraftListRow, JiraDraftView } from "../../jira/wire.ts";

/**
 * `/jira` — the read-only ARCHIVE of Jira drafts.
 *
 * It used to be the composer. A Jira task is written in the melosys chat now
 * (🧾 on a reply → the draft runs as a turn → a draft card under that reply with
 * copy, save and the key verdicts), so this page stopped being where work is
 * done and became where it is looked up afterwards: saved drafts by default, an
 * all-attempts toggle, and one read-only render per draft.
 *
 * **Server-rendered, unlike the composer it replaces.** The composer showed
 * nothing until the reader typed something, so it was a shell plus a bundle;
 * every byte this page shows is already in the row. So the list is HTML, the
 * draft is HTML, and the markdown goes through `formatWebHtml` HERE — the same
 * function the chat bundle re-exports for its own preview, the wiki reader's
 * `renderAskAnswerHtml` precedent. That also means `curl /jira` is the whole
 * page, which is what the acceptance sweep checks.
 *
 * One small bundle survives, and it owns only what HTML cannot do: the
 * Forhåndsvisning/Markdown switch and **Kopier markdown**. With JavaScript off,
 * the `<noscript>` rule below reveals the raw pane so the markdown is still
 * selectable.
 */
export type JiraPageView =
  | {
      kind: "list";
      drafts: JiraDraftListRow[];
      savedOnly: boolean;
      /** The limit the read used. */
      limit: number;
      /** `?limit=` as the reader typed it, else null — the links echo only that. */
      limitParam: number | null;
      /** The DB had a row past the limit. Told, never inferred from `drafts.length`. */
      capped: boolean;
    }
  /** `list` is the state the reader arrived from, so the back link returns
   *  there — absent when they typed the `?draft=` url themselves. */
  | { kind: "draft"; draft: JiraDraftView; list?: JiraArchiveListState }
  | { kind: "missing"; draftId: string; list?: JiraArchiveListState };

export async function renderJiraPage(view: JiraPageView): Promise<string> {
  // **The bundle rides a draft that actually RENDERS the switch and the copy
  // button**, and the test for that is TEXT, not status: `jiraDraftHasControls`
  // asks for markdown on a non-`failed` row. So the list (rows of links) and a
  // draft with nothing to show get no bundle — but a `generating` row CARRYING
  // TEXT does, and the archive is full of them: a notes-path regenerate wrote
  // the new status before the run and left `markdown` alone, so a run that never
  // finished is archived as `generating` over the previous turn's task, which
  // this page renders with the switch and the copy button over it (plus the
  // meta-refresh below). Status alone would have taken the affordances off
  // exactly those pages. The predicate is the pure
  // module's own, the same one its body branch reads, so the two cannot drift.
  const isDraft = view.kind === "draft";
  const needsClient = isDraft && jiraDraftHasControls(view.draft);
  const [client, buildHash] = await Promise.all([
    needsClient ? jiraArchiveClientScript() : Promise.resolve(""),
    getDashboardBuildHash(),
  ]);

  const { title, body } = renderBody(view);
  // A `generating` draft is the one page whose content is not final: the chat's
  // thread-level notice links here for a draft no bubble can carry, and a static
  // «skrives fortsatt» never became the finished task. Five seconds of
  // server-rendered refresh rather than a poller — there is no other client
  // state on this page to lose.
  const refresh =
    isDraft && view.draft.status === "generating"
      ? `\n  <meta http-equiv="refresh" content="5">`
      : "";

  return `<!DOCTYPE html>
<html lang="no">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">${refresh}
  ${buildHashMetaTag(buildHash)}
  <title>${escHtml(title)}</title>
  <style>
    ${SHARED_STYLES}
    ${markdownContentStyles(".ja-preview")}
    ${JIRA_ARCHIVE_STYLES}
  </style>
  <noscript><style>
    /* No bundle ⇒ no view switch. Show the raw markdown under the rendered
       draft rather than leaving it unreachable, and hide the two controls that
       would now do nothing. */
    .ja-raw[hidden] { display: block !important; }
    .ja-switch { display: none; }
  </style></noscript>
</head>
<body>
  ${renderNav("jira")}

  <div class="ja" id="${JA_ROOT_ID}">
    ${body}
  </div>

  ${client ? `<script>\n    ${client}\n  </script>` : ""}
</body>
</html>`;
}

function renderBody(view: JiraPageView): { title: string; body: string } {
  if (view.kind === "missing") {
    return {
      title: "Muninn - Jira-arkiv",
      body: jiraArchiveMissingHtml(view.draftId, view.list),
    };
  }
  if (view.kind === "draft") {
    // The stored markdown is model output, so it is rendered exactly the way the
    // wiki reader renders a synthesized answer: `formatWebHtml` escapes raw HTML
    // and only lets `http(s)` links through, which is the whole reason the chat's
    // client-side `sanitizeHtml` pass has no server-side counterpart to miss.
    const bodyHtml = view.draft.markdown ? formatWebHtml(view.draft.markdown) : "";
    return {
      title: `Muninn - ${deriveDraftHeading(view.draft)}`,
      body: jiraDraftViewHtml(view.draft, bodyHtml, view.list),
    };
  }
  return {
    title: "Muninn - Jira-arkiv",
    body: `<div class="ja-mast">
      <h1>Jira-arkiv</h1>
      <p class="ja-sub">Utkastene som er skrevet i chatten — «🧾 Lag Jira-sak» på et svar kjører utkastet
        som en tur i samtalen og leverer det som et kort der. Her ligger de etterpå: lagrede først,
        hele historikken bak «Alle forsøk». Lesevisning — teksten redigeres i samtalen den kom fra.</p>
    </div>
    ${jiraArchiveListHtml(view.drafts, {
      savedOnly: view.savedOnly,
      limit: view.limit,
      limitParam: view.limitParam,
      capped: view.capped,
    })}`,
  };
}

/** Rendered when the page itself could not be built — a bundle failure must not
 *  surface as an unexplained Hono 500 on a page whose only job is to be read. */
export function renderJiraFallback(error: string): string {
  return `<!DOCTYPE html>
<html lang="no"><head><meta charset="UTF-8"><title>Muninn - Jira-arkiv</title></head>
<body style="font-family:system-ui;padding:40px;max-width:70ch">
<h1>Jira-arkivet kunne ikke bygges</h1>
<p>${escHtml(error)}</p>
<p>Samme rader kan leses over API-et — <code>GET /api/jira/archive</code>,
<code>GET /api/jira/draft/:id</code> — men de treffer den samme databasen, så er det den som er nede,
svarer de ikke heller.</p>
</body></html>`;
}

const JIRA_ARCHIVE_STYLES = `
    .ja {
      --ja-line: var(--border-primary);
      --ja-line-soft: var(--border-subtle);
      --ja-surface: var(--bg-panel);
      --ja-surface-2: var(--bg-surface);
      --ja-ink: var(--text-primary);
      --ja-ink-2: var(--text-secondary);
      --ja-muted: var(--text-muted);
      --ja-faint: var(--text-dim);
      --ja-accent: var(--accent);
      --ja-accent-ink: var(--accent-light);
      --ja-accent-wash: color-mix(in srgb, var(--accent) 14%, transparent);
      --ja-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      max-width: 1080px;
      margin: 0 auto;
      padding: 18px 24px 48px;
      color: var(--ja-ink-2);
    }
    .ja h1 { font-size: 21px; font-weight: 600; color: var(--ja-ink); }
    .ja code { font-family: var(--ja-mono); font-size: 12px; color: var(--ja-ink-2); }
    .ja button { font: inherit; color: inherit; cursor: pointer; }
    .ja-sub { color: var(--ja-muted); font-size: 12.5px; max-width: 100ch; margin-top: 6px; line-height: 1.5; }
    .ja-empty { color: var(--ja-faint); font-size: 13px; font-style: italic; padding: 14px 0; line-height: 1.5; }

    /* ---- the list ------------------------------------------------------- */
    .ja-listhead {
      display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      margin: 18px 0 10px; padding-bottom: 8px; border-bottom: 1px solid var(--ja-line-soft);
    }
    .ja-tabs { display: flex; gap: 6px; }
    .ja-count { color: var(--ja-faint); font-size: 11.5px; margin-left: auto; }
    a.ja-tab, .ja-tab {
      border: 1px solid var(--ja-line); background: var(--ja-surface-2); color: var(--ja-muted);
      border-radius: 6px; padding: 4px 11px; font-size: 12px; text-decoration: none;
    }
    a.ja-tab:hover { border-color: var(--ja-accent); color: var(--ja-accent-ink); }
    /* Two-class selector on purpose (0,2,0). A bare \`.ja-tab-on\` (0,1,0) loses
       to \`a.ja-tab\` (0,1,1) on the list's link tabs and to \`.ja button\` (0,1,1)
       on the draft page's switch buttons — the selected tab rendered identically
       to the unselected one on both. */
    .ja-tab.ja-tab-on { background: var(--ja-accent-wash); border-color: var(--ja-accent); color: var(--ja-accent-ink); font-weight: 600; }

    .ja-rows { display: flex; flex-direction: column; gap: 6px; }
    a.ja-row {
      display: flex; flex-direction: column; gap: 5px; text-decoration: none;
      border: 1px solid var(--ja-line); border-radius: 8px; padding: 10px 13px;
      background: var(--ja-surface); color: inherit;
    }
    a.ja-row:hover { border-color: var(--ja-accent); }
    .ja-row-title { font-size: 13.5px; font-weight: 600; color: var(--ja-ink); line-height: 1.4; overflow-wrap: anywhere; }
    .ja-row-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .ja-meta-bit { font-size: 11.5px; color: var(--ja-muted); }
    .ja-row-when { font-family: var(--ja-mono); font-size: 11px; color: var(--ja-faint); margin-left: auto; }

    /* ---- one draft ------------------------------------------------------- */
    a.ja-back { font-size: 12px; color: var(--ja-muted); text-decoration: none; }
    a.ja-back:hover { color: var(--ja-accent-ink); }
    .ja-title { margin-top: 8px; overflow-wrap: anywhere; }
    .ja-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 8px 0 14px; }
    .ja-draftid { font-family: var(--ja-mono); font-size: 10.5px; color: var(--ja-faint); overflow-wrap: anywhere; }

    .ja-chip {
      font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-weight: 700;
      border-radius: 3px; padding: 1px 6px; border: 1px solid currentColor; color: var(--ja-muted);
    }
    .ja-chip-ready { color: var(--status-success); }
    .ja-chip-generating { color: var(--status-warning); }
    .ja-chip-failed { color: var(--status-error); }
    .ja-chip-saved { color: var(--status-success); }
    .ja-chip-unsaved { color: var(--ja-faint); }
    .ja-cov { font-size: 10.5px; border-radius: 3px; padding: 1px 6px; border: 1px dashed currentColor; }
    .ja-cov-warn { color: var(--status-warning); }
    .ja-cov-bad { color: var(--status-error); }

    .ja-banner {
      padding: 9px 12px; border-radius: 6px; font-size: 12.5px; line-height: 1.5; margin-bottom: 10px;
      border: 1px solid var(--ja-line); background: var(--ja-surface-2);
    }
    .ja-banner ul { margin: 6px 0 0; padding-left: 18px; }
    .ja-banner li { margin-bottom: 3px; }
    .ja-banner-warn { border-color: color-mix(in srgb, var(--status-warning) 45%, transparent); background: color-mix(in srgb, var(--status-warning) 9%, transparent); }
    .ja-banner-bad { border-color: color-mix(in srgb, var(--status-error) 45%, transparent); background: color-mix(in srgb, var(--status-error) 9%, transparent); }
    /* "this draft came out of a conversation" — provenance, not a problem, so it
       borrows the accent rather than a status colour. */
    .ja-banner-thread { border-color: var(--ja-accent); background: var(--ja-accent-wash); color: var(--ja-ink-2); }
    a.ja-threadlink { color: var(--ja-accent-ink); text-decoration: none; white-space: nowrap; }
    a.ja-threadlink:hover { text-decoration: underline; }

    .ja-switch { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    .ja-spacer { flex: 1 1 auto; }
    .ja-secondary {
      border: 1px solid var(--ja-line); background: var(--ja-surface-2); color: var(--ja-ink-2);
      border-radius: 6px; padding: 4px 11px; font-size: 12px;
    }
    .ja-secondary:hover { border-color: var(--ja-accent); color: var(--ja-accent-ink); }

    .ja-preview, .ja-raw {
      border: 1px solid var(--ja-line); border-radius: 8px; background: var(--ja-surface-2);
      padding: 14px 16px; font-size: 13.5px; overflow: auto;
    }
    .ja-preview { color: var(--ja-ink-2); }
    .ja-preview table { display: block; overflow-x: auto; }
    .ja-raw {
      font: inherit; font-family: var(--ja-mono); font-size: 12.5px; line-height: 1.55;
      width: 100%; min-height: 60vh; resize: vertical; color: var(--ja-ink);
    }

    .ja-keys { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
    .ja-key {
      font-family: var(--ja-mono); font-size: 11px; border-radius: 4px; padding: 2px 7px;
      border: 1px solid currentColor; text-decoration: none; display: inline-flex; gap: 5px; align-items: baseline;
    }
    .ja-key em { font-family: inherit; font-style: normal; font-size: 10px; opacity: .85; }
    .ja-key-ok { color: var(--status-success); }
    .ja-key-notes { color: var(--status-warning); }
    .ja-key-unknown { color: var(--status-error); }

    .ja-notes { margin-top: 14px; font-size: 12.5px; color: var(--ja-muted); }
    .ja-notes summary { cursor: pointer; color: var(--ja-faint); font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; }
    .ja-notes pre {
      margin-top: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--ja-mono);
      font-size: 12px; line-height: 1.5; border: 1px solid var(--ja-line-soft); border-radius: 6px;
      padding: 10px 12px; background: var(--ja-surface-2); max-height: 40vh; overflow: auto;
    }
`;
