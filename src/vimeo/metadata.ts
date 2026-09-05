/**
 * What the route derives from oEmbed's answer beyond title and duration — pure,
 * so the rule is testable without a network.
 *
 * The SPEAKER is not a field Vimeo has. Conference accounts encode it in the
 * title — JavaZone's convention, measured on all 10 items of its RSS feed
 * 2026-09-05, is `<talk title> - <speaker>` (and `… - Handle - Full
 * Name` when the speaker has a handle), so the LAST ` - ` segment is the
 * speaker. That rule is only true of an account known to follow it: a talk
 * uploaded by an individual titled "Kotlin - the good parts" would otherwise
 * be filed under a speaker called "the good parts". Hence the allowlist.
 */

/** oEmbed `author_name`s known to title their uploads `<title> - <speaker>`. */
export const VIMEO_CONFERENCE_ACCOUNTS: readonly string[] = ["JavaZone"];

export function isVimeoConferenceAccount(author: string): boolean {
  const wanted = author.trim().toLowerCase();
  return wanted !== "" && VIMEO_CONFERENCE_ACCOUNTS.some((a) => a.toLowerCase() === wanted);
}

/**
 * The speaker a conference account's title names, or `undefined` when the
 * account is not one we know the convention of, or the title carries no ` - `
 * segment, or the last segment is empty.
 */
export function speakerFromTitle(title: string, author: string): string | undefined {
  if (!isVimeoConferenceAccount(author)) return undefined;
  const parts = title.split(" - ").map((p) => p.trim());
  if (parts.length < 2) return undefined;
  const last = parts[parts.length - 1] ?? "";
  return last === "" ? undefined : last;
}
