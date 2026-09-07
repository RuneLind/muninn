// src/youtube/extension-options-rules.ts
var FALLBACK_KIND_ID = "standard";
var FALLBACK_CAPTURE_OPTIONS = {
  kinds: [{ id: FALLBACK_KIND_ID, label: "Standard" }],
  defaultKind: FALLBACK_KIND_ID,
  framesSupported: true,
  fromServer: false
};
var OPTIONS_UNREACHABLE_MESSAGE = "Could not reach Muninn options — Standard only.";
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
function parseCaptureOptions(payload) {
  if (typeof payload !== "object" || payload === null)
    return null;
  const raw = payload;
  if (!Array.isArray(raw.kinds))
    return null;
  const kinds = [];
  for (const entry of raw.kinds) {
    if (typeof entry !== "object" || entry === null)
      continue;
    const { id, label } = entry;
    if (!isNonEmptyString(id))
      continue;
    kinds.push({ id, label: isNonEmptyString(label) ? label : id });
  }
  if (kinds.length === 0)
    return null;
  const offered = new Set(kinds.map((k) => k.id));
  const defaultKind = isNonEmptyString(raw.default_kind) && offered.has(raw.default_kind) ? raw.default_kind : kinds[0].id;
  const frames = raw.frames;
  const framesSupported = typeof frames === "object" && frames !== null && typeof frames.supported === "boolean" ? frames.supported : true;
  return { kinds, defaultKind, framesSupported, fromServer: true };
}
function pickKind(stored, options) {
  if (isNonEmptyString(stored) && options.kinds.some((k) => k.id === stored.trim())) {
    return stored.trim();
  }
  return options.defaultKind;
}
function restoredKindNote(stored, picked, options) {
  if (!options.fromServer)
    return null;
  if (!isNonEmptyString(stored))
    return null;
  const wanted = stored.trim();
  if (wanted === picked)
    return null;
  const label = options.kinds.find((k) => k.id === picked)?.label ?? picked;
  return `“${wanted}” is not offered here — using ${label}.`;
}
function pickFrames(stored, options) {
  return options.framesSupported && stored === true;
}
function buildSummarizeBody(input) {
  return {
    title: typeof input.title === "string" ? input.title : "",
    url: input.url,
    video_id: input.videoId,
    kind: isNonEmptyString(input.kind) ? input.kind.trim() : FALLBACK_KIND_ID,
    frames: input.frames === true
  };
}
export {
  restoredKindNote,
  pickKind,
  pickFrames,
  parseCaptureOptions,
  buildSummarizeBody,
  OPTIONS_UNREACHABLE_MESSAGE,
  FALLBACK_KIND_ID,
  FALLBACK_CAPTURE_OPTIONS
};
