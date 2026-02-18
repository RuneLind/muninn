# Voice Pipeline

How Javrvis handles voice messages — speech-to-text via whisper-cli, processing through the standard message pipeline, and text-to-speech via macOS `say` with codec conversion for Telegram.

## Overview

Voice messages follow a mirror mode pattern: voice in produces text + voice out, while text in produces text out. The voice handler wraps the standard message processing pipeline with STT before and TTS after.

```
Telegram voice message (OGG/Opus)
  → Download from Telegram API
  → STT: OGG → WAV → whisper-cli → text
  → Standard message pipeline (same as text messages)
  → TTS: text → macOS say → AIFF → ffmpeg → OGG/Opus
  → Send voice message + text caption back to Telegram
```

## Speech-to-Text (STT)

### The Codec Problem

Telegram sends voice messages as OGG/Opus. While `whisper-cli` (from the `whisper-cpp` brew package) claims OGG support, it **cannot** handle Telegram's OGG/Opus encoding — it silently produces garbage or errors.

The solution: convert to WAV first with ffmpeg.

### Pipeline

```
Telegram OGG/Opus buffer
  → Write to temp file (jarvis-<uuid>.ogg)
  → ffmpeg -i input.ogg -ar 16000 -ac 1 -y output.wav
  → whisper-cli --model <path> --no-timestamps output.wav
  → Clean artifacts ([BLANK_AUDIO], timestamps)
  → Return transcribed text
  → Delete temp files (finally block)
```

Key parameters:
- **Sample rate:** 16kHz (whisper requirement)
- **Channels:** Mono (whisper requirement)
- **Model:** Configurable via `WHISPER_MODEL_PATH` env var (default: `./models/ggml-base.en.bin`)
- **Binary name:** `whisper-cli` (brew installs `whisper-cpp` but the binary is named `whisper-cli`)

### Error Handling

- ffmpeg failure: throws with stderr
- whisper-cli failure: throws with stderr
- Empty transcription (no speech detected): throws specific error "Could not detect any speech in the audio"
- Temp files: always cleaned up in `finally` block

## Text-to-Speech (TTS)

### Platform Limitation

TTS uses macOS's built-in `say` command — this means TTS only works on macOS. An availability check runs on first use and caches the result:

```typescript
const proc = Bun.spawn(["which", "say"], ...);
ttsAvailable = (await proc.exited) === 0;
```

If `say` is not available, voice messages get text responses only (graceful degradation).

### Pipeline

```
Response text (max 4000 chars)
  → Write to temp file (avoids shell argument length limits)
  → say -o output.aiff -f input.txt
  → ffmpeg -i output.aiff -c:a libopus -b:a 64k -y output.ogg
  → Read OGG buffer
  → Send as Telegram voice message
  → Delete temp files (finally block)
```

Key parameters:
- **Max length:** 4000 characters (truncated with "..." if longer)
- **Audio codec:** libopus at 64kbps (Telegram requirement for voice messages)
- **Text input:** Written to a file rather than passed as argument (avoids shell escaping issues and argument length limits)

### Why File-Based Input

`say` can accept text as an argument (`say "hello"`), but this fails with:
- Long texts (shell argument limits)
- Special characters (quotes, backticks)
- Multi-line text

Using `-f input.txt` avoids all of these issues.

## Mirror Mode

The voice handler implements a simple rule:

| Input | Output |
|---|---|
| Voice message | Text response + voice response |
| Text message | Text response only |

This is handled in the voice handler — when a voice message is received:
1. Transcribe to text (STT)
2. Process through `processMessage()` (same as text)
3. Synthesize response to voice (TTS)
4. Send both text and voice back

## Key Files

| File | Purpose |
|---|---|
| `src/voice/stt.ts` | `transcribeVoice()` — OGG→WAV→whisper-cli→text |
| `src/voice/tts.ts` | `synthesizeVoice()` — text→say→AIFF→OGG/Opus |
| `src/bot/voice-handler.ts` | Telegram voice message handler, mirror mode logic |

## Dependencies

| Tool | Install | Purpose |
|---|---|---|
| `whisper-cli` | `brew install whisper-cpp` | Speech-to-text |
| `ffmpeg` | `brew install ffmpeg` | Audio format conversion |
| `say` | Built into macOS | Text-to-speech |
| Whisper model | Download `.bin` file | Language model for transcription |
