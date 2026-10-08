/// <reference lib="dom" />
/** The reader's `localStorage`, or undefined where reading it throws (a
 *  private window, blocked site data). Every reader preference goes through
 *  this, so each falls back to its default the same way. */
export function localStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
