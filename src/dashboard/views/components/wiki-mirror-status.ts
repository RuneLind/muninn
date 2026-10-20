/**
 * The rail line for a bucket-mirrored wiki whose copy is not up to date
 * (architecture review 2026-10, finding 32). The listing carries `mirror` only
 * while the mirror is not `ok`; absent, the line stays hidden.
 */
export const MIRROR_STATUS_SLOT_ID = "wikiMirrorStatus";
/** The live region: the health message only, so a screen reader speaks when
 *  the health changes. */
export const MIRROR_STATUS_MSG_ID = "wikiMirrorStatusMsg";
/** Outside the live region: the age advances every minute and must not
 *  re-announce the line. */
export const MIRROR_STATUS_AGE_ID = "wikiMirrorStatusAge";

/** The rail slot, `hidden` until a listing reports a mirror that is not `ok`. */
export function mirrorStatusSlotHtml(): string {
  return `<p class="wiki-mirror-status" id="${MIRROR_STATUS_SLOT_ID}" hidden>`
    + `<span class="wiki-mirror-status-mark" aria-hidden="true">⚠</span> `
    + `<span id="${MIRROR_STATUS_MSG_ID}" role="status"></span> `
    + `<span id="${MIRROR_STATUS_AGE_ID}"></span></p>`;
}

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

/** The line in two parts: `message` changes only with the health, `since`
 *  with the clock. Null when there is nothing to say. */
export function mirrorStatusParts(
  status: ListingMirrorStatus | undefined | null,
  now: number,
): { message: string; since: string } | null {
  if (!status || typeof status !== "object" || status.health === "ok") return null;
  const since = typeof status.lastSuccessAt === "number"
    ? `last complete update ${ago(now - status.lastSuccessAt)}.`
    : "no complete update yet.";
  switch (status.health) {
    case "starting":
      return { message: "Copying this wiki from the bucket — pages may be missing.", since: "" };
    case "degraded": {
      const n = status.failedObjects;
      const what = n > 0 ? `${n} page${n === 1 ? "" : "s"} or file${n === 1 ? "" : "s"} could not be updated` : "the last update was incomplete";
      return { message: `Copy may be out of date: ${what};`, since };
    }
    case "failing":
      return { message: "Copy may be out of date: the bucket does not answer;", since };
    case "refused":
      return { message: "Copy is no longer updated from the bucket;", since };
    default:
      return { message: "Copy may be out of date;", since };
  }
}

/** The line's text, or null when there is nothing to say. */
export function mirrorStatusText(status: ListingMirrorStatus | undefined | null, now: number): string | null {
  const parts = mirrorStatusParts(status, now);
  if (!parts) return null;
  return parts.since ? `${parts.message} ${parts.since}` : parts.message;
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
 *  between listings. The message is written only when it changed: replacing
 *  the live region's text, even with the same words, re-announces it. */
export function repaintMirrorStatus(now: number): void {
  if (typeof document === "undefined") return;
  const slot = document.getElementById(MIRROR_STATUS_SLOT_ID);
  const msg = document.getElementById(MIRROR_STATUS_MSG_ID);
  const age = document.getElementById(MIRROR_STATUS_AGE_ID);
  if (!slot || !msg || !age) return;
  const parts = mirrorStatusParts(lastStatus, now);
  slot.hidden = parts === null;
  const message = parts?.message ?? "";
  if (msg.textContent !== message) msg.textContent = message;
  age.textContent = parts?.since ?? "";
}

/** Start the minute tick and return the listing hook (`receivePages`'
 *  `onMirror`). The reader passes the browser's clock and timer. */
export function installMirrorStatus(clock: {
  now: () => number;
  setInterval: (tick: () => void, ms: number) => unknown;
}): (status: ListingMirrorStatus | undefined) => void {
  clock.setInterval(() => repaintMirrorStatus(clock.now()), MIRROR_STATUS_TICK_MS);
  return (status) => paintMirrorStatus(status, clock.now());
}

export function mirrorStatusStyles(): string {
  return `
    .wiki-mirror-status { margin: 4px 0 6px; padding: 4px 8px; font-size: 12px; line-height: 1.35;
      border: 1px solid var(--status-warning); border-radius: 6px; color: var(--text-primary); }
    .wiki-mirror-status[hidden] { display: none; }
    .wiki-mirror-status-mark { color: var(--status-warning); }
  `;
}
