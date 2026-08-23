/// <reference lib="dom" />
/** Browser entrypoint: puts the draft card's PURE helpers on globalThis so the
 *  surrounding inline script (CHAT_SCRIPT in page.ts, plus the DOM half injected
 *  by `jiraCardScript()`) can call them by bare name — the SAME functions the
 *  server-side tests exercise, with no hand-ported JS-string copy to keep in
 *  sync. The `jira-entry-browser.ts` pattern. */

import {
  jiraCardArchiveUrl,
  jiraCardBadges,
  jiraCardHtml,
  jiraCardNoticeHtml,
  jiraCardPollExpired,
  jiraCardSaveFailedMessage,
  jiraCardShouldPoll,
  jiraCardSignature,
} from "./jira-card-pure.ts";

Object.assign(globalThis, {
  jiraCardArchiveUrl,
  jiraCardBadges,
  jiraCardHtml,
  jiraCardNoticeHtml,
  jiraCardPollExpired,
  jiraCardSaveFailedMessage,
  jiraCardShouldPoll,
  jiraCardSignature,
});
