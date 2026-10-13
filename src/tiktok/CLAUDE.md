# TikTok

<!-- moved out of the root CLAUDE.md by /doctor on 2026-10-13 -->

Path: `src/tiktok/`

TikTok video summarization *including visual content* — `src/video/media.ts` → `src/video/short-video.ts` (Claude reads frame JPEGs via `extraDirs` → `--add-dir`) → `tiktok-summaries` collection. `summarizer.ts` is the SPEC, not a job of its own: the X-video vertical runs the same code with its own spec. 60-min cap (TikTok's platform maximum) with duration-scaled download/whisper/ffmpeg timeouts — `downloadVideo` takes no default cap, so a new vertical must state its own. `kind` on the POST (`GET /api/tiktok/options`), and the whisper transcript is filed under `## Transcript` on the ingest body. **Requires `yt-dlp` on PATH**; `SUMMARIZER_BOT` needs a connector with `supportsExtraDirs` (route pre-flights and 503s before the expensive download/whisper work). Optional `TIKTOK_WHISPER_MODEL_PATH` overrides the shared whisper model.
