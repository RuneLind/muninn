# X article

<!-- moved out of the root CLAUDE.md by /doctor on 2026-10-13 -->

Path: `src/x-article/`

X/Twitter summarization (backs `x-article-routes.ts` + Chrome extension). Two paths into the same job store + `x-articles` collection: `summarizer.ts` (pasted text) and `video.ts` (X video posts). `video.ts` is a SPEC over the shared short-video job (`src/video/short-video.ts`) rather than a summarizer of its own: 3-hour cap, duration-scaled timeouts, ingest + dedup keyed on the bare status URL via `canonicalXStatusUrl`/`extractXStatusId` so media-slot/query variants can't double-capture, and no degraded-frame-Reads warn (the TikTok spec's, deliberately not inherited). Same `supportsExtraDirs` pre-flight + yt-dlp requirement as TikTok, and the same `kind` picker (`GET /api/x-articles/video-options`).
