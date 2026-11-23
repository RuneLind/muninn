// src/youtube/extension-options-rules.ts
var FALLBACK_KIND_ID = "standard";
var FALLBACK_VISUAL_DETAIL_ID = "selected";
var FALLBACK_VISUAL_DETAIL_OPTIONS = [
  { id: FALLBACK_VISUAL_DETAIL_ID, label: "Selected" }
];
var FALLBACK_CAPTURE_OPTIONS = {
  kinds: [{ id: FALLBACK_KIND_ID, label: "Standard" }],
  defaultKind: FALLBACK_KIND_ID,
  framesSupported: true,
  visualDetail: {
    options: FALLBACK_VISUAL_DETAIL_OPTIONS,
    defaultDetail: FALLBACK_VISUAL_DETAIL_ID
  },
  connectors: null,
  fromServer: false
};
var OPTIONS_UNREACHABLE_MESSAGE = "Could not reach Muninn options — Standard only.";
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
function parseOptionRows(raw) {
  if (!Array.isArray(raw))
    return [];
  const rows = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null)
      continue;
    const { id, label } = entry;
    if (!isNonEmptyString(id))
      continue;
    rows.push({ id, label: isNonEmptyString(label) ? label : id });
  }
  return rows;
}
function parseVisualDetail(raw) {
  if (typeof raw !== "object" || raw === null)
    return null;
  const { supported, options, default: fallback } = raw;
  if (supported === false)
    return null;
  const rows = parseOptionRows(options);
  if (rows.length === 0)
    return null;
  const offered = new Set(rows.map((r) => r.id));
  const defaultDetail = isNonEmptyString(fallback) && offered.has(fallback) ? fallback : rows[0].id;
  return { options: rows, defaultDetail };
}
function parseConnectors(raw) {
  if (typeof raw !== "object" || raw === null)
    return null;
  const { options, default_label } = raw;
  if (!Array.isArray(options))
    return null;
  const rows = [];
  for (const entry of options) {
    if (typeof entry !== "object" || entry === null)
      continue;
    const { id, label, kinds, frames } = entry;
    if (!isNonEmptyString(id))
      continue;
    const parsedKinds = parseOptionRows(kinds);
    if (parsedKinds.length === 0)
      continue;
    const f = frames;
    rows.push({
      id,
      label: isNonEmptyString(label) ? label : id,
      kinds: parsedKinds,
      framesSupported: typeof f === "object" && f !== null && typeof f.supported === "boolean" ? f.supported : true
    });
  }
  if (rows.length === 0)
    return null;
  return { defaultLabel: isNonEmptyString(default_label) ? default_label : "Default", options: rows };
}
function parseCaptureOptions(payload) {
  if (typeof payload !== "object" || payload === null)
    return null;
  const raw = payload;
  if (!Array.isArray(raw.kinds))
    return null;
  const kinds = parseOptionRows(raw.kinds);
  if (kinds.length === 0)
    return null;
  const offered = new Set(kinds.map((k) => k.id));
  const defaultKind = isNonEmptyString(raw.default_kind) && offered.has(raw.default_kind) ? raw.default_kind : kinds[0].id;
  const frames = raw.frames;
  const framesSupported = typeof frames === "object" && frames !== null && typeof frames.supported === "boolean" ? frames.supported : true;
  return {
    kinds,
    defaultKind,
    framesSupported,
    visualDetail: parseVisualDetail(raw.visual_detail),
    connectors: parseConnectors(raw.connectors),
    fromServer: true
  };
}
var DEFAULT_CONNECTOR_ID = "";
function pickConnector(stored, options) {
  if (isNonEmptyString(stored) && options.connectors?.options.some((c) => c.id === stored.trim())) {
    return stored.trim();
  }
  return DEFAULT_CONNECTOR_ID;
}
function restoredConnectorNote(stored, picked, options) {
  if (!options.fromServer)
    return null;
  if (!isNonEmptyString(stored))
    return null;
  if (stored.trim() === picked)
    return null;
  return "The remembered connector is not offered here — using the default.";
}
function optionsForConnector(options, connectorId) {
  const row = isNonEmptyString(connectorId) ? options.connectors?.options.find((c) => c.id === connectorId.trim()) : undefined;
  if (!row)
    return options;
  return {
    ...options,
    kinds: row.kinds,
    defaultKind: row.kinds.some((k) => k.id === options.defaultKind) ? options.defaultKind : row.kinds[0].id,
    framesSupported: row.framesSupported
  };
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
function pickVisualDetail(stored, options) {
  const capability = options.visualDetail;
  if (!capability)
    return null;
  if (isNonEmptyString(stored) && capability.options.some((o) => o.id === stored.trim())) {
    return stored.trim();
  }
  return capability.defaultDetail;
}
function buildSummarizeBody(input) {
  return {
    title: typeof input.title === "string" ? input.title : "",
    url: input.url,
    video_id: input.videoId,
    kind: isNonEmptyString(input.kind) ? input.kind.trim() : FALLBACK_KIND_ID,
    frames: input.frames === true,
    ...isNonEmptyString(input.visualDetail) ? { visual_detail: input.visualDetail.trim() } : {},
    ...isNonEmptyString(input.connectorId) ? { connector_id: input.connectorId.trim() } : {}
  };
}
export {
  restoredKindNote,
  restoredConnectorNote,
  pickVisualDetail,
  pickKind,
  pickFrames,
  pickConnector,
  parseCaptureOptions,
  optionsForConnector,
  buildSummarizeBody,
  OPTIONS_UNREACHABLE_MESSAGE,
  FALLBACK_VISUAL_DETAIL_OPTIONS,
  FALLBACK_VISUAL_DETAIL_ID,
  FALLBACK_KIND_ID,
  FALLBACK_CAPTURE_OPTIONS,
  DEFAULT_CONNECTOR_ID
};
