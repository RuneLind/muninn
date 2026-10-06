/**
 * The transcript check's block in the `/summaries` Fact check section, rendered
 * SERVER-side (by `/result` and the transcript POST) so the page bundle carries
 * none of it: one row per web claim, its web verdict beside its transcript
 * verdict, joined by `index`, and the reading of the pair.
 */

import { escHtml } from "./escape.ts";
import { describeCut, transcriptReading, type SavedTranscriptCheck } from "../../../summaries/transcript-check.ts";

const WEB_LABEL: Record<string, string> = {
  "✅": "web: supported",
  "⚠️": "web: partly supported",
  "❌": "web: contradicted",
  "❓": "web: unverified",
};

export function renderTranscriptCheckHtml(
  webClaims: ReadonlyArray<{ index: number; title: string; verdict: string }>,
  check: SavedTranscriptCheck,
  opts: { stale?: boolean | null } = {},
): string {
  const byIndex = new Map(check.claims.map((c) => [c.index, c]));
  const rows = webClaims
    .map((w) => {
      const t = byIndex.get(w.index);
      const web = w.verdict === "⚠" ? "⚠️" : w.verdict;
      const tChip = t
        ? `<span class="sum-fc-tchip" data-tverdict="${escHtml(t.verdict)}">transcript: ${escHtml(t.verdict)}</span>`
        : '<span class="sum-fc-tchip" data-tverdict="none">transcript: no verdict</span>';
      const reading = t ? transcriptReading(web, t.verdict) : null;
      return (
        `<li data-claim-index="${w.index}">` +
        `<span class="sum-fc-v" title="${escHtml(WEB_LABEL[web] ?? "web")}">${escHtml(web)}</span>` +
        tChip +
        `<span class="sum-fc-t">${escHtml(w.title)}</span>` +
        (reading ? `<span class="sum-fc-tx-read">${escHtml(reading)}</span>` : "") +
        (t?.note ? `<div class="sum-fc-tx-note">${escHtml(t.note)}</div>` : "") +
        "</li>"
      );
    })
    .join("");
  const cut = describeCut(check.cut);
  return (
    '<div class="sum-fc-tx">' +
    '<div class="sum-fc-tx-head">Against the transcript' +
    (opts.stale ? ' <span class="sum-fc-stale" title="The transcript changed since this check">stale</span>' : "") +
    "</div>" +
    (cut ? `<div class="sum-fc-tx-cut">${escHtml(cut)}</div>` : "") +
    `<ol class="sum-fc-tx-list">${rows}</ol>` +
    "</div>"
  );
}
