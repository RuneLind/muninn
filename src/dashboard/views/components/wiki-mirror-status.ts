/**
 * The rail line for a bucket-mirrored wiki whose copy is not up to date
 * (architecture review 2026-10, finding 32). The listing carries `mirror` only
 * while the mirror is not `ok`; absent, the line stays hidden.
 */
import { escHtml } from "./escape.ts";

export const MIRROR_STATUS_SLOT_ID = "wikiMirrorStatus";

/** The listing's `mirror` field (`src/wiki/bucket-mirror-status.ts`). */
export interface ListingMirrorStatus {
  health: string;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  failedObjects: number;
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** The line's text, or null when there is nothing to say. */
export function mirrorStatusText(status: ListingMirrorStatus | undefined | null, now: number): string | null {
  if (!status || typeof status !== "object" || status.health === "ok") return null;
  const since = typeof status.lastSuccessAt === "number"
    ? `last complete update ${ago(now - status.lastSuccessAt)}`
    : "no complete update yet";
  switch (status.health) {
    case "starting":
      return "Copying this wiki from the bucket — pages may be missing.";
    case "degraded": {
      const n = status.failedObjects;
      const what = n > 0 ? `${n} page${n === 1 ? "" : "s"} or file${n === 1 ? "" : "s"} could not be updated` : "the last update was incomplete";
      return `Copy may be out of date: ${what}; ${since}.`;
    }
    case "failing":
      return `Copy may be out of date: the bucket does not answer; ${since}.`;
    case "refused":
      return `Copy is no longer updated from the bucket; ${since}.`;
    default:
      return `Copy may be out of date; ${since}.`;
  }
}

export function mirrorStatusHtml(status: ListingMirrorStatus | undefined | null, now: number): string {
  const text = mirrorStatusText(status, now);
  return text ? `<span class="wiki-mirror-status-mark" aria-hidden="true">⚠</span> ${escHtml(text)}` : "";
}

/** How often the reader redraws the line between listings: the age text's
 *  finest step is a minute, and a listing can be 5 min apart or held back. */
export const MIRROR_STATUS_TICK_MS = 60_000;

/** The last status a listing carried, for `repaintMirrorStatus`. */
let lastStatus: ListingMirrorStatus | undefined | null;

/** Paint the slot from a listing; hides it when the listing has no `mirror`. */
export function paintMirrorStatus(status: ListingMirrorStatus | undefined | null, now: number): void {
  lastStatus = status;
  repaintMirrorStatus(now);
}

/** Redraw the last listing's status against `now`, so its age advances
 *  between listings. Writes only when the text changed: the slot is a
 *  `role="status"` live region. */
export function repaintMirrorStatus(now: number): void {
  const slot = typeof document === "undefined" ? null : document.getElementById(MIRROR_STATUS_SLOT_ID);
  if (!slot) return;
  const html = mirrorStatusHtml(lastStatus, now);
  if (slot.innerHTML !== html) slot.innerHTML = html;
  slot.hidden = html === "";
}

export function mirrorStatusStyles(): string {
  return `
    .wiki-mirror-status { margin: 4px 0 6px; padding: 4px 8px; font-size: 12px; line-height: 1.35;
      border: 1px solid var(--status-warning); border-radius: 6px; color: var(--text-primary); }
    .wiki-mirror-status[hidden] { display: none; }
    .wiki-mirror-status-mark { color: var(--status-warning); }
  `;
}
