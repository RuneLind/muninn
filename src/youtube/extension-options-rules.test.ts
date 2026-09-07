/**
 * The extension's rule module, and the checked-in copy the popup actually runs.
 *
 * Two halves. The first is ordinary unit coverage of rules that have no other
 * check at all — the extension is unpackaged JavaScript with no harness, so
 * "the popup restores a kind the server no longer offers" is otherwise found by
 * a reader getting a 400.
 *
 * The second is the freshness gate: it re-runs the SHIPPED emitter
 * (`scripts/build-extension.ts`, the same entry `bun run build:extension`
 * calls) into a temp file and compares bytes with
 * `extensions/youtube/capture-rules.js`. Editing the module and forgetting to
 * rebuild is then a red test rather than a popup running last month's rules.
 * The output is bun's own codegen, so a bun version bump can fail it too — the
 * remedy is `bun run build:extension` and committing the result.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FALLBACK_CAPTURE_OPTIONS,
  FALLBACK_KIND_ID,
  buildSummarizeBody,
  parseCaptureOptions,
  pickFrames,
  pickKind,
  type CaptureOptions,
} from "./extension-options-rules.ts";
import { EXTENSION_RULES_OUTPUT, buildExtensionRules } from "../../scripts/build-extension.ts";

const SERVER_PAYLOAD = {
  kinds: [
    { id: "standard", label: "Standard" },
    { id: "deep", label: "Deep (opus, full thinking)" },
    { id: "talk-notes", label: "Talk notes (timeline)" },
  ],
  default_kind: "standard",
  frames: { supported: true },
};

describe("parseCaptureOptions", () => {
  test("a well-formed answer becomes the picker, marked as coming from the server", () => {
    const parsed = parseCaptureOptions(SERVER_PAYLOAD);
    expect(parsed).toEqual({
      kinds: [
        { id: "standard", label: "Standard" },
        { id: "deep", label: "Deep (opus, full thinking)" },
        { id: "talk-notes", label: "Talk notes (timeline)" },
      ],
      defaultKind: "standard",
      framesSupported: true,
      fromServer: true,
    });
  });

  test("every unusable answer is null, so the popup can SAY it could not read them", () => {
    // Each of these is a real shape a reader's `muninnUrl` can produce: an
    // instance with no such route (HTML or an error object), a proxy answering
    // a string, an older Muninn answering an empty list.
    for (const bad of [
      null,
      undefined,
      "<!doctype html>",
      42,
      {},
      { error: "Not found" },
      { kinds: {} },
      { kinds: [] },
      { kinds: [{ label: "Standard" }] },
      { kinds: [{ id: "", label: "x" }] },
      { kinds: [{ id: "  ", label: "x" }] },
      { kinds: ["standard"] },
    ]) {
      expect(parseCaptureOptions(bad)).toBeNull();
    }
  });

  test("a junk entry is dropped, a usable one still makes a picker", () => {
    const parsed = parseCaptureOptions({ kinds: [{ id: 7 }, { id: "deep" }] });
    // A label-less entry keeps its id as the label rather than rendering
    // "undefined" in the dropdown.
    expect(parsed?.kinds).toEqual([{ id: "deep", label: "deep" }]);
  });

  test("a default the server does not offer falls back to the first kind, never to a 400", () => {
    expect(parseCaptureOptions({ ...SERVER_PAYLOAD, default_kind: "should-i-watch" })?.defaultKind)
      .toBe("standard");
    expect(parseCaptureOptions({ kinds: [{ id: "deep", label: "D" }] })?.defaultKind).toBe("deep");
  });

  test("frames.supported is read when it is a boolean and assumed otherwise", () => {
    expect(parseCaptureOptions({ ...SERVER_PAYLOAD, frames: { supported: false } })?.framesSupported)
      .toBe(false);
    // An instance that omits the flag still has a good kind list; the POST
    // re-checks the connector and answers 503 with a sentence.
    expect(parseCaptureOptions({ kinds: SERVER_PAYLOAD.kinds })?.framesSupported).toBe(true);
    expect(parseCaptureOptions({ ...SERVER_PAYLOAD, frames: { supported: "yes" } })?.framesSupported)
      .toBe(true);
  });

  test("the fallback is Standard only and is NOT marked as coming from the server", () => {
    expect(FALLBACK_CAPTURE_OPTIONS.kinds).toEqual([{ id: "standard", label: "Standard" }]);
    expect(FALLBACK_CAPTURE_OPTIONS.fromServer).toBe(false);
    expect(FALLBACK_CAPTURE_OPTIONS.defaultKind).toBe(FALLBACK_KIND_ID);
  });
});

describe("pickKind — a remembered choice is re-validated against the CURRENT options", () => {
  const options = parseCaptureOptions(SERVER_PAYLOAD) as CaptureOptions;

  test("a kind the server still offers is restored", () => {
    expect(pickKind("deep", options)).toBe("deep");
    expect(pickKind(" talk-notes ", options)).toBe("talk-notes");
  });

  test("a kind the server no longer offers falls back to the default", () => {
    // The concrete case: the summarizer bot moved to a Copilot connector, so
    // `deep` is gone from this instance's set while the browser still has it.
    const narrowed = parseCaptureOptions({
      kinds: [{ id: "standard", label: "Standard" }, { id: "talk-notes", label: "T" }],
      default_kind: "standard",
    }) as CaptureOptions;
    expect(pickKind("deep", narrowed)).toBe("standard");
  });

  test("an install from before the picker has no kind at all — that is the default", () => {
    for (const stored of [undefined, null, "", "   ", 7, {}, true]) {
      expect(pickKind(stored, options)).toBe("standard");
    }
  });

  test("the answer is always an offered id, even under the fallback options", () => {
    expect(pickKind("deep", FALLBACK_CAPTURE_OPTIONS)).toBe("standard");
  });
});

describe("pickFrames", () => {
  const options = parseCaptureOptions(SERVER_PAYLOAD) as CaptureOptions;
  const noFrames = parseCaptureOptions({ ...SERVER_PAYLOAD, frames: { supported: false } }) as CaptureOptions;

  test("only an explicit stored true ticks the box", () => {
    expect(pickFrames(true, options)).toBe(true);
    for (const stored of [false, undefined, null, "true", 1]) {
      expect(pickFrames(stored, options)).toBe(false);
    }
  });

  test("a remembered tick does not survive onto an instance that cannot read frames", () => {
    expect(pickFrames(true, noFrames)).toBe(false);
  });
});

describe("buildSummarizeBody", () => {
  test("the two coercions the route 400s on", () => {
    expect(
      buildSummarizeBody({ title: "T", url: "https://x/y", videoId: "dQw4w9WgXcQ", kind: "deep", frames: true }),
    ).toEqual({ title: "T", url: "https://x/y", video_id: "dQw4w9WgXcQ", kind: "deep", frames: true });
  });

  test("a missing kind is the default id, never an absent key", () => {
    // `undefined` would be dropped by JSON.stringify and read by the route as
    // "not picked" — silently Standard, which is right by accident here and
    // wrong the moment a default moves.
    const body = buildSummarizeBody({ url: "https://x/y", videoId: "dQw4w9WgXcQ" });
    expect(body.kind).toBe("standard");
    expect(JSON.parse(JSON.stringify(body)).kind).toBe("standard");
  });

  test("frames is always a real boolean, whatever the popup handed over", () => {
    for (const frames of [undefined, null, "true", 1, {}]) {
      expect(buildSummarizeBody({ url: "u", videoId: "v", frames }).frames).toBe(false);
    }
  });

  test("a title-less video sends an empty string, not `undefined`", () => {
    expect(buildSummarizeBody({ url: "u", videoId: "v", title: null }).title).toBe("");
  });
});

describe("the checked-in extension copy", () => {
  test("`bun run build:extension` reproduces extensions/youtube/capture-rules.js byte for byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muninn-ext-build-"));
    try {
      // The SHIPPED emitter, not a re-typed `bun build`: one emitter, one
      // output, so the command in package.json cannot drift from this check.
      const fresh = await buildExtensionRules(join(dir, "capture-rules.js"));
      const checkedIn = await Bun.file(EXTENSION_RULES_OUTPUT).text();
      expect(fresh).toBe(checkedIn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
