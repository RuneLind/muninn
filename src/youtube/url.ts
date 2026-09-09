/**
 * The one rule for "which video does this url name".
 *
 * Its own module, import-free, for the reason `src/youtube/frames.ts` is: the
 * capture RE-RUN needs this function and nothing else out of the YouTube
 * vertical, and `src/dashboard/routes/youtube-routes.ts` — where it used to
 * live — drags in the job store, the summarizer, the frames seam and every
 * capture route with it. `youtube-routes.ts` re-exports it, so no existing
 * importer moved.
 */

/**
 * The 11-character video id a YouTube url names, or `null`.
 *
 * Exact host or a real SUBDOMAIN of it, never a suffix match: `endsWith` also
 * accepts `evilyoutube.com`, so one document ingested from such a url answered
 * `duplicate` for the real video — and, through the delete listener, named the
 * video whose kept frames get removed.
 */
export function extractYouTubeVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === "youtu.be") return u.pathname.slice(1) || null;
    if (host === "youtube.com" || host.endsWith(".youtube.com")) return u.searchParams.get("v");
    return null;
  } catch {
    return null;
  }
}
