# X article

<!-- moved out of the root CLAUDE.md by /doctor on 2026-10-13 -->

Path: `src/x-article/`

X/Twitter summarization (backs `x-article-routes.ts` + Chrome extension). Two paths into the same job store + `x-articles` collection: `summarizer.ts` (pasted text) and `video.ts` (X video posts). `video.ts` is a SPEC over the shared short-video job (`src/video/short-video.ts`) rather than a summarizer of its own: 3-hour cap, duration-scaled timeouts, ingest + dedup keyed on the bare status URL via `canonicalXStatusUrl`/`extractXStatusId` so media-slot/query variants can't double-capture, and no degraded-frame-Reads warn (the TikTok spec's, deliberately not inherited). Same frames pre-flight as TikTok (`shortVideoCaptureBlocker`, `src/video/short-video-kinds.ts`): with frames on (the default) the route checks the connector's `supportsExtraDirs` and, on claude-cli, the CLI version (`restrictedCliBlocker`, ≥ 2.1.303 for `--restricted`), and answers 503 with a plain-sentence `error` (no `code` field, unlike YouTube/Vimeo's `frames_unsupported`/`cli_too_old`) before a job exists; `frames: false` is never blocked. Same yt-dlp requirement and the same `kind` picker (`GET /api/x-articles/video-options`).
