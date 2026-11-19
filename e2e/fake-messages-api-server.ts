/**
 * The fake Anthropic Messages API (`src/test/fake-messages-api.ts`) as a
 * process of its own, for a spec: Playwright runs specs under Node, and the
 * fake is a `Bun.serve`. Run with `bun`; prints `FAKE_API_URL=<url>` once it
 * listens, then answers every request with `FAKE_API_CHUNKS` (a JSON array of
 * text chunks) streamed `FAKE_API_DELAY_MS` apart, until killed.
 */
import { startFakeMessagesApi } from "../src/test/fake-messages-api.ts";

const chunks = JSON.parse(process.env.FAKE_API_CHUNKS ?? '["PAGE-SUMMARY: fetched."]') as string[];
const delayMs = Number(process.env.FAKE_API_DELAY_MS ?? "0");
const api = startFakeMessagesApi({ reply: { chunks, delayMs } });
process.stdout.write(`FAKE_API_URL=${api.url}\n`);
setInterval(() => {}, 1 << 30);
