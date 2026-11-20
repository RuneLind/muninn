/**
 * Discuss's tab, the server-rendered half (P3): the ids, the pane body's
 * skeleton and the styles, which `views/wiki-page.ts` renders. The
 * behaviour is `wiki-discuss-tab.ts`.
 */
import { HANDOFF_QUESTION_MAX } from "../../../wiki/discuss-bounds.ts";

export const DISCUSS_TAB = "discuss";
export const DISCUSS_BODY_ID = "discussBody";
export const DISCUSS_INPUT_ID = "wikiDiscussInput";
export const DISCUSS_ASK_BTN_ID = "wikiDiscussAskBtn";

/** The tab's skeleton, server-rendered into the pane (the turns are painted). */
export function discussTabBodyHtml(): string {
  return (
    `<div class="wiki-conn-body wiki-discuss-body" id="${DISCUSS_BODY_ID}" style="display:none">` +
    `<div class="wiki-discuss-turns"></div>` +
    `<div class="wiki-discuss-compose">` +
    `<textarea class="wiki-discuss-input" id="${DISCUSS_INPUT_ID}" rows="2" maxlength="${HANDOFF_QUESTION_MAX}" placeholder="Ask the wiki agent about this page…" aria-label="Ask the wiki agent"></textarea>` +
    `<button type="button" class="wiki-discuss-ask" id="${DISCUSS_ASK_BTN_ID}">Ask</button>` +
    `</div></div>`
  );
}

export function discussTabStyles(): string {
  return `
    .wiki-discuss-body { flex-direction: column; gap: 10px; padding: 12px 12px 10px; }
    .wiki-discuss-turns { display: flex; flex-direction: column; gap: 14px; }
    .wiki-discuss-hint { font-size: 12px; color: var(--text-dim); padding: 6px 4px; line-height: 1.5; }
    .wiki-discuss-turn { display: flex; flex-direction: column; gap: 6px; padding-bottom: 12px; border-bottom: 1px solid var(--border-primary); }
    .wiki-discuss-chip {
      align-self: flex-start; max-width: 100%; text-align: left; cursor: pointer;
      padding: 5px 9px; border-radius: 6px; font: inherit; font-size: 12px; line-height: 1.4;
      background: var(--bg-surface); color: var(--text-secondary);
      border: 1px solid var(--border-primary); border-left: 3px solid var(--accent);
    }
    .wiki-discuss-chip:hover { color: var(--text-primary); border-color: var(--accent); }
    .wiki-discuss-gone { font-size: 12px; color: var(--status-warning); }
    .wiki-discuss-whole { font-size: 11px; font-style: italic; color: var(--text-dim); }
    .wiki-discuss-q { font-size: 13px; font-weight: 600; color: var(--text-primary); white-space: pre-wrap; }
    .wiki-discuss-status { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-dim); }
    .wiki-discuss-status .spinner { width: 12px; height: 12px; border: 2px solid var(--border-secondary); border-top-color: var(--accent); border-radius: 50%; animation: wikiAskSpin 0.7s linear infinite; }
    .wiki-discuss-tools { display: flex; flex-wrap: wrap; gap: 4px; }
    .wiki-discuss-tool { font-size: 10.5px; font-family: var(--font-mono, monospace); color: var(--text-dim); background: var(--bg-inset); border-radius: 4px; padding: 1px 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Not .wiki-article: the reader's selection, find and reveal code reads that
       class as the page. The chat's pre-wrap, since the formatter writes no <p>. */
    .wiki-discuss-answer { font-size: 13px; line-height: 1.55; color: var(--text-primary); white-space: pre-wrap; overflow-wrap: anywhere; }
    .wiki-discuss-answer code { font-family: var(--font-mono, monospace); font-size: 0.92em; background: var(--bg-inset); padding: 1px 4px; border-radius: 4px; }
    .wiki-discuss-answer pre { white-space: pre; overflow-x: auto; background: var(--bg-inset); padding: 8px; border-radius: 6px; }
    .wiki-discuss-answer pre code { background: none; padding: 0; }
    .wiki-discuss-answer a { color: var(--accent-light); }
    .wiki-discuss-error { font-size: 12px; color: var(--status-error); }
    .wiki-discuss-edit-note { font-size: 12px; color: var(--text-secondary); font-style: italic; }
    .wiki-discuss-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .wiki-discuss-continue {
      padding: 5px 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
      border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary);
    }
    .wiki-discuss-continue:hover { border-color: var(--accent); }
    .wiki-discuss-continue:disabled { opacity: 0.5; cursor: progress; }
    .wiki-discuss-edit { display: flex; flex-direction: column; gap: 6px; padding: 8px; border-radius: 8px; border: 1px solid var(--border-secondary); background: var(--bg-surface); }
    .wiki-discuss-edit-head { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
    .wiki-discuss-edit-why { font-size: 12px; color: var(--text-secondary); }
    .wiki-discuss-diff { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .wiki-discuss-diff > div { padding: 4px 6px; border-radius: 4px; background: var(--bg-inset); }
    .wiki-discuss-diff-ctx { color: var(--text-dim); }
    .wiki-discuss-diff del { color: var(--status-error); text-decoration: line-through; }
    .wiki-discuss-diff ins { color: var(--status-success); text-decoration: none; font-weight: 600; }
    .wiki-discuss-edit-lint { font-size: 12px; color: var(--status-warning); }
    .wiki-discuss-edit-lint ul { margin: 4px 0 0; padding-left: 18px; }
    .wiki-discuss-edit-done { font-size: 12px; color: var(--status-success); }
    .wiki-discuss-apply {
      padding: 5px 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: 12px; font-weight: 600;
      border: none; background: var(--accent); color: var(--on-accent);
    }
    .wiki-discuss-apply:disabled { opacity: 0.5; cursor: progress; }
    .wiki-article .wiki-discuss-edit-mark { outline: 2px dashed var(--accent); outline-offset: 3px; border-radius: 3px; }
    .wiki-discuss-cont-status { font-size: 12px; color: var(--text-secondary); }
    .wiki-discuss-cont-out { width: 100%; box-sizing: border-box; min-height: 8em; font-family: var(--font-mono, monospace); font-size: 12px; border-radius: 6px; border: 1px solid var(--border-secondary); background: var(--bg-inset); color: var(--text-primary); }
    .wiki-discuss-compose { display: flex; gap: 8px; margin-top: auto; padding-top: 8px; position: sticky; bottom: 0; background: var(--bg-panel); }
    .wiki-discuss-input {
      flex: 1; padding: 8px 10px; border-radius: 8px; resize: vertical;
      border: 1px solid var(--border-secondary); background: var(--bg-inset);
      color: var(--text-primary); font-size: 13px; font-family: inherit; line-height: 1.4;
    }
    .wiki-discuss-input:focus { outline: none; border-color: var(--accent); }
    .wiki-discuss-ask {
      align-self: flex-end; padding: 7px 14px; border-radius: 8px; border: none; cursor: pointer;
      background: var(--accent); color: var(--on-accent); font-size: 13px; font-weight: 600; font-family: inherit;
    }
    .wiki-discuss-ask:disabled { opacity: 0.5; cursor: default; }
  `;
}
