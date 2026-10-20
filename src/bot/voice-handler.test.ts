/**
 * Span status on the Telegram voice path's failure sites (arch review 2026-10
 * finding 54): a failed step's span ends "error", so /traces renders it red
 * instead of green. A download or STT failure also ends the root as error; a
 * TTS or send failure is caught after the text reply went out, so the root
 * finishes ok with one red child.
 *
 * Uses mock.module, so this file runs in its own `bun test` link in every
 * chain (`src/test/mock-isolation.test.ts`).
 */

import { test, expect, mock, beforeEach, afterAll } from "bun:test";

type EndCall = { label: string; status: "ok" | "error" };
const ends: EndCall[] = [];
const started: string[] = [];
let root: "ok" | "error" | null = null;

class FakeTracer {
  constructor(_name: string, _opts?: unknown) {}
  start(label: string) {
    started.push(label);
    return label;
  }
  end(label: string, _attrs?: unknown, status: "ok" | "error" = "ok") {
    ends.push({ label, status });
    return 1;
  }
  // Every mark reads as non-zero, as the real Timing does for an open span.
  summary() {
    return Object.fromEntries(started.map((l) => [l, 5]));
  }
  error() {
    root = "error";
  }
  finish(status: "ok" | "error" = "ok") {
    root = status;
  }
}

let sttImpl: () => Promise<string> = async () => "hello";
let ttsImpl: () => Promise<Uint8Array> = async () => new Uint8Array([1]);

mock.module("../tracing/index.ts", () => ({ Tracer: FakeTracer }));
mock.module("../voice/stt.ts", () => ({ transcribeVoice: () => sttImpl() }));
mock.module("../voice/tts.ts", () => ({ synthesizeVoice: () => ttsImpl() }));
mock.module("../core/message-processor.ts", () => ({
  processMessage: async () => ({ responseText: "reply", inputTokens: 1, outputTokens: 1 }),
}));
mock.module("../db/threads.ts", () => ({ getActiveThreadId: async () => null }));
mock.module("../db/messages.ts", () => ({ setTelegramMessageId: async () => {} }));
mock.module("../observability/activity-log.ts", () => ({ activityLog: { push: () => {} } }));

const { createVoiceHandler } = await import("./voice-handler.ts");

const realFetch = globalThis.fetch;
let downloadOk = true;
let sendVoiceFails = false;
let downloadThrows: "getFile" | "fetch" | "arrayBuffer" | null = null;

beforeEach(() => {
  ends.length = 0;
  started.length = 0;
  root = null;
  downloadThrows = null;
  downloadOk = true;
  sendVoiceFails = false;
  sttImpl = async () => "hello";
  ttsImpl = async () => new Uint8Array([1]);
  globalThis.fetch = (async () => {
    if (downloadThrows === "fetch") throw new Error("network down");
    if (downloadThrows === "arrayBuffer") {
      const res = new Response(new Uint8Array([1, 2]));
      res.arrayBuffer = async () => {
        throw new Error("body read failed");
      };
      return res;
    }
    return downloadOk ? new Response(new Uint8Array([1, 2])) : new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function ctx() {
  return {
    message: { voice: { file_id: "f" } },
    from: { id: 7, first_name: "A" },
    chat: { id: 1 },
    api: {
      getFile: async () => {
        if (downloadThrows === "getFile") throw new Error("getFile failed");
        return { file_path: "voice.ogg" };
      },
    },
    reply: async () => ({ message_id: 2 }),
    replyWithChatAction: async () => {},
    replyWithVoice: async () => {
      if (sendVoiceFails) throw new Error("send failed");
      return {};
    },
  };
}

const handler = createVoiceHandler({} as never, { name: "b", telegramBotToken: "t" } as never);
const run = () => handler(ctx() as never);
const statusOf = (label: string) => ends.filter((e) => e.label === label).map((e) => e.status);

test("a failed download ends voice_download as error", async () => {
  downloadOk = false;
  await run();
  expect(statusOf("voice_download")).toEqual(["error"]);
});

for (const step of ["getFile", "fetch", "arrayBuffer"] as const) {
  test(`a throw in ${step} ends voice_download as error and the root as error`, async () => {
    downloadThrows = step;
    await run().catch(() => {});
    expect(statusOf("voice_download")).toEqual(["error"]);
    expect(started).not.toContain("stt");
    expect(root).toBe("error");
  });
}

test("a failed transcription ends stt as error", async () => {
  sttImpl = async () => {
    throw new Error("stt down");
  };
  await run();
  expect(statusOf("voice_download")).toEqual(["ok"]);
  expect(statusOf("stt")).toEqual(["error"]);
});

test("a failed synthesis ends tts as error and starts no send span", async () => {
  ttsImpl = async () => {
    throw new Error("tts down");
  };
  await run();
  expect(statusOf("tts")).toEqual(["error"]);
  expect(started).not.toContain("telegram_send_voice");
});

test("a failed voice send ends telegram_send_voice as error, tts stays ok", async () => {
  sendVoiceFails = true;
  await run();
  expect(statusOf("tts")).toEqual(["ok"]);
  expect(statusOf("telegram_send_voice")).toEqual(["error"]);
  expect(root).toBe("ok");
});

test("the success path ends every span ok", async () => {
  await run();
  for (const label of ["voice_download", "stt", "tts", "telegram_send_voice"]) {
    expect(statusOf(label)).toEqual(["ok"]);
  }
});
