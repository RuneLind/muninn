# TikTok

<!-- moved out of the root CLAUDE.md by /doctor on 2026-10-13 -->

Path: `src/tiktok/`

TikTok video summarization *including visual content* — `src/video/media.ts` → `src/video/short-video.ts` (Claude reads frame JPEGs through `toolSurface: { read: [framesDir] }`, `<workDir>/frames`, which holds the kept frames and not the video, the audio or the frames thinning dropped; a capture with `frames: false` or whose extraction failed declares `"none"`) → `tiktok-summaries` collection. `summarizer.ts` is the SPEC, not a job of its own: the X-video vertical runs the same code with its own spec. 60-min cap (TikTok's platform maximum) with duration-scaled download/whisper/ffmpeg timeouts — `downloadVideo` takes no default cap, so a new vertical must state its own. `kind` on the POST (`GET /api/tiktok/options`), and the whisper transcript is filed under `## Transcript` on the ingest body. **Requires `yt-dlp` on PATH**; With frames on (the default), `SUMMARIZER_BOT` needs a connector with `supportsExtraDirs` and, on claude-cli, a CLI of 2.1.303 or later; the route pre-flights both and 503s before the expensive download/whisper work. `frames: false` runs with no tools on any connector. Optional `TIKTOK_WHISPER_MODEL_PATH` overrides the shared whisper model.
