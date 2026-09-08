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
 *
 * ⚠️ The last case calls `process.chdir`, and this file shares a process with
 * the ~265 other files of the `test:unit` chunk: the working directory is
 * process-wide state, so its `finally` restore is load-bearing for every one of
 * them — a case that leaves the process in `/tmp` breaks whichever file reads a
 * relative path next, in an order that changes with the file set.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  FALLBACK_CAPTURE_OPTIONS,
  FALLBACK_KIND_ID,
  FALLBACK_VISUAL_DETAIL_ID,
  buildSummarizeBody,
  parseCaptureOptions,
  pickFrames,
  pickKind,
  pickVisualDetail,
  restoredKindNote,
  type CaptureOptions,
} from "./extension-options-rules.ts";
import { EXTENSION_RULES_OUTPUT, buildExtensionRules } from "./extension-build.ts";

/** An instance from BEFORE the visual-detail axis: kinds and frames, nothing else. */
const SERVER_PAYLOAD = {
  kinds: [
    { id: "standard", label: "Standard" },
    { id: "deep", label: "Deep (opus, full thinking)" },
    { id: "talk-notes", label: "Talk notes (timeline)" },
  ],
  default_kind: "standard",
  frames: { supported: true },
};

/** What this repo's own options endpoint answers. */
const SERVER_PAYLOAD_V2 = {
  ...SERVER_PAYLOAD,
  visual_detail: {
    supported: true,
    default: "selected",
    options: [
      { id: "selected", label: "Selected" },
      { id: "detailed", label: "Detailed" },
    ],
  },
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
      // An instance with no visual-detail capability at all: no control, and no
      // such field on the POST.
      visualDetail: null,
      fromServer: true,
    });
  });

  test("the visual-detail capability is read when the instance offers one", () => {
    expect(parseCaptureOptions(SERVER_PAYLOAD_V2)?.visualDetail).toEqual({
      options: [
        { id: "selected", label: "Selected" },
        { id: "detailed", label: "Detailed" },
      ],
      defaultDetail: "selected",
    });
  });

  test("every unusable visual-detail shape is null, and never a broken picker", () => {
    // A control rendered from junk offers the reader a choice the route refuses.
    for (const bad of [
      undefined,
      null,
      "detailed",
      {},
      { supported: true },
      { supported: true, options: [] },
      { supported: true, options: {} },
      { supported: true, options: [{ label: "Detailed" }] },
      { supported: false, options: [{ id: "selected", label: "Selected" }] },
    ]) {
      expect(parseCaptureOptions({ ...SERVER_PAYLOAD, visual_detail: bad })?.visualDetail).toBeNull();
    }
  });

  test("a visual-detail default the server does not offer falls back to the first row", () => {
    const parsed = parseCaptureOptions({
      ...SERVER_PAYLOAD,
      visual_detail: { supported: true, default: "exhaustive", options: [{ id: "detailed", label: "D" }] },
    });
    expect(parsed?.visualDetail?.defaultDetail).toBe("detailed");
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

  test("the fallback offers ONLY the policy every instance runs — the `kinds` rule", () => {
    // NOT the `framesSupported` rule: the POST re-checks the connector and
    // answers 503 with a sentence, so an over-offered tick is refused out loud.
    // `visual_detail` has no such refusal behind it — a Muninn from before this
    // feature IGNORES the key — so offering `detailed` where the options could
    // not be read offers a choice that may silently do nothing. The fallback
    // therefore offers what every instance runs, exactly as `kinds` falls back
    // to `standard` alone rather than to a catalog of every shipped preset.
    expect(FALLBACK_CAPTURE_OPTIONS.visualDetail?.options.map((o) => o.id)).toEqual(["selected"]);
    expect(FALLBACK_CAPTURE_OPTIONS.visualDetail?.defaultDetail).toBe(FALLBACK_VISUAL_DETAIL_ID);
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

describe("restoredKindNote — the fallback is SAID, not silent", () => {
  const options = parseCaptureOptions(SERVER_PAYLOAD) as CaptureOptions;
  const narrowed = parseCaptureOptions({
    kinds: [{ id: "standard", label: "Standard" }],
    default_kind: "standard",
  }) as CaptureOptions;

  test("a remembered kind this instance dropped is named, with what runs instead", () => {
    const note = restoredKindNote("deep", pickKind("deep", narrowed), narrowed);
    expect(note).toContain("deep");
    expect(note).toContain("Standard");
  });

  test("nothing to say when the remembered kind survived", () => {
    expect(restoredKindNote("deep", pickKind("deep", options), options)).toBeNull();
    expect(restoredKindNote(" deep ", pickKind(" deep ", options), options)).toBeNull();
  });

  test("an install that never stored a kind is the default, not a fallback", () => {
    for (const stored of [undefined, null, "", "   ", 7, {}, true]) {
      expect(restoredKindNote(stored, pickKind(stored, narrowed), narrowed)).toBeNull();
    }
  });

  test("silent under the unreachable fallback — that message is the explanation", () => {
    // `OPTIONS_UNREACHABLE_MESSAGE` already says the picker is Standard-only
    // because Muninn could not be read; a second line about the remembered kind
    // would blame the wrong thing.
    expect(
      restoredKindNote("deep", pickKind("deep", FALLBACK_CAPTURE_OPTIONS), FALLBACK_CAPTURE_OPTIONS),
    ).toBeNull();
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

describe("pickVisualDetail — the second axis, re-validated the same way", () => {
  const options = parseCaptureOptions(SERVER_PAYLOAD_V2) as CaptureOptions;
  const noCapability = parseCaptureOptions(SERVER_PAYLOAD) as CaptureOptions;

  test("a remembered policy the instance offers is restored", () => {
    expect(pickVisualDetail("detailed", options)).toBe("detailed");
    expect(pickVisualDetail(" selected ", options)).toBe("selected");
  });

  test("anything the instance does not offer falls back to its default, never a 400", () => {
    for (const stored of [undefined, null, "", "   ", "exhaustive", 7, {}, true]) {
      expect(pickVisualDetail(stored, options)).toBe("selected");
    }
  });

  test("an instance with no such capability answers null — the signal to send no field", () => {
    expect(pickVisualDetail("detailed", noCapability)).toBeNull();
    expect(pickVisualDetail(undefined, noCapability)).toBeNull();
  });
});

describe("buildSummarizeBody", () => {
  test("the two coercions the route 400s on", () => {
    expect(
      buildSummarizeBody({ title: "T", url: "https://x/y", videoId: "dQw4w9WgXcQ", kind: "deep", frames: true }),
    ).toEqual({ title: "T", url: "https://x/y", video_id: "dQw4w9WgXcQ", kind: "deep", frames: true });
  });

  test("a visual detail rides along when there is one, and is ABSENT when there is not", () => {
    // Absent rather than blank: the route refuses a present key holding
    // something it does not offer, and reads an absent one as the default.
    const withDetail = buildSummarizeBody({ url: "u", videoId: "v", visualDetail: " detailed " });
    expect(withDetail.visual_detail).toBe("detailed");
    for (const detail of [undefined, null, "", "   ", 7, {}, true]) {
      const body = buildSummarizeBody({ url: "u", videoId: "v", visualDetail: detail });
      expect("visual_detail" in body).toBe(false);
      expect("visual_detail" in JSON.parse(JSON.stringify(body))).toBe(false);
    }
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

  test("the emitted bytes do not depend on the process's working directory", async () => {
    // The gate above compares a build run from wherever `bun test` was invoked
    // against a copy committed by a build run from the repo root. Bun writes one
    // `// <path>` module banner per bundled module, relative to `process.cwd()`
    // — so without normalization the same source emits three different files
    // from the repo root, from `src/`, and from `/tmp`, and the gate's remedy
    // ("a bun bump changed the codegen") names the wrong cause.
    const dir = mkdtempSync(join(tmpdir(), "muninn-ext-cwd-"));
    const originalCwd = process.cwd();
    // Not `process.cwd()`: the point of the case is that the answer must not
    // depend on it, so the reference build is taken from a directory this file
    // can name — the repo root two levels above it.
    const repoRoot = resolve(import.meta.dir, "../..");
    try {
      process.chdir(repoRoot);
      const fromRepoRoot = await buildExtensionRules(join(dir, "from-repo-root.js"));
      const elsewhere: string[] = [];
      for (const cwd of [join(repoRoot, "src"), tmpdir()]) {
        process.chdir(cwd);
        elsewhere.push(await buildExtensionRules(join(dir, `from-${elsewhere.length}.js`)));
      }
      for (const text of elsewhere) expect(text).toBe(fromRepoRoot);
    } finally {
      process.chdir(originalCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
