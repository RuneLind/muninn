/// <reference lib="dom" />
/** Browser entrypoint: puts the «Lag Jira-sak» control's PURE helpers on
 *  globalThis so the surrounding inline script (CHAT_SCRIPT in page.ts, plus the
 *  DOM half injected by `jiraEntryScript()`) can call them by bare name — the
 *  SAME functions the server-side tests exercise, with no hand-ported JS-string
 *  copy to keep in sync. The `inspector-panel-browser.ts` pattern. */

import {
  initialJiraEntryState,
  jiraEntryButtonHtml,
  jiraEntryCanSubmit,
  jiraEntryDraftBody,
  jiraEntryOutcome,
  jiraEntryPanelHtml,
  jiraEntryVisible,
  JE_POPUP_BLOCKED_MESSAGE,
} from "./jira-entry-pure.ts";

Object.assign(globalThis, {
  initialJiraEntryState,
  jiraEntryButtonHtml,
  jiraEntryCanSubmit,
  jiraEntryDraftBody,
  jiraEntryOutcome,
  jiraEntryPanelHtml,
  jiraEntryVisible,
  JE_POPUP_BLOCKED_MESSAGE,
});
